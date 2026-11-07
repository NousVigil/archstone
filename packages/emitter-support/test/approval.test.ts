import { describe, it, expect, vi } from "vitest";
import { validateExecution } from "@archstone/schema";
import type { IRDecisionGate, IRTool } from "@archstone/compiler";
import {
  buildApprovalRequest,
  isValidApprovalId,
  isValidDecisionReference,
  classifyAnswer,
  evaluateDecisionGates,
  APPROVAL_ID_EXPECTED,
  APPROVAL_PENDING_REASON,
  APPROVAL_REFUSED_REASON,
  CONSENT_PENDING_REASON,
  CONSENT_REFUSED_REASON,
  type ApprovalAskResult,
  type ApprovalRequest,
  type ApprovalResolver,
  type ApprovalTransport,
  type DecisionGateDecision,
} from "../src/approval";
import { buildExecutionRecord, auditNow } from "../src/audit";

// ADD-393 (archstone#165) — the decision gates' pure half: the fixed request body (§2), the one
// answer shape and its classifier (§3, D-4), the id and reference character rules (§4), and the
// orchestration both audited consumers share (§2 order, §8 principal rule, §9 resolver seam).
// Written against the ADD, not the code: a row here that the code disagrees with is a finding.
// The HTTP transport is `providers/rest`'s `askApproval`, tested there; here it is a fake.

const GATE: IRDecisionGate = {
  input: "approval",
  ask: { baseUrl: "https://approvals.test", path: "/approvals/consume", headers: { Authorization: "Bearer ${APPROVALS_TOKEN}" } },
};
const CONSENT_GATE: IRDecisionGate = {
  input: "consent",
  ask: { baseUrl: "https://consents.test", path: "/consents/check", headers: { Authorization: "Bearer ${CONSENTS_TOKEN}" } },
};

function tool(over: Partial<IRTool> = {}): IRTool {
  return {
    id: "banking.initiate-transfer",
    description: "Send money.",
    effect: "write",
    provider: "core-banking",
    policies: ["human-approval"],
    lifecycle: "stable",
    input: [],
    output: [],
    approval: GATE,
    ...over,
  };
}

const ID = "APR-SECRET-0042";
const REF = "REF-0001";

/** A fake transport: records every call, answers with `answer` (a body, a result, or a throw). */
function fakeTransport(answer: ApprovalAskResult | ((req: ApprovalRequest, gate: IRDecisionGate) => ApprovalAskResult) | Error) {
  const calls: { gate: IRDecisionGate; request: ApprovalRequest }[] = [];
  const transport: ApprovalTransport = async (gate, request) => {
    calls.push({ gate, request });
    if (answer instanceof Error) throw answer;
    return typeof answer === "function" ? answer(request, gate) : answer;
  };
  return { transport, calls };
}

const body = (b: unknown): ApprovalAskResult => ({ ok: true, body: b });

function denialOf(d: DecisionGateDecision) {
  expect(d.allowed).toBe(false);
  if (d.allowed) throw new Error("unreachable");
  return d;
}

// ---------------------------------------------------------------------------------------------
// §2 — the fixed body
// ---------------------------------------------------------------------------------------------

describe("buildApprovalRequest — the fixed body (ADD-393 §2, D-2)", () => {
  it("is exactly {version, token, capabilityId, effect, principal, approvalId, input} and nothing else", () => {
    const req = buildApprovalRequest(tool({ effect: "irreversible" }), "human-approval", ID, { source: "ACC-1", approval: ID }, "user-17");
    expect(req).toEqual({
      version: 1,
      token: "human-approval",
      capabilityId: "banking.initiate-transfer",
      effect: "irreversible",
      principal: "user-17",
      approvalId: ID,
      input: { source: "ACC-1", approval: ID },
    });
    expect(Object.keys(req).sort()).toEqual(["approvalId", "capabilityId", "effect", "input", "principal", "token", "version"]);
  });

  it("carries the principal verbatim — opaque, never trimmed or case-folded (ADD-42 D-1)", () => {
    const p = "  User-17@Example ";
    expect(buildApprovalRequest(tool(), "human-approval", ID, {}, p).principal).toBe(p);
  });

  it("sends principal null when the invocation carries none", () => {
    expect(buildApprovalRequest(tool(), "consent-required", ID, {}, undefined).principal).toBeNull();
    expect(buildApprovalRequest(tool(), "consent-required", ID, {}, undefined).token).toBe("consent-required");
  });

  it("removes null and absent members, keeps optional fields that are present, normalises nothing else", () => {
    const input = {
      source: "ACC-1",
      reference: "rent", // optional, present → kept
      memo: null, // null → removed
      note: undefined, // absent → removed
      amount: { amount: 450, currency: "EUR", extra: null }, // nested null → removed, rest verbatim
      zero: 0,
      no: false,
      empty: "",
      spaced: "  Mixed Case  ",
      list: [null, 1, "a"], // array members untouched
    };
    const req = buildApprovalRequest(tool(), "human-approval", ID, input, "p");
    expect(req.input).toEqual({
      source: "ACC-1",
      reference: "rent",
      amount: { amount: 450, currency: "EUR" },
      zero: 0,
      no: false,
      empty: "",
      spaced: "  Mixed Case  ",
      list: [null, 1, "a"],
    });
    expect("memo" in req.input).toBe(false);
    expect("note" in req.input).toBe(false);
    // The caller's object is not mutated.
    expect(input.memo).toBeNull();
    expect("extra" in input.amount).toBe(true);
  });

  it("serialises to JSON with no undefined members left behind", () => {
    const req = buildApprovalRequest(tool(), "human-approval", ID, { a: undefined, b: 1 }, undefined);
    expect(JSON.parse(JSON.stringify(req))).toEqual(req);
  });
});

// ---------------------------------------------------------------------------------------------
// §4 — the id and reference rules
// ---------------------------------------------------------------------------------------------

describe("isValidApprovalId — 1–256 visible ASCII 0x21–0x7E (ADD-393 §4)", () => {
  it("accepts sys_ids, issue keys, UUIDs, payment ids and the full visible range", () => {
    for (const v of ["a", "APR-2026-0042", "OPS-1234", "6f1c9a2e-8a1b-4c7d-9e2f-0a1b2c3d4e5f", "pi_3Nk2", "!~", "x".repeat(256)]) {
      expect(isValidApprovalId(v)).toBe(true);
    }
    let all = "";
    for (let c = 0x21; c <= 0x7e; c++) all += String.fromCharCode(c);
    expect(isValidApprovalId(all)).toBe(true);
  });

  it("rejects empty, 257 characters, space, non-ASCII, control characters and non-strings", () => {
    for (const v of ["", "x".repeat(257), "APR 1", " APR", "APRé", "APR–", "\u{1F600}", "APR\n", "APR\t", "\x00", "\x7f", "\x20"]) {
      expect(isValidApprovalId(v)).toBe(false);
    }
    for (const v of [undefined, null, 42, true, {}, [], ["APR-1"]]) {
      expect(isValidApprovalId(v)).toBe(false);
    }
  });
});

describe("isValidDecisionReference — 1–512 visible ASCII (ADD-393 §4)", () => {
  it("accepts 1 and 512 characters", () => {
    expect(isValidDecisionReference("r")).toBe(true);
    expect(isValidDecisionReference("r".repeat(512))).toBe(true);
  });

  it("rejects empty, 513 characters, space, non-ASCII, control characters and non-strings", () => {
    for (const v of ["", "r".repeat(513), "a b", "ré", "r\n", "\x7f", undefined, null, 1, {}]) {
      expect(isValidDecisionReference(v)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// §3 — the answer table
// ---------------------------------------------------------------------------------------------

describe("classifyAnswer — the one answer shape (ADD-393 §3, D-4)", () => {
  it("allowed + reference → answer", () => {
    expect(classifyAnswer({ approvalId: ID, outcome: "allowed", reference: REF }, ID)).toEqual({ kind: "answer", outcome: "allowed", reference: REF });
  });

  it("allowed without a reference → unevaluatable (reference is required on allowed)", () => {
    expect(classifyAnswer({ approvalId: ID, outcome: "allowed" }, ID).kind).toBe("unevaluatable");
  });

  it("pending and refused, with and without a reference → answer", () => {
    for (const outcome of ["pending", "refused"] as const) {
      expect(classifyAnswer({ approvalId: ID, outcome }, ID)).toEqual({ kind: "answer", outcome });
      expect(classifyAnswer({ approvalId: ID, outcome, reference: REF }, ID)).toEqual({ kind: "answer", outcome, reference: REF });
    }
  });

  it("a wrong or missing echo → unevaluatable, on every outcome", () => {
    for (const outcome of ["allowed", "pending", "refused"]) {
      expect(classifyAnswer({ approvalId: "APR-OTHER", outcome, reference: REF }, ID).kind).toBe("unevaluatable");
      expect(classifyAnswer({ outcome, reference: REF }, ID).kind).toBe("unevaluatable");
      expect(classifyAnswer({ approvalId: ID.toLowerCase(), outcome, reference: REF }, ID).kind).toBe("unevaluatable");
      expect(classifyAnswer({ approvalId: 42, outcome, reference: REF }, "42").kind).toBe("unevaluatable");
    }
  });

  it("an unknown, differently-cased, boolean or missing outcome → unevaluatable", () => {
    for (const outcome of ["approved", "ALLOWED", "denied", "", true, false, 1, null, undefined]) {
      expect(classifyAnswer({ approvalId: ID, outcome, reference: REF }, ID).kind).toBe("unevaluatable");
    }
    expect(classifyAnswer({ approvalId: ID, reference: REF }, ID).kind).toBe("unevaluatable");
  });

  it("a reference too long, non-ASCII, empty or non-string → unevaluatable on any outcome", () => {
    for (const outcome of ["allowed", "pending", "refused"]) {
      for (const reference of ["r".repeat(513), "réf", "", "a b", 7, null, {}]) {
        expect(classifyAnswer({ approvalId: ID, outcome, reference }, ID).kind).toBe("unevaluatable");
      }
    }
  });

  it("a non-object, an array, null → unevaluatable", () => {
    for (const b of [null, undefined, "allowed", 1, true, [], [{ approvalId: ID, outcome: "allowed", reference: REF }]]) {
      expect(classifyAnswer(b, ID).kind).toBe("unevaluatable");
    }
  });

  it("extra fields are ignored — never surfaced in the classification", () => {
    const c = classifyAnswer({ approvalId: ID, outcome: "refused", reference: REF, reason: "the CFO said no", debug: { x: 1 } }, ID);
    expect(c).toEqual({ kind: "answer", outcome: "refused", reference: REF });
    expect(JSON.stringify(c)).not.toContain("CFO");
  });

  it("an unevaluatable detail is Archstone's wording, never text the endpoint sent", () => {
    const c = classifyAnswer({ approvalId: "ENDPOINT-TEXT-xyz", outcome: "ENDPOINT-OUTCOME-xyz", reference: REF }, ID);
    expect(c.kind).toBe("unevaluatable");
    if (c.kind === "unevaluatable") {
      expect(c.detail).not.toContain("ENDPOINT");
      expect(c.detail).not.toContain(ID);
    }
  });
});

// ---------------------------------------------------------------------------------------------
// §2/§8/§9 — the shared orchestration
// ---------------------------------------------------------------------------------------------

describe("evaluateDecisionGates — no token, no gate (ADD-393 D-8)", () => {
  it("no decision token → allowed, no references, transport never called", async () => {
    const t = fakeTransport(body({}));
    const d = await evaluateDecisionGates(tool({ policies: ["authenticated"] }), { approval: ID }, { principal: "p" }, { transport: t.transport });
    expect(d).toEqual({ allowed: true });
    expect(t.calls).toHaveLength(0);
  });

  it("a gate block without the token is not asked (the token decides; apply refuses the block)", async () => {
    const t = fakeTransport(body({}));
    const d = await evaluateDecisionGates(tool({ policies: [], approval: GATE, consent: CONSENT_GATE }), { approval: ID }, {}, { transport: t.transport });
    expect(d).toEqual({ allowed: true });
    expect(t.calls).toHaveLength(0);
  });

  it("token declared with no gate → policy_unevaluatable, transport never called", async () => {
    const t = fakeTransport(body({ approvalId: ID, outcome: "allowed", reference: REF }));
    const d = denialOf(await evaluateDecisionGates(tool({ approval: undefined }), { approval: ID }, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(d.references).toBeUndefined();
    expect(t.calls).toHaveLength(0);
  });

  it("…even when a resolver is supplied — the resolver does not lift the gate requirement (§9)", async () => {
    const t = fakeTransport(body({}));
    const resolve = vi.fn(async () => ({ approvalId: ID, outcome: "allowed" as const, reference: REF }));
    const d = denialOf(
      await evaluateDecisionGates(tool({ approval: undefined }), { approval: ID }, { principal: "p" }, { transport: t.transport, resolver: { resolve } }),
    );
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(resolve).not.toHaveBeenCalled();
    expect(t.calls).toHaveLength(0);
  });

  it("consent-required with no consent gate → policy_unevaluatable, approval never asked either", async () => {
    const t = fakeTransport(body({ approvalId: ID, outcome: "allowed", reference: REF }));
    const d = denialOf(
      await evaluateDecisionGates(tool({ policies: ["consent-required", "human-approval"] }), { approval: ID, consent: "CON-1" }, { principal: "p" }, { transport: t.transport }),
    );
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(t.calls).toHaveLength(0);
  });
});

describe("evaluateDecisionGates — the id input (ADD-393 §4)", () => {
  const bad: [string, unknown][] = [
    ["missing", undefined],
    ["null", null],
    ["empty", ""],
    ["257 chars", "x".repeat(257)],
    ["a space", "APR SECRET"],
    ["non-ASCII", "APR-SECRÉT"],
    ["a control char", "APR-SECRET\n"],
    ["a number", 42],
    ["an object", { id: "APR-SECRET" }],
  ];
  for (const [label, value] of bad) {
    it(`${label} → input_invalid naming the field path, never the value, nothing sent`, async () => {
      const t = fakeTransport(body({}));
      const resolve = vi.fn();
      const d = denialOf(
        await evaluateDecisionGates(tool(), value === undefined ? {} : { approval: value }, { principal: "p" }, { transport: t.transport, resolver: { resolve } }),
      );
      expect(d.denial.reason).toBe("input_invalid");
      expect(d.denial.problems).toEqual([{ path: "approval", expected: APPROVAL_ID_EXPECTED }]);
      expect(d.denial.message).toContain("approval");
      expect(d.denial.message).not.toContain("SECRET");
      expect(JSON.stringify(d.denial.problems)).not.toContain("SECRET");
      expect(d.references).toBeUndefined();
      expect(t.calls).toHaveLength(0);
      expect(resolve).not.toHaveBeenCalled();
    });
  }

  it("names the gate's own input field when it is not called `approval`", async () => {
    const t = fakeTransport(body({}));
    const d = denialOf(await evaluateDecisionGates(tool({ approval: { ...GATE, input: "ticket" } }), { ticket: "" }, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.problems).toEqual([{ path: "ticket", expected: APPROVAL_ID_EXPECTED }]);
  });
});

describe("evaluateDecisionGates — the principal (ADD-393 §8, OR-5)", () => {
  it("irreversible + no principal → policy_unevaluatable 'needs an identified caller', nothing sent", async () => {
    const t = fakeTransport(body({ approvalId: ID, outcome: "allowed", reference: REF }));
    const resolve = vi.fn();
    const d = denialOf(await evaluateDecisionGates(tool({ effect: "irreversible" }), { approval: ID }, {}, { transport: t.transport, resolver: { resolve } }));
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(d.denial.message).toContain("needs an identified caller");
    expect(d.denial.message).not.toContain(ID);
    expect(d.references).toBeUndefined();
    expect(t.calls).toHaveLength(0);
    expect(resolve).not.toHaveBeenCalled();
  });

  it("irreversible consent gate + no principal → the same refusal, nothing sent", async () => {
    const t = fakeTransport(body({}));
    const d = denialOf(
      await evaluateDecisionGates(tool({ effect: "irreversible", policies: ["consent-required"], approval: undefined, consent: CONSENT_GATE }), { consent: "CON-1" }, {}, { transport: t.transport }),
    );
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(d.denial.message).toContain("needs an identified caller");
    expect(t.calls).toHaveLength(0);
  });

  for (const effect of ["write", "read"] as const) {
    it(`${effect} + no principal → the ask IS sent, with principal null`, async () => {
      const t = fakeTransport(body({ approvalId: ID, outcome: "allowed", reference: REF }));
      const d = await evaluateDecisionGates(tool({ effect }), { approval: ID }, {}, { transport: t.transport });
      expect(d.allowed).toBe(true);
      expect(t.calls).toHaveLength(1);
      expect(t.calls[0]!.request.principal).toBeNull();
      expect(t.calls[0]!.request.effect).toBe(effect);
    });
  }

  it("irreversible WITH a principal → sent, principal verbatim, the gate block passed through", async () => {
    const t = fakeTransport(body({ approvalId: ID, outcome: "allowed", reference: REF }));
    const d = await evaluateDecisionGates(tool({ effect: "irreversible" }), { approval: ID, source: "ACC-1", memo: null }, { principal: "user-17" }, { transport: t.transport });
    expect(d.allowed).toBe(true);
    expect(t.calls).toHaveLength(1);
    expect(t.calls[0]!.gate).toBe(GATE);
    expect(t.calls[0]!.request).toEqual({
      version: 1,
      token: "human-approval",
      capabilityId: "banking.initiate-transfer",
      effect: "irreversible",
      principal: "user-17",
      approvalId: ID,
      input: { approval: ID, source: "ACC-1" },
    });
  });
});

describe("evaluateDecisionGates — outcomes and codes (ADD-393 D-6)", () => {
  it("allowed → allowed, references carry approvalId + reference", async () => {
    const t = fakeTransport(body({ approvalId: ID, outcome: "allowed", reference: REF }));
    const d = await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: t.transport });
    expect(d).toEqual({ allowed: true, references: { "human-approval": { approvalId: ID, reference: REF } } });
  });

  const table: [string, "human-approval" | "consent-required", "pending" | "refused", string][] = [
    ["approval pending", "human-approval", "pending", APPROVAL_PENDING_REASON],
    ["approval refused", "human-approval", "refused", APPROVAL_REFUSED_REASON],
    ["consent pending", "consent-required", "pending", CONSENT_PENDING_REASON],
    ["consent refused", "consent-required", "refused", CONSENT_REFUSED_REASON],
  ];
  for (const [label, token, outcome, code] of table) {
    it(`${label} → ${code}`, async () => {
      const t = fakeTransport((req) => body({ approvalId: req.approvalId, outcome }));
      const capTool = token === "human-approval" ? tool() : tool({ policies: ["consent-required"], approval: undefined, consent: CONSENT_GATE });
      const d = denialOf(await evaluateDecisionGates(capTool, { approval: ID, consent: ID }, { principal: "p" }, { transport: t.transport }));
      expect(d.denial.reason).toBe(code);
      expect(d.references).toEqual({ [token]: { approvalId: ID } });
      expect(t.calls).toHaveLength(1);
    });
  }

  it("the code strings are exactly the four the ADD names", () => {
    expect([APPROVAL_PENDING_REASON, APPROVAL_REFUSED_REASON, CONSENT_PENDING_REASON, CONSENT_REFUSED_REASON]).toEqual([
      "approval_pending",
      "approval_refused",
      "consent_pending",
      "consent_refused",
    ]);
  });

  it("pending's message points the agent at checking the status, not at retrying (§1)", async () => {
    const t = fakeTransport(body({ approvalId: ID, outcome: "pending" }));
    const d = denialOf(await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.message).toBe("capability 'banking.initiate-transfer' needs an approval that is still pending — check the approval's status before calling it again.");
  });

  it("a refused answer with a reference records it", async () => {
    const t = fakeTransport(body({ approvalId: ID, outcome: "refused", reference: REF }));
    const d = denialOf(await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.reason).toBe(APPROVAL_REFUSED_REASON);
    expect(d.references).toEqual({ "human-approval": { approvalId: ID, reference: REF } });
  });
});

describe("evaluateDecisionGates — consent before approval (ADD-393 §2)", () => {
  const both = () => tool({ policies: ["human-approval", "consent-required"], consent: CONSENT_GATE });
  const input = { approval: ID, consent: "CON-7" };

  it("asks consent first, then approval; both allowed → both references", async () => {
    const t = fakeTransport((req) => body({ approvalId: req.approvalId, outcome: "allowed", reference: `R-${req.token}` }));
    const d = await evaluateDecisionGates(both(), input, { principal: "p" }, { transport: t.transport });
    expect(t.calls.map((c) => c.request.token)).toEqual(["consent-required", "human-approval"]);
    expect(t.calls[0]!.gate).toBe(CONSENT_GATE);
    expect(t.calls[0]!.request.approvalId).toBe("CON-7");
    expect(t.calls[1]!.gate).toBe(GATE);
    expect(d).toEqual({
      allowed: true,
      references: {
        "consent-required": { approvalId: "CON-7", reference: "R-consent-required" },
        "human-approval": { approvalId: ID, reference: "R-human-approval" },
      },
    });
  });

  for (const outcome of ["pending", "refused"] as const) {
    it(`consent ${outcome} → approval never asked`, async () => {
      const t = fakeTransport((req) => body({ approvalId: req.approvalId, outcome }));
      const d = denialOf(await evaluateDecisionGates(both(), input, { principal: "p" }, { transport: t.transport }));
      expect(d.denial.reason).toBe(outcome === "pending" ? CONSENT_PENDING_REASON : CONSENT_REFUSED_REASON);
      expect(t.calls).toHaveLength(1);
      expect(t.calls[0]!.request.token).toBe("consent-required");
      expect(d.references).toEqual({ "consent-required": { approvalId: "CON-7" } });
    });
  }

  it("consent unevaluatable → approval never asked", async () => {
    const t = fakeTransport({ ok: false, sent: true, detail: "the endpoint answered HTTP 500" });
    const d = denialOf(await evaluateDecisionGates(both(), input, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(t.calls).toHaveLength(1);
  });

  it("consent allowed, approval refused → approval_refused, both references kept", async () => {
    const t = fakeTransport((req) =>
      body(req.token === "consent-required" ? { approvalId: req.approvalId, outcome: "allowed", reference: "C-1" } : { approvalId: req.approvalId, outcome: "refused" }),
    );
    const d = denialOf(await evaluateDecisionGates(both(), input, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.reason).toBe(APPROVAL_REFUSED_REASON);
    expect(d.references).toEqual({ "consent-required": { approvalId: "CON-7", reference: "C-1" }, "human-approval": { approvalId: ID } });
  });
});

describe("evaluateDecisionGates — every request-free refusal is decided before any ask (ADD-393 §4 'before any request')", () => {
  const both = () => tool({ policies: ["human-approval", "consent-required"], consent: CONSENT_GATE });

  it("a valid consent id but an invalid approval id → input_invalid, consent never asked", async () => {
    const t = fakeTransport((req) => body({ approvalId: req.approvalId, outcome: "allowed", reference: "C-1" }));
    const d = denialOf(await evaluateDecisionGates(both(), { consent: "CON-7", approval: "" }, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.reason).toBe("input_invalid");
    expect(d.denial.problems).toEqual([{ path: "approval", expected: APPROVAL_ID_EXPECTED }]);
    expect(t.calls).toHaveLength(0);
    expect(d.references).toBeUndefined();
  });

  it("a consent gate present but the approval gate missing → policy_unevaluatable, consent never asked", async () => {
    const t = fakeTransport(body({}));
    const d = denialOf(
      await evaluateDecisionGates(tool({ policies: ["human-approval", "consent-required"], approval: undefined, consent: CONSENT_GATE }), { consent: "CON-7", approval: ID }, { principal: "p" }, { transport: t.transport }),
    );
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(t.calls).toHaveLength(0);
  });

  it("a transport that refused before sending (sent: false) → policy_unevaluatable, no reference recorded", async () => {
    const t = fakeTransport({ ok: false, sent: false, detail: "the ask's Authorization secret is empty" });
    const d = denialOf(await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(d.references).toBeUndefined();
  });

  it("consent allowed, then the approval transport refuses before sending → only the consent reference", async () => {
    const t = fakeTransport((req) =>
      req.token === "consent-required" ? body({ approvalId: req.approvalId, outcome: "allowed", reference: "C-1" }) : { ok: false, sent: false, detail: "missing env var(s): T" },
    );
    const d = denialOf(await evaluateDecisionGates(both(), { consent: "CON-7", approval: ID }, { principal: "p" }, { transport: t.transport }));
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(d.references).toEqual({ "consent-required": { approvalId: "CON-7", reference: "C-1" } });
  });
});

describe("evaluateDecisionGates — every non-answer is policy_unevaluatable, traceable to the id sent (ADD-393 D-5, D-7)", () => {
  const nonAnswers: [string, ApprovalAskResult | Error][] = [
    ["transport failure", { ok: false, sent: true, detail: "the endpoint answered HTTP 404" }],
    ["transport throw", new Error("boom at https://approvals.test with Bearer s3cr3t")],
    ["wrong echo", body({ approvalId: "APR-OTHER", outcome: "allowed", reference: REF })],
    ["missing echo", body({ outcome: "allowed", reference: REF })],
    ["unknown outcome", body({ approvalId: ID, outcome: "approved", reference: REF })],
    ["boolean outcome", body({ approvalId: ID, outcome: true, reference: REF })],
    ["allowed without reference", body({ approvalId: ID, outcome: "allowed" })],
    ["reference too long", body({ approvalId: ID, outcome: "allowed", reference: "r".repeat(513) })],
    ["non-object", body("allowed")],
    ["array", body([])],
    ["null", body(null)],
  ];
  for (const [label, answer] of nonAnswers) {
    it(`${label} → policy_unevaluatable with references carrying the approvalId (the ask was sent)`, async () => {
      const t = fakeTransport(answer);
      const d = denialOf(await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: t.transport }));
      expect(d.denial.reason).toBe("policy_unevaluatable");
      expect(d.references).toEqual({ "human-approval": { approvalId: ID } });
      expect(t.calls).toHaveLength(1);
      expect(d.denial.message).not.toContain(ID);
      expect(d.denial.message).not.toContain("s3cr3t");
      expect(d.denial.message).not.toContain("approvals.test");
    });
  }
});

describe("evaluateDecisionGates — the embedder resolver (ADD-393 §9, OR-2)", () => {
  it("replaces the transport: resolver called with the exact request, transport never called", async () => {
    const t = fakeTransport(body({}));
    const seen: ApprovalRequest[] = [];
    const resolver: ApprovalResolver = {
      resolve: async (req) => {
        seen.push(req);
        return { approvalId: req.approvalId, outcome: "allowed", reference: REF };
      },
    };
    const d = await evaluateDecisionGates(tool(), { approval: ID, x: null }, { principal: "p" }, { transport: t.transport, resolver });
    expect(d).toEqual({ allowed: true, references: { "human-approval": { approvalId: ID, reference: REF } } });
    expect(t.calls).toHaveLength(0);
    expect(seen).toEqual([buildApprovalRequest(tool(), "human-approval", ID, { approval: ID }, "p")]);
  });

  it("its answer goes through the same validation: a wrong echo → policy_unevaluatable", async () => {
    const t = fakeTransport(body({}));
    const resolver: ApprovalResolver = { resolve: async () => ({ approvalId: "APR-OTHER", outcome: "allowed", reference: REF }) };
    const d = denialOf(await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: t.transport, resolver }));
    expect(d.denial.reason).toBe("policy_unevaluatable");
    expect(d.references).toEqual({ "human-approval": { approvalId: ID } });
    expect(t.calls).toHaveLength(0);
  });

  it("…and allowed without a reference → policy_unevaluatable", async () => {
    const resolver = { resolve: async () => ({ approvalId: ID, outcome: "allowed" }) } as unknown as ApprovalResolver;
    const d = denialOf(await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: fakeTransport(body({})).transport, resolver }));
    expect(d.denial.reason).toBe("policy_unevaluatable");
  });

  it("pending/refused from the resolver map to the same codes", async () => {
    for (const [outcome, code] of [["pending", APPROVAL_PENDING_REASON], ["refused", APPROVAL_REFUSED_REASON]] as const) {
      const resolver: ApprovalResolver = { resolve: async (r) => ({ approvalId: r.approvalId, outcome }) };
      const d = denialOf(await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: fakeTransport(body({})).transport, resolver }));
      expect(d.denial.reason).toBe(code);
    }
  });

  it("a throw or a rejection → policy_unevaluatable, the thrown text never surfaced", async () => {
    const throwing: ApprovalResolver = {
      resolve: () => {
        throw new Error("DB-SECRET-dsn");
      },
    };
    const rejecting: ApprovalResolver = { resolve: () => Promise.reject(new Error("DB-SECRET-dsn")) };
    for (const resolver of [throwing, rejecting]) {
      const d = denialOf(await evaluateDecisionGates(tool(), { approval: ID }, { principal: "p" }, { transport: fakeTransport(body({})).transport, resolver }));
      expect(d.denial.reason).toBe("policy_unevaluatable");
      expect(d.denial.message).not.toContain("DB-SECRET");
      expect(d.references).toEqual({ "human-approval": { approvalId: ID } });
    }
  });
});

describe("evaluateDecisionGates — denial messages disclose nothing (BR-30)", () => {
  const input = { approval: ID, beneficiary: "BEN-SECRET-9", amount: { amount: 987654, currency: "EUR" } };
  const answers: ApprovalAskResult[] = [
    body({ approvalId: ID, outcome: "pending", reason: "ENDPOINT-TEXT pending because" }),
    body({ approvalId: ID, outcome: "refused", reason: "ENDPOINT-TEXT refused because" }),
    body({ approvalId: "ENDPOINT-TEXT", outcome: "allowed", reference: REF }),
    body({ approvalId: ID, outcome: "ENDPOINT-TEXT" }),
    body({ approvalId: ID, outcome: "allowed", reference: "ENDPOINT-TEXT with spaces" }),
  ];
  for (const answer of answers) {
    it(`never carries the approval id, an input value or endpoint text — ${JSON.stringify(answer).slice(0, 70)}`, async () => {
      const t = fakeTransport(answer);
      const d = denialOf(await evaluateDecisionGates(tool(), input, { principal: "p" }, { transport: t.transport }));
      for (const needle of [ID, "BEN-SECRET", "987654", "ENDPOINT-TEXT", "https://approvals.test", "/approvals/consume"]) {
        expect(d.denial.message).not.toContain(needle);
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// D-7 — the record
// ---------------------------------------------------------------------------------------------

describe("buildExecutionRecord — status.decisionReferences (ADD-393 D-7)", () => {
  it("is copied unscrubbed, even when the id equals the caller's accessToken, and the record validates", () => {
    const token = "tok-equal-ABC123";
    const refs = { "human-approval": { approvalId: token, reference: REF }, "consent-required": { approvalId: "CON-7" } };
    const r = buildExecutionRecord({
      tool: tool(),
      input: { approval: token },
      consumer: "mcp",
      caller: { principal: "p", accessToken: token },
      startedAt: auditNow(),
      status: { phase: "succeeded", decisionReferences: refs },
    });
    expect(r.status.decisionReferences).toEqual(refs);
    // A copy, not the caller's object.
    expect(r.status.decisionReferences).not.toBe(refs);
    // The scrub still applies where it always did: the input value equal to the token is redacted.
    expect(JSON.stringify(r.spec)).not.toContain(token);
    const v = validateExecution(r);
    expect(v.errors).toBe("");
    expect(v.ok).toBe(true);
  });

  it("validates on a denied record with each of the four new codes, carrying the id of the ask sent", () => {
    for (const denialReason of [APPROVAL_PENDING_REASON, APPROVAL_REFUSED_REASON, CONSENT_PENDING_REASON, CONSENT_REFUSED_REASON] as const) {
      const r = buildExecutionRecord({
        tool: tool(),
        input: {},
        consumer: "function-calling",
        startedAt: auditNow(),
        status: { phase: "denied", message: "no", denialReason, decisionReferences: { "human-approval": { approvalId: ID } } },
      });
      const v = validateExecution(r);
      expect(v.errors).toBe("");
      expect(r.status.decisionReferences).toEqual({ "human-approval": { approvalId: ID } });
    }
  });

  it("is absent when the status carries none", () => {
    const r = buildExecutionRecord({ tool: tool(), input: {}, consumer: "mcp", startedAt: auditNow(), status: { phase: "succeeded" } });
    expect("decisionReferences" in r.status).toBe(false);
  });

  it("the schema closes it: an unknown token or member fails validation", () => {
    const r = buildExecutionRecord({
      tool: tool(),
      input: {},
      consumer: "mcp",
      startedAt: auditNow(),
      status: { phase: "succeeded", decisionReferences: { "human-approval": { approvalId: ID, reference: REF } } },
    });
    expect(validateExecution({ ...r, status: { ...r.status, decisionReferences: { "rate-limited": { approvalId: ID } } } }).ok).toBe(false);
    expect(validateExecution({ ...r, status: { ...r.status, decisionReferences: { "human-approval": { approvalId: ID, reason: "x" } } } }).ok).toBe(false);
    expect(validateExecution({ ...r, status: { ...r.status, decisionReferences: { "human-approval": { reference: REF } } } }).ok).toBe(false);
  });
});
