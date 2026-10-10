import { describe, it, expect, vi } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExecution } from "@archstone/schema";
import { buildRegistry } from "@archstone/runtime";
import type { IR } from "@archstone/compiler";
import type { FetchLike } from "@archstone/provider-rest";
import { fromIR, type AuditSink, type ExecutionRecord } from "../src/index";
import { mcpHandler } from "../src/mcp";

// #195: the declared input contract is enforced, so a tourism.search call must carry every
// required field (destination, dates, travelers) in its declared shape.
const NICE_SEARCH = { destination: "Nice", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };


// #44 (ADD-44) — the embedded consumer emits. `executeCapability` is the second of the two
// audited consumers, and the one whose records an auditor will compare against the MCP path's:
// same builder, same vocabulary, different `spec.consumer` and nothing else.

const here = dirname(fileURLToPath(import.meta.url));
const bank = resolve(here, "../../../examples/manifests/bank");
const tourism = resolve(here, "../../../examples/manifests/tourism");

/** `archstone build`'s artifact is IR round-tripped through JSON — simulate that exactly. */
function artifact(dir: string): IR {
  return JSON.parse(JSON.stringify(buildRegistry(dir).registry!.ir)) as IR;
}

function spySink(): { sink: AuditSink; records: ExecutionRecord[]; lines: string[] } {
  const records: ExecutionRecord[] = [];
  const lines: string[] = [];
  return { records, lines, sink: (r) => { records.push(r); lines.push(JSON.stringify(r)); } };
}

const ok200: FetchLike = async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 });
const forbiddenFetch: FetchLike = () => {
  throw new Error("must not be called — this attempt performs no connector work whatsoever");
};

describe("execute() — one record per attempt, consumer fixed to function-calling (S-US1.2, BR-4)", () => {
  it("emits exactly once on a successful invocation, validating against the compiled schema", async () => {
    const s = spySink();
    const a = fromIR(artifact(bank));
    const r = await a.execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: ok200,
      caller: { accessToken: "caller-token-7d1e", principal: "user:alice" },
      auditSink: s.sink,
    });
    expect(r.status).toBe("ok");
    expect(s.records).toHaveLength(1);
    expect(s.records[0].spec.consumer).toBe("function-calling");
    expect(s.records[0].metadata.capabilityId).toBe("banking.list-accounts");
    expect(s.records[0].spec.principal).toBe("user:alice");
    expect(s.records[0].status.phase).toBe("succeeded");
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("emits NO record for an unknown capability id (BR-9, TP-1′)", async () => {
    const s = spySink();
    const r = await fromIR(artifact(bank)).execute("nope.missing", {}, { auditSink: s.sink });
    expect(r.error).toBe("unknown capability: nope.missing");
    expect(s.records).toHaveLength(0);
  });

  it("records denied + the evaluator's reason on a policy refusal, with zero fetches (S-US3.1)", async () => {
    const s = spySink();
    const ir = artifact(bank);
    ir.tools.find((t) => t.id === "banking.list-accounts")!.policyRules = [{ id: "treasury-baseline", allow: ["user:alice"] }];
    const r = await fromIR(ir).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e", principal: "user:bob" },
      auditSink: s.sink,
    });
    expect(r.denial?.reason).toBe("principal_not_allowed");
    expect(s.records[0].status).toEqual({
      phase: "denied",
      message: r.error,
      denialReason: "principal_not_allowed",
    });
    expect(s.records[0].spec.policyRuleIds).toEqual(["treasury-baseline"]);
  });

  it("records failed with the shipped error text when the attempt never reaches a backend (S-US4.1)", async () => {
    const s = spySink();
    const r = await fromIR(artifact(bank)).execute("banking.generate-statement", { account: "acc-1", period: { from: "2027-01-01", to: "2027-01-31" } }, {
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e" },
      auditSink: s.sink,
    });
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.records[0].status.message).toBe(r.error);
    expect(s.records[0].status.message).toBe("capability 'banking.generate-statement' has no connector");
  });

  it("records a violation as failed with the SAME sentence the MCP path returns, and a degraded as succeeded (BR-15, BR-17, BR-44)", async () => {
    const a = fromIR(artifact(tourism));
    const env = { STAYS_API_URL: "https://x.test" };
    // `totalMatches` present in every call here — this test isolates `response:`'s own
    // required/degraded behavior; extract:'s (totalMatches) is covered separately.
    const body = (stay: Record<string, unknown>): FetchLike => async () =>
      new Response(JSON.stringify({ stays: [stay], totalMatches: 1 }), { status: 200 });

    const violation = spySink();
    const v = await a.execute("tourism.search", NICE_SEARCH, { env, fetchImpl: body({ name: "Azur" }), auditSink: violation.sink });
    expect(v.status).toBe("violation");
    expect(violation.records[0].status.phase).toBe("failed");
    expect(violation.records[0].status.message).toBe(
      "contract violation: capability 'tourism.search' — provider response is missing required field(s): location, pricePerNight. Declared output shape not met; raw body withheld.",
    );

    const degraded = spySink();
    const d = await a.execute("tourism.search", NICE_SEARCH, {
      env, fetchImpl: body({ name: "Azur", location: "Nice", pricePerNight: 118 }), auditSink: degraded.sink,
    });
    expect(d.status).toBe("degraded");
    expect(degraded.records[0].status.phase).toBe("succeeded");
  });

  it("passes correlation ids through and omits them otherwise (BR-23)", async () => {
    const s = spySink();
    await fromIR(artifact(bank)).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl: ok200, caller: { accessToken: "caller-token-7d1e" },
      auditSink: s.sink, sessionId: "sess-9",
    });
    expect(s.records[0].metadata.sessionId).toBe("sess-9");
    expect("workflowId" in s.records[0].metadata).toBe(false);
  });
});

describe("mcpHandler records the PROTOCOL, not the package (S-US1.7, BR-5, EC-11)", () => {
  it("a tools/call through @archstone/agent's mcpHandler carries consumer \"mcp\"", async () => {
    const s = spySink();
    const handler = mcpHandler(fromIR(artifact(bank)), {
      bearerToken: "secret",
      invoke: { auditSink: s.sink, env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl: ok200 },
      resolveCaller: () => ({ accessToken: "end-user-token", principal: "user:alice" }),
    });
    const res = await handler(
      new Request("http://test.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer secret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "banking_list-accounts", arguments: {} } }),
      }),
    );
    expect(res.status).toBe(200);
    expect(s.records).toHaveLength(1);
    expect(s.records[0].spec.consumer).toBe("mcp");
    expect(s.records[0].spec.principal).toBe("user:alice");
    expect(s.lines[0]).not.toContain("end-user-token");
  });
});

describe("execute() — the audit log cannot leak the credential it audited (US-5, BR-38)", () => {
  const TOKEN = "SUPER-SECRET-TOKEN-9f3a";

  it("the token is absent from the emitted bytes on succeeded, denied AND failed (S-US5.1…S-US5.3)", async () => {
    const s = spySink();
    const ir = artifact(bank);
    const sentAuth: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (_u, init) => {
      sentAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    };
    const caller = { accessToken: TOKEN, principal: "user:mallory", tenantId: "tenant-a" };

    // succeeded — the shipped binding puts ${caller.accessToken} in an Authorization header.
    await fromIR(ir).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl, caller, auditSink: s.sink,
    });
    expect(sentAuth).toEqual([`Bearer ${TOKEN}`]); // the token really was in play

    // denied — a different branch of the record builder.
    const denying = artifact(bank);
    denying.tools.find((t) => t.id === "banking.list-accounts")!.policyRules = [{ id: "p", allow: ["user:alice"] }];
    await fromIR(denying).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl: forbiddenFetch, caller, auditSink: s.sink,
    });

    // failed — a third branch, and the token is also smuggled in as capability input. #195: the
    // field is declared (an undeclared key would now be refused as input_invalid, a denial).
    const withNote = artifact(bank);
    withNote.tools.find((t) => t.id === "banking.list-accounts")!.input.push({ name: "note", required: false, type: { kind: "scalar", semantic: "string" } });
    await fromIR(withNote).execute("banking.list-accounts", { note: TOKEN }, {
      env: {}, fetchImpl: forbiddenFetch, caller, auditSink: s.sink,
    });

    expect(s.records.map((r) => r.status.phase)).toEqual(["succeeded", "denied", "failed"]);
    for (const line of s.lines) {
      expect(line).not.toContain(TOKEN);
      expect(line).not.toContain("tenant-a");
    }
  });
});

describe("execute() — a broken sink can never break, delay, or be seen (US-6)", () => {
  async function run(sink: AuditSink | undefined) {
    return fromIR(artifact(bank)).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl: ok200, caller: { accessToken: "caller-token-7d1e" }, auditSink: sink,
    });
  }

  it("a rejecting sink leaves ExecuteResult identical and execute()'s own Promise unrejected (S-US6.2, BR-28)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseline = await run(undefined);
    const withReject = await run(() => Promise.reject(new Error("nope")));
    expect(withReject).toEqual(baseline);
    await new Promise((r) => setImmediate(r));
    expect(err).toHaveBeenCalledTimes(1);
    err.mockRestore();
  });

  it("a hanging sink adds no latency (S-US6.3, BR-29)", async () => {
    // Resolving at all is the guarantee: an awaited sink would hang forever and time out here.
    const started = Date.now();
    const r = await run(() => new Promise<void>(() => {}));
    expect(r.status).toBe("ok");
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("no sink is a strict no-op: no clock read, no id generated (S-US9.2, BR-34)", async () => {
    const clock = vi.spyOn(Date.prototype, "toISOString");
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
    const r = await run(undefined);
    expect(r.status).toBe("ok");
    expect(clock).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    clock.mockRestore();
    uuid.mockRestore();
  });
});

// The reason ADD-43 D-10 could decline an IR version bump: the record is the drift detector.
describe("the record makes stale-artifact drift visible (US-10, BR-11)", () => {
  it("a stale artifact records an EMPTY rule list where the rebuilt one denies and names the rule (S-US10.2, S-US10.4)", async () => {
    const env = { CORE_BANKING_URL: "https://core.example" };
    const caller = { accessToken: "caller-token-7d1e", principal: "user:mallory" };

    // The artifact deployed BEFORE the policy was written: no policyRules on the tool at all.
    const stale = artifact(bank);
    expect(stale.tools.find((t) => t.id === "banking.list-accounts")!.policyRules).toBeUndefined();
    const staleRun = spySink();
    const staleResult = await fromIR(stale).execute("banking.list-accounts", {}, {
      env, fetchImpl: ok200, caller, auditSink: staleRun.sink,
    });

    // The artifact rebuilt AFTER `archstone build` lowered the same policy.
    const rebuilt = artifact(bank);
    rebuilt.tools.find((t) => t.id === "banking.list-accounts")!.policyRules = [{ id: "treasury-baseline", allow: ["user:alice"] }];
    const rebuiltRun = spySink();
    const rebuiltResult = await fromIR(rebuilt).execute("banking.list-accounts", {}, {
      env, fetchImpl: forbiddenFetch, caller, auditSink: rebuiltRun.sink,
    });

    // The documented fail-open: the stale deployment allows what the manifest forbids…
    expect(staleResult.status).toBe("ok");
    expect(rebuiltResult.denial?.reason).toBe("principal_not_allowed");
    // …and the two records are NOT byte-identical any more, which is the whole point.
    expect(staleRun.records[0].spec.policyRuleIds).toEqual([]);
    expect(rebuiltRun.records[0].spec.policyRuleIds).toEqual(["treasury-baseline"]);
    expect(staleRun.records[0].status.phase).toBe("succeeded");
  });

  it("an ALLOWED invocation also lists the rules it was decided against (S-US10.1, EC-6, R-3)", async () => {
    const s = spySink();
    const ir = artifact(bank);
    ir.tools.find((t) => t.id === "banking.list-accounts")!.policyRules = [
      { id: "treasury-baseline", allow: ["user:alice"] },
      { id: "transfer-limits" },
    ];
    await fromIR(ir).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: ok200,
      caller: { accessToken: "caller-token-7d1e", principal: "user:alice" },
      auditSink: s.sink,
    });
    expect(s.records[0].status.phase).toBe("succeeded");
    expect(s.records[0].spec.policyRuleIds).toEqual(["treasury-baseline", "transfer-limits"]);
  });
});

// ADD-51 (#51): the embedded path now carries the SAME ADD-24 exposure gate `callTool` already
// enforces. This block used to be a "characterization" test pinning the defect (a retired
// capability recorded `phase: "succeeded"` — manufactured evidence). It now asserts the fix:
// `executeCapability` refuses the call, before any connector work, and records `denied`/
// `lifecycle_blocked` instead.
describe("execute() — the ADD-51 lifecycle exposure gate (#51)", () => {
  it("a retired capability is refused and records denied/lifecycle_blocked, never succeeded (S-US1.1/S-US1.4)", async () => {
    const s = spySink();
    const ir = artifact(bank);
    ir.tools.find((t) => t.id === "banking.list-accounts")!.lifecycle = "retired";
    const r = await fromIR(ir).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e" },
      auditSink: s.sink,
    });
    expect(r.status).toBe("error");
    expect(r.denial).toEqual({ reason: "lifecycle_blocked", capability: "banking.list-accounts" });
    expect(r.error).toBe("capability 'banking.list-accounts' is retired and can no longer be invoked.");

    expect(s.records).toHaveLength(1);
    expect(s.records[0].status).toEqual({
      phase: "denied",
      message: "capability 'banking.list-accounts' is retired and can no longer be invoked.",
      denialReason: "lifecycle_blocked",
    });
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("fires before invokeRest is ever reached — an unbound, retired capability never reports 'no REST connector' (EC-2, S-US2.4)", async () => {
    const ir = artifact(bank);
    ir.tools.find((t) => t.id === "banking.generate-statement")!.lifecycle = "retired";
    const r = await fromIR(ir).execute("banking.generate-statement", {}, {
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e" },
    });
    expect(r.denial?.reason).toBe("lifecycle_blocked");
    expect(r.error).not.toMatch(/no REST connector/);
  });

  it("denies regardless of whether the caller would satisfy the resolved policy, and the record's policyRuleIds is populated exactly as any other phase's (BR-8/BR-19, S-US2.3/S-US5.2)", async () => {
    const s = spySink();
    const ir = artifact(bank);
    const tool = ir.tools.find((t) => t.id === "banking.list-accounts")!;
    tool.lifecycle = "retired";
    tool.policyRules = [{ id: "treasury-baseline", allow: ["user:alice"] }];
    const r = await fromIR(ir).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e", principal: "user:alice" }, // policy WOULD allow this principal
      auditSink: s.sink,
    });
    expect(r.denial?.reason).toBe("lifecycle_blocked");
    expect(r.denial?.reason).not.toBe("principal_not_allowed");

    // BR-19: `spec.policyRuleIds` is populated from `tool.policyRules ?? []` UNCONDITIONALLY —
    // by the shared `buildExecutionRecord` helper, regardless of the fact that `evaluatePolicy`
    // was never called for this attempt (the lifecycle gate ran and returned first). It must
    // NOT be forced empty "because policy did not run" — that is precisely the plausible-looking
    // wrong fix this assertion exists to catch.
    expect(s.records).toHaveLength(1);
    expect(s.records[0].spec.policyRuleIds).toEqual(["treasury-baseline"]);
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("with no sink configured, the result is byte-for-byte identical to the sink-configured case (BR-20)", async () => {
    const ir = artifact(bank);
    ir.tools.find((t) => t.id === "banking.list-accounts")!.lifecycle = "retired";
    const opts = {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e" },
    };
    const withSink = await fromIR(ir).execute("banking.list-accounts", {}, { ...opts, auditSink: () => {} });
    const withoutSink = await fromIR(ir).execute("banking.list-accounts", {}, opts);
    expect(withSink).toEqual(withoutSink);
  });

  it("no sink is a strict no-op even for a lifecycle denial: no clock read, no id generated (S-US6.1, BR-20)", async () => {
    const clock = vi.spyOn(Date.prototype, "toISOString");
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
    const ir = artifact(bank);
    ir.tools.find((t) => t.id === "banking.list-accounts")!.lifecycle = "retired";
    const r = await fromIR(ir).execute("banking.list-accounts", {}, { fetchImpl: forbiddenFetch });
    expect(r.denial?.reason).toBe("lifecycle_blocked");
    expect(clock).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    clock.mockRestore();
    uuid.mockRestore();
  });
});

// ADD-56 (#56): the exposure gate's SECOND denying outcome — an unrecognized `lifecycle` value.
// Only reachable via a hand-written or forward-versioned `fromIR` artifact (ADD-0008 D-2); every
// scenario here mutates the round-tripped IR artifact the same way #51's block above does.
describe("execute() — the ADD-56 fail-closed exposure gate on an unrecognized lifecycle (#56)", () => {
  it("S-US1.1: an unrecognized lifecycle string is refused and records denied/lifecycle_unevaluatable, never succeeded", async () => {
    const s = spySink();
    const ir = artifact(bank) as { tools: { id: string; lifecycle?: unknown }[] };
    ir.tools.find((t) => t.id === "banking.list-accounts")!.lifecycle = "sunset";
    const r = await fromIR(ir).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e" },
      auditSink: s.sink,
    });
    expect(r.status).toBe("error");
    expect(r.denial).toEqual({ reason: "lifecycle_unevaluatable", capability: "banking.list-accounts" });
    expect(r.error).not.toBe("capability 'banking.list-accounts' is retired and can no longer be invoked.");

    expect(s.records).toHaveLength(1);
    expect(s.records[0].status.phase).toBe("denied");
    expect(s.records[0].status.denialReason).toBe("lifecycle_unevaluatable");
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("S-US1.2/EC-2: a non-string lifecycle value (number) is refused identically", async () => {
    const ir = artifact(bank) as { tools: { id: string; lifecycle?: unknown }[] };
    ir.tools.find((t) => t.id === "banking.list-accounts")!.lifecycle = 7;
    const r = await fromIR(ir).execute("banking.list-accounts", {}, { fetchImpl: forbiddenFetch });
    expect(r.denial?.reason).toBe("lifecycle_unevaluatable");
  });

  it("S-US1.3/EC-3: a lifecycle field entirely absent is refused, never silently treated as compiler-defaulted stable", async () => {
    const ir = artifact(bank) as { tools: { id: string; lifecycle?: unknown }[] };
    delete ir.tools.find((t) => t.id === "banking.list-accounts")!.lifecycle;
    const r = await fromIR(ir).execute("banking.list-accounts", {}, { fetchImpl: forbiddenFetch });
    expect(r.denial?.reason).toBe("lifecycle_unevaluatable");
  });

  it("S-US1.4: the gate fires before any connector work — an unset required env var never surfaces", async () => {
    const ir = artifact(bank) as { tools: { id: string; lifecycle?: unknown }[] };
    ir.tools.find((t) => t.id === "banking.list-accounts")!.lifecycle = "sunset";
    const r = await fromIR(ir).execute("banking.list-accounts", {}, { fetchImpl: forbiddenFetch });
    expect(r.error).not.toMatch(/missing env var/i);
    expect(r.denial?.reason).toBe("lifecycle_unevaluatable");
  });

  it("BR-18/S-US5.2: denies regardless of whether the caller would satisfy the resolved policy, and never calls evaluatePolicy's own module (BR-18, S-US5.1)", async () => {
    const s = spySink();
    const ir = artifact(bank) as { tools: { id: string; lifecycle?: unknown; policyRules?: unknown }[] };
    const tool = ir.tools.find((t) => t.id === "banking.list-accounts")!;
    tool.lifecycle = "sunset";
    tool.policyRules = [{ id: "treasury-baseline", allow: ["user:alice"] }];
    const r = await fromIR(ir).execute("banking.list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e", principal: "user:alice" }, // policy WOULD allow this principal
      auditSink: s.sink,
    });
    expect(r.denial?.reason).toBe("lifecycle_unevaluatable");
    expect(r.denial?.reason).not.toBe("principal_not_allowed");
    expect(s.records[0].spec.policyRuleIds).toEqual(["treasury-baseline"]);
  });

  it("BR-8: callTool and executeCapability select identical message text and denialReason for the identical fixture", async () => {
    const ir = artifact(bank) as { tools: { id: string; lifecycle?: unknown }[] };
    ir.tools.find((t) => t.id === "banking.list-accounts")!.lifecycle = "sunset";
    const built = fromIR(ir);
    const r = await built.execute("banking.list-accounts", {}, { fetchImpl: forbiddenFetch });

    const handler = mcpHandler(built, { bearerToken: "secret", invoke: { fetchImpl: forbiddenFetch } });
    const res = await handler(
      new Request("http://test.local/mcp", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
          authorization: "Bearer secret",
        },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "tools/call",
          params: { name: "banking_list-accounts", arguments: {} },
        }),
      }),
    );
    const body = (await res.json()) as { result: { content: { type: string; text: string }[]; isError: boolean } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toBe(r.error);
  });
});
