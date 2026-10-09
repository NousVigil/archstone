// Caller resolution for the demo Worker. The Worker asserts a principal from a two-entry table of
// PUBLISHED keys (examples/showcase/credentials.mjs); it verifies nothing beyond that lookup, and
// the principal is an opaque string to Archstone. Every value reachable through these keys is
// invented.
import { DEMO_KEYS, callerFor, type DemoCaller } from "../../../showcase/credentials.mjs";

export type KeyLabel = "none" | "A" | "B";

/**
 * The caller for an `Authorization` header, or `undefined` for no header at all.
 *
 *  - key A            -> accessToken + principal `demo:visitor`
 *  - key B            -> accessToken + principal `demo:blocked`
 *  - any other bearer -> credential present, principal absent (the synthetic API then answers 401)
 *  - a header that is present but is not `Bearer <token>` -> THROWS. The caller of this function
 *    turns that into `callerResolutionFailed`, which the runtime reports as `policy_unevaluatable`.
 */
export function resolveCaller(authorization: string | null): DemoCaller | undefined {
  if (authorization === null) return undefined;
  const m = /^Bearer\s+(\S+)$/i.exec(authorization.trim());
  if (!m) throw new Error("Authorization header is present but is not a Bearer credential");
  const token = m[1];
  for (const entry of Object.values(DEMO_KEYS)) {
    if (entry.key === token) return { accessToken: token, principal: entry.principal };
  }
  return { accessToken: token };
}

/** The caller a scenario's fixed `key` stands for on the browser path. */
export function scenarioCaller(label: KeyLabel): DemoCaller | undefined {
  return callerFor(label);
}

/** The `caller` field of a `/run` response. */
export function callerName(label: KeyLabel): "none" | "demo key A" | "demo key B" {
  return label === "none" ? "none" : label === "A" ? "demo key A" : "demo key B";
}
