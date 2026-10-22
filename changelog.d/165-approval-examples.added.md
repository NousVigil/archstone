- **The Showcase has an approval flow, and a reference endpoint for the `human-approval` gate.**
  Three new capabilities let an agent ask a person to approve a payment or a cancellation, and read
  the decision: `wanderlust.request-payment-approval`, `wanderlust.request-cancellation-approval`
  and `wanderlust.approval-status`. The synthetic agency serves them, plus a decision route that a
  person uses and no capability binds. It also serves `POST /v1/approvals/consume`, the endpoint
  Archstone asks before a gated call. That endpoint matches the approval to the capability, the
  principal and the full input, refuses a `null` principal, and consumes an `irreversible` approval
  in the same step that answers `allowed`. `docs/ONBOARDING.md` gains an "Approval and consent"
  section. Once a capability is gated, the call is refused unless the deployer's endpoint answers
  `allowed` for it. Single use is the endpoint's contract, which Archstone cannot observe.
  `archstone serve` carries no principal today, so a gated `irreversible` capability needs the
  embedded SDK or a host `resolveCaller` (#165).
