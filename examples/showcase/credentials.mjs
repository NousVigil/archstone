// The two PUBLIC demo keys of the Showcase.
//
// These are published on purpose, in this file and in the README: anyone may use them, and they
// unlock nothing but a synthetic agency whose data is invented and whose bookings are derived
// from their inputs, never stored. They exist so the policy scenarios have something to show:
// a credential the backend accepts, and a principal the manifest's policy can allow or deny.
//
//   key A  ->  credential accepted by the synthetic API, principal "demo:visitor" (may book)
//   key B  ->  credential accepted by the synthetic API, principal "demo:blocked" (may not)
//
// The values are obviously fake. Do not reuse this pattern for a real credential.
//
// Plain ESM, no imports, no Node API: the same file is read by the synthetic API, by tests and
// (later) by a Workers runtime.

/** @typedef {{ accessToken?: string, principal?: string }} DemoCaller */

export const DEMO_KEY_A = "demo-public-key-visitor-0000";
export const DEMO_KEY_B = "demo-public-key-blocked-0000";

/** Which public key maps to which principal. The principal is asserted by whoever hosts the
 *  server; Archstone treats it as an opaque string and verifies nothing about it. */
export const DEMO_KEYS = Object.freeze({
  A: Object.freeze({ key: DEMO_KEY_A, principal: "demo:visitor" }),
  B: Object.freeze({ key: DEMO_KEY_B, principal: "demo:blocked" }),
});

/** Every bearer value the synthetic API accepts. */
export const ACCEPTED_KEYS = Object.freeze([DEMO_KEY_A, DEMO_KEY_B]);

/**
 * The caller context for a scenario's `key` label: "A" and "B" are the two public keys,
 * "none" is an anonymous call (no credential, no principal).
 *
 * @param {"none" | "A" | "B"} label
 * @returns {DemoCaller | undefined}
 */
export function callerFor(label) {
  if (label === "none") return undefined;
  const k = DEMO_KEYS[label];
  return { accessToken: k.key, principal: k.principal };
}
