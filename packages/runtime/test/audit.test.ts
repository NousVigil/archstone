import { describe, it, expect, vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { validateExecution } from "@archstone/schema";
import type { IR, IRTool } from "@archstone/compiler";
import { Registry, type AuditSink, type ExecutionRecord } from "@archstone/emitter-support";
import { invokeRest, type FetchLike, type InvokeOptions } from "@archstone/provider-rest";
import { callTool } from "../src/server";
import { createHttpHandler } from "../src/http";
import { buildRegistry } from "../src/registry";
import { runVerify, verifyTool } from "../src/verify";

// #44 (ADD-44) — the MCP consumer emits. The unit under test is the AUDITED CONSUMER, not the
// builder (emitter-support/test/audit.test.ts): what a record says on each of the fifteen
// termination points, that there is exactly one of them, that it validates against the shipped
// schema, that no credential survives into the emitted bytes, and that a broken sink can
// neither break, delay, nor be observed by the invocation it watches.

const here = dirname(fileURLToPath(import.meta.url));
const bank = resolve(here, "../../../examples/manifests/bank");
const tourism = resolve(here, "../../../examples/manifests/tourism");
const bankRegistry = buildRegistry(bank).registry!;
const tourismRegistry = buildRegistry(tourism).registry!;

/** A spy sink that also keeps the exact bytes a JSON Lines sink would have written. */
function spySink(): { sink: AuditSink; records: ExecutionRecord[]; lines: string[] } {
  const records: ExecutionRecord[] = [];
  const lines: string[] = [];
  return {
    records,
    lines,
    sink: (record) => {
      records.push(record);
      lines.push(JSON.stringify(record));
    },
  };
}

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: "bank.list",
    description: "List accounts.",
    effect: "read",
    provider: "core",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [],
    connector: { type: "rest", rest: { baseUrl: "https://core.example", method: "GET", path: "/accounts" } },
    ...over,
  };
}

function registryOf(...tools: IRTool[]): Registry {
  const ir: IR = { version: "0", company: { id: "acme" }, tools, resources: {} };
  return new Registry(ir);
}

const ok200: FetchLike = async () => new Response(JSON.stringify({ accounts: [] }), { status: 200 });
const forbiddenFetch: FetchLike = () => {
  throw new Error("must not be called — this attempt performs no connector work whatsoever");
};

describe("callTool — one record per attempt, on every termination point (BR-2, S-US4.9)", () => {
  it("TP-1: an unresolvable tool name emits NO record, and the result is unchanged (BR-9, S-US1.8)", async () => {
    const s = spySink();
    const r = await callTool(registryOf(tool()), "does_not_exist", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    expect(r.content[0].text).toBe("unknown tool: does_not_exist");
    expect(s.records).toHaveLength(0);
  });

  it("TP-2: a retired capability records denied/lifecycle_blocked, not failed (S-US3.3, BR-14)", async () => {
    const s = spySink();
    const r = await callTool(
      registryOf(tool({ lifecycle: "retired" })),
      "bank.list",
      {},
      { auditSink: s.sink, fetchImpl: forbiddenFetch },
    );
    expect(s.records).toHaveLength(1);
    expect(s.records[0].status).toEqual({
      phase: "denied",
      message: "capability 'bank.list' is retired and can no longer be invoked.",
      denialReason: "lifecycle_blocked",
    });
    expect(r._meta?.["dev.archstone/lifecycle_blocked"]).toBeDefined(); // result untouched
  });

  it("TP-2 wins over TP-3: retired AND policy-denied records lifecycle_blocked (S-US3.4)", async () => {
    const s = spySink();
    await callTool(
      registryOf(tool({ lifecycle: "retired", policyRules: [{ id: "p", allow: ["user:alice"] }] })),
      "bank.list",
      {},
      { auditSink: s.sink, fetchImpl: forbiddenFetch, caller: { principal: "user:mallory" } },
    );
    expect(s.records[0].status.denialReason).toBe("lifecycle_blocked");
    expect(s.records[0].status.denialReason).not.toBe("principal_not_allowed");
  });

  // ADD-56 (#56): TP-2's sibling — the exposure gate's SECOND denying outcome, for a `lifecycle`
  // value this build does not recognize at all (only reachable via a hand-written/forward-
  // versioned artifact — `registryOf`/`tool()` simulate exactly that by widening past the
  // `Lifecycle` type, mirroring an untrusted `fromIR` artifact).
  it("TP-2b (S-US2.1, BR-4, BR-6): an unrecognized lifecycle records denied/lifecycle_unevaluatable, with a message distinct from retired's", async () => {
    const s = spySink();
    const r = await callTool(
      registryOf(tool({ lifecycle: "sunset" as IRTool["lifecycle"] })),
      "bank.list",
      {},
      { auditSink: s.sink, fetchImpl: forbiddenFetch },
    );
    expect(s.records).toHaveLength(1);
    expect(s.records[0].status.denialReason).toBe("lifecycle_unevaluatable");
    expect(s.records[0].status.message).not.toBe("capability 'bank.list' is retired and can no longer be invoked.");
    expect(r.isError).toBe(true);
    expect(r.content[0].text).not.toBe("capability 'bank.list' is retired and can no longer be invoked.");
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("S-US2.2/BR-9: the unevaluatable _meta is distinguishable from the retired _meta — a distinct key, never identical", async () => {
    const unevaluatable = await callTool(
      registryOf(tool({ lifecycle: "sunset" as IRTool["lifecycle"] })),
      "bank.list",
      {},
      { fetchImpl: forbiddenFetch },
    );
    const retired = await callTool(registryOf(tool({ lifecycle: "retired" })), "bank.list", {}, { fetchImpl: forbiddenFetch });
    expect(unevaluatable._meta?.["dev.archstone/lifecycle_unevaluatable"]).toEqual({
      error: "lifecycle_unevaluatable",
      capability: "bank.list",
      lifecycle: "sunset",
    });
    expect(unevaluatable._meta?.["dev.archstone/lifecycle_blocked"]).toBeUndefined();
    expect(retired._meta?.["dev.archstone/lifecycle_blocked"]).toBeDefined();
    expect(unevaluatable._meta).not.toEqual(retired._meta);
  });

  it("TP-2b wins over TP-3: unrecognized lifecycle AND policy-deniable records lifecycle_unevaluatable, never a policy reason (S-US5.1, BR-18)", async () => {
    const s = spySink();
    await callTool(
      registryOf(tool({ lifecycle: "sunset" as IRTool["lifecycle"], policyRules: [{ id: "p", allow: ["user:alice"] }] })),
      "bank.list",
      {},
      { auditSink: s.sink, fetchImpl: forbiddenFetch, caller: { principal: "user:mallory" } },
    );
    expect(s.records[0].status.denialReason).toBe("lifecycle_unevaluatable");
    expect(s.records[0].status.denialReason).not.toBe("principal_not_allowed");
  });

  it("EC-3/S-US1.3: a lifecycle field entirely absent from a hand-written tool entry is refused as unevaluatable, not defaulted to stable", async () => {
    const t = tool() as Partial<IRTool>;
    delete t.lifecycle;
    const r = await callTool(registryOf(t as IRTool), "bank.list", {}, { fetchImpl: forbiddenFetch });
    expect(r._meta?.["dev.archstone/lifecycle_unevaluatable"]).toBeDefined();
  });

  // EC-12: two independent fail-closed mechanisms on one call — the exposure gate wins,
  // unconditionally, because it runs before evaluatePolicy is ever reached (mirrors #51 EC-8's
  // identical ruling for retired + policy_unevaluatable).
  it("EC-12: unrecognized lifecycle AND an unevaluatable policy still records lifecycle_unevaluatable, never policy_unevaluatable", async () => {
    const s = spySink();
    await callTool(
      registryOf(tool({ lifecycle: "sunset" as IRTool["lifecycle"], policyRules: [{ id: "p", futureKey: 1 } as never] })),
      "bank.list",
      {},
      { auditSink: s.sink, fetchImpl: forbiddenFetch },
    );
    expect(s.records[0].status.denialReason).toBe("lifecycle_unevaluatable");
    expect(s.records[0].status.denialReason).not.toBe("policy_unevaluatable");
  });

  it("TP-3: a policy denial records denied + the evaluator's own reason, and issues zero fetches (S-US3.1)", async () => {
    const s = spySink();
    await callTool(
      registryOf(tool({ policyRules: [{ id: "treasury-baseline", allow: ["user:alice"] }] })),
      "bank.list",
      {},
      { auditSink: s.sink, fetchImpl: forbiddenFetch, caller: { principal: "user:bob" } },
    );
    expect(s.records).toHaveLength(1);
    expect(s.records[0].status.phase).toBe("denied");
    expect(s.records[0].status.denialReason).toBe("principal_not_allowed");
    expect(s.records[0].spec.principal).toBe("user:bob");
    expect(s.records[0].spec.policyRuleIds).toEqual(["treasury-baseline"]); // S-US10.4
  });

  it("TP-3: all four policy reason codes reach the record verbatim (S-US3.2)", async () => {
    const cases: [IRTool, InvokeOptions, string][] = [
      [tool({ policies: ["authenticated"] }), {}, "authenticated_no_credential"],
      [tool({ policyRules: [{ id: "p", allow: ["user:alice"] }] }), { caller: { principal: "user:bob" } }, "principal_not_allowed"],
      [tool({ policyRules: [{ id: "p", deny: ["user:bob"] }] }), { caller: { principal: "user:bob" } }, "principal_denied"],
      [tool({ policyRules: [{ id: "p", futureKey: 1 } as never] }), {}, "policy_unevaluatable"],
    ];
    for (const [t, opts, expected] of cases) {
      const s = spySink();
      await callTool(registryOf(t), "bank.list", {}, { ...opts, auditSink: s.sink, fetchImpl: forbiddenFetch });
      expect(s.records).toHaveLength(1);
      expect(s.records[0].status.denialReason).toBe(expected);
    }
  });

  it("TP-3: an anonymous denial omits the principal key; an explicit \"\" is recorded as present (S-US3.9, S-US3.10)", async () => {
    const t = tool({ policyRules: [{ id: "p", allow: ["user:alice"] }] });
    const anon = spySink();
    await callTool(registryOf(t), "bank.list", {}, { auditSink: anon.sink, fetchImpl: forbiddenFetch });
    expect("principal" in anon.records[0].spec).toBe(false);

    const empty = spySink();
    await callTool(registryOf(t), "bank.list", {}, { auditSink: empty.sink, fetchImpl: forbiddenFetch, caller: { principal: "" } });
    expect(empty.records[0].spec.principal).toBe("");
    expect(empty.records[0].status.denialReason).toBe("principal_not_allowed");
  });

  it("TP-4: an unbound capability records failed with the shipped message and zero fetches (S-US4.1)", async () => {
    const s = spySink();
    const fetchSpy = vi.fn(ok200);
    // A credential IS supplied: `banking.generate-statement` declares `policies:[authenticated]`,
    // so without one the attempt would terminate one gate earlier, at TP-3.
    await callTool(bankRegistry, "banking.generate-statement", {}, { auditSink: s.sink, fetchImpl: fetchSpy, caller: { accessToken: "caller-token-7d1e" } });
    expect(s.records).toHaveLength(1);
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.records[0].status.message).toBe("capability 'banking.generate-statement' has no connector");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("TP-5: a missing env var records failed with the verbatim text (S-US4.2)", async () => {
    const s = spySink();
    await callTool(bankRegistry, "banking_list-accounts", {}, {
      auditSink: s.sink,
      env: {},
      fetchImpl: forbiddenFetch,
      caller: { accessToken: "caller-token-7d1e" },
    });
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.records[0].status.message).toContain("missing env var(s): CORE_BANKING_URL");
  });

  it("TP-6: a missing caller credential records FAILED, not denied — no policy refused it (S-US4.3)", async () => {
    const s = spySink();
    // `policies` cleared so the `authenticated` gate does not fire: the binding still needs
    // ${caller.accessToken}, so invokeRest fails closed on the placeholder.
    const t = tool({
      policies: [],
      connector: { type: "rest", rest: { baseUrl: "https://core.example", method: "GET", path: "/a", headers: { Authorization: "Bearer ${caller.accessToken}" } } },
    });
    await callTool(registryOf(t), "bank.list", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.records[0].status.message).toContain("missing caller credential(s)");
    expect(s.records[0].status.denialReason).toBeUndefined();
  });

  it("TP-9: an allowlist rejection records failed, with zero fetches (S-US4.4)", async () => {
    const s = spySink();
    const t = tool({
      connector: { type: "rest", rest: { baseUrl: "https://${caller.tenantId}.core.example", method: "GET", path: "/a" } },
    });
    await callTool(registryOf(t), "bank.list", {}, {
      auditSink: s.sink,
      fetchImpl: forbiddenFetch,
      caller: { tenantId: "tenant-a" },
      allowedHosts: [],
    });
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.records[0].status.message).toContain("allowlist");
  });

  it("TP-9: the resolved ${caller.tenantId} host does NOT survive into the emitted bytes (BF-1, BR-36, BR-39, S-US5.7)", async () => {
    // The reviewer's proof: `resolveCaller` substitutes the RESOLVED tenantId into the
    // allowlist-rejection error text (providers/rest/src/index.ts), and that text becomes
    // status.message verbatim (BR-15). A scrub keyed only to `accessToken` never saw it. This is
    // a byte-search over the exact bytes a JSON Lines sink would write, on a caller that supplies
    // ONLY tenantId — no accessToken at all — so nothing else could coincidentally scrub it.
    const t = tool({
      connector: { type: "rest", rest: { baseUrl: "https://${caller.tenantId}.core.example", method: "GET", path: "/a" } },
    });

    // Proof the value really was in play: the SAME call, made directly against invokeRest (no
    // audit layer at all), demonstrably embeds the resolved host in its raw error text —
    // otherwise the negative assertion below would be vacuous.
    const raw = await invokeRest(t, {}, { fetchImpl: forbiddenFetch, caller: { tenantId: "tenant-a" }, allowedHosts: [] });
    expect(raw.error).toContain("tenant-a.core.example");

    const s = spySink();
    await callTool(registryOf(t), "bank.list", {}, {
      auditSink: s.sink,
      fetchImpl: forbiddenFetch,
      caller: { tenantId: "tenant-a" },
      allowedHosts: [],
    });
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.lines[0]).not.toContain("tenant-a");
  });

  it("TP-10: a missing required path parameter records failed (S-US4.5)", async () => {
    const s = spySink();
    const t = tool({
      connector: { type: "rest", rest: { baseUrl: "https://core.example", method: "GET", path: "/accounts/{accountId}" } },
    });
    await callTool(registryOf(t), "bank.list", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.records[0].status.message).toContain("missing required path parameter(s)");
  });

  it("TP-11: a network failure records failed, with completedAt present (S-US4.6)", async () => {
    const s = spySink();
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await callTool(registryOf(tool()), "bank.list", {}, { auditSink: s.sink, fetchImpl });
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.records[0].status.message).toBe("request failed (error code unknown)");
    expect(s.records[0].metadata.completedAt).toBeTruthy();
  });

  it("TP-12: a non-2xx round trip records failed, and onResponse fires independently (S-US4.7, EC-12, BR-33)", async () => {
    const s = spySink();
    const hookCalls: unknown[] = [];
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 503 });
    await callTool(registryOf(tool()), "bank.list", {}, {
      auditSink: s.sink,
      fetchImpl,
      onResponse: (info) => void hookCalls.push(info),
    });
    expect(s.records).toHaveLength(1);
    expect(s.records[0].status.phase).toBe("failed");
    expect(hookCalls).toHaveLength(1);
  });

  it("TP-13/TP-14/TP-15: violation is failed, degraded is SUCCEEDED, ok is succeeded (S-US4.8, BR-17)", async () => {
    // `totalMatches` present throughout — this test isolates `response:`'s own
    // required/degraded behavior; extract:'s (totalMatches) is covered separately.
    const body = (stay: Record<string, unknown>): FetchLike => async () =>
      new Response(JSON.stringify({ stays: [stay], totalMatches: 1 }), { status: 200 });
    const env = { STAYS_API_URL: "https://x.test" };

    const violation = spySink();
    await callTool(tourismRegistry, "tourism_search", { destination: "Nice" }, {
      auditSink: violation.sink, env, fetchImpl: body({ name: "Azur" }), // location/pricePerNight missing (required)
    });
    expect(violation.records[0].status.phase).toBe("failed");
    expect(violation.records[0].status.message).toContain("contract violation: capability 'tourism.search'");

    const degraded = spySink();
    await callTool(tourismRegistry, "tourism_search", { destination: "Nice" }, {
      auditSink: degraded.sink, env, fetchImpl: body({ name: "Azur", location: "Nice", pricePerNight: 118 }), // rating optional
    });
    expect(degraded.records[0].status.phase).toBe("succeeded");
    expect(degraded.records[0].status.message).toBeUndefined();

    const okRun = spySink();
    await callTool(tourismRegistry, "tourism_search", { destination: "Nice" }, {
      auditSink: okRun.sink, env, fetchImpl: body({ name: "Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }),
    });
    expect(okRun.records[0].status.phase).toBe("succeeded");
  });

  it("never emits pending or running, and never populates status.output (S-US2.4, BR-19, D-7)", async () => {
    const s = spySink();
    const env = { CORE_BANKING_URL: "https://core.example" };
    const secretBody: FetchLike = async () =>
      new Response(JSON.stringify({ accounts: [{ iban: "account-number-4111111111111111" }] }), { status: 200 });
    await callTool(bankRegistry, "banking_list-accounts", {}, { auditSink: s.sink, env, fetchImpl: secretBody, caller: { accessToken: "caller-token-7d1e" } });
    await callTool(registryOf(tool({ lifecycle: "retired" })), "bank.list", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    expect(new Set(s.records.map((r) => r.status.phase))).toEqual(new Set(["succeeded", "denied"]));
    // `ExecutionStatus` does not even declare `output` — read through a cast for that reason.
    for (const r of s.records) expect(Object.keys(r.status)).not.toContain("output");
    // S-US5.6: no response payload anywhere in the record.
    expect(s.lines.join("")).not.toContain("account-number-4111111111111111");
  });

  it("every record from every termination point validates against the compiled schema (S-US2.1, BR-7)", async () => {
    const s = spySink();
    const env = { CORE_BANKING_URL: "https://core.example" };
    await callTool(registryOf(tool({ lifecycle: "retired" })), "bank.list", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    await callTool(registryOf(tool({ policies: ["authenticated"] })), "bank.list", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    await callTool(bankRegistry, "banking.generate-statement", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    await callTool(bankRegistry, "banking_list-accounts", {}, { auditSink: s.sink, env: {}, fetchImpl: forbiddenFetch, caller: { accessToken: "caller-token-7d1e" } });
    await callTool(bankRegistry, "banking_list-accounts", {}, { auditSink: s.sink, env, fetchImpl: ok200, caller: { accessToken: "caller-token-7d1e" } });
    await callTool(tourismRegistry, "tourism_search", { destination: "Nice" }, {
      auditSink: s.sink,
      env: { STAYS_API_URL: "https://x.test" },
      fetchImpl: async () => new Response(JSON.stringify({ stays: [{ name: "Azur" }] }), { status: 200 }),
    });
    expect(s.records).toHaveLength(6);
    for (const r of s.records) expect(validateExecution(r)).toEqual({ ok: true, errors: "" });
  });
});

// ADD-44 Amendment 2 (archstone#34): `status.reachedConnector` disambiguates the billable/
// non-billable split inside `phase: "failed"` — present and `false` for every pre-dispatch
// short-circuit and the network-exception branch (none of which received a response), `true`
// for a non-2xx response and for a contract violation (both received one).
describe("callTool — status.reachedConnector (ADD-44 Amendment 2, archstone#34)", () => {
  it("false — unbound capability, no REST connector (TP-4)", async () => {
    const s = spySink();
    await callTool(bankRegistry, "banking.generate-statement", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch, caller: { accessToken: "caller-token-7d1e" } });
    expect(s.records[0].status).toMatchObject({ phase: "failed", reachedConnector: false });
  });

  it("false — missing env var (TP-5)", async () => {
    const s = spySink();
    await callTool(bankRegistry, "banking_list-accounts", {}, { auditSink: s.sink, env: {}, fetchImpl: forbiddenFetch, caller: { accessToken: "caller-token-7d1e" } });
    expect(s.records[0].status).toMatchObject({ phase: "failed", reachedConnector: false });
  });

  it("false — missing caller credential (TP-6)", async () => {
    const s = spySink();
    const t = tool({
      policies: [],
      connector: { type: "rest", rest: { baseUrl: "https://core.example", method: "GET", path: "/a", headers: { Authorization: "Bearer ${caller.accessToken}" } } },
    });
    await callTool(registryOf(t), "bank.list", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    expect(s.records[0].status).toMatchObject({ phase: "failed", reachedConnector: false });
  });

  it("false — missing required path parameter (TP-10)", async () => {
    const s = spySink();
    const t = tool({
      connector: { type: "rest", rest: { baseUrl: "https://core.example", method: "GET", path: "/accounts/{accountId}" } },
    });
    await callTool(registryOf(t), "bank.list", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    expect(s.records[0].status).toMatchObject({ phase: "failed", reachedConnector: false });
  });

  it("false — a network-level exception before any response arrives (TP-11) — D-13's deliberate grouping with pre-dispatch causes (R-13)", async () => {
    const s = spySink();
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    await callTool(registryOf(tool()), "bank.list", {}, { auditSink: s.sink, fetchImpl });
    expect(s.records[0].status).toMatchObject({ phase: "failed", reachedConnector: false });
  });

  it("true — a non-2xx response WAS received from the connector (TP-12)", async () => {
    const s = spySink();
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 503 });
    await callTool(registryOf(tool()), "bank.list", {}, { auditSink: s.sink, fetchImpl });
    expect(s.records[0].status).toMatchObject({ phase: "failed", reachedConnector: true });
  });

  it("true — a contract violation, unconditionally: reachable only after invokeRest returned ok:true (TP-13)", async () => {
    const ir: IR = {
      version: "0",
      company: { id: "acme" },
      resources: { "acme.Account": [{ name: "iban", required: true, type: { kind: "scalar", semantic: "identifier" } }] },
      tools: [
        tool({
          output: [{ name: "account", required: true, type: { kind: "resource", name: "acme.Account" } }],
          response: { resource: "acme.Account", field: "account", fields: [{ name: "iban", path: "$.iban" }] },
        }),
      ],
    };
    const registry = new Registry(ir);
    const s = spySink();
    // The body omits `iban` — the mapping's required field — so applyResponseMapping returns
    // VIOLATION, even though the connector plainly answered with a 200.
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({}), { status: 200 });
    await callTool(registry, "bank.list", {}, { auditSink: s.sink, fetchImpl });
    expect(s.records[0].status.message).toContain("contract violation");
    expect(s.records[0].status).toMatchObject({ phase: "failed", reachedConnector: true });
  });

  it("absent on succeeded and on denied — a constant carries no information (D-14)", async () => {
    const succeeded = spySink();
    await callTool(bankRegistry, "banking_list-accounts", {}, {
      auditSink: succeeded.sink,
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: ok200,
      caller: { accessToken: "caller-token-7d1e" },
    });
    expect("reachedConnector" in succeeded.records[0].status).toBe(false);

    const denied = spySink();
    await callTool(registryOf(tool({ lifecycle: "retired" })), "bank.list", {}, { auditSink: denied.sink, fetchImpl: forbiddenFetch });
    expect("reachedConnector" in denied.records[0].status).toBe(false);
  });

  it("every reachedConnector case above validates against the compiled schema", async () => {
    const s = spySink();
    await callTool(bankRegistry, "banking.generate-statement", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch, caller: { accessToken: "caller-token-7d1e" } });
    await callTool(registryOf(tool()), "bank.list", {}, { auditSink: s.sink, fetchImpl: async () => new Response("nope", { status: 503 }) });
    await callTool(registryOf(tool({ lifecycle: "retired" })), "bank.list", {}, { auditSink: s.sink, fetchImpl: forbiddenFetch });
    expect(s.records).toHaveLength(3);
    for (const r of s.records) expect(validateExecution(r)).toEqual({ ok: true, errors: "" });
  });
});

describe("callTool — the record's identity fields (BR-4, BR-20, BR-22)", () => {
  it("fixes consumer to \"mcp\" and ignores a host that tries to set one (BR-4, S-US1.6)", async () => {
    const s = spySink();
    const hostBag = { auditSink: s.sink, fetchImpl: ok200, consumer: "spoofed" } as unknown as InvokeOptions;
    await callTool(registryOf(tool()), "bank.list", {}, hostBag);
    expect(s.records[0].spec.consumer).toBe("mcp");
  });

  it("records the UNSANITIZED CDL id even when invoked under the sanitized name (S-US2.7, BR-20)", async () => {
    const s = spySink();
    await callTool(bankRegistry, "banking_list-accounts", {}, {
      auditSink: s.sink,
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: ok200,
      caller: { accessToken: "caller-token-7d1e" },
    });
    expect(s.records[0].metadata.capabilityId).toBe("banking.list-accounts");
    expect(s.records[0].metadata.provider).toBe("core-banking");
  });

  it("gives twenty concurrent identical invocations twenty distinct ids (S-US2.6, EC-18)", async () => {
    const s = spySink();
    await Promise.all(
      Array.from({ length: 20 }, () =>
        callTool(registryOf(tool()), "bank.list", { same: "input" }, { auditSink: s.sink, fetchImpl: ok200 }),
      ),
    );
    expect(s.records).toHaveLength(20);
    expect(new Set(s.records.map((r) => r.metadata.id)).size).toBe(20);
  });

  it("passes sessionId/workflowId through and omits them otherwise (BR-23, S-US2.8)", async () => {
    const withIds = spySink();
    await callTool(registryOf(tool()), "bank.list", {}, {
      auditSink: withIds.sink, fetchImpl: ok200, sessionId: "sess-1", workflowId: "wf-1",
    });
    expect(withIds.records[0].metadata.sessionId).toBe("sess-1");
    expect(withIds.records[0].metadata.workflowId).toBe("wf-1");

    const without = spySink();
    await callTool(registryOf(tool()), "bank.list", {}, { auditSink: without.sink, fetchImpl: ok200 });
    expect("sessionId" in without.records[0].metadata).toBe(false);
  });
});

// The strongest guarantee in this increment. Not a field walk: a substring search over the
// bytes a sink would write, on all three phases, because they are built on different branches.
describe("callTool — the audit log cannot leak the credential it audited (US-5, BR-38)", () => {
  const TOKEN = "SUPER-SECRET-TOKEN-9f3a";
  const env = { CORE_BANKING_URL: "https://core.example" };

  it("succeeded: the shipped banking.list-accounts binding puts the token in an Authorization header; it appears nowhere in the emitted line (S-US5.1)", async () => {
    const s = spySink();
    const sentAuth: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      sentAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    };
    await callTool(bankRegistry, "banking_list-accounts", {}, { auditSink: s.sink, env, fetchImpl, caller: { accessToken: TOKEN } });
    // Proof the token really was in play on this call — otherwise the assertion below is vacuous.
    expect(sentAuth).toEqual([`Bearer ${TOKEN}`]);
    expect(s.records[0].status.phase).toBe("succeeded");
    expect(s.lines[0]).not.toContain(TOKEN);
  });

  it("denied: the token appears nowhere (S-US5.2)", async () => {
    const s = spySink();
    const denyingRegistry = registryOf(
      tool({
        id: "banking.list-accounts",
        policyRules: [{ id: "p", allow: ["user:alice"] }],
        connector: { type: "rest", rest: { baseUrl: "${CORE_BANKING_URL}", method: "GET", path: "/v2/accounts", headers: { Authorization: "Bearer ${caller.accessToken}" } } },
      }),
    );
    await callTool(denyingRegistry, "banking.list-accounts", {}, {
      auditSink: s.sink, env, fetchImpl: forbiddenFetch, caller: { accessToken: TOKEN, principal: "user:mallory" },
    });
    expect(s.records[0].status.phase).toBe("denied");
    expect(s.lines[0]).not.toContain(TOKEN);
  });

  it("failed: the token appears nowhere (S-US5.3)", async () => {
    const s = spySink();
    await callTool(bankRegistry, "banking_list-accounts", {}, {
      auditSink: s.sink, env: {}, fetchImpl: forbiddenFetch, caller: { accessToken: TOKEN },
    });
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.lines[0]).not.toContain(TOKEN);
  });

  it("the token appears nowhere even when the agent smuggles it in as capability input, on all three phases (S-US5.4)", async () => {
    const env2 = { STAYS_API_URL: "https://x.test" };
    const runs: ExecutionRecord[] = [];
    const lines: string[] = [];
    const sink: AuditSink = (r) => {
      runs.push(r);
      lines.push(JSON.stringify(r));
    };
    await callTool(tourismRegistry, "tourism_search", { destination: TOKEN }, {
      auditSink: sink, env: env2, fetchImpl: async () => new Response(JSON.stringify({ stays: [{ name: "A", location: "B", pricePerNight: 1 }], totalMatches: 1 }), { status: 200 }),
      caller: { accessToken: TOKEN },
    });
    await callTool(registryOf(tool({ policyRules: [{ id: "p", allow: ["user:alice"] }] })), "bank.list", { q: TOKEN }, {
      auditSink: sink, fetchImpl: forbiddenFetch, caller: { accessToken: TOKEN, principal: "user:mallory" },
    });
    await callTool(bankRegistry, "banking.generate-statement", { q: TOKEN }, {
      auditSink: sink, env, fetchImpl: forbiddenFetch, caller: { accessToken: TOKEN },
    });
    expect(runs.map((r) => r.status.phase)).toEqual(["succeeded", "denied", "failed"]);
    for (const line of lines) expect(line).not.toContain(TOKEN);
  });

  it("carries no representation of the outbound request — no url, header, query or body (S-US5.5)", async () => {
    const s = spySink();
    await callTool(bankRegistry, "banking_list-accounts", {}, {
      auditSink: s.sink, env, fetchImpl: ok200, caller: { accessToken: TOKEN, tenantId: "tenant-a" },
    });
    const line = s.lines[0];
    for (const leak of ["https://core.example", "/v2/accounts", "Authorization", "Bearer", "tenant-a"]) {
      expect(line).not.toContain(leak);
    }
  });
});

describe("callTool — a broken sink can never break, delay, or be seen by the invocation (US-6)", () => {
  const env = { CORE_BANKING_URL: "https://core.example" };

  async function callWith(sink: AuditSink | undefined) {
    return callTool(bankRegistry, "banking_list-accounts", {}, { auditSink: sink, env, fetchImpl: ok200, caller: { accessToken: "caller-token-7d1e" } });
  }

  it("a throwing sink leaves CallResult byte-identical to the no-sink call (S-US6.1, S-US6.5, BR-32)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const baseline = await callWith(undefined);
    const withThrow = await callWith(() => {
      throw new Error("boom");
    });
    expect(JSON.stringify(withThrow)).toBe(JSON.stringify(baseline));
    expect(JSON.stringify(withThrow)).not.toMatch(/audit|sink/i);
    err.mockRestore();
  });

  it("three throwing invocations produce three stderr lines naming the capability (S-US6.4, BR-31)", async () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    for (let i = 0; i < 3; i += 1) {
      await callWith(() => {
        throw new Error("boom");
      });
    }
    expect(err).toHaveBeenCalledTimes(3);
    for (const call of err.mock.calls) expect(String(call[0])).toContain("banking.list-accounts");
    err.mockRestore();
  });

  it("a sink whose Promise never settles adds no latency (S-US6.3, BR-29)", async () => {
    // The real detector is that this RESOLVES at all: an awaited sink would hang here forever
    // and fail by timeout. The wall clock is a loose secondary guard, deliberately generous so
    // it reports latency rather than CI load.
    const started = Date.now();
    const r = await callWith(() => new Promise<void>(() => {}));
    expect(r.isError).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("a mutating sink corrupts neither the invocation's input nor the next record (S-US6.6, BR-30)", async () => {
    const seen: ExecutionRecord[] = [];
    const vandal: AuditSink = (r) => {
      seen.push(JSON.parse(JSON.stringify(r)) as ExecutionRecord);
      delete (r.spec as Partial<ExecutionRecord["spec"]>).input;
      (r.metadata as Record<string, unknown>).injected = true;
      (r.spec as Record<string, unknown>).principal = "user:attacker";
    };
    const input = { destination: "Nice" };
    const env2 = { STAYS_API_URL: "https://x.test" };
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "A", location: "B", pricePerNight: 1 }], totalMatches: 1 }), { status: 200 });
    for (let i = 0; i < 2; i += 1) {
      const r = await callTool(tourismRegistry, "tourism_search", input, { auditSink: vandal, env: env2, fetchImpl });
      expect(r.isError).toBe(false);
    }
    expect(input).toEqual({ destination: "Nice" }); // the invoked input is untouched
    expect(seen).toHaveLength(2);
    expect(validateExecution(seen[1])).toEqual({ ok: true, errors: "" }); // the second is complete
  });

  it("an onResponse hook and a sink coexist, each behaving as it does alone (S-US6.7, BR-33)", async () => {
    const s = spySink();
    type HookInfo = { capabilityId: string; status: number; data: unknown; durationMs: number };
    const hook: HookInfo[] = [];
    const solo: HookInfo[] = [];
    const env2 = { STAYS_API_URL: "https://x.test" };
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "A", location: "B", pricePerNight: 1, rating: 4 }] }), { status: 200 });
    const both = await callTool(tourismRegistry, "tourism_search", { destination: "Nice" }, {
      auditSink: s.sink, env: env2, fetchImpl, onResponse: (i) => void hook.push(i),
    });
    const alone = await callTool(tourismRegistry, "tourism_search", { destination: "Nice" }, {
      env: env2, fetchImpl, onResponse: (i) => void solo.push(i),
    });
    expect(hook).toHaveLength(1);
    expect(solo).toHaveLength(1);
    expect(s.records).toHaveLength(1);
    // The CallResult carries no timing, so whole-object equality is the right assertion there.
    expect(JSON.stringify(both)).toBe(JSON.stringify(alone));
    // The hook's payload does: #39's info shape is {capabilityId, status, data, durationMs}, and
    // `durationMs` measures two DIFFERENT invocations here — it is supposed to vary. Comparing
    // the whole object would pass only when both calls land in the same millisecond, and would
    // drown BR-33's actual property (the hook observes the same thing whether or not a sink is
    // attached) in a field that can only ever be equal by luck. So: everything except the
    // duration must match exactly…
    const withoutDuration = ({ durationMs: _d, ...rest }: HookInfo): Omit<HookInfo, "durationMs"> => rest;
    expect(withoutDuration(hook[0])).toEqual(withoutDuration(solo[0]));
    // …and the duration must be present and well-formed on both, which is the part of the
    // payload's shape non-interference can actually assert.
    for (const info of [hook[0], solo[0]]) {
      expect(typeof info.durationMs).toBe("number");
      expect(Number.isFinite(info.durationMs)).toBe(true);
      expect(info.durationMs).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("no sink is a strict no-op (US-9, BR-34)", () => {
  it("builds no record: no clock is read and no id is generated (S-US9.2)", async () => {
    const clock = vi.spyOn(Date.prototype, "toISOString");
    const uuid = vi.spyOn(globalThis.crypto, "randomUUID");
    const r = await callTool(bankRegistry, "banking_list-accounts", {}, {
      env: { CORE_BANKING_URL: "https://core.example" },
      fetchImpl: ok200,
      caller: { accessToken: "caller-token-7d1e" },
    });
    expect(r.isError).toBe(false);
    expect(clock).not.toHaveBeenCalled();
    expect(uuid).not.toHaveBeenCalled();
    clock.mockRestore();
    uuid.mockRestore();
  });

  it("and does read them when a sink IS configured — the negative control", async () => {
    const clock = vi.spyOn(Date.prototype, "toISOString");
    const s = spySink();
    await callTool(registryOf(tool()), "bank.list", {}, { auditSink: s.sink, fetchImpl: ok200 });
    expect(clock).toHaveBeenCalled();
    clock.mockRestore();
  });
});

describe("createHttpHandler — the sink survives the per-request options rebuild (SF-5, S-US1.4, EC-10)", () => {
  function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
    return new Request("http://test.local/mcp", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
      body: JSON.stringify(body),
    });
  }

  it("emits a record with an ABSENT principal when no resolveCaller is wired (unlike `caller`, which is clobbered)", async () => {
    const s = spySink();
    const handler = createHttpHandler(bankRegistry, {
      bearerToken: "endpoint-secret",
      invoke: {
        auditSink: s.sink,
        sessionId: "process-wide-session",
        env: { CORE_BANKING_URL: "https://core.example" },
        fetchImpl: ok200,
        caller: { accessToken: "ignored-because-clobbered", principal: "user:ignored" },
      },
    });
    const res = await handler(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "banking_list-accounts", arguments: {} } }, { authorization: "Bearer endpoint-secret" }),
    );
    expect(res.status).toBe(200);
    expect(s.records).toHaveLength(1);
    expect(s.records[0].spec.consumer).toBe("mcp");
    // `caller` was clobbered by the rebuild, so the capability had no credential and the record
    // has no principal — while the sink and the sessionId rode through untouched.
    expect("principal" in s.records[0].spec).toBe(false);
    expect(s.records[0].metadata.sessionId).toBe("process-wide-session");
  });
});

describe("the contract prober emits nothing (US-8, BR-6, EC-17)", () => {
  const contractTool = (fixture: string, over: Partial<IRTool> = {}): IRTool =>
    tool({ id: "bank.list", contract: { fingerprint: "sha256:x", probeFixture: fixture }, ...over });

  /** A probe that actually RUNS — the case that reaches `invokeRest` with the same bag. */
  function withFixture(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "archstone-audit-verify-"));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ capabilityId: "bank.list", request: {} }));
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it("verifyTool emits no record on ANY outcome, even when handed the identical bag it forwards into invokeRest (S-US8.1…S-US8.3)", async () => {
    const s = spySink();
    const bag: InvokeOptions = { auditSink: s.sink, fetchImpl: forbiddenFetch };
    await verifyTool(contractTool("nope.json"), here, {}, bag); // fixture missing → red
    await verifyTool(contractTool("nope.json", { policyRules: [{ id: "p", allow: ["user:alice"] }] }), here, {}, bag); // policy-denied
    await verifyTool(tool(), here, {}, bag); // no contract declared
    // …and the one that genuinely completes a round trip, both green-ish and failing.
    await withFixture(async (dir) => {
      const green = await verifyTool(contractTool("fixture.json"), dir, {}, { auditSink: s.sink, fetchImpl: ok200 });
      expect(green.status).toBeDefined();
      await verifyTool(contractTool("fixture.json"), dir, {}, {
        auditSink: s.sink,
        fetchImpl: async () => new Response("boom", { status: 500 }),
      });
    });
    expect(s.records).toHaveLength(0);
  });

  it("runVerify emits nothing while callTool with the SAME bag emits exactly one (S-US8.4)", async () => {
    const s = spySink();
    const bag: InvokeOptions = { auditSink: s.sink, fetchImpl: ok200 };
    const reg = registryOf(contractTool("nope.json"));
    await runVerify([contractTool("nope.json")], here, {}, bag);
    expect(s.records).toHaveLength(0);
    await callTool(reg, "bank.list", {}, bag);
    expect(s.records).toHaveLength(1);
  });
});
