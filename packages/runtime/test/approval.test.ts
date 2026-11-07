import { describe, it, expect } from "vitest";
import { validateExecution } from "@archstone/schema";
import type { IR, IRDecisionGate, IRTool } from "@archstone/compiler";
import {
  Registry,
  InMemoryRateLimitCounter,
  type ApprovalRequest,
  type ApprovalResolver,
  type AuditSink,
  type ExecutionRecord,
} from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { callTool, POLICY_DENIED_META_KEY, INPUT_INVALID_META_KEY } from "../src/server";

// archstone#165 / ADD-393 — `callTool`'s decision-gate step: the binding-declared ask to the
// deployer's endpoint, after the rate limit and strictly before the connector. Every case below
// is one of ADD-393 §12's acceptance criteria, or one of the §2/§4/§7/§8/§9 rules behind them.
// The fetch fake routes by URL so the ask and the connector call are counted separately: "zero
// connector requests" and "no ask sent" are two different claims and each is asserted on its own.

const APPROVALS = "https://approvals.example";
const CONSENTS = "https://consents.example";
const CORE = "https://core.example";
const ENV = { APPROVALS_TOKEN: "s3cret" };
const CALLER = { principal: "user-17" };

function gate(baseUrl: string, input: string, over: Partial<IRDecisionGate["ask"]> = {}): IRDecisionGate {
  return {
    input,
    ask: { baseUrl, path: "/consume", headers: { Authorization: "Bearer ${APPROVALS_TOKEN}" }, ...over },
  };
}

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: "banking.initiate-transfer",
    description: "Initiate a transfer.",
    effect: "irreversible",
    provider: "core",
    policies: ["human-approval"],
    lifecycle: "stable",
    input: [
      { name: "approval", required: true, type: { kind: "resource", name: "Approval", identity: true } },
      { name: "beneficiary", required: true, type: { kind: "scalar", semantic: "identifier" } },
      { name: "amount", required: false, type: { kind: "scalar", semantic: "money" } },
      { name: "memo", required: false, type: { kind: "scalar", semantic: "string" } },
    ],
    output: [],
    connector: { type: "rest", rest: { baseUrl: CORE, method: "POST", path: "/v2/transfers" } },
    approval: gate(APPROVALS, "approval"),
    ...over,
  };
}

function registryOf(...tools: IRTool[]): Registry {
  const ir: IR = { version: "0", company: { id: "acme" }, tools, resources: {} };
  return new Registry(ir);
}

const ARGS = { approval: "APR-2026-0042", beneficiary: "BEN-9" };

interface Ask {
  url: string;
  method: string | undefined;
  redirect: string | undefined;
  headers: Record<string, string>;
  body: ApprovalRequest;
}

type Endpoint = (body: ApprovalRequest) => Response | Promise<Response>;

const answer = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

/** A fetch that routes by URL: asks to the approvals/consents hosts, the connector to CORE. */
function harness(endpoints: { approval?: Endpoint; consent?: Endpoint } = {}) {
  const asks: Ask[] = [];
  const consentAsks: Ask[] = [];
  const connectorCalls: string[] = [];
  const order: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    const record = (): Ask => ({
      url,
      method: init?.method,
      redirect: init?.redirect,
      headers: { ...(init?.headers as Record<string, string>) },
      body: JSON.parse(String(init?.body)) as ApprovalRequest,
    });
    if (url.startsWith(APPROVALS)) {
      const a = record();
      asks.push(a);
      order.push("approval");
      if (!endpoints.approval) throw new Error("no approval endpoint in this test");
      return endpoints.approval(a.body);
    }
    if (url.startsWith(CONSENTS)) {
      const a = record();
      consentAsks.push(a);
      order.push("consent");
      if (!endpoints.consent) throw new Error("no consent endpoint in this test");
      return endpoints.consent(a.body);
    }
    if (url.startsWith(CORE)) {
      connectorCalls.push(url);
      order.push("connector");
      return answer({ transferId: "T-1" });
    }
    throw new Error(`unexpected request to ${url}`);
  };
  return { fetchImpl, asks, consentAsks, connectorCalls, order };
}

const allowed: Endpoint = (b) => answer({ approvalId: b.approvalId, outcome: "allowed", reference: "SN-CHG0042" });
const pending: Endpoint = (b) => answer({ approvalId: b.approvalId, outcome: "pending" });
const refused: Endpoint = (b) => answer({ approvalId: b.approvalId, outcome: "refused", reason: "ENDPOINT-FREE-TEXT" });

function spySink(): { sink: AuditSink; records: ExecutionRecord[] } {
  const records: ExecutionRecord[] = [];
  return { sink: (r) => void records.push(r), records };
}

const policyReason = (r: Awaited<ReturnType<typeof callTool>>): unknown =>
  (r._meta?.[POLICY_DENIED_META_KEY] as { reason?: unknown } | undefined)?.reason;

describe("no gate → fail-closed (ADD-393 D-8, §12 AC 1)", () => {
  it("a declared human-approval with no approval: block is policy_unevaluatable with ZERO requests of any kind", async () => {
    const h = harness({ approval: allowed });
    const r = await callTool(registryOf(tool({ approval: undefined })), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
    });
    expect(r.isError).toBe(true);
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toEqual({
      error: "policy_denied",
      capability: "banking.initiate-transfer",
      reason: "policy_unevaluatable",
    });
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("the record of a no-gate refusal carries no decisionReferences (no ask was sent)", async () => {
    const h = harness({ approval: allowed });
    const s = spySink();
    await callTool(registryOf(tool({ approval: undefined })), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(s.records).toHaveLength(1);
    expect(s.records[0].status.phase).toBe("denied");
    expect(s.records[0].status.decisionReferences).toBeUndefined();
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });
});

describe("allowed with a reference → executes (§12 AC 2)", () => {
  it("calls the connector exactly once, after exactly one ask", async () => {
    const h = harness({ approval: allowed });
    const r = await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
    });
    expect(r.isError).toBe(false);
    expect(h.asks).toHaveLength(1);
    expect(h.connectorCalls).toEqual([`${CORE}/v2/transfers`]);
    expect(h.order).toEqual(["approval", "connector"]);
  });

  it("the ask is one POST to the static path, redirect manual, the Authorization secret resolved", async () => {
    const h = harness({ approval: allowed });
    await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    const [ask] = h.asks;
    expect(ask.url).toBe(`${APPROVALS}/consume`);
    expect(ask.method).toBe("POST");
    expect(ask.redirect).toBe("manual");
    expect(ask.headers.Authorization).toBe("Bearer s3cret");
  });

  it("the record carries status.decisionReferences and validates against the execution schema", async () => {
    const h = harness({ approval: allowed });
    const s = spySink();
    await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(s.records).toHaveLength(1);
    const rec = s.records[0];
    expect(rec.status.phase).toBe("succeeded");
    expect(rec.status.decisionReferences).toEqual({
      "human-approval": { approvalId: "APR-2026-0042", reference: "SN-CHG0042" },
    });
    expect(validateExecution(rec)).toEqual({ ok: true, errors: "" });
  });

  it("a connector failure after allowed records `failed` and still carries the references (burned approval is traceable)", async () => {
    const h = harness({ approval: allowed });
    const s = spySink();
    const failingConnector: FetchLike = async (input, init) =>
      String(input).startsWith(CORE) ? new Response("boom", { status: 500 }) : h.fetchImpl(input, init);
    const r = await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: failingConnector,
      auditSink: s.sink,
    });
    expect(r.isError).toBe(true);
    expect(s.records[0].status.phase).toBe("failed");
    expect(s.records[0].status.decisionReferences).toEqual({
      "human-approval": { approvalId: "APR-2026-0042", reference: "SN-CHG0042" },
    });
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });
});

describe("pending / refused → their own codes, zero connector requests (§12 AC 3, 4; D-6)", () => {
  it("pending → approval_pending, and the message points at checking status", async () => {
    const h = harness({ approval: pending });
    const r = await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(r.isError).toBe(true);
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toEqual({
      error: "policy_denied",
      capability: "banking.initiate-transfer",
      reason: "approval_pending",
    });
    expect(r.content[0].text).toMatch(/still pending — check the approval's status before calling it again/);
    expect(h.asks).toHaveLength(1);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("refused → approval_refused; the endpoint's free text never reaches the agent or the record", async () => {
    const h = harness({ approval: refused });
    const s = spySink();
    const r = await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(policyReason(r)).toBe("approval_refused");
    expect(h.asks).toHaveLength(1);
    expect(h.connectorCalls).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("ENDPOINT-FREE-TEXT");
    expect(JSON.stringify(s.records)).not.toContain("ENDPOINT-FREE-TEXT");
    expect(s.records[0].status).toMatchObject({ phase: "denied", denialReason: "approval_refused" });
    expect(s.records[0].status.decisionReferences).toEqual({ "human-approval": { approvalId: "APR-2026-0042" } });
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("a reference returned with pending/refused is recorded", async () => {
    const h = harness({ approval: (b) => answer({ approvalId: b.approvalId, outcome: "refused", reference: "SN-CHG0099" }) });
    const s = spySink();
    await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, auditSink: s.sink });
    expect(s.records[0].status.decisionReferences).toEqual({
      "human-approval": { approvalId: "APR-2026-0042", reference: "SN-CHG0099" },
    });
  });
});

describe("every non-answer → policy_unevaluatable, never a refusal (§12 AC 5, D-5)", () => {
  const cases: [string, Endpoint, Partial<IRDecisionGate["ask"]>?][] = [
    ["404", () => new Response("no such approval ENDPOINT-FREE-TEXT", { status: 404 })],
    ["500", () => new Response("ENDPOINT-FREE-TEXT", { status: 500 })],
    ["302 redirect", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/consume" } })],
    ["wrong echo", () => answer({ approvalId: "APR-OTHER", outcome: "allowed", reference: "SN-1" })],
    ["missing echo", () => answer({ outcome: "allowed", reference: "SN-1" })],
    [
      "oversize body (> 64 KiB, otherwise a valid allowed)",
      (b) => answer({ approvalId: b.approvalId, outcome: "allowed", reference: "SN-1", pad: "x".repeat(64 * 1024) }),
    ],
    ["unparsable JSON", () => new Response("{ not json", { status: 200 })],
    ["unknown outcome", (b) => answer({ approvalId: b.approvalId, outcome: "approved", reference: "SN-1" })],
    ["allowed without a reference", (b) => answer({ approvalId: b.approvalId, outcome: "allowed" })],
    ["allowed with a reference containing a space", (b) => answer({ approvalId: b.approvalId, outcome: "allowed", reference: "SN 1" })],
    ["network error", () => Promise.reject(new TypeError("fetch failed"))],
  ];

  for (const [name, endpoint] of cases) {
    it(`${name} → policy_unevaluatable, zero connector requests, record carries approvalId only`, async () => {
      const h = harness({ approval: endpoint });
      const s = spySink();
      const r = await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, {
        env: ENV,
        caller: CALLER,
        fetchImpl: h.fetchImpl,
        auditSink: s.sink,
      });
      expect(r.isError).toBe(true);
      expect(policyReason(r)).toBe("policy_unevaluatable");
      expect(h.asks).toHaveLength(1);
      expect(h.connectorCalls).toHaveLength(0);
      expect(JSON.stringify(r)).not.toContain("ENDPOINT-FREE-TEXT");
      expect(s.records).toHaveLength(1);
      expect(s.records[0].status).toMatchObject({ phase: "denied", denialReason: "policy_unevaluatable" });
      expect(s.records[0].status.decisionReferences).toEqual({ "human-approval": { approvalId: "APR-2026-0042" } });
      expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
    });
  }

  it("timeout (timeoutSeconds 1, an ask that never resolves) → policy_unevaluatable, zero connector requests", async () => {
    const h = harness({ approval: () => new Promise<Response>(() => undefined) });
    const s = spySink();
    const t0 = Date.now();
    const r = await callTool(registryOf(tool({ approval: gate(APPROVALS, "approval", { timeoutSeconds: 1 }) })), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(h.asks).toHaveLength(1);
    expect(h.connectorCalls).toHaveLength(0);
    expect(JSON.stringify(r)).not.toContain("s3cret");
    expect(s.records[0].status.decisionReferences).toEqual({ "human-approval": { approvalId: "APR-2026-0042" } });
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  }, 10_000);

  it("a non-loopback http: baseUrl → policy_unevaluatable, nothing sent", async () => {
    const h = harness({ approval: allowed });
    const plain = tool({ approval: gate("http://approvals.example", "approval") });
    const r = await callTool(registryOf(plain), "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("an empty or unset Authorization secret → policy_unevaluatable, nothing sent (§5)", async () => {
    for (const env of [{ APPROVALS_TOKEN: "" }, {}]) {
      const h = harness({ approval: allowed });
      const r = await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env, caller: CALLER, fetchImpl: h.fetchImpl });
      expect(policyReason(r)).toBe("policy_unevaluatable");
      expect(h.asks).toHaveLength(0);
      expect(h.connectorCalls).toHaveLength(0);
    }
  });

  it("an ask refused before it was sent leaves no decisionReferences on the record (§7: written whenever the ask was SENT)", async () => {
    const h = harness({ approval: allowed });
    const s = spySink();
    await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env: {}, caller: CALLER, fetchImpl: h.fetchImpl, auditSink: s.sink });
    expect(h.asks).toHaveLength(0);
    expect(s.records).toHaveLength(1);
    expect(s.records[0].status.decisionReferences).toBeUndefined();
  });
});

describe("principal (§8)", () => {
  it("irreversible + no principal → policy_unevaluatable, and no ask is sent", async () => {
    const h = harness({ approval: allowed });
    const s = spySink();
    const r = await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, {
      env: ENV,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(r.content[0].text).toMatch(/needs an identified caller for its approval/);
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
    // No ask was sent, so nothing to trace.
    expect(s.records[0].status.decisionReferences).toBeUndefined();
  });

  it("a write capability with no principal → the ask IS sent, with principal: null", async () => {
    const h = harness({ approval: refused });
    const r = await callTool(registryOf(tool({ effect: "write" })), "banking.initiate-transfer", ARGS, {
      env: ENV,
      fetchImpl: h.fetchImpl,
    });
    expect(policyReason(r)).toBe("approval_refused");
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0].body.principal).toBeNull();
    expect(h.asks[0].body.effect).toBe("write");
    expect(h.connectorCalls).toHaveLength(0);
  });
});

describe("the approval id (§4)", () => {
  it("an id containing a space → input_invalid under INPUT_INVALID_META_KEY naming the field path, no ask", async () => {
    const h = harness({ approval: allowed });
    const s = spySink();
    const r = await callTool(registryOf(tool()), "banking.initiate-transfer", { ...ARGS, approval: "APR 2026" }, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(r.isError).toBe(true);
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toBeUndefined();
    const meta = r._meta?.[INPUT_INVALID_META_KEY] as { error: string; capability: string; problems: { path: string; expected: string }[] };
    expect(meta.error).toBe("input_invalid");
    expect(meta.capability).toBe("banking.initiate-transfer");
    expect(meta.problems.map((p) => p.path)).toEqual(["approval"]);
    // Never the value.
    expect(JSON.stringify(r)).not.toContain("APR 2026");
    expect(s.records[0].status).toMatchObject({ phase: "denied", denialReason: "input_invalid" });
    expect(s.records[0].status.decisionReferences).toBeUndefined();
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("an id of 257 characters → input_invalid; 256 is accepted", async () => {
    const h = harness({ approval: allowed });
    const long = await callTool(registryOf(tool()), "banking.initiate-transfer", { ...ARGS, approval: "A".repeat(257) }, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
    });
    expect(r_input(long)).toBe(true);
    expect(h.asks).toHaveLength(0);
    const ok = await callTool(registryOf(tool()), "banking.initiate-transfer", { ...ARGS, approval: "A".repeat(256) }, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
    });
    expect(ok.isError).toBe(false);
    expect(h.asks).toHaveLength(1);
  });
});

function r_input(r: Awaited<ReturnType<typeof callTool>>): boolean {
  return r._meta?.[INPUT_INVALID_META_KEY] !== undefined;
}

describe("ordering (§2)", () => {
  it("a rate-limited tool spends its unit before the ask: a denied ask still consumed a counter unit", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const limited = tool({ policyRules: [{ id: "rl", rateLimit: { maxInvocations: 1, windowSeconds: 60 } }] });
    const h = harness({ approval: refused });
    const registry = registryOf(limited);
    const r1 = await callTool(registry, "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, rateLimitCounter: counter });
    expect(policyReason(r1)).toBe("approval_refused");
    expect(h.asks).toHaveLength(1);
    const r2 = await callTool(registry, "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, rateLimitCounter: counter });
    expect(policyReason(r2)).toBe("rate_limit_exceeded");
    expect(h.asks).toHaveLength(1); // the limiter refused before any second ask
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("a rate limit with no counter refuses before the ask", async () => {
    const limited = tool({ policyRules: [{ id: "rl", rateLimit: { maxInvocations: 1, windowSeconds: 60 } }] });
    const h = harness({ approval: allowed });
    const r = await callTool(registryOf(limited), "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(h.asks).toHaveLength(0);
  });

  it("an input_invalid from validateInput sends no ask (missing approval, wrong type, undeclared key)", async () => {
    const h = harness({ approval: allowed });
    for (const args of [{ beneficiary: "BEN-9" }, { ...ARGS, approval: 42 }, { ...ARGS, extra: true }]) {
      const r = await callTool(registryOf(tool()), "banking.initiate-transfer", args, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
      expect(r_input(r)).toBe(true);
    }
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("a policy denial (authenticated, no credential) sends no ask", async () => {
    const h = harness({ approval: allowed });
    const r = await callTool(registryOf(tool({ policies: ["authenticated", "human-approval"] })), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
    });
    expect(policyReason(r)).toBe("authenticated_no_credential");
    expect(h.asks).toHaveLength(0);
  });
});

describe("consent-required mirrors it, and is asked first (§2, D-6)", () => {
  const both = (over: Partial<IRTool> = {}): IRTool =>
    tool({
      policies: ["consent-required", "human-approval"],
      input: [...tool().input, { name: "consent", required: true, type: { kind: "resource", name: "Consent", identity: true } }],
      consent: gate(CONSENTS, "consent"),
      ...over,
    });
  const BOTH_ARGS = { ...ARGS, consent: "CNS-7" };
  const consentAllowed: Endpoint = (b) => answer({ approvalId: b.approvalId, outcome: "allowed", reference: "CNS-REF-1" });

  it("an invalid approval id is input_invalid before ANY request — the consent is not asked either (§4)", async () => {
    const h = harness({ consent: consentAllowed, approval: allowed });
    const s = spySink();
    const r = await callTool(registryOf(both()), "banking.initiate-transfer", { ...BOTH_ARGS, approval: "BAD ID" }, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(r._meta?.[INPUT_INVALID_META_KEY]).toBeDefined();
    expect(h.consentAsks).toHaveLength(0);
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
    expect(s.records[0].status.decisionReferences).toBeUndefined();
  });

  it("an approval gate missing is refused before the consent is asked", async () => {
    const h = harness({ consent: consentAllowed, approval: allowed });
    const r = await callTool(registryOf(both({ approval: undefined })), "banking.initiate-transfer", BOTH_ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(h.consentAsks).toHaveLength(0);
  });

  it("consent pending → consent_pending; the approval is not asked", async () => {
    const h = harness({ consent: (b) => answer({ approvalId: b.approvalId, outcome: "pending" }), approval: allowed });
    const r = await callTool(registryOf(both()), "banking.initiate-transfer", BOTH_ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(policyReason(r)).toBe("consent_pending");
    expect(r.content[0].text).toMatch(/needs a consent that is still pending/);
    expect(h.consentAsks).toHaveLength(1);
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("consent refused → consent_refused; the approval is not asked", async () => {
    const h = harness({ consent: (b) => answer({ approvalId: b.approvalId, outcome: "refused" }), approval: allowed });
    const r = await callTool(registryOf(both()), "banking.initiate-transfer", BOTH_ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(policyReason(r)).toBe("consent_refused");
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("consent allowed then approval allowed → consent, approval, connector — in that order; both references recorded", async () => {
    const h = harness({ consent: consentAllowed, approval: allowed });
    const s = spySink();
    const r = await callTool(registryOf(both()), "banking.initiate-transfer", BOTH_ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(r.isError).toBe(false);
    expect(h.order).toEqual(["consent", "approval", "connector"]);
    expect(h.consentAsks[0].body.token).toBe("consent-required");
    expect(h.consentAsks[0].body.approvalId).toBe("CNS-7");
    expect(h.asks[0].body.token).toBe("human-approval");
    expect(s.records[0].status.decisionReferences).toEqual({
      "consent-required": { approvalId: "CNS-7", reference: "CNS-REF-1" },
      "human-approval": { approvalId: "APR-2026-0042", reference: "SN-CHG0042" },
    });
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("consent allowed, approval pending → approval_pending; the record keeps the consent reference", async () => {
    const h = harness({ consent: consentAllowed, approval: pending });
    const s = spySink();
    const r = await callTool(registryOf(both()), "banking.initiate-transfer", BOTH_ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      auditSink: s.sink,
    });
    expect(policyReason(r)).toBe("approval_pending");
    expect(h.connectorCalls).toHaveLength(0);
    expect(s.records[0].status.decisionReferences).toEqual({
      "consent-required": { approvalId: "CNS-7", reference: "CNS-REF-1" },
      "human-approval": { approvalId: "APR-2026-0042" },
    });
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("consent-required with no consent: block → policy_unevaluatable, zero requests", async () => {
    const h = harness({ consent: consentAllowed, approval: allowed });
    const r = await callTool(registryOf(both({ consent: undefined })), "banking.initiate-transfer", BOTH_ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
    });
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(h.order).toEqual([]);
  });

  it("consent 404 → policy_unevaluatable, not consent_refused", async () => {
    const h = harness({ consent: () => new Response("", { status: 404 }), approval: allowed });
    const r = await callTool(registryOf(both()), "banking.initiate-transfer", BOTH_ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("consent alone on a read capability, no principal → ask sent with principal null", async () => {
    const readTool = tool({
      effect: "read",
      policies: ["consent-required"],
      approval: undefined,
      input: [{ name: "consent", required: true, type: { kind: "resource", name: "Consent", identity: true } }],
      consent: gate(CONSENTS, "consent"),
    });
    const h = harness({ consent: consentAllowed });
    const r = await callTool(registryOf(readTool), "banking.initiate-transfer", { consent: "CNS-7" }, { env: ENV, fetchImpl: h.fetchImpl });
    expect(r.isError).toBe(false);
    expect(h.consentAsks[0].body.principal).toBeNull();
    expect(h.connectorCalls).toHaveLength(1);
  });
});

describe("approvalResolver replaces the transport (§9, OR-2)", () => {
  it("fetch sees only the connector call; the resolver receives the fixed request", async () => {
    const h = harness();
    const seen: ApprovalRequest[] = [];
    const resolver: ApprovalResolver = {
      resolve: async (req) => {
        seen.push(req);
        return { approvalId: req.approvalId, outcome: "allowed", reference: "DB-1" };
      },
    };
    const s = spySink();
    const r = await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      approvalResolver: resolver,
      auditSink: s.sink,
    });
    expect(r.isError).toBe(false);
    expect(h.asks).toHaveLength(0);
    expect(h.connectorCalls).toHaveLength(1);
    expect(seen).toEqual([
      {
        version: 1,
        token: "human-approval",
        capabilityId: "banking.initiate-transfer",
        effect: "irreversible",
        principal: "user-17",
        approvalId: "APR-2026-0042",
        input: ARGS,
      },
    ]);
    expect(s.records[0].status.decisionReferences).toEqual({ "human-approval": { approvalId: "APR-2026-0042", reference: "DB-1" } });
  });

  it("with no gate block it is still refused, and the resolver is never called", async () => {
    const h = harness();
    let called = 0;
    const resolver: ApprovalResolver = {
      resolve: async (req) => {
        called += 1;
        return { approvalId: req.approvalId, outcome: "allowed", reference: "DB-1" };
      },
    };
    const r = await callTool(registryOf(tool({ approval: undefined })), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
      approvalResolver: resolver,
    });
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(called).toBe(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("its answer goes through the same validation; a throw is policy_unevaluatable; null principal on irreversible never calls it", async () => {
    const h = harness();
    const run = (resolver: ApprovalResolver, anonymous = false) =>
      callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env: ENV, caller: anonymous ? undefined : CALLER, fetchImpl: h.fetchImpl, approvalResolver: resolver });

    expect(policyReason(await run({ resolve: async () => ({ approvalId: "APR-OTHER", outcome: "allowed", reference: "R" }) }))).toBe(
      "policy_unevaluatable",
    );
    expect(policyReason(await run({ resolve: async (q) => ({ approvalId: q.approvalId, outcome: "allowed" }) }))).toBe("policy_unevaluatable");
    expect(policyReason(await run({ resolve: async () => Promise.reject(new Error("db down")) }))).toBe("policy_unevaluatable");
    expect(policyReason(await run({ resolve: async (q) => ({ approvalId: q.approvalId, outcome: "pending" }) }))).toBe("approval_pending");
    expect(policyReason(await run({ resolve: async (q) => ({ approvalId: q.approvalId, outcome: "refused" }) }))).toBe("approval_refused");

    let called = 0;
    const r = await run(
      {
        resolve: async (q) => {
          called += 1;
          return { approvalId: q.approvalId, outcome: "allowed", reference: "R" };
        },
      },
      true,
    );
    expect(policyReason(r)).toBe("policy_unevaluatable");
    expect(called).toBe(0);
    expect(h.connectorCalls).toHaveLength(0);
    expect(h.asks).toHaveLength(0);
  });
});

describe("the ask is not reaching the connector (ADD-44 D-13)", () => {
  it("never triggers onResponse — a pending denial fires nothing; an allowed call fires once, for the connector", async () => {
    const seen: { capabilityId: string; status: number; data: unknown }[] = [];
    const onResponse = (info: { capabilityId: string; status: number; data: unknown }) => void seen.push(info);

    const hp = harness({ approval: pending });
    await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: hp.fetchImpl, onResponse });
    expect(hp.asks).toHaveLength(1);
    expect(seen).toHaveLength(0);

    const ha = harness({ approval: allowed });
    await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: ha.fetchImpl, onResponse });
    await new Promise((r) => setTimeout(r, 0));
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ capabilityId: "banking.initiate-transfer", status: 200, data: { transferId: "T-1" } });
  });

  it("a denied ask records no reachedConnector", async () => {
    const h = harness({ approval: () => new Response("", { status: 404 }) });
    const s = spySink();
    await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, auditSink: s.sink });
    expect(s.records[0].status.reachedConnector).toBeUndefined();
  });
});

describe("the ask body is exactly the fixed shape (§2)", () => {
  it("carries the full declared input — optional fields included, nulls dropped, nothing else", async () => {
    const h = harness({ approval: allowed });
    const args = {
      approval: "APR-2026-0042",
      beneficiary: "BEN-9",
      amount: { amount: 450, currency: "EUR" },
      memo: null,
    };
    await callTool(registryOf(tool()), "banking.initiate-transfer", args, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(h.asks).toHaveLength(1);
    expect(h.asks[0].body).toStrictEqual({
      version: 1,
      token: "human-approval",
      capabilityId: "banking.initiate-transfer",
      effect: "irreversible",
      principal: "user-17",
      approvalId: "APR-2026-0042",
      input: { approval: "APR-2026-0042", beneficiary: "BEN-9", amount: { amount: 450, currency: "EUR" } },
    });
    expect(Object.keys(h.asks[0].body)).toEqual(["version", "token", "capabilityId", "effect", "principal", "approvalId", "input"]);
  });

  it("the principal is sent opaque and verbatim", async () => {
    const h = harness({ approval: allowed });
    await callTool(registryOf(tool()), "banking.initiate-transfer", ARGS, {
      env: ENV,
      caller: { principal: "  Tenant/User:17  " },
      fetchImpl: h.fetchImpl,
    });
    expect(h.asks[0].body.principal).toBe("  Tenant/User:17  ");
  });
});
