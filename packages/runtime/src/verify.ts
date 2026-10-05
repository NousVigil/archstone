// @archstone/runtime — Contract probe runner (ADD-18 / RFC-0006 Phase 2).
//
// `runVerify` replays a bound tool's golden fixture against the LIVE backend and
// derives a health status. This is the only place outside a real MCP invocation that
// makes a network call — always explicit, on demand (`archstone verify`), never
// triggered by `apply`/`serve` — and, since #124/ADD-124, never for a `write`/`irreversible`
// capability unless the operator asserts a sandbox. Reuses #12's `applyResponseMapping` verbatim (ADD-18
// D-3/R-4): one mapper, so a probe VIOLATION is exactly what a real call would see.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  describeShape,
  diffShape,
  fingerprintShape,
  fingerprintShapeMap,
  hasShapeDrift,
  shapeDriftSummary,
  type IRContract,
  type IRTool,
  type IRResourceRegistry,
  type ShapeDiff,
  type ShapeMap,
} from "@archstone/compiler";
import { evaluatePolicy, hasIdentityClaims, lifecycleExposure, passThroughRefusal } from "@archstone/emitter-support";
import { applyResponseMapping } from "./mapping";
import { invokeConnector, type ConnectorInvokeOptions } from "./connector";

// ADR-0012 D-6: the union options type (rest fields + sql fields, incl. `identityAdapter`).
type InvokeOptions = ConnectorInvokeOptions;
// ADD-24: HealthStatus's canonical home moved to @archstone/emitter-support (registry.ts's
// exposure composition needs it, and runtime depends on emitter-support, never the reverse) —
// re-exported here, unchanged, so nothing downstream (e.g. the CLI's `HealthStatus` import
// from "@archstone/runtime") breaks.
import type { HealthStatus } from "@archstone/emitter-support";
export type { HealthStatus } from "@archstone/emitter-support";

export interface ToolVerification {
  capabilityId: string;
  status: HealthStatus;
  detail: string;
  /**
   * #43 (ADD-43 D-14): set iff this verification was refused by the policy evaluation point
   * before any request was issued — i.e. the probe observed **nothing at all** about the
   * backend's contract.
   *
   * Why an additive optional field rather than a fourth `HealthStatus` value: `HealthStatus` is
   * a CLOSED set already consumed by ADD-24's `combineExposure` and by ADD-20's published
   * `archstone verify --json` shape, so a `"denied"` member would take a published CLI contract
   * and the exposure severity ordering with it. `red` stays correct for the OPERATOR-facing
   * report — they asked "is this binding healthy?" and the honest answer is "I could not
   * establish that" (D-7).
   *
   * What this flag exists to stop is that `red` travelling ONWARD into an AGENT-facing surface.
   * `readHealthSnapshot` (registry.ts) skips any entry carrying it, so the tool ends up with no
   * health entry at all, `combineExposure` leaves its exposure untouched, and no hint is
   * appended to its advertised description. Without it, the documented ADD-24 D-8 workflow
   * (`archstone verify --json` > `.archstone-health.json`, then serve) would append
   * `"binding health: red — the last contract verification failed"` at the highest severity to
   * a policy-gated tool's description, for EVERY caller including permitted ones — a statement
   * that is factually false (no verification occurred) and that makes policy affect listing,
   * which BR-36 forbids. Because the CLI supplies no caller, that is the DEFAULT outcome for
   * any `allow`-bearing capability, not a corner case.
   *
   * The failure is silent: nothing throws, no exit code changes, an agent just reads a false
   * warning. `runtime/test/lifecycle.integration.test.ts` asserts it.
   */
  policyDenied?: true;
  /**
   * #114 (ADD-114 D-4): which paths the provider gained, lost or retyped since the contract was
   * recorded. Present only when the binding recorded a `contract.shape`, that shape is
   * consistent with its own fingerprint (D-3), and something actually moved.
   *
   * NARRATIVE ONLY. `status` above is derived exactly as ADD-18 D-4 defines it, from the
   * fingerprint alone — this field explains a status it never determines (D-2). It rides into
   * `archstone verify --json` for free, since the CLI serialises this object directly.
   */
  drift?: ShapeDiff;
  /**
   * #18: the live fingerprint `status` was actually derived from — the value `narrateShapeChange`
   * already renders into `detail`'s prose (`"fingerprint sha256:… → sha256:…"`) but that a
   * `--json` consumer could previously only read by parsing English out of that string. This is
   * the same string, as data, nothing recomputed and nothing new compared.
   *
   * Present iff a probe actually happened and returned a response `fingerprintShape` could run
   * over — i.e. every branch below the `invokeRest` call in `verifyTool`, GREEN included. That
   * "even when unchanged" half is deliberate, not an oversight: a green result today reports only
   * the word "unchanged" (`detail: "fingerprint unchanged"`), so this field is what makes a green
   * run informative on its own terms rather than merely reporting the absence of a problem — a
   * consumer can record what it observed and diff across runs itself, without waiting for drift.
   *
   * Omitted (never `null` or the recorded value) on every path that returns before that call: no
   * `contract`, no fixture, a policy denial, or a failed request — nothing was observed on any of
   * those, so there is nothing to carry. Mirrors `ContractRecording.fingerprint` below, which
   * uses the same "absent means not observed" convention for the same reason.
   */
  observedFingerprint?: string;
}

/**
 * #124 (ADD-124 D-2): a contract-bearing binding that `runVerify` DECLINED to replay, because
 * replaying it would repeat a non-`read` invocation against whatever `${VAR}` resolves to.
 *
 * Why this is not a fourth `HealthStatus` and not a `ToolVerification` at all: none of
 * green/yellow/red is honest about something that was never attempted. `ProbeOutcome`'s
 * `not-attempted` (one function over, in `recordContract`) already establishes the precedent —
 * reporting a never-sent request as `red` asserts that the backend disagreed with the manifest,
 * which did not happen. `policyDenied` (ADD-43 D-14) chooses `red` for the opposite reason: a
 * legitimate attempt was BLOCKED by this run's configuration, which is operator-relevant. A
 * default effect-skip is Archstone's own designed-in guardrail working exactly as documented,
 * so it earns no colour and is pulled out of the status vocabulary entirely, into this list.
 */
export interface SkippedVerification {
  capabilityId: string;
  /** `"write" | "irreversible"` — `read` is the only effect a skip never applies to (D-5). */
  effect: Exclude<IRTool["effect"], "read">;
  /** Human-readable, mirrors `ToolVerification.detail`. */
  detail: string;
}

/**
 * `runVerify`'s return shape (#124 / ADD-124 D-2, D-8).
 *
 * BREAKING relative to the bare `ToolVerification[]` this function returned before v0.15:
 * `@archstone/runtime/verify` is a published subpath, so a programmatic consumer must read
 * `.results`. `results` keeps its shape and meaning exactly — non-`read` bindings are simply
 * absent from it by default, which is what keeps every existing
 * `results.some(r => r.status === "red")` gate meaning what it always meant (D-7).
 */
export interface VerifyRun {
  results: ToolVerification[];
  /** Empty when nothing was skipped — i.e. under `includeNonRead`, or on an all-`read` manifest. */
  skipped: SkippedVerification[];
}

/**
 * WHICH tools `runVerify` walks — deliberately NOT part of `InvokeOptions`, which says HOW to
 * call one (ADD-124 D-3).
 *
 * Keeping the two apart is load-bearing, not tidiness: `InvokeOptions` carries `auditSink` and
 * `onResponse`, and two tests (`cli/test/audit-surface.test.ts`,
 * `cli/test/onresponse-surface.test.ts`) pin that the CLI hands `runVerify` no such bag. A
 * filtering flag folded into that bag would have forced both to loosen, and they would have
 * stopped protecting against a future sink riding along on the same object. This shape cannot
 * carry a callback or a sink by construction.
 */
export interface VerifyScope {
  /**
   * Re-include `write`/`irreversible` contract-bearing tools in the live replay. The operator
   * is asserting the backend is a sandbox (`archstone verify --sandbox`); Archstone cannot
   * check that assertion and deliberately does not try (#124: the deployment, not the
   * manifest, decides where `${VAR}` points).
   */
  includeNonRead?: boolean;
}

export interface GoldenFixture {
  capabilityId: string;
  recordedAt?: string;
  request: Record<string, unknown>;
  expects?: { collectionNonEmpty?: boolean };
  /**
   * ADR-0012 D-8 — the positive leg's principal, `sql`-connector bindings only. Used by
   * `verifyTool` to replay the fixture's `request` ONLY when no caller principal was supplied
   * (`archstone verify` supplies none: an `--identity-map` configures the claims half of a
   * verify-time identity, and this records the principal half). A caller principal supplied by
   * the host always wins; `rest` bindings ignore this field. Unschema'd, like
   * `negativeIdentity`.
   */
  identity?: { principal: string };
  /**
   * ADR-0012 D-8 — a DIFFERENT tenant's principal, `sql`-connector bindings only. Every `sql`
   * binding with a recorded `contract` must also have this recorded, or `runVerify` marks it
   * 🔴 (BR-17). Unschema'd, exactly like the rest of `GoldenFixture` (internal ADD-37 O-11) —
   * a `verify`-time artifact, not a manifest input.
   */
  negativeIdentity?: { principal: string };
}

function readFixture(dir: string, path: string): GoldenFixture | undefined {
  try {
    return JSON.parse(readFileSync(resolve(dir, path), "utf8")) as GoldenFixture;
  } catch {
    return undefined;
  }
}

/**
 * Turn a fingerprint mismatch into a sentence that names what moved — or explains why it
 * cannot (ADD-114 D-3).
 *
 * Three outcomes, in order of how much we are entitled to claim:
 *   1. no `contract.shape` recorded → ADD-18's original wording, unchanged;
 *   2. a shape recorded that disagrees with its own fingerprint → say so, and name nothing. The
 *      two are records of one observation and can only diverge by hand-editing; naming fields
 *      from a shape that does not describe this contract is worse than naming none;
 *   3. a consistent shape → the named diff.
 */
function narrateShapeChange(
  contract: IRContract,
  liveShape: ShapeMap,
  liveFingerprint: string,
): { detail: string; drift?: ShapeDiff } {
  const fingerprints = `fingerprint ${contract.fingerprint} → ${liveFingerprint}`;
  if (!contract.shape) return { detail: `response shape changed (${fingerprints})` };
  if (fingerprintShapeMap(contract.shape) !== contract.fingerprint) {
    return { detail: `response shape changed (${fingerprints}); recorded shape is stale and was not used — re-record this contract` };
  }
  const drift = diffShape(contract.shape, liveShape);
  if (!hasShapeDrift(drift)) return { detail: `response shape changed (${fingerprints})` };
  return { detail: `response shape ${shapeDriftSummary(drift)}`, drift };
}

/**
 * ADR-0012 D-8 — the mandatory negative isolation test, `sql`-connector bindings only.
 * Returns `undefined` when there is nothing to report (not a `sql` binding, or the negative
 * replay proved isolation by returning zero rows); otherwise the exact `detail` string
 * `verifyTool` reports as a hard 🔴.
 *
 * D-8 case 4 (confirmed behavior, not left implicit): a recorded `negativeIdentity` the
 * configured `identityAdapter` cannot resolve is the IDENTICAL build-failing outcome as an
 * absent one — distinguished only by the detail string, never a silent skip or an automatic
 * green. A negative identity that resolves to an EMPTY claims object `{}` counts as
 * unresolved: with no session GUC set, RLS returns zero rows and isolation would be "proven"
 * vacuously.
 */
async function checkNegativeIsolation(tool: IRTool, fixture: GoldenFixture, opts?: InvokeOptions): Promise<string | undefined> {
  if (tool.connector?.type !== "sql") return undefined;

  const negativeIdentity = fixture.negativeIdentity;
  if (!negativeIdentity) {
    return "isolation not verified: no negative identity recorded";
  }
  const claims = opts?.identityAdapter?.(negativeIdentity.principal);
  if (!hasIdentityClaims(claims)) {
    return "isolation not verified: negative identity did not resolve to any claims";
  }

  // The IDENTICAL recorded request, replayed under a DIFFERENT principal via the same
  // `identityAdapter` (D-8 mechanics step 2) — `invokeSql` itself reads `opts.caller.principal`
  // and resolves claims from it, so overriding `caller` here is the only change needed.
  const negativeOpts: InvokeOptions = { ...opts, caller: { ...opts?.caller, principal: negativeIdentity.principal } };
  const result = await invokeConnector(tool, fixture.request, negativeOpts);
  if (!result.ok) {
    // The replay itself could not be attempted (e.g. a connection failure) — this proves
    // NOTHING about isolation either way, so it is reported as unverified, not as a pass.
    return `isolation not verified: negative replay failed — ${result.error ?? `status ${result.status}`}`;
  }
  const rows = Array.isArray(result.data) ? result.data.length : 0;
  if (rows > 0) {
    return `isolation test failed: ${rows} foreign row${rows === 1 ? "" : "s"} returned for capability '${tool.id}'`;
  }
  return undefined;
}

/**
 * ADR-0012 D-8 mechanics step 1 — the options the positive leg replays under. For a `sql`
 * binding with no caller principal (the CLI's case) and a recorded `fixture.identity`, the
 * fixture's principal stands in, resolved through the same `identityAdapter`. Otherwise —
 * a caller principal supplied, no `identity` recorded, or a non-`sql` binding — `opts` is
 * returned untouched, so an old `sql` fixture still refuses with "no session identity
 * resolved" exactly as before.
 */
function positiveLegOptions(tool: IRTool, fixture: GoldenFixture, opts?: InvokeOptions): InvokeOptions | undefined {
  if (tool.connector?.type !== "sql") return opts;
  if (opts?.caller?.principal !== undefined || !fixture.identity) return opts;
  return { ...opts, caller: { ...opts?.caller, principal: fixture.identity.principal } };
}

/** `value outside declared origins in: <fields>` — field names only, never a value. */
function withheldDetail(withheld: readonly string[]): string {
  return `value outside declared origins in: ${withheld.join(", ")}`;
}

/** A violation's detail: the missing required fields, then any withheld ones, each named as what
 *  it is. With nothing withheld it is exactly the text it always was. */
function violationDetail(missing: readonly string[], withheld: readonly string[] | undefined): string {
  if (!withheld) return `missing required field(s) ${missing.join(", ")}`;
  const parts = missing.length > 0 ? [`missing required field(s) ${missing.join(", ")}`] : [];
  parts.push(withheldDetail(withheld));
  return parts.join("; ");
}

/** Verify one tool's contract against the live backend. Returns green/yellow/red — never
 *  throws (a network/fs failure is itself a red result, not an exception the CLI must catch).
 *
 *  For a `sql` binding, the positive replay runs under the caller principal when one is
 *  supplied, otherwise under the fixture's recorded `identity` (ADR-0012 D-8); the negative
 *  isolation leg always runs under `negativeIdentity`. Policy evaluation still sees only the
 *  caller principal. */
export async function verifyTool(tool: IRTool, dir: string, resources: IRResourceRegistry, opts?: InvokeOptions): Promise<ToolVerification> {
  const base = { capabilityId: tool.id };
  const contract = tool.contract;
  if (!contract) return { ...base, status: "red", detail: "no contract: declared — nothing to verify" };

  const fixture = readFixture(dir, contract.probeFixture);
  if (!fixture) return { ...base, status: "red", detail: `fixture not found or unreadable: ${contract.probeFixture}` };

  // #43 (ADD-43 D-6): the contract prober is the THIRD invocation consumer, and it must route
  // through the same evaluation point as `callTool`/`executeCapability`. A probe makes a real
  // call with real credentials and is `authenticated`-gated today only because that gate lives
  // inside `invokeRest`; moving the gate (D-4) would silently un-gate `archstone verify` and the
  // published `runVerify()` unless this call exists. Placed immediately before `invokeRest`, so
  // "no contract" / "fixture not found" keep reporting themselves first.
  //
  // ADD-51 (#51) D-6, deliberately, do NOT "fix" this into a third exposure gate: unlike
  // `callTool`/`executeCapability`, `verifyTool` itself does not read
  // `registry.getExposure(tool.id)` and still probes a `lifecycle: retired` capability exactly
  // like a `stable` one IF it is called directly on one. Two reasons, both load-bearing. (1)
  // `verifyTool` never emits an `Execution` audit record under any outcome, so the
  // manufactured-evidence harm ADD-51 exists to close is structurally impossible on this path
  // regardless of lifecycle wiring. (2) Gating `verifyTool` itself would make it impossible to
  // ever probe a retired capability on purpose (e.g. investigating one before un-retiring it).
  //
  // #54 (R-2's fix, once filed): the CI-release-gate regression this residual risk named — a
  // retired-but-still-`contract:`-bearing capability turning `archstone verify`'s gate red
  // forever — is fixed one level up, in `runVerify`'s contract-bearing filter (below), which
  // now excludes a non-invocable (retired) tool before it ever reaches this function. See
  // `runVerify`'s doc comment. This function is unchanged by that fix and remains reachable
  // directly on a retired tool by a caller who wants to probe one deliberately.
  const decision = evaluatePolicy(tool, {
    principal: opts?.caller?.principal,
    credentialPresent: opts?.caller?.accessToken !== undefined,
  });
  if (!decision.allowed) {
    // `red`, with a detail textually distinguishable from the `live request failed:` prefix
    // below — because no live request was made (BR-37). `policyDenied` keeps this out of the
    // health snapshot entirely (D-14, see the field's doc comment).
    return {
      ...base,
      status: "red",
      detail: `policy denied before any request was made: ${decision.denial.message}`,
      policyDenied: true,
    };
  }

  // ADR-0012 D-8 — for `sql` bindings only, the mandatory negative isolation test runs BEFORE
  // the positive replay below: an isolation failure is reported on its own terms, with its own
  // distinct detail string, never conflated with (or masked by) whatever the positive replay
  // would otherwise report.
  const isolationDetail = await checkNegativeIsolation(tool, fixture, opts);
  if (isolationDetail) return { ...base, status: "red", detail: isolationDetail };

  const result = await invokeConnector(tool, fixture.request, positiveLegOptions(tool, fixture, opts));
  if (!result.ok) return { ...base, status: "red", detail: `live request failed: ${result.error ?? `status ${result.status}`}` };

  const liveFingerprint = fingerprintShape(result.data);
  const fingerprintChanged = liveFingerprint !== contract.fingerprint;
  const liveShape = describeShape(result.data);
  // #18: every return from here on reports a probe that actually happened and actually got a
  // response back — so every one of them, GREEN included, carries what it observed.
  const observed = { ...base, observedFingerprint: liveFingerprint };

  const unchecked = passThroughRefusal(tool, resources);
  if (unchecked) return { ...observed, status: "red", detail: unchecked };

  if (!tool.response && !tool.extract) {
    // Neither response: nor extract: to validate against — fingerprint drift is all we can see.
    if (!fingerprintChanged) return { ...observed, status: "green", detail: "fingerprint unchanged" };
    const { detail, drift } = narrateShapeChange(contract, liveShape, liveFingerprint);
    return { ...observed, status: "yellow", detail, ...(drift ? { drift } : {}) };
  }

  const mapped = applyResponseMapping(tool, result.data, resources);
  if (mapped.status === "violation") {
    return { ...observed, status: "red", detail: `contract violation: ${violationDetail(mapped.missing ?? [], mapped.withheld)}` };
  }

  // An origin-checked value outside the declared origins is RED even on an optional field. In
  // production it is silently dropped (the result only degrades), which is exactly why the
  // operator has to hear it here: the provider's own data already breaks the guarantee. Kept
  // distinct from the yellow `degraded` text, which means the provider did not send a field.
  if (mapped.withheld) {
    const degradedToo = mapped.degraded ? `; degraded: optional field(s) absent — ${mapped.degraded.join(", ")}` : "";
    return { ...observed, status: "red", detail: `${withheldDetail(mapped.withheld)}${degradedToo}` };
  }

  // `collectionNonEmpty` names a `response:` collection field — nothing to check against an
  // extract:-only tool, which maps scalars, never a collection.
  if (fixture.expects?.collectionNonEmpty && tool.response) {
    const field = tool.response.field;
    const value = mapped.data?.[field];
    const empty = Array.isArray(value) ? value.length === 0 : value === undefined || value === null;
    if (empty) return { ...observed, status: "red", detail: `expected a non-empty '${field}' collection; got none` };
  }

  if (mapped.status === "degraded") {
    return { ...observed, status: "yellow", detail: `degraded: optional field(s) absent — ${(mapped.degraded ?? []).join(", ")}` };
  }
  if (fingerprintChanged) {
    const { detail, drift } = narrateShapeChange(contract, liveShape, liveFingerprint);
    return { ...observed, status: "yellow", detail: `mapping still resolves; ${detail}`, ...(drift ? { drift } : {}) };
  }
  return { ...observed, status: "green", detail: "fingerprint unchanged, mapping OK" };
}

/**
 * Verify every contract-bearing tool in a registry.
 *
 * #54 (fixing ADD-51 D-6's named residual risk, R-2): a `lifecycle: retired` capability is
 * excluded from the contract-bearing filter here — never handed to `verifyTool` at all, so it
 * never enters the returned report. This is deliberately NOT the same fix as `policyDenied`
 * (ADD-43 D-14): a policy denial still enters the report (marked, then skipped only by the
 * health-snapshot reader, `registry.ts`'s `readHealthSnapshot`) because a policy evaluation is
 * itself a fact worth reporting. A retirement is not — a business withdrawing a capability is a
 * normal operational event, not a thing `archstone verify` has anything to say about, so the
 * capability is simply never probed and never appears, exactly as if its `contract:` block did
 * not exist. That is what keeps `reports.some(r => r.status === "red")` (`cli/src/index.ts`,
 * the CI release gate) from going permanently red the day a `contract:`-bearing capability is
 * retired without also deleting its contract block.
 *
 * Invocability is read via `lifecycleExposure` — the exact pure lowering
 * `Registry.getExposure` (`@archstone/emitter-support/registry.ts`) composes into its
 * `exposureById` map, reused verbatim rather than re-deriving `lifecycle === "retired"` here
 * (ADD-24 D-6/R-5: any future reader shares this one computation). `runVerify` receives raw
 * `IRTool[]`, not a `Registry`, and health never affects `invocable` (ADD-24 D-9), so calling
 * `lifecycleExposure` directly — the same function `getExposure` calls, with no health
 * component to compose — yields an identical answer to `registry.getExposure(t.id).invocable`
 * for every tool.
 *
 * This does NOT change `verifyTool` itself (still deliberately ungated per D-6, directly
 * reachable and still probing a retired capability if called on one on purpose) — only this
 * orchestrator, which is what `archstone verify`/the CLI gate actually walks.
 *
 * #124 (ADD-124 D-1/D-5): the SAME filter now also splits on `effect`. A replay is an
 * invocation — Axiom A-1 — so replaying a `write`/`irreversible` fixture creates a real booking
 * or moves real money, on every CI run. `archstone init --probe` has refused exactly this since
 * ADD-37 (R-8, the `effect-not-read` refusal); `verify` did not, and the asymmetry was the bug.
 * Such a tool is NOT probed and NOT reported as a health status — it is returned in `skipped`
 * (see `SkippedVerification`), so a dashboard cannot read it as green and an operator cannot
 * miss it. `scope.includeNonRead` (the CLI's `--sandbox`) is the only way back in.
 *
 * The test is `effect === "read"`, not `effect !== "write" && effect !== "irreversible"`:
 * anything this build does not recognise as a read is treated as unsafe to replay. That is the
 * deliberate OPPOSITE of the unrecognized-`lifecycle` rule below (where the loud choice is to
 * probe anyway), and for a reason that does not generalise: getting `lifecycle` wrong costs a
 * misreported line in a report, getting `effect` wrong costs a real side effect on someone's
 * production backend. Fail closed where the failure is irreversible.
 *
 * `policyDenied` entries' gate handling is unchanged and explicitly out of scope for this fix
 * (see #54's PR description) — a separate decision, deferred.
 *
 * Bug fix (found reviewing #54): the original filter excluded every `invocable:false` tool —
 * `lifecycleExposure(...).invocable` is `false` for BOTH `lifecycle: "retired"` (this fix's
 * actual target) AND the `unevaluatable`/default branch (an unrecognized `lifecycle` value on a
 * hand-written or forward-versioned IR, ADD-56). That conflated a governance refusal with a
 * compatibility refusal: a capability with a corrupted/unrecognized lifecycle AND a genuinely
 * broken `contract:` block was silently excluded from the report instead of being probed and
 * flagged red — undermining ADD-56's "make incompatibility loud" goal on this one path. The
 * filter now checks `blockedReason !== "retired"` specifically, so an unrecognized-lifecycle
 * tool (`blockedReason: "unevaluatable"`) stays in `contractBearing` and is probed by
 * `verifyTool` exactly as it was before this whole feature shipped. `Exposure.blockedReason` is
 * always present when `invocable:false` and always absent when `invocable:true` (`exposure.ts`),
 * so this substitution needs no separate `invocable` check.
 */
export async function runVerify(
  tools: IRTool[],
  dir: string,
  resources: IRResourceRegistry,
  opts?: InvokeOptions,
  scope?: VerifyScope,
): Promise<VerifyRun> {
  const contractBearing = tools.filter((t) => t.contract && lifecycleExposure(t.lifecycle).blockedReason !== "retired");

  // ⚠️ #54 (retired) and #124 (effect) BOTH live here, in the orchestrator, and neither belongs
  // in `verifyTool`. Moving either one down would make it impossible to ever probe such a tool
  // deliberately — a retired capability under investigation, a `write` capability against a
  // scratch backend from a test. `runVerify` is where a DEFAULT policy belongs; `verifyTool`
  // stays the ungated primitive. See ADD-124 D-1 and ADD-56/#54 before changing this.
  // ONE decision, read twice — never two conditions that could drift apart and leave a tool both
  // probed and reported as skipped.
  const includeNonRead = scope?.includeNonRead === true;
  const probeable = includeNonRead ? contractBearing : contractBearing.filter((t) => t.effect === "read");
  const skipped: SkippedVerification[] = includeNonRead
    ? []
    : contractBearing
        .filter((t) => t.effect !== "read")
        .map((t) => ({
          capabilityId: t.id,
          effect: t.effect as Exclude<IRTool["effect"], "read">,
          // Deliberately names no CLI flag. `runtime` is a published library — `--sandbox` is the
          // CLI's spelling of `includeNonRead`, and an embedder calling `runVerify` directly
          // would be told to pass an argument that does not exist in their program. The surface
          // that owns the flag is the surface that names it.
          detail:
            `not replayed: effect is \`${t.effect}\`, and a replay is a real invocation — ` +
            `it would repeat that effect against the live backend.`,
        }));

  return { results: await Promise.all(probeable.map((t) => verifyTool(t, dir, resources, opts))), skipped };
}

// ---------------------------------------------------------------------------------------
// Recording a contract (ADD-37 D-6 / R-1)
// ---------------------------------------------------------------------------------------

/**
 * How a probe ended.
 *
 * `green` / `yellow` / `red` mirror `HealthStatus` deliberately — this is the same question
 * `verifyTool` answers, asked one moment earlier. `not-attempted` is the fourth outcome
 * ADD-37 Amendment 1 §A-5 adds, and it is not a nicety:
 *
 * `invokeRest` returns `{ok: false, status: 0, error: "missing env var(s): …"}` BEFORE it
 * sends anything. Reporting that as `red` asserts that the backend disagreed with the
 * manifest, which is false — nothing was asked of the backend at all. False reds are how
 * people learn to ignore reds, and this one would fire on the very first run of every
 * generated manifest whose credential variable is not set yet.
 *
 * Same disposition as `red` for the CONTRACT (write nothing); the opposite disposition in the
 * report.
 */
export type ProbeOutcome = "green" | "yellow" | "red" | "not-attempted";

/**
 * The result of one recording attempt.
 *
 * `fingerprint` and `fixture` are present together or not at all — the schema requires
 * `source` + `fingerprint` + `probe.fixture`, so a half-recording is not a thing a caller
 * could write down even if it wanted to.
 */
export interface ContractRecording {
  capabilityId: string;
  outcome: ProbeOutcome;
  detail: string;
  fingerprint?: string;
  /** The recorded response shape (ADD-114 D-6), derived from the SAME body as `fingerprint`
   *  in the same call — which is what makes the two consistent by construction at the only
   *  point that writes them, and is what D-3's check later relies on. */
  shape?: ShapeMap;
  fixture?: GoldenFixture;
  /** Optional fields that came back absent or null. Real required/optional evidence — the
   *  caller may offer a loosening at the gate, and must never apply one silently: n=1 is not
   *  a classification. */
  degraded?: string[];
  /** Required fields that came back absent or null. A VIOLATION, and the reason nothing is
   *  written: a manifest that violates on its own recording is not a manifest. */
  missing?: string[];
  /** Origin-checked fields whose recorded value was outside the declared origins. Always `red`,
   *  and nothing is kept: a fixture `verify` would report red on its first replay is not worth
   *  writing down. Names only — the value is never printed. */
  withheld?: string[];
}

export interface RecordContractOptions extends InvokeOptions {
  /** Injected so a test can pin the recorded timestamp. Defaults to the wall clock — this
   *  module is the runtime, not the pure core, and recording is inherently a moment in time. */
  now?: Date;
}

/** Errors `invokeRest` returns WITHOUT sending a request. Matched on the message because that
 *  is the only signal in the shipped return shape — `status: 0` alone also covers a network
 *  failure, which is a genuine red. */
const NOT_ATTEMPTED_RE = /^missing (?:env var|caller credential)\(s\):/;

/**
 * Record a contract for a tool that does not have one yet (ADD-37 D-6).
 *
 * A SIBLING of `verifyTool`, not a flag on it, and the reason is structural rather than
 * stylistic: `verifyTool` returns `red` on `!tool.contract` before doing anything, and the
 * contract is precisely what this function exists to create. The chicken-and-egg is real.
 *
 * What makes this the right place for it (R-1): it is the SAME module, over the SAME
 * `invokeRest` call, with the same policy evaluation and the same `fingerprintShape` and
 * `applyResponseMapping`, as the replay that will later be asked to trust the artifact. A
 * second orchestration of "call the backend, hash the shape, run the mapper" living in
 * `init` would look green at record time and be unreplayable afterwards — silently, for the
 * manifest's lifetime.
 *
 * It reads no filesystem: there is no fixture to find yet. That is the one deliberate
 * departure from ADD-37 §6 step 6's sketched `(tool, input, dir, resources, opts)` signature —
 * carrying a `dir` this function cannot use would suggest it does something with it.
 *
 * NOTE it never decides WHETHER to probe. Consent, the confirmed `effect: read` and the method
 * rule (R-8) are the caller's gate, upstream, where the human is.
 */
export async function recordContract(
  tool: IRTool,
  input: Record<string, unknown>,
  resources: IRResourceRegistry,
  opts?: RecordContractOptions,
): Promise<ContractRecording> {
  const base = { capabilityId: tool.id };

  // Same evaluation point as `verifyTool` (#43 / ADD-43 D-6), for the same reason: a probe
  // makes a real call with real credentials. `init` never emits `policies:`, so this cannot
  // fire on a freshly generated manifest — it is here so that re-recording an EXISTING
  // hand-written manifest cannot route around the gate.
  const decision = evaluatePolicy(tool, {
    principal: opts?.caller?.principal,
    credentialPresent: opts?.caller?.accessToken !== undefined,
  });
  if (!decision.allowed) {
    // `not-attempted`, not `red`.
    //
    // DELIBERATELY DIVERGENT FROM `verifyTool`, which answers `red` + `policyDenied` for this
    // identical condition — recorded here so nobody "fixes" the two into agreement. They are
    // answering different questions. `verifyTool` answers an OPERATOR's "is this binding
    // healthy?", and "I could not establish that" is honestly red (ADD-43 D-7); its
    // `policyDenied` flag then exists to stop that red travelling onward into an agent-facing
    // surface. `recordContract` answers "did I learn anything worth writing down?", and the
    // answer is simply no — nothing was asked of the backend. Both refuse to write a contract;
    // only the report wording differs, which is the whole point of the fourth outcome.
    return { ...base, outcome: "not-attempted", detail: `policy denied before any request was made: ${decision.denial.message}` };
  }

  const result = await invokeConnector(tool, input, opts);
  if (!result.ok) {
    const error = result.error ?? `status ${result.status}`;
    if (result.status === 0 && NOT_ATTEMPTED_RE.test(error)) {
      return { ...base, outcome: "not-attempted", detail: `no request was sent — ${error}` };
    }
    return { ...base, outcome: "red", detail: `live request failed: ${error}` };
  }

  const fingerprint = fingerprintShape(result.data);
  const shape = describeShape(result.data);
  const fixture: GoldenFixture = {
    capabilityId: tool.id,
    recordedAt: (opts?.now ?? new Date()).toISOString(),
    request: input,
  };

  const unchecked = passThroughRefusal(tool, resources);
  if (unchecked) return { ...base, outcome: "red", detail: unchecked };

  if (!tool.response && !tool.extract) {
    // Nothing to validate against; the fingerprint is still a real, replayable fact.
    return { ...base, outcome: "green", detail: "recorded — no response mapping to validate", fingerprint, shape, fixture };
  }

  const mapped = applyResponseMapping(tool, result.data, resources);
  if (mapped.status === "violation") {
    // KEEP NOTHING. A field the manifest marks required came back null or absent on the very
    // response we are recording, so the contract would be green against a fiction and red
    // against reality. The loosening belongs at the gate, offered to a human, never applied
    // here: n=1 is not a classification.
    return {
      ...base,
      outcome: "red",
      detail: `contract violation on the recorded response: ${violationDetail(mapped.missing ?? [], mapped.withheld)}`,
      ...(mapped.missing ? { missing: mapped.missing } : {}),
      ...(mapped.withheld ? { withheld: mapped.withheld } : {}),
    };
  }
  if (mapped.withheld) {
    // KEEP NOTHING, as for a violation: `verify` reports any withheld value red, so this fixture
    // would fail its own first replay.
    return {
      ...base,
      outcome: "red",
      detail: `not recorded: ${withheldDetail(mapped.withheld)}`,
      withheld: mapped.withheld,
      ...(mapped.degraded ? { degraded: mapped.degraded } : {}),
    };
  }
  if (mapped.status === "degraded") {
    return {
      ...base,
      outcome: "yellow",
      detail: `recorded, degraded: optional field(s) absent — ${(mapped.degraded ?? []).join(", ")}`,
      fingerprint,
      shape,
      fixture,
      ...(mapped.degraded ? { degraded: mapped.degraded } : {}),
    };
  }
  return { ...base, outcome: "green", detail: "recorded — mapping OK", fingerprint, shape, fixture };
}
