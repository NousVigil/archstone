// S-10: a person approves before it happens (human-approval, ADD-393).
//
// The whole flow, through the embedded SDK against the synthetic agency over HTTP: the agent books,
// asks for an approval, tries to pay while it is pending, waits by reading its status, a person at
// the agency approves (an HTTP call straight to the agency's approvals system, never through
// Archstone and never a capability), the agent pays, and tries to pay again with the same approval.
//
// Expected: the payment runs once, after the approval, and its execution record carries the
// approval it presented and the agency's decision reference. Negative: no approval, a pending one,
// a used one, a rejected one and one granted for another action are each refused before the agency
// is asked to pay; a broken ask (the runtime's secret wrong) is `policy_unevaluatable`, never read
// as a refusal; the agency received exactly one payment.
//
// What this does NOT show, because Archstone does not do it: that the approval works once is the
// agency's ask endpoint consuming it. Archstone refuses unless that endpoint answers `allowed`.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fromIR } from "@archstone/agent";
import { MANIFEST_REL, startApi } from "./lib.mjs";
import { callerFor } from "../credentials.mjs";
import { DEMO_APPROVER_KEY, DEMO_ASK_KEY } from "../api/wanderlust-api.mjs";

export const meta = { id: "S-10", file: "s-10.json", kind: "sdk", title: "A person approves before it happens (human-approval)" };

const DATES = { from: "2027-05-12", to: "2027-05-15" };
const PARTY = { adults: 2 };

export async function run(ctx) {
  const work = ctx.temp("work");
  const api = await startApi();
  ctx.onEnd(api.close);
  ctx.registerApi(api);

  const irPath = join(work, "ir.json");
  const built = await ctx.cli(["build", MANIFEST_REL, "--out", irPath]);
  ctx.check("`build` exits 0 and writes the IR the SDK loads", built.exit === 0);
  const ir = JSON.parse(readFileSync(irPath, "utf8"));
  const sdk = fromIR(ir);

  const records = [];
  const env = { SHOWCASE_API_URL: api.url, SHOWCASE_ASK_TOKEN: DEMO_ASK_KEY };
  const opts = { env, caller: callerFor("A"), auditSink: (r) => records.push(r) };
  /** Every approval object an agent was given, to check its shape below. */
  const seenApprovals = [];
  /** One SDK call, recorded by outcome: the status, the refusal's reason, and an approval's id and
   *  status or a payment's status. (Times and prices stay out, so the transcript has one clock.) */
  const exec = async (id, input, options = opts) => {
    const r = await sdk.execute(id, input, options);
    if (r.data?.approval) seenApprovals.push(r.data.approval);
    ctx.callStep(id, input, {
      status: r.status,
      ...(r.denial ? { reason: r.denial.reason } : {}),
      ...(r.data?.approval ? { approval: { id: r.data.approval.id, status: r.data.approval.status } } : {}),
      ...(r.data?.payment ? { payment: { status: r.data.payment.status } } : {}),
    });
    return r;
  };
  const payments = () => api.requests.filter((r) => r === "POST /v1/payments").length;
  const decide = (id, decision) =>
    fetch(`${api.url}/v1/approvals/${id}/decision`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${DEMO_APPROVER_KEY}` },
      body: JSON.stringify({ decision }),
    });

  // --- the booking the payment is for
  const quote = await exec("wanderlust.quote", { stayId: "ws-1001", dates: DATES, travelers: PARTY });
  const book = await exec("wanderlust.book", { quoteId: quote.data.quote.quoteId, stayId: "ws-1001", dates: DATES, travelers: PARTY, guestName: "Ana Pop" });
  ctx.check("the booking is made (status ok)", book.status === "ok");
  const { bookingId, total, paymentQuote } = book.data.booking;
  const pay = { bookingId, amount: total, paymentQuote };

  // --- no approval at all: the declared input is required
  const bare = await exec("wanderlust.pay", pay);
  ctx.check("a payment without an approval id is refused as input_invalid, and the agency is not asked", bare.status === "error" && bare.denial?.reason === "input_invalid" && payments() === 0, { negative: true });

  // --- the agent asks a person; the approval starts pending
  const requested = await exec("wanderlust.request-payment-approval", pay);
  const approval = requested.data.approval.id;
  ctx.check("the agent requests an approval for exactly this payment, and it starts pending", requested.status === "ok" && requested.data.approval.status === "pending");

  const early = await exec("wanderlust.pay", { ...pay, approval });
  ctx.check("paying while the approval is pending is refused approval_pending, and the agency is not asked to pay", early.denial?.reason === "approval_pending" && payments() === 0, { negative: true });
  const waiting = await exec("wanderlust.approval-status", { approval });
  ctx.check("the agent waits by reading the status, which says pending", waiting.data.approval.status === "pending");

  // --- a person decides, in the agency's system: not a capability, not through Archstone
  const decided = await decide(approval, "approve");
  ctx.check("a person at the agency approves it, outside Archstone (no capability decides)", decided.ok && !ir.tools.some((t) => /decide|decision|grant/i.test(t.id)));
  const approved = await exec("wanderlust.approval-status", { approval });
  ctx.check("the status now says approved", approved.data.approval.status === "approved");

  // --- a broken ask is never a refusal: it fails closed as unevaluatable
  const broken = await exec("wanderlust.pay", { ...pay, approval }, { ...opts, env: { ...env, SHOWCASE_ASK_TOKEN: "wrong-secret" } });
  ctx.check("with the runtime's secret wrong, the agency's endpoint answers 401 and the call is policy_unevaluatable, not a refusal", broken.denial?.reason === "policy_unevaluatable" && payments() === 0, { negative: true });

  // --- the payment runs, once
  const paid = await exec("wanderlust.pay", { ...pay, approval });
  ctx.check("with the approval granted, the payment goes through", paid.status === "ok" && paid.data.payment.status === "paid");
  const paidRecord = records.filter((r) => r.metadata.capabilityId === "wanderlust.pay").at(-1);
  const refs = paidRecord?.status?.decisionReferences?.["human-approval"];
  ctx.check("its execution record carries the approval presented and the agency's decision reference", refs?.approvalId === approval && /^DEC-[0-9a-f]{8}$/.test(refs?.reference ?? ""));

  const reused = await exec("wanderlust.pay", { ...pay, approval });
  ctx.check("the same approval presented again is refused approval_refused: the agency used it up", reused.denial?.reason === "approval_refused", { negative: true });
  const spent = await exec("wanderlust.approval-status", { approval });
  ctx.check("the status says used", spent.data.approval.status === "used");

  // --- a rejected approval, and one granted for another action
  const cancel = { bookingId };
  const asked = await exec("wanderlust.request-cancellation-approval", cancel);
  await decide(asked.data.approval.id, "reject");
  const rejected = await exec("wanderlust.cancel", { ...cancel, approval: asked.data.approval.id });
  ctx.check("a cancellation a person rejected is refused approval_refused", rejected.denial?.reason === "approval_refused", { negative: true });
  const other = await exec("wanderlust.request-cancellation-approval", { bookingId: "B-0000cafe" });
  await decide(other.data.approval.id, "approve");
  const wrongAction = await exec("wanderlust.pay", { ...pay, approval: other.data.approval.id });
  ctx.check("an approval granted to cancel another booking cannot pay for this one: approval_refused", wrongAction.denial?.reason === "approval_refused", { negative: true });

  ctx.check(
    "an agent is given an approval's id, status and expiry, and nothing else the agency returned (approver contact, requesting principal)",
    seenApprovals.length === 6 && seenApprovals.every((a) => Object.keys(a).sort().join() === "expiresAt,id,status"),
    { negative: true },
  );
  ctx.check("the agency received exactly one payment, and no cancellation", payments() === 1 && !api.requests.some((r) => r.endsWith("/cancel")), { negative: true });
}
