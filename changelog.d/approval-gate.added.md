- **`human-approval` and `consent-required` are enforced.** A gated capability takes the approval
  id as an ordinary required input, which the agent obtains through capabilities the deployer
  authors. Its binding declares an `approval:` (or `consent:`) block: one authenticated `POST` to
  the deployer's own endpoint, after the rate limit and before the provider. Archstone builds the
  body itself: `{ version, token, capabilityId, effect, principal, approvalId, input }`. **The
  call is refused unless the deployer's endpoint answers `allowed` for it.** The endpoint answers
  `{ approvalId, outcome: allowed | pending | refused, reference }`.
  - Archstone holds no approval state. Single use is the endpoint contract: the endpoint consumes
    an `irreversible` approval in the operation that answers `allowed`.
  - New denial reasons: `approval_pending`, `approval_refused`, `consent_pending` and
    `consent_refused`.
  - Every non-answer is `policy_unevaluatable`. That covers a 404, a timeout (`timeoutSeconds`,
    default 10), a redirect (never followed), a body over 64 KiB, a malformed body and a wrong
    echo.
  - The record carries the presented id and the returned reference in
    `status.decisionReferences`. With an audit sink, `archstone audit` lists an approval id that
    appears on two executed records.
  - A declared token with no gate refuses every call and `apply` warns `approval-gate-missing`.
    `apply` errors when there is no `${VAR}` secret in an `Authorization` header, when the path
    is templated, or when the URL is plain `http:` to anything but loopback.
  - An `irreversible` gated capability with no principal is refused before any ask. No
    `archstone serve` path carries a principal, so gated capabilities are served through the
    embedded SDK or a host `resolveCaller`. Embedders may pass an `approvalResolver` with the same
    request and answer shapes. `apply` and `doctor` no longer report either token as unenforced.
    (#165)
