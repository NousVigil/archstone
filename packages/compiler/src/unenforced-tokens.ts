// @archstone/compiler — the one list of CDL policy tokens this version does not enforce.
//
// Internal: deliberately NOT re-exported from `index.ts`. Two rules read it — BR-40 in
// `validate.ts` (every capability) and the `irreversible-unenforced-policy` lint in `lint.ts`
// (irreversible ones; ADD-311) — and a token gaining enforcement (`rate-limited` is #45's) must
// leave both in one edit. A token's three sentences therefore live together here: why it is not
// enforced (BR-40's own text, moved verbatim), what that means for a caller, and what to do.

export interface UnenforcedToken {
  /** BR-40's reason, verbatim. */
  why: string;
  /** What the lack of enforcement means for an `irreversible` capability. */
  consequence: string;
  /** What to change instead. */
  action: string;
}

/**
 * CDL policy tokens (`cdl.schema.json`'s closed enum) that Archstone does NOT enforce in this
 * version. `authenticated` is deliberately absent — it is enforced, at the one evaluation point
 * (#43 / ADD-43 D-4), so it must not be warned about.
 */
export const UNENFORCED_POLICY_TOKENS: Readonly<Record<string, UnenforcedToken>> = {
  "rate-limited": {
    why: "enforcing it needs invocation counting and therefore state — tracked as issue #45",
    consequence: "An agent can run it as often as it is called.",
    action: "Attach a Policy document with spec.rateLimit, which is enforced, or limit it in the provider.",
  },
  "tenant-scoped": {
    why: "which tenant's data a call may touch is a separate axis from identity, and is deliberately not implemented yet",
    consequence: "Archstone does not confine a call to one tenant's data.",
    action: "Confine it in the provider.",
  },
  "human-approval": {
    why: "no approval mechanism exists",
    consequence: "An agent can run it without anyone approving.",
    action: "Put the approval step in the provider, or do not serve this capability to an agent unattended.",
  },
  "consent-required": {
    why: "no consent mechanism exists",
    consequence: "An agent can run it without anyone recording consent.",
    action: "Collect consent in the provider, or do not serve this capability to an agent unattended.",
  },
};
