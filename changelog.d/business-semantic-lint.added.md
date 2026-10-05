- **`archstone apply` checks what an `irreversible` capability declares** (`@archstone/compiler`,
  `@archstone/cli`). Three warnings, each naming the capability and what to change, in both `apply`
  and `archstone doctor`: an `irreversible` capability with no `failures`; one that neither
  declares `policies:[authenticated]` nor has a Policy `allow` list; and one declaring a policy
  token this version does not enforce. The last replaces the existing per-token warning for that
  capability and token, so a script matching the old wording for an `irreversible` capability will
  no longer match it. Warnings never change the exit code of either command. In `doctor --json`
  they appear in `findings` with codes `irreversible-no-failures`, `irreversible-unauthenticated`
  and `irreversible-unenforced-policy` (the last carries `token`). Available to code as
  `lintIR(ir, model)`, pure and offline. The rules are checks over the declaration, not over the
  backend: `archstone verify` is still the check against the provider.
