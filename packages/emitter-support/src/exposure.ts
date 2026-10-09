// @archstone/emitter-support — lifecycle -> exposure lowering (ADD-24)
//
// The one pure, MCP-SDK-free, fs-free mechanism mapping a tool's authored `lifecycle`
// (compile-time, IR-carried) — and, only at the Registry layer, an optional binding-health
// reading (runtime-computed, never IR — ADD-24 D-7) — to a target-agnostic EXPOSURE:
//   - listed:    should this tool appear in a discovery listing (e.g. MCP tools/list)?
//   - invocable: may this tool be called at all?
//   - hint:      an optional severity + human-readable text an emitter MAY surface
//                (e.g. appended to an MCP tool's `description`).
//
// This is the ONLY place lifecycle/health compose into a listing/invocation decision.
// Never re-implemented per emitter (ADD-24 D-6, R-5) — MCP-specific rendering (how a hint
// becomes description text, how tools/list filters, the `_meta` rejection shape) belongs
// only in @archstone/runtime's server.ts, never here.

import type { Lifecycle } from "@archstone/compiler";

/** Binding health, as already produced by `archstone verify` (`ToolVerification.status`,
 *  runtime/src/verify.ts) — re-declared here as the canonical, dependency-direction-safe
 *  home (runtime depends on emitter-support, never the reverse) so both packages share one
 *  definition instead of two independently-maintained unions. */
export type HealthStatus = "green" | "yellow" | "red";

export type HintLevel = "caution" | "deprecation";

export interface ExposureHint {
  level: HintLevel;
  text: string;
}

/** A tool's neutral exposure — what any emitter (MCP today; OpenAPI/docs later) does with
 *  it is that emitter's own concern. */
export interface Exposure {
  listed: boolean;
  invocable: boolean;
  hint?: ExposureHint;
  /**
   * ADD-56 D-2: populated ONLY when `invocable:false`, naming which of the two possible block
   * reasons produced it — `"retired"` (a business withdrew this capability, ADD-24 D-10) or
   * `"unevaluatable"` (this build does not recognize the declared `lifecycle` value at all,
   * ADD-56 D-1). The two are different facts with different remediations (a business decision
   * to un-retire, vs. a runtime/compiler upgrade) and must never be conflated in the audit
   * trail — see `callTool`/`executeCapability`'s own comments at the exposure gate.
   *
   * Always absent when `invocable:true`. Also absent for `Registry.getExposure`'s unknown-id
   * fallback (D-4) — there is no tool to report a block reason about, which is exactly what
   * distinguishes that case from either of these two.
   */
  blockedReason?: "retired" | "unevaluatable";
}

/** Severity order, defined once (`none < caution < deprecation`) so health composition
 *  (`combineExposure`, below) can raise — never invent or lower — a lifecycle-derived hint. */
const SEVERITY_ORDER: Record<"none" | HintLevel, number> = { none: 0, caution: 1, deprecation: 2 };

function severityOf(hint: ExposureHint | undefined): number {
  return SEVERITY_ORDER[hint?.level ?? "none"];
}

/**
 * Map a capability's authored `lifecycle` (a pure compile-time fact, ADD-24 D-1) to its
 * exposure. Per-state behavior (ADD-24 D-10 / capability-lifecycle.md §3):
 *  - experimental → listed:false, invocable:true — unlisted but reachable by id ("opt-in
 *    by knowing it"; no opt-in flag/Policy mechanism exists to make this conditional).
 *  - beta         → listed:true,  invocable:true, hint: caution.
 *  - stable       → listed:true,  invocable:true, no hint.
 *  - deprecated   → listed:true,  invocable:true, hint: deprecation. The draft's "or hidden
 *    by Policy" branch is explicitly deferred (ADD-24 D-10/R-3) — no Policy engine exists.
 *  - retired      → listed:false, invocable:false, blockedReason:"retired" — a governance
 *    refusal (ADD-24 D-10); this is the sole gate `callTool` must enforce beyond bindings.
 *
 * R-4 (ADD-24): `beta`/`deprecated` differ only in hint text, not listed/invocable — a valid
 * MVP simplification (every one of the five states still gets a faithful, distinct lowering
 * as a whole), not a missing behavior.
 *
 * ADD-56 D-1/R-1: THIS FUNCTION IS TOTAL — the `default` branch below is NOT dead code, even
 * though `lifecycle`'s static type (`Lifecycle`) is a closed five-member union and TypeScript's
 * own exhaustiveness narrowing will therefore prove the branch "unreachable" from the type
 * checker's point of view (verified empirically in ADD-56 §1: `tsc --strict
 * --noImplicitReturns` does not flag a missing `default` on an exhausted literal-union switch).
 * The type system is right about the type and wrong about the data: `lifecycle` reaches this
 * function un-runtime-validated whenever it arrives via `fromIR`'s `json as IR` cast
 * (`agent/src/index.ts`) — a hand-written or forward-versioned artifact can carry ANY string
 * (or a non-string, or an absent field) here, by design (ADD-0008 D-2, `fromIR` validates only
 * `version === "0"`). Before this ADD, that fell off the end of the switch and returned
 * `undefined`, which `Registry`'s constructor stored as a real `Map` value, and
 * `getExposure`'s `?? {listed:true, invocable:true}` fallback could not tell apart from a
 * missing key — the capability became fully listed and fully invocable. This `default` branch
 * is what makes that impossible: every call now returns a real `Exposure`, fail-closed, exactly
 * like `retired` but distinguishably (`blockedReason:"unevaluatable"`, never `"retired"`) so a
 * governance refusal and a compatibility refusal are never conflated downstream. Do not remove
 * this branch on the reasoning that "the switch is already exhaustive" — that reasoning is
 * exactly the trap; see `policy.ts`'s `unevaluatable()` guard for the same precedent at the
 * same trust boundary.
 */
export function lifecycleExposure(lifecycle: Lifecycle): Exposure {
  switch (lifecycle) {
    case "experimental":
      return { listed: false, invocable: true };
    case "beta":
      return { listed: true, invocable: true, hint: { level: "caution", text: "beta — interface may still change" } };
    case "stable":
      return { listed: true, invocable: true };
    case "deprecated":
      return { listed: true, invocable: true, hint: { level: "deprecation", text: "deprecated — avoid new usage" } };
    case "retired":
      return { listed: false, invocable: false, blockedReason: "retired" };
    default:
      // ADD-56 D-1: `lifecycle` crossed the `fromIR` trust boundary without runtime validation
      // (see this function's own doc comment) and matched none of the five known literals — the
      // most restrictive, same-shaped response as `retired`, but distinguishably so.
      return { listed: false, invocable: false, blockedReason: "unevaluatable" };
  }
}

/** Where a capability stands on the surface a model sees (#173). `exposed`: advertised and
 *  callable. `unlisted`: callable by id but not advertised (`experimental`). `not_exposed`:
 *  neither advertised nor callable — `retired` (a business withdrew it), `unevaluatable` (a
 *  lifecycle this build does not recognise), or `unbound` (no binding to call). */
export type Surface =
  | { state: "exposed" }
  | { state: "unlisted"; reason: "experimental" }
  | { state: "not_exposed"; reason: "retired" | "unevaluatable" | "unbound" };

/** Lower a combined exposure plus boundness to a `Surface`. `exposed` holds exactly when the
 *  capability is bound and `listed` — the `Registry.listedTools()` predicate. */
export function surfaceOf(exposure: Exposure, bound: boolean): Surface {
  if (exposure.blockedReason) return { state: "not_exposed", reason: exposure.blockedReason };
  if (!bound) return { state: "not_exposed", reason: "unbound" };
  if (!exposure.listed) return { state: "unlisted", reason: "experimental" };
  return { state: "exposed" };
}

function healthHint(health: HealthStatus): ExposureHint | undefined {
  switch (health) {
    case "red":
      return { level: "deprecation", text: "binding health: red — the last contract verification failed" };
    case "yellow":
      return { level: "caution", text: "binding health: yellow — the last contract verification was degraded" };
    case "green":
      return undefined;
    default:
      // ADD-56 D-5: zero-risk hardening, NOT a fix to a reachable defect — verified unreachable
      // through any untrusted path today. `HealthStatus` values are pre-filtered through
      // `HEALTH_STATUSES` (runtime/src/registry.ts) before ever reaching this function, unlike
      // `lifecycle` above. Matches `"green"`'s existing behavior (no hint) for symmetry with the
      // sibling switch, not because an unrecognized reading is a live hazard.
      return undefined;
  }
}

/**
 * Compose a tool's lifecycle-derived exposure with its (optional) binding health reading.
 * Health only ever RAISES hint severity (`max(lifecycle-derived, health-derived)`, ADD-24 §7
 * step 5) — it NEVER sets `invocable:false` and NEVER touches `listed` (ADD-24 D-9):
 * invocation-blocking authority stays exclusively `lifecycle: retired`'s (D-10), because the
 * always-fresh, per-call safety net is the response-mapping validator (ADD-12/19), not a
 * possibly-stale cached health snapshot (ADD-24 R-2). Absent health (no snapshot, or the tool
 * has no contract) leaves `base` untouched.
 */
export function combineExposure(base: Exposure, health?: HealthStatus): Exposure {
  if (!health) return base;
  const hint = healthHint(health);
  if (!hint || severityOf(hint) <= severityOf(base.hint)) return base;
  return { ...base, hint };
}
