import { describe, it, expect } from "vitest";
import { validateExecution } from "@archstone/schema";
import type { IR, IRDecisionGate, IRTool } from "@archstone/compiler";
import { InMemoryRateLimitCounter, type ApprovalRequest, type ApprovalResolver, type ExecutionRecord } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { callTool, POLICY_DENIED_META_KEY } from "@archstone/runtime";
import { Registry } from "@archstone/emitter-support";
import { fromIR, type ExecuteResult } from "../src/index";

// archstone#165 / ADD-393 — `executeCapability`'s decision-gate step, the SAME shared
// `evaluateDecisionGates` `callTool` runs at the SAME point (after the rate limit, strictly
// before the connector). Mirrors packages/runtime/test/approval.test.ts's core cases in the
// embedded envelope (`{status:"error", denial:{reason, capability}}`), then pins parity: the same
// tool and the same fake endpoint give the same denialReason on both consumers.

const APPROVALS = "https://approvals.example";
const CONSENTS = "https://consents.example";
const CORE = "https://core.example";
const ENV = { APPROVALS_TOKEN: "s3cret" };
const CALLER = { principal: "user-17" };
const ID = "banking.initiate-transfer";

function gate(baseUrl: string, input: string, over: Partial<IRDecisionGate["ask"]> = {}): IRDecisionGate {
  return { input, ask: { baseUrl, path: "/consume", headers: { Authorization: "Bearer ${APPROVALS_TOKEN}" }, ...over } };
}

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: ID,
    description: "Initiate a transfer.",
    effect: "irreversible",
    provider: "core",
    policies: ["human-approval"],
    lifecycle: "stable",
    input: [
      { name: "approval", required: true, type: { kind: "resource", name: "Approval", identity: true } },
      { name: "beneficiary", required: true, type: { kind: "scalar", semantic: "identifier" } },
      { name: "memo", required: false, type: { kind: "scalar", semantic: "string" } },
    ],
    output: [],
    connector: { type: "rest", rest: { baseUrl: CORE, method: "POST", path: "/v2/transfers" } },
    approval: gate(APPROVALS, "approval"),
    ...over,
  };
}

const irOf = (...tools: IRTool[]): IR => ({ version: "0", company: { id: "acme" }, tools, resources: {} });
const agentOf = (...tools: IRTool[]) => fromIR(JSON.parse(JSON.stringify(irOf(...tools))));

const ARGS = { approval: "APR-2026-0042", beneficiary: "BEN-9" };

type Endpoint = (body: ApprovalRequest) => Response | Promise<Response>;
const answer = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status });

function harness(endpoints: { approval?: Endpoint; consent?: Endpoint } = {}) {
  const asks: ApprovalRequest[] = [];
  const consentAsks: ApprovalRequest[] = [];
  const connectorCalls: string[] = [];
  const order: string[] = [];
  const fetchImpl: FetchLike = async (input, init) => {
    const url = String(input);
    if (url.startsWith(APPROVALS) || url.startsWith(CONSENTS)) {
      const body = JSON.parse(String(init?.body)) as ApprovalRequest;
      const isApproval = url.startsWith(APPROVALS);
      (isApproval ? asks : consentAsks).push(body);
      order.push(isApproval ? "approval" : "consent");
      const ep = isApproval ? endpoints.approval : endpoints.consent;
      if (!ep) throw new Error("no endpoint in this test");
      return ep(body);
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
const refused: Endpoint = (b) => answer({ approvalId: b.approvalId, outcome: "refused" });
const notFound: Endpoint = () => new Response("not found", { status: 404 });

function spySink() {
  const records: ExecutionRecord[] = [];
  return { sink: (r: ExecutionRecord) => void records.push(r), records };
}

const expectDenied = (r: ExecuteResult, reason: string) => {
  expect(r.status).toBe("error");
  expect(r.denial).toEqual({ reason, capability: ID });
};

describe("execute() — no gate → fail-closed", () => {
  it("policy_unevaluatable with zero requests of any kind", async () => {
    const h = harness({ approval: allowed });
    const r = await agentOf(tool({ approval: undefined })).execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expectDenied(r, "policy_unevaluatable");
    expect(h.order).toEqual([]);
  });
});

describe("execute() — the four answers", () => {
  it("allowed → ok, connector called once after exactly one ask; the record carries decisionReferences and validates", async () => {
    const h = harness({ approval: allowed });
    const s = spySink();
    const r = await agentOf(tool()).execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, auditSink: s.sink });
    expect(r.status).toBe("ok");
    expect(r.denial).toBeUndefined();
    expect(h.order).toEqual(["approval", "connector"]);
    expect(s.records).toHaveLength(1);
    expect(s.records[0].status.phase).toBe("succeeded");
    expect(s.records[0].status.decisionReferences).toEqual({
      "human-approval": { approvalId: "APR-2026-0042", reference: "SN-CHG0042" },
    });
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  it("pending → approval_pending, zero connector calls", async () => {
    const h = harness({ approval: pending });
    const r = await agentOf(tool()).execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expectDenied(r, "approval_pending");
    expect(r.error).toMatch(/check the approval's status before calling it again/);
    expect(h.asks).toHaveLength(1);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("refused → approval_refused, zero connector calls", async () => {
    const h = harness({ approval: refused });
    const s = spySink();
    const r = await agentOf(tool()).execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, auditSink: s.sink });
    expectDenied(r, "approval_refused");
    expect(h.connectorCalls).toHaveLength(0);
    expect(s.records[0].status).toMatchObject({ phase: "denied", denialReason: "approval_refused" });
    expect(s.records[0].status.decisionReferences).toEqual({ "human-approval": { approvalId: "APR-2026-0042" } });
    expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
  });

  const nonAnswers: [string, Endpoint][] = [
    ["404", notFound],
    ["302", () => new Response(null, { status: 302, headers: { location: "https://elsewhere.example/" } })],
    ["wrong echo", () => answer({ approvalId: "APR-OTHER", outcome: "allowed", reference: "R" })],
    ["oversize", (b) => answer({ approvalId: b.approvalId, outcome: "allowed", reference: "R", pad: "x".repeat(64 * 1024) })],
  ];
  for (const [name, ep] of nonAnswers) {
    it(`${name} → policy_unevaluatable, zero connector calls, record carries approvalId only`, async () => {
      const h = harness({ approval: ep });
      const s = spySink();
      const r = await agentOf(tool()).execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, auditSink: s.sink });
      expectDenied(r, "policy_unevaluatable");
      expect(h.asks).toHaveLength(1);
      expect(h.connectorCalls).toHaveLength(0);
      expect(s.records[0].status.decisionReferences).toEqual({ "human-approval": { approvalId: "APR-2026-0042" } });
      expect(validateExecution(s.records[0])).toEqual({ ok: true, errors: "" });
    });
  }

  it("timeout (timeoutSeconds 1, never-resolving ask) → policy_unevaluatable, zero connector calls", async () => {
    const h = harness({ approval: () => new Promise<Response>(() => undefined) });
    const r = await agentOf(tool({ approval: gate(APPROVALS, "approval", { timeoutSeconds: 1 }) })).execute(ID, ARGS, {
      env: ENV,
      caller: CALLER,
      fetchImpl: h.fetchImpl,
    });
    expectDenied(r, "policy_unevaluatable");
    expect(h.connectorCalls).toHaveLength(0);
  }, 10_000);

  it("execute() never reads process.env for the ask's secret: with no env the ask is not sent", async () => {
    process.env.APPROVALS_TOKEN = "from-process-env";
    try {
      const h = harness({ approval: allowed });
      const r = await agentOf(tool()).execute(ID, ARGS, { caller: CALLER, fetchImpl: h.fetchImpl });
      expectDenied(r, "policy_unevaluatable");
      expect(h.asks).toHaveLength(0);
    } finally {
      delete process.env.APPROVALS_TOKEN;
    }
  });
});

describe("execute() — principal and id", () => {
  it("irreversible + no principal sends nothing", async () => {
    const h = harness({ approval: allowed });
    const r = await agentOf(tool()).execute(ID, ARGS, { env: ENV, fetchImpl: h.fetchImpl });
    expectDenied(r, "policy_unevaluatable");
    expect(h.order).toEqual([]);
  });

  it("write + no principal → the ask is sent with principal null", async () => {
    const h = harness({ approval: refused });
    const r = await agentOf(tool({ effect: "write" })).execute(ID, ARGS, { env: ENV, fetchImpl: h.fetchImpl });
    expectDenied(r, "approval_refused");
    expect(h.asks[0].principal).toBeNull();
  });

  it("an id with a space → input_invalid naming the field path, no ask", async () => {
    const h = harness({ approval: allowed });
    const r = await agentOf(tool()).execute(ID, { ...ARGS, approval: "APR 1" }, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(r.status).toBe("error");
    expect(r.denial?.reason).toBe("input_invalid");
    expect(r.denial?.capability).toBe(ID);
    expect(r.denial?.problems?.map((p) => p.path)).toEqual(["approval"]);
    expect(JSON.stringify(r)).not.toContain("APR 1");
    expect(h.order).toEqual([]);
  });

  it("the ask body is the fixed shape with the full declared input, nulls dropped", async () => {
    const h = harness({ approval: allowed });
    await agentOf(tool()).execute(ID, { ...ARGS, memo: null }, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(h.asks[0]).toStrictEqual({
      version: 1,
      token: "human-approval",
      capabilityId: ID,
      effect: "irreversible",
      principal: "user-17",
      approvalId: "APR-2026-0042",
      input: ARGS,
    });
  });
});

describe("execute() — ordering", () => {
  it("a denied ask still spent its rate-limit unit; the next call is refused by the limiter with no ask", async () => {
    const counter = new InMemoryRateLimitCounter(() => 0);
    const a = agentOf(tool({ policyRules: [{ id: "rl", rateLimit: { maxInvocations: 1, windowSeconds: 60 } }] }));
    const h = harness({ approval: refused });
    expectDenied(await a.execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, rateLimitCounter: counter }), "approval_refused");
    expectDenied(await a.execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, rateLimitCounter: counter }), "rate_limit_exceeded");
    expect(h.asks).toHaveLength(1);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("an input_invalid from validateInput sends no ask", async () => {
    const h = harness({ approval: allowed });
    const r = await agentOf(tool()).execute(ID, { beneficiary: "BEN-9" }, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl });
    expect(r.denial?.reason).toBe("input_invalid");
    expect(h.order).toEqual([]);
  });

  it("consent is asked first; a pending consent means the approval is never asked", async () => {
    const both = tool({
      policies: ["consent-required", "human-approval"],
      input: [...tool().input, { name: "consent", required: true, type: { kind: "resource", name: "Consent", identity: true } }],
      consent: gate(CONSENTS, "consent"),
    });
    const h = harness({ consent: (b) => answer({ approvalId: b.approvalId, outcome: "pending" }), approval: allowed });
    expectDenied(await agentOf(both).execute(ID, { ...ARGS, consent: "CNS-7" }, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl }), "consent_pending");
    expect(h.order).toEqual(["consent"]);

    const h2 = harness({ consent: (b) => answer({ approvalId: b.approvalId, outcome: "refused" }), approval: allowed });
    expectDenied(await agentOf(both).execute(ID, { ...ARGS, consent: "CNS-7" }, { env: ENV, caller: CALLER, fetchImpl: h2.fetchImpl }), "consent_refused");
    expect(h2.order).toEqual(["consent"]);

    const h3 = harness({ consent: (b) => answer({ approvalId: b.approvalId, outcome: "allowed", reference: "C-1" }), approval: allowed });
    const ok = await agentOf(both).execute(ID, { ...ARGS, consent: "CNS-7" }, { env: ENV, caller: CALLER, fetchImpl: h3.fetchImpl });
    expect(ok.status).toBe("ok");
    expect(h3.order).toEqual(["consent", "approval", "connector"]);
  });
});

describe("execute() — ExecuteOptions.approvalResolver", () => {
  it("replaces HTTP: fetch only sees the connector call", async () => {
    const h = harness();
    const seen: ApprovalRequest[] = [];
    const approvalResolver: ApprovalResolver = {
      resolve: async (q) => {
        seen.push(q);
        return { approvalId: q.approvalId, outcome: "allowed", reference: "DB-1" };
      },
    };
    const s = spySink();
    const r = await agentOf(tool()).execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, approvalResolver, auditSink: s.sink });
    expect(r.status).toBe("ok");
    expect(h.order).toEqual(["connector"]);
    expect(seen).toHaveLength(1);
    expect(seen[0].approvalId).toBe("APR-2026-0042");
    expect(s.records[0].status.decisionReferences).toEqual({ "human-approval": { approvalId: "APR-2026-0042", reference: "DB-1" } });
  });

  it("with no gate block it is still refused, the resolver never called", async () => {
    const h = harness();
    let called = 0;
    const approvalResolver: ApprovalResolver = {
      resolve: async (q) => {
        called += 1;
        return { approvalId: q.approvalId, outcome: "allowed", reference: "DB-1" };
      },
    };
    const r = await agentOf(tool({ approval: undefined })).execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, approvalResolver });
    expectDenied(r, "policy_unevaluatable");
    expect(called).toBe(0);
    expect(h.order).toEqual([]);
  });

  it("its answer is validated (wrong echo, throw → policy_unevaluatable); irreversible with no principal never calls it", async () => {
    const h = harness();
    const a = agentOf(tool());
    expectDenied(
      await a.execute(ID, ARGS, {
        env: ENV,
        caller: CALLER,
        fetchImpl: h.fetchImpl,
        approvalResolver: { resolve: async () => ({ approvalId: "X", outcome: "allowed", reference: "R" }) },
      }),
      "policy_unevaluatable",
    );
    expectDenied(
      await a.execute(ID, ARGS, {
        env: ENV,
        caller: CALLER,
        fetchImpl: h.fetchImpl,
        approvalResolver: { resolve: () => Promise.reject(new Error("db down")) },
      }),
      "policy_unevaluatable",
    );
    let called = 0;
    expectDenied(
      await a.execute(ID, ARGS, {
        env: ENV,
        fetchImpl: h.fetchImpl,
        approvalResolver: {
          resolve: async (q) => {
            called += 1;
            return { approvalId: q.approvalId, outcome: "allowed", reference: "R" };
          },
        },
      }),
      "policy_unevaluatable",
    );
    expect(called).toBe(0);
    expect(h.connectorCalls).toHaveLength(0);
  });

  it("the ask never triggers onResponse", async () => {
    const seen: unknown[] = [];
    const h = harness({ approval: pending });
    await agentOf(tool()).execute(ID, ARGS, { env: ENV, caller: CALLER, fetchImpl: h.fetchImpl, onResponse: (i) => void seen.push(i) });
    expect(h.asks).toHaveLength(1);
    expect(seen).toHaveLength(0);
  });
});

describe("parity: callTool and execute() give the same denialReason for the same tool and endpoint", () => {
  const cases: [string, Endpoint, string | undefined][] = [
    ["allowed", allowed, undefined],
    ["pending", pending, "approval_pending"],
    ["refused", refused, "approval_refused"],
    ["404", notFound, "policy_unevaluatable"],
  ];
  for (const [name, ep, expected] of cases) {
    it(name, async () => {
      const ir = irOf(tool());
      const hMcp = harness({ approval: ep });
      const sMcp = spySink();
      const mcp = await callTool(new Registry(JSON.parse(JSON.stringify(ir)) as IR), ID, ARGS, {
        env: ENV,
        caller: CALLER,
        fetchImpl: hMcp.fetchImpl,
        auditSink: sMcp.sink,
      });
      const hEmb = harness({ approval: ep });
      const sEmb = spySink();
      const emb = await fromIR(JSON.parse(JSON.stringify(ir))).execute(ID, ARGS, {
        env: ENV,
        caller: CALLER,
        fetchImpl: hEmb.fetchImpl,
        auditSink: sEmb.sink,
      });

      const mcpReason = (mcp._meta?.[POLICY_DENIED_META_KEY] as { reason?: string } | undefined)?.reason;
      expect(mcpReason).toBe(expected);
      expect(emb.denial?.reason).toBe(expected);
      expect(mcp.isError).toBe(expected !== undefined);
      expect(emb.status).toBe(expected === undefined ? "ok" : "error");
      // Same requests on both, and the same record status.
      expect(hEmb.order).toEqual(hMcp.order);
      expect(hEmb.asks).toEqual(hMcp.asks);
      expect(sEmb.records[0].status.denialReason).toBe(sMcp.records[0].status.denialReason);
      expect(sEmb.records[0].status.decisionReferences).toEqual(sMcp.records[0].status.decisionReferences);
      expect(sEmb.records[0].status.message).toBe(sMcp.records[0].status.message);
    });
  }
});
