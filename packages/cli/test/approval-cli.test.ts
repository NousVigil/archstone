import { describe, it, expect } from "vitest";
import { lintIR, type IR, type IRDecisionGate, type IRTool } from "@archstone/compiler";
import type { ExecutionRecord } from "@archstone/emitter-support";
import { diagnose, type Finding } from "../src/doctor";
import { findApprovalReuse, summarize } from "../src/audit-report";

// archstone#165 / ADD-393 §7–§8 — the CLI half: `doctor`'s two gate findings (and the absence of
// the old "unenforced" lint for both tokens), and `archstone audit`'s approvalId reuse finding.

const gate = (input: string): IRDecisionGate => ({
  input,
  ask: { baseUrl: "https://approvals.example", path: "/consume", headers: { Authorization: "Bearer ${APPROVALS_TOKEN}" } },
});

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: "banking.initiate-transfer",
    description: "Initiate a transfer.",
    effect: "irreversible",
    provider: "core",
    policies: ["human-approval"],
    lifecycle: "stable",
    input: [{ name: "approval", required: true, type: { kind: "resource", name: "Approval", identity: true } }],
    output: [],
    connector: { type: "rest", rest: { baseUrl: "https://core.example", method: "POST", path: "/v2/transfers" } },
    ...over,
  };
}

const ir = (...tools: IRTool[]): IR => ({ version: "0", company: { id: "acme" }, tools, resources: {} });

/** `diagnose` with `lintIR`'s findings passed through, as the CLI does — so a regression that
 *  put either token back into the unenforced list would surface here as
 *  `irreversible-unenforced-policy`. */
function doctor(i: IR): Finding[] {
  const lint = lintIR(i, { capabilityDocs: [] });
  return diagnose(i, "/nonexistent-manifest-dir", { lint }).findings;
}

const gateFindings = (fs: Finding[]) => fs.filter((f) => /^(approval|consent)-/.test(f.code));

describe("doctor — human-approval (ADD-393 D-8)", () => {
  it("no gate → approval-gate-missing warning, token set, refused fail-closed", () => {
    const fs = doctor(ir(tool()));
    const g = gateFindings(fs);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({
      severity: "warning",
      code: "approval-gate-missing",
      capability: "banking.initiate-transfer",
      token: "human-approval",
    });
    expect(g[0].because).toMatch(/refused, fail-closed/);
    expect(fs.map((f) => f.code)).not.toContain("irreversible-unenforced-policy");
  });

  it("with a gate → approval-without-principal advisory; on irreversible it says the ask is never sent, and mentions verify", () => {
    const fs = doctor(ir(tool({ approval: gate("approval") })));
    const g = gateFindings(fs);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({
      severity: "advisory",
      code: "approval-without-principal",
      capability: "banking.initiate-transfer",
      token: "human-approval",
    });
    expect(g[0].because).toMatch(/never sent/);
    expect(g[0].because).toMatch(/irreversible/);
    expect(g[0].because).toMatch(/verify/);
    expect(fs.map((f) => f.code)).not.toContain("approval-gate-missing");
    expect(fs.map((f) => f.code)).not.toContain("irreversible-unenforced-policy");
  });

  it("with a gate on a write capability → the advisory says the ask is sent with principal null", () => {
    const g = gateFindings(doctor(ir(tool({ effect: "write", approval: gate("approval") }))));
    expect(g).toHaveLength(1);
    expect(g[0].code).toBe("approval-without-principal");
    expect(g[0].because).toMatch(/principal: null/);
    expect(g[0].because).not.toMatch(/never sent/);
    expect(g[0].because).toMatch(/verify/);
  });

  it("the wording never claims Archstone enforces single use (§6)", () => {
    const all = [...doctor(ir(tool())), ...doctor(ir(tool({ approval: gate("approval") })))];
    for (const f of gateFindings(all)) {
      expect(`${f.message} ${f.because}`).not.toMatch(/single-use|prevents reuse|unenforced|not enforce/i);
    }
  });
});

describe("doctor — consent-required mirrors it", () => {
  const consentTool = (over: Partial<IRTool> = {}) =>
    tool({
      policies: ["consent-required"],
      input: [{ name: "consent", required: true, type: { kind: "resource", name: "Consent", identity: true } }],
      ...over,
    });

  it("no gate → consent-gate-missing warning with token consent-required", () => {
    const fs = doctor(ir(consentTool()));
    const g = gateFindings(fs);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ severity: "warning", code: "consent-gate-missing", token: "consent-required" });
    expect(fs.map((f) => f.code)).not.toContain("irreversible-unenforced-policy");
  });

  it("with a gate → consent-without-principal advisory", () => {
    const fs = doctor(ir(consentTool({ consent: gate("consent") })));
    const g = gateFindings(fs);
    expect(g).toHaveLength(1);
    expect(g[0]).toMatchObject({ severity: "advisory", code: "consent-without-principal", token: "consent-required" });
    expect(g[0].because).toMatch(/never sent/);
    expect(g[0].because).toMatch(/verify/);
    expect(fs.map((f) => f.code)).not.toContain("irreversible-unenforced-policy");
  });

  it("both tokens, both gates → one advisory each, distinguished by token", () => {
    const g = gateFindings(
      doctor(
        ir(
          tool({
            policies: ["consent-required", "human-approval"],
            approval: gate("approval"),
            consent: gate("consent"),
          }),
        ),
      ),
    );
    expect(g.map((f) => [f.code, f.token])).toEqual([
      ["consent-without-principal", "consent-required"],
      ["approval-without-principal", "human-approval"],
    ]);
  });

  it("a capability declaring neither token gets no gate finding", () => {
    expect(gateFindings(doctor(ir(tool({ policies: [] }))))).toEqual([]);
  });
});

// --- archstone audit: approvalId reuse (ADD-393 D-7) ------------------------------------------

function rec(over: {
  id?: string;
  capabilityId?: string;
  startedAt?: string;
  phase?: "succeeded" | "failed" | "denied";
  approval?: { approvalId: string; reference?: string };
  consent?: { approvalId: string; reference?: string };
}): ExecutionRecord {
  const decisionReferences = {
    ...(over.approval ? { "human-approval": over.approval } : {}),
    ...(over.consent ? { "consent-required": over.consent } : {}),
  };
  return {
    apiVersion: "archstone/v1",
    kind: "Execution",
    metadata: {
      id: over.id ?? "exec-1",
      capabilityId: over.capabilityId ?? "banking.initiate-transfer",
      provider: "core",
      startedAt: over.startedAt ?? "2026-10-22T09:00:00.000Z",
      completedAt: "2026-10-22T09:00:00.400Z",
    },
    spec: { input: {}, consumer: "mcp", policyRuleIds: [] },
    status: {
      phase: over.phase ?? "succeeded",
      ...(over.phase === "denied" ? { denialReason: "approval_refused" as const } : {}),
      ...(Object.keys(decisionReferences).length > 0 ? { decisionReferences } : {}),
    },
  } as ExecutionRecord;
}

describe("findApprovalReuse", () => {
  it("reports an approvalId on two executed (succeeded/failed) records, with their references", () => {
    const records = [
      rec({ id: "e1", startedAt: "2026-10-22T09:00:00.000Z", approval: { approvalId: "APR-1", reference: "SN-1" } }),
      rec({ id: "e2", startedAt: "2026-10-22T09:05:00.000Z", phase: "failed", approval: { approvalId: "APR-1", reference: "SN-2" } }),
      rec({ id: "e3", approval: { approvalId: "APR-2", reference: "SN-3" } }),
    ];
    expect(findApprovalReuse(records)).toEqual([
      {
        approvalId: "APR-1",
        records: [
          { id: "e1", capabilityId: "banking.initiate-transfer", startedAt: "2026-10-22T09:00:00.000Z", phase: "succeeded", reference: "SN-1" },
          { id: "e2", capabilityId: "banking.initiate-transfer", startedAt: "2026-10-22T09:05:00.000Z", phase: "failed", reference: "SN-2" },
        ],
      },
    ]);
  });

  it("is keyed on approvalId, not reference: two executions with the same id and no references are reported", () => {
    const reuse = findApprovalReuse([rec({ id: "e1", approval: { approvalId: "APR-1" } }), rec({ id: "e2", approval: { approvalId: "APR-1" } })]);
    expect(reuse).toHaveLength(1);
    expect(reuse[0].records.map((r) => r.reference)).toEqual([undefined, undefined]);
  });

  it("does not report an id on one succeeded and one denied record — a denied attempt never ran", () => {
    expect(
      findApprovalReuse([
        rec({ id: "e1", approval: { approvalId: "APR-1", reference: "SN-1" } }),
        rec({ id: "e2", phase: "denied", approval: { approvalId: "APR-1" } }),
      ]),
    ).toEqual([]);
  });

  it("does not apply to consents, which are commonly durable", () => {
    expect(
      findApprovalReuse([
        rec({ id: "e1", consent: { approvalId: "CNS-1", reference: "C-1" } }),
        rec({ id: "e2", consent: { approvalId: "CNS-1", reference: "C-1" } }),
      ]),
    ).toEqual([]);
  });
});

describe("summarize — the reuse section", () => {
  const heading = /Approval ids on more than one executed record/;

  it("prints the section, with id, references and record ids, only when there is reuse", () => {
    const out = summarize([
      rec({ id: "e1", approval: { approvalId: "APR-1", reference: "SN-1" } }),
      rec({ id: "e2", approval: { approvalId: "APR-1", reference: "SN-2" } }),
    ]);
    expect(out).toMatch(heading);
    expect(out).toContain("APR-1");
    expect(out).toContain("reference SN-1");
    expect(out).toContain("reference SN-2");
    expect(out).toContain("e1");
    expect(out).toContain("e2");
  });

  it("omits the section when nothing is reused", () => {
    const out = summarize([
      rec({ id: "e1", approval: { approvalId: "APR-1", reference: "SN-1" } }),
      rec({ id: "e2", phase: "denied", approval: { approvalId: "APR-1" } }),
      rec({ id: "e3", consent: { approvalId: "CNS-1" } }),
      rec({ id: "e4", consent: { approvalId: "CNS-1" } }),
    ]);
    expect(out).not.toMatch(heading);
  });
});
