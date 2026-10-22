- **The examples run the `human-approval` gate end to end, with a reference endpoint to copy.** In the
  Showcase, an agent asks a person to approve (`wanderlust.request-payment-approval`,
  `wanderlust.request-cancellation-approval`), waits by reading `wanderlust.approval-status`, and
  passes the approval id to `wanderlust.pay` or `wanderlust.cancel`. Both are now gated. The
  synthetic agency serves `POST /v1/approvals/consume`, the endpoint Archstone asks: it matches the
  approval to the capability, the principal and the full input, refuses a `null` principal, and
  uses an `irreversible` approval up in the same step that answers `allowed`. A person decides on a
  route no capability binds. The bank example gains the same flow for
  `banking.initiate-transfer`. Scenario S-10 is no longer locked: it is a recorded transcript of the
  whole flow. `docs/ONBOARDING.md` gains "Approval and consent". The call is refused unless the
  deployer's endpoint answers `allowed` for it; single use is that endpoint's contract, which
  Archstone cannot observe. `archstone serve` carries no principal today, so a gated `irreversible`
  capability needs the embedded SDK or a host `resolveCaller`, as the demo Worker has (#165).
- **Breaking, examples only:** `wanderlust.pay`, `wanderlust.cancel` and `banking.initiate-transfer`
  take a new required `approval` input, and a call without an approval the deployer's endpoint
  allows is refused.
