// S-10 (#165, ADD-393): a person approves before it happens. Asserted from the recorded calls: the
// payment is refused before the agency is asked until a person has approved it, runs once, and is
// refused again with the same approval. Archstone refuses unless the agency's endpoint answers
// `allowed`; that the approval works once is the agency's endpoint using it up.

import { describe, it, expect } from "vitest";
import { calls, expectWellFormed } from "./recorded";

const t = expectWellFormed("S-10", "sdk");
const steps = calls(t);
const outcomes = steps.map((s) => `${s.call.tool} ${(s.result.reason as string | undefined) ?? s.result.status}`);
const approvalOf = (s: (typeof steps)[number]) => s.result.approval as { id: string; status: string } | undefined;

describe("recorded S-10: a person approves before it happens", () => {
  it("tells the whole story in order: refused without, pending, unevaluatable, paid once, refused after", () => {
    expect(outcomes).toEqual([
      "wanderlust.quote ok",
      "wanderlust.book ok",
      "wanderlust.pay input_invalid",
      "wanderlust.request-payment-approval ok",
      "wanderlust.pay approval_pending",
      "wanderlust.approval-status ok",
      "wanderlust.approval-status ok",
      "wanderlust.pay policy_unevaluatable",
      "wanderlust.pay ok",
      "wanderlust.pay approval_refused",
      "wanderlust.approval-status ok",
      "wanderlust.request-cancellation-approval ok",
      "wanderlust.cancel approval_refused",
      "wanderlust.request-cancellation-approval ok",
      "wanderlust.pay approval_refused",
    ]);
  });

  it("the agent waits by reading the status: pending, then approved, then used", () => {
    const statuses = steps.filter((s) => s.call.tool === "wanderlust.approval-status").map((s) => approvalOf(s)!.status);
    expect(statuses).toEqual(["pending", "approved", "used"]);
  });

  it("every gated call presents the approval as a declared input, and the paid call presents the one requested", () => {
    const requested = approvalOf(steps.find((s) => s.call.tool === "wanderlust.request-payment-approval")!)!.id;
    const paid = steps.find((s) => s.call.tool === "wanderlust.pay" && s.result.status === "ok")!;
    expect(paid.call.arguments.approval).toBe(requested);
    expect(t.asserts.map((a) => a.claim)).toContain("its execution record carries the approval presented and the agency's decision reference");
  });

  it("negative: what an agent is told is never more than the approval's id, status and expiry", () => {
    expect(t.asserts.filter((a) => a.negative).map((a) => a.claim)).toContain(
      "an agent is given an approval's id, status and expiry, and nothing else the agency returned (approver contact, requesting principal)",
    );
    expect(JSON.stringify(t)).not.toMatch(/approvals\.desk|\+00 000 000 222|requestedBy|demo-public-key-approver/);
  });

  it("negative: the refusals are claims of the transcript, the agency received one payment", () => {
    const negatives = t.asserts.filter((a) => a.negative).map((a) => a.claim);
    expect(negatives).toContain("the agency received exactly one payment, and no cancellation");
    expect(negatives.some((c) => /not a refusal/.test(c))).toBe(true);
    expect(negatives.some((c) => /the agency used it up/.test(c))).toBe(true);
  });
});
