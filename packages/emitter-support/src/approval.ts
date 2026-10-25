// @archstone/emitter-support — the decision gates: `human-approval` and `consent-required`
// (archstone#165, ADD-393, ADR-0014 as amended).
//
// THE GUARANTEE, in the one sentence every public text uses: a gated call is refused unless the
// deployer's endpoint answers `allowed` for it, in the same invocation. Archstone holds no
// approval state. The agent obtains an approval through ordinary capabilities the deployer
// authors and presents its id as an ordinary required input; the gated capability's binding
// declares one `POST` to the deployer's endpoint; this module builds that request and reads the
// answer. Single use is the endpoint's contract (it consumes an `irreversible` approval in the
// operation that answers `allowed`), which Archstone cannot observe.
//
// WHAT LIVES HERE AND WHAT DOES NOT. Pure: the fixed request body, the answer classifier, the id
// and reference character rules, the reason codes, and the one orchestration both audited
// consumers (`callTool`, `executeCapability`) call — so the two cannot drift (the #30 defect
// class). The HTTP is NOT here: this package never imports `@archstone/provider-rest`
// (`test/boundary.test.ts`). The consumer injects the transport — `askApproval` from
// `providers/rest`, or an embedder's `ApprovalResolver` — and everything that comes back goes
// through the same classifier.
//
// WHERE IT RUNS. After `evaluateRateLimit`, strictly before the connector, consent first: an
// operator is not asked to stand behind a call its data subject has not consented to. A retry
// is therefore a full attempt — it spends a rate-limit unit and sends an ask — which is why the
// `pending` message tells the agent to check the approval's status instead.

import type { IRDecisionGate, IRTool } from "@archstone/compiler";
import type { InputProblem } from "./input";
import { inputInvalidMessage } from "./input";

/** The two CDL tokens resolved by a binding-declared ask. */
export type DecisionToken = "human-approval" | "consent-required";

/** The version of the request body below. A field added to it is a new version. */
export const APPROVAL_REQUEST_VERSION = 1;

/**
 * The body of the ask — built by Archstone and nothing else, never from a template (ADD-393 D-2).
 * Also exactly what an embedder's `ApprovalResolver.resolve` receives.
 */
export interface ApprovalRequest {
  version: typeof APPROVAL_REQUEST_VERSION;
  token: DecisionToken;
  capabilityId: string;
  effect: IRTool["effect"];
  /** Opaque and verbatim (ADD-42 D-1). `null` when the invocation carries none — never sent
   *  `null` for an `irreversible` capability, which is refused before any ask. The endpoint
   *  contract requires a `null` principal to be answered `refused` on every capability. */
  principal: string | null;
  approvalId: string;
  /** The full declared input the input gate accepted, optional fields included, with `null` and
   *  absent members removed and nothing else normalised. */
  input: Record<string, unknown>;
}

/** The only answer shape (ADD-393 D-4). Anything else in the body is ignored, never recorded and
 *  never shown to the agent: free text from the deciding system is a disclosure channel. */
export interface ApprovalAnswer {
  /** Mandatory echo of the `approvalId` sent — binds the answer to this ask. */
  approvalId: string;
  outcome: "allowed" | "pending" | "refused";
  /** Required on `allowed`, optional otherwise. 1–512 visible ASCII characters. */
  reference?: string;
}

/**
 * ADD-393 §9 / OR-2 — the embedder escape hatch. Passed as `approvalResolver` on `InvokeOptions`
 * or `ExecuteOptions`, it REPLACES THE TRANSPORT of every gate: an in-process deployer with
 * approvals in its own database need not stand up an HTTP endpoint to talk to itself.
 *
 * Its limits, stated:
 *  - **It carries no timeout of its own.** The core sets none, so bounding the wait is the
 *    embedder's obligation. A `resolve` that never settles holds the invocation open.
 *  - **It does not lift the gate requirement.** A capability that declares the token still needs
 *    its binding's `approval:`/`consent:` block (which names the id input and declares that the
 *    gate exists); without one the call is refused even when a resolver is supplied.
 *  - Its answer goes through the same validation as an HTTP answer (echo, reference, outcome); a
 *    throw or rejection is `policy_unevaluatable`; the null-principal rule for `irreversible`
 *    applies before it is called.
 *  - `archstone serve` never sets it.
 *
 * The endpoint contract applies to it unchanged: match the approval to this capability,
 * principal and input; for an `irreversible` capability consume it in the operation that answers
 * `allowed`; refuse a used, expired or mismatched approval, and a `null` principal.
 */
export interface ApprovalResolver {
  resolve(request: ApprovalRequest): Promise<ApprovalAnswer>;
}

/** The four reason codes of the gate step (ADD-393 D-6) — one producer each: this module. */
export const APPROVAL_PENDING_REASON = "approval_pending";
export const APPROVAL_REFUSED_REASON = "approval_refused";
export const CONSENT_PENDING_REASON = "consent_pending";
export const CONSENT_REFUSED_REASON = "consent_refused";
export type DecisionDenialReason =
  | typeof APPROVAL_PENDING_REASON
  | typeof APPROVAL_REFUSED_REASON
  | typeof CONSENT_PENDING_REASON
  | typeof CONSENT_REFUSED_REASON;

/** `status.decisionReferences` (ADD-393 D-7): per token, the id presented and the reference a
 *  valid answer returned. Written whenever an ask was SENT. */
export type DecisionReferences = Partial<Record<DecisionToken, { approvalId: string; reference?: string }>>;

/** The answer body cap. Read with a cap by the transport, never `response.text()`. */
export const APPROVAL_ANSWER_MAX_BYTES = 64 * 1024;
/** Default and bounds of `ask.timeoutSeconds`: a lookup-and-consume, not a human wait, leaving
 *  room under the MCP TS SDK client's 60 s default for the connector call that follows. */
export const APPROVAL_TIMEOUT_DEFAULT_SECONDS = 10;
export const APPROVAL_TIMEOUT_MAX_SECONDS = 50;

const VISIBLE_ASCII = /^[\x21-\x7e]+$/;

/** An approval id the gate will send: 1–256 visible ASCII characters (`0x21`–`0x7E`). Anything
 *  else is `input_invalid` before any request — so the value is safe to store unscrubbed. */
export function isValidApprovalId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 256 && VISIBLE_ASCII.test(value);
}

/** A reference the gate will accept: 1–512 visible ASCII characters, or the answer is malformed. */
export function isValidDecisionReference(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 512 && VISIBLE_ASCII.test(value);
}

/** `null` and absent object members removed, recursively through objects (the input gate's own
 *  absent rule); arrays and every other value untouched. */
function withoutAbsent(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(withoutAbsent);
  if (typeof value !== "object" || value === null) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined || v === null) continue;
    out[k] = withoutAbsent(v);
  }
  return out;
}

/** The fixed body of one ask (ADD-393 §2). `input` must already have passed `validateInput`. */
export function buildApprovalRequest(
  tool: IRTool,
  token: DecisionToken,
  approvalId: string,
  input: Record<string, unknown>,
  principal: string | undefined,
): ApprovalRequest {
  return {
    version: APPROVAL_REQUEST_VERSION,
    token,
    capabilityId: tool.id,
    effect: tool.effect,
    principal: principal ?? null,
    approvalId,
    input: withoutAbsent(input) as Record<string, unknown>,
  };
}

/** The classifier's verdict on one answer body. `detail` is Archstone's own wording of what was
 *  wrong — never any text the endpoint sent (BR-30). */
export type AnswerClassification =
  | { kind: "answer"; outcome: ApprovalAnswer["outcome"]; reference?: string }
  | { kind: "unevaluatable"; detail: string };

/**
 * Read one answer body (already parsed JSON, from the transport or a resolver) against the sent
 * id. Pure. Everything but the one valid shape is `unevaluatable` — a missing or wrong echo, an
 * outcome outside the three, `allowed` without a valid reference, a malformed reference on any
 * outcome — never a refusal: the endpoint did not answer, so nothing was decided.
 */
export function classifyAnswer(body: unknown, sentApprovalId: string): AnswerClassification {
  if (typeof body !== "object" || body === null || Array.isArray(body)) {
    return { kind: "unevaluatable", detail: "the answer is not a JSON object" };
  }
  const b = body as Record<string, unknown>;
  if (b.approvalId !== sentApprovalId) {
    return { kind: "unevaluatable", detail: "the answer does not echo the approval id sent" };
  }
  const outcome = b.outcome;
  if (outcome !== "allowed" && outcome !== "pending" && outcome !== "refused") {
    return { kind: "unevaluatable", detail: "the answer's outcome is not allowed, pending or refused" };
  }
  if (b.reference !== undefined && !isValidDecisionReference(b.reference)) {
    return { kind: "unevaluatable", detail: "the answer's reference is not 1–512 visible ASCII characters" };
  }
  if (outcome === "allowed" && b.reference === undefined) {
    return { kind: "unevaluatable", detail: "the answer is allowed but carries no reference" };
  }
  return b.reference === undefined ? { kind: "answer", outcome } : { kind: "answer", outcome, reference: b.reference as string };
}

/** What the HTTP transport returns: the parsed body of a 2xx answer, or Archstone's own wording
 *  of why there is none (a non-2xx status, a redirect, a timeout, a body over the cap, …). */
export type ApprovalAskResult =
  | { ok: true; body: unknown }
  /** `sent` is `false` only when the transport refused BEFORE any request left — an unset secret,
   *  a non-https URL. It decides whether the record carries the id (ADD-393 §7: written whenever
   *  the ask was SENT). When the transport cannot tell, it says `true`. */
  | { ok: false; detail: string; sent: boolean };

/** The transport the consumer injects — `providers/rest`'s `askApproval`, bound to its options. */
export type ApprovalTransport = (gate: IRDecisionGate, request: ApprovalRequest) => Promise<ApprovalAskResult>;

export type DecisionGateDenialReason = DecisionDenialReason | "policy_unevaluatable" | "input_invalid";

export interface DecisionGateDenial {
  reason: DecisionGateDenialReason;
  /** Agent-facing, and copied verbatim into the audit record. Never carries endpoint text, the
   *  approval id, or any input value. */
  message: string;
  /** On `input_invalid` only: the id field's path and expectation, never its value. */
  problems?: InputProblem[];
}

export type DecisionGateDecision =
  | { allowed: true; references?: DecisionReferences }
  | { allowed: false; denial: DecisionGateDenial; references?: DecisionReferences };

/** Consent first (ADD-393 §2). */
const GATES: readonly { token: DecisionToken; block: "consent" | "approval"; noun: string; pending: DecisionDenialReason; refused: DecisionDenialReason }[] = [
  { token: "consent-required", block: "consent", noun: "consent", pending: CONSENT_PENDING_REASON, refused: CONSENT_REFUSED_REASON },
  { token: "human-approval", block: "approval", noun: "approval", pending: APPROVAL_PENDING_REASON, refused: APPROVAL_REFUSED_REASON },
];

/** The id field's expectation, as `input_invalid` names it. */
export const APPROVAL_ID_EXPECTED = "an id of 1–256 visible ASCII characters";

/**
 * The gate step, identical at both audited consumers. Runs every gate the capability's tokens
 * call for, consent then approval, and stops at the first that does not answer `allowed`.
 *
 * Per gate: the token declared with no block in the binding → `policy_unevaluatable` (fail-closed,
 * ADR-0014 D-3; a resolver does not lift this); an id that is not 1–256 visible ASCII →
 * `input_invalid`, nothing sent; an `irreversible` capability with no principal →
 * `policy_unevaluatable`, nothing sent; otherwise one ask, through `resolver` when supplied, else
 * `transport`. Every refusal that needs no request is decided for every gate before any ask
 * leaves. From the moment an ask is sent, `references` carries its id, so even an unevaluatable
 * ask is traceable to the id presented; an ask the transport refused before sending leaves none.
 */
export async function evaluateDecisionGates(
  tool: IRTool,
  input: Record<string, unknown>,
  caller: { principal?: string },
  how: { transport: ApprovalTransport; resolver?: ApprovalResolver },
): Promise<DecisionGateDecision> {
  let references: DecisionReferences | undefined;
  const deny = (denial: DecisionGateDenial): DecisionGateDecision =>
    references ? { allowed: false, denial, references } : { allowed: false, denial };

  // Every refusal that needs no request is decided for EVERY gate before ANY ask is sent: an
  // invalid approval id must not cost the data subject a consent the endpoint may consume
  // (ADD-393 §4, "before any request").
  const planned: { g: (typeof GATES)[number]; gate: IRDecisionGate; approvalId: string }[] = [];
  for (const g of GATES) {
    if (!tool.policies.includes(g.token)) continue;
    const gate = tool[g.block];
    if (!gate) {
      return deny({
        reason: "policy_unevaluatable",
        message: `capability '${tool.id}' declares policies:[${g.token}] but its binding declares no ${g.block} gate — refusing (fail-closed).`,
      });
    }
    const approvalId = input[gate.input];
    if (!isValidApprovalId(approvalId)) {
      const problems: InputProblem[] = [{ path: gate.input, expected: APPROVAL_ID_EXPECTED }];
      return deny({ reason: "input_invalid", message: inputInvalidMessage(tool.id, problems), problems });
    }
    if (tool.effect === "irreversible" && caller.principal === undefined) {
      return deny({
        reason: "policy_unevaluatable",
        message: `capability '${tool.id}' needs an identified caller for its ${g.noun} — this surface supplies none.`,
      });
    }
    planned.push({ g, gate, approvalId });
  }

  for (const { g, gate, approvalId } of planned) {
    const request = buildApprovalRequest(tool, g.token, approvalId, input, caller.principal);
    const sent = (): void => {
      references = { ...references, [g.token]: { approvalId } };
    };

    let classified: AnswerClassification;
    if (how.resolver) {
      sent();
      try {
        classified = classifyAnswer(await how.resolver.resolve(request), approvalId);
      } catch {
        classified = { kind: "unevaluatable", detail: "the approval resolver threw" };
      }
    } else {
      let asked: ApprovalAskResult;
      try {
        asked = await how.transport(gate, request);
      } catch {
        asked = { ok: false, detail: "the ask could not be sent", sent: true };
      }
      if (asked.ok || asked.sent) sent();
      classified = asked.ok ? classifyAnswer(asked.body, approvalId) : { kind: "unevaluatable", detail: asked.detail };
    }

    if (classified.kind === "unevaluatable") {
      return deny({
        reason: "policy_unevaluatable",
        message: `capability '${tool.id}' could not be evaluated — its ${g.noun} endpoint gave no valid answer (${classified.detail}) — refusing (fail-closed).`,
      });
    }
    if (classified.reference !== undefined) references = { ...references, [g.token]: { approvalId, reference: classified.reference } };
    if (classified.outcome === "pending") {
      return deny({
        reason: g.pending,
        message: `capability '${tool.id}' needs ${g.noun === "approval" ? "an approval" : "a consent"} that is still pending — check the ${g.noun}'s status before calling it again.`,
      });
    }
    if (classified.outcome === "refused") {
      return deny({
        reason: g.refused,
        message: `capability '${tool.id}' was refused: the ${g.noun} presented was not accepted for this call.`,
      });
    }
  }
  return references ? { allowed: true, references } : { allowed: true };
}
