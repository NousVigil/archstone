// @archstone/agent — execute(): connector invocation + fail-closed response mapping
// (ADD-0008 #28)
//
// Composes invokeRest (@archstone/provider-rest) -> applyResponseMapping
// (@archstone/emitter-support) into a 4-state result — NOT the MCP CallResult shape
// (content/isError/_meta from @archstone/runtime's server.ts). Mirrors that file's
// `callTool` composition (invokeRest -> check ok -> applyResponseMapping -> branch on
// status) but adds a 4th outcome, "error", for transport/connector failures invokeRest
// already distinguishes from a shape VIOLATION (missing env, missing path param, network
// error, non-2xx) — R-8 in ADD-0008's risk table; not in the RFC's original ok|degraded|
// violation sketch.

import {
  Registry,
  applyResponseMapping,
  contractViolationMessage,
  type InvalidField,
  passThroughRefusal,
  evaluatePolicy,
  evaluateRateLimit,
  auditNow,
  buildExecutionRecord,
  emitExecutionRecord,
  LIFECYCLE_BLOCKED_REASON,
  LIFECYCLE_UNEVALUATABLE_REASON,
  INPUT_INVALID_DENIAL_REASON,
  validateInput,
  inputInvalidMessage,
  type InputProblem,
  type ExecutionStatus,
  type ExecutionDenialReason,
} from "@archstone/emitter-support";
import type { FetchLike, CallerContext } from "@archstone/provider-rest";
// ADR-0012 D-5: `@archstone/agent`'s root (this file) is RFC-0008's "pure mapper + fetch +
// injectable env only" edge-deployable surface — it must never gain a static edge to
// `@archstone/provider-sql`/`pg`. `invokeConnectorRest` is the edge-safe default; a Node-only
// embedder who wants `sql`-bound capabilities to actually work passes `opts.connector` (see
// `ExecuteOptions.connector` below), typically `@archstone/runtime/connector`'s `invokeConnector`
// — imported by THEIR code, never by this file. `packages/agent/test/boundary.test.ts` pins that
// this file's import graph never reaches `pg`/`@archstone/provider-sql`.
import { invokeConnectorRest, type InvokeOptions as EdgeSafeInvokeOptions } from "@archstone/runtime/connector-rest";

type InvokeOptions = EdgeSafeInvokeOptions;

export interface ExecuteOptions {
  /** Injected, Workers-style — execute() never falls back to `process.env` (ADD-0008
   *  §2/§7.2). Omitting this (or a var it doesn't contain) means any `${VAR}` connector
   *  placeholder resolves as missing, which surfaces as `status: "error"`, not a crash. */
  env?: Record<string, string | undefined>;
  fetchImpl?: FetchLike;
  /** ADD-32: the end user this execute() call acts on behalf of — pure pass-through to
   *  invokeRest (no policy logic here). Omitting it behaves exactly as before unless the
   *  capability declares `policies: [authenticated]`, in which case invokeRest fails closed
   *  with `status: "error"` (no new ExecuteResult variant needed). */
  caller?: CallerContext;
  /** Security-hardening follow-up to ADD-32 — pure pass-through to invokeRest (no policy logic
   *  here). A deployer-level allowlist for the caller-influenced-baseUrl guard (see
   *  `providers/rest`'s `InvokeOptions.allowedHosts`); irrelevant unless a binding's baseUrl
   *  contains `${caller.NAME}`. */
  allowedHosts?: string[];
  /** Issue #39: pure pass-through to invokeRest — no policy/logic added here, exactly like
   *  `caller`/`allowedHosts` above. Type-only imported from `@archstone/provider-rest`; see
   *  `InvokeOptions.onResponse`'s doc-comment there for the full firing/fail-safe contract. */
  onResponse?: InvokeOptions["onResponse"];
  /** Issue #44: the `Execution` audit sink. Unlike `caller`/`allowedHosts`/`onResponse` above
   *  this is NOT a pass-through to `invokeRest` — `executeCapability` is one of the two audited
   *  consumers and builds the record itself, from the same decision it just made. Type-only
   *  imported; see `InvokeOptions.auditSink` and `AuditSink`'s own doc comment (which states
   *  that the trail is best-effort and lossy) for the full contract. */
  auditSink?: InvokeOptions["auditSink"];
  /** Issue #44: correlation ids passed through to the record exactly as supplied, or omitted.
   *  Never synthesized or derived. */
  sessionId?: string;
  workflowId?: string;
  /** #45 / ADD-45: pure pass-through to the rate-limit evaluation step, exactly like `caller`/
   *  `allowedHosts`/`onResponse` above — `executeCapability` calls `evaluateRateLimit` itself
   *  (mirroring how it already calls `evaluatePolicy`) rather than forwarding this into
   *  `invokeRest`. No-store default: a capability declaring `spec.rateLimit` with this absent
   *  DENIES rather than proceeding unlimited — see `evaluateRateLimit`'s doc comment. */
  rateLimitCounter?: InvokeOptions["rateLimitCounter"];
  /** ADR-0012 D-3 — pure pass-through to `invokeSql` for a `sql`-bound capability; ignored by
   *  `invokeRest`. See `IdentityAdapter`'s own doc comment (`@archstone/emitter-support`) — set
   *  once, statically, at construction time, never derived from `input`. */
  identityAdapter?: InvokeOptions["identityAdapter"];
  /** ADR-0012 D-4 — pure pass-through to `invokeSql`; ignored by `invokeRest`. */
  sqlSessionGucPrefix?: InvokeOptions["sqlSessionGucPrefix"];
  /** ADR-0012 D-5 — a Node-only embedder's explicit opt-in to `sql`-bound-capability support.
   *  Absent (the default, and the only option in an edge-deployed embedding): a `sql`-bound
   *  capability's `execute()` call returns `status: "error"` with a clean, explanatory message —
   *  this surface never imports `pg`. Present: every invocation routes through the supplied
   *  function instead (typically `@archstone/runtime/connector`'s `invokeConnector`, imported by
   *  the EMBEDDER'S own Node-only code, never by this package). */
  connector?: InvokeOptions["connector"];
}

/** #43 ADD-43 D-11: the embedded rendering of a policy refusal — the `ExecuteResult` sibling of
 *  the MCP path's `_meta["dev.archstone/policy_denied"]`. Same decision, same reason code, same
 *  human message; only the envelope differs, and the two are deliberately NOT forced to
 *  converge (BR-32). `capability` is the unsanitized CDL id (BR-28).
 *
 *  ADD-51 (#51): `reason` also carries `"lifecycle_blocked"` — populated when this call was
 *  refused by the ADD-24 exposure gate below, which is distinct from and runs BEFORE the policy
 *  evaluation point (ADD-43 D-4's boundary between the two vocabularies). This field is no
 *  longer populated only by policy.
 *
 *  ADD-56 (#56): `reason` also carries `"lifecycle_unevaluatable"` — the exposure gate's SECOND
 *  denying outcome, populated when the capability's declared `lifecycle` is a value this build
 *  does not recognize at all (only reachable via a hand-written or forward-versioned `fromIR`
 *  artifact). Distinct from `"lifecycle_blocked"` on purpose: a governance refusal (`retired`)
 *  and a compatibility refusal (unrecognized value) are different facts with different
 *  remediations — see `Exposure.blockedReason`'s doc comment in `@archstone/emitter-support`. */
export interface ExecuteDenial {
  reason: ExecutionDenialReason;
  capability: string;
  /** #195: present only when `reason` is `"input_invalid"` — the declared field paths and fixed
   *  expectation phrases that failed (at most 16), never an argument value or an undeclared key's
   *  name. The embedded sibling of `_meta["dev.archstone/input_invalid"].problems`. */
  problems?: InputProblem[];
  /** #195: `true` when more than 16 problems existed and the list was cut. */
  truncated?: true;
}

export interface ExecuteResult {
  status: "ok" | "degraded" | "violation" | "error";
  data?: Record<string, unknown>; // present on ok/degraded
  missing?: string[]; // present on violation (ADD-12/19 semantics, verbatim)
  /** Present-but-wrong-shape fields (#196), `{field, expected}`, never the value: required ones on a
   *  `violation`, optional ones (dropped) on `degraded`. Present only when non-empty. */
  invalid?: InvalidField[];
  degraded?: string[]; // present on degraded
  /** Origin-checked fields (`web-page`) whose value was outside the declared origins and was
   *  therefore withheld — absent from `data`, never forwarded. Field names only, never values.
   *  Present only when non-empty: on `degraded` (an optional field withheld) or `violation` (a
   *  required one). Additive, and deliberately NOT folded into `degraded`, which keeps meaning
   *  "the provider did not send an optional field". */
  withheld?: string[];
  error?: string; // present on error — invokeRest returned ok:false (InvokeResult.error verbatim)
  /**
   * #43 (ADD-43 D-11): present iff this call was refused — by the policy evaluation point, OR
   * (ADD-51, #51) by the ADD-24 exposure gate for a `retired` capability, which runs BEFORE
   * policy and is explicitly NOT the policy evaluation point (ADD-43 D-4's boundary). In either
   * case `status` is `"error"` and `error` carries the human message.
   *
   * Additive and optional ON PURPOSE. A fifth `status` value (`"denied"`) would read better
   * against #44's `Execution.status.phase` vocabulary, but `ExecuteResult.status` is a published
   * union: a new member breaks every consumer's exhaustive `switch`, and it would break the
   * shipped `expect(r.status).toBe("error")` assertion — while buying nothing this object does
   * not already provide. `denial !== undefined` is a strictly STRONGER discriminator than a
   * status string, because it also carries the reason.
   */
  denial?: ExecuteDenial;
}

export async function executeCapability(
  registry: Registry,
  capabilityId: string,
  input: Record<string, unknown>,
  opts?: ExecuteOptions,
): Promise<ExecuteResult> {
  const tool = registry.getCapability(capabilityId);
  if (!tool) {
    // #44: no audit record — nothing resolved, so the record's required `capabilityId` would
    // have to carry an unvalidated caller-chosen string. See `callTool`'s twin of this comment.
    return { status: "error", error: `unknown capability: ${capabilityId}` };
  }

  // #44: the attempt clock starts before the exposure gate and before policy evaluation, so a
  // denied attempt has a real start time. Strict no-op with no sink: no clock read, no id, no
  // record, no allocation.
  const auditSink = opts?.auditSink;
  const startedAt = auditSink ? auditNow() : "";
  const audit = (status: ExecutionStatus): void => {
    if (!auditSink) return;
    emitExecutionRecord(
      auditSink,
      buildExecutionRecord({
        tool,
        input,
        // Fixed by this call site, never host-configurable.
        consumer: "function-calling",
        caller: opts?.caller,
        sessionId: opts?.sessionId,
        workflowId: opts?.workflowId,
        startedAt,
        status,
      }),
    );
  };

  // ADD-51 (#51): the SAME ADD-24 exposure gate `callTool` (runtime/src/server.ts) already
  // enforces — `registry.getExposure(tool.id).invocable`, checked immediately after resolution/
  // startedAt and strictly BEFORE `evaluatePolicy`, mirroring `callTool`'s pinned order
  // (ADD-43 BR-34) so a capability that is both `retired` and policy-deniable reports
  // `lifecycle_blocked` here too, never `policy_denied`. Message text is `server.ts`'s, reused
  // verbatim. Before this ADD, a `retired` capability reached the backend on this path and,
  // since #44 shipped, the audit trail recorded `phase: "succeeded"` — manufactured evidence
  // that a withdrawn capability ran cleanly. `verifyTool` (runtime/src/verify.ts) deliberately
  // stays ungated (ADD-51 D-6) — see that file's own comment for why.
  //
  // ADD-56 (#56): `lifecycleExposure` is now TOTAL — an unrecognized `lifecycle` value ALSO sets
  // `invocable:false`, distinguished from `retired` via `exposure.blockedReason`. Text and
  // denialReason for the two cases MUST stay distinct (governance vs. compatibility refusal —
  // see `exposure.ts`'s `Exposure.blockedReason` doc comment); this branch mirrors `server.ts`'s
  // `callTool` textually. The `undefined`-`blockedReason` case (D-4's unknown-id fallback)
  // cannot occur here: `tool` above was already resolved via `getCapability`, which reads the
  // identical `exposureById` map `getExposure` does.
  const exposure = registry.getExposure(tool.id);
  if (!exposure.invocable) {
    if (exposure.blockedReason === "unevaluatable") {
      const text = `capability '${tool.id}' declares a lifecycle this build does not recognize and cannot evaluate — refusing (fail-closed).`;
      audit({ phase: "denied", message: text, denialReason: LIFECYCLE_UNEVALUATABLE_REASON });
      return {
        status: "error",
        error: text,
        denial: { reason: LIFECYCLE_UNEVALUATABLE_REASON, capability: tool.id },
      };
    }
    const text = `capability '${tool.id}' is retired and can no longer be invoked.`;
    audit({ phase: "denied", message: text, denialReason: LIFECYCLE_BLOCKED_REASON });
    return {
      status: "error",
      error: text,
      denial: { reason: LIFECYCLE_BLOCKED_REASON, capability: tool.id },
    };
  }

  // Never assume process.env (Workers-style, ADD-0008 §7.2): default to {} rather than
  // leaving env undefined — invokeRest itself falls back to `process.env` when its own
  // `opts.env` is undefined, which would be wrong on a Worker. An empty env just means
  // every `${VAR}` placeholder resolves as missing, which invokeRest already reports as
  // a normal `ok:false` (mapped below to `status: "error"`).
  // #43 (ADD-43 D-5/D-6): the SAME evaluation point `callTool` and `verifyTool` call — one
  // shared function in @archstone/emitter-support, never a second copy here (the ADD-30 defect
  // class). Called unconditionally, after the exposure gate above and before any connector work,
  // so a denial issues zero outbound requests and no `onResponse` hook fires.
  const decision = evaluatePolicy(tool, {
    principal: opts?.caller?.principal,
    credentialPresent: opts?.caller?.accessToken !== undefined,
  });
  if (!decision.allowed) {
    audit({ phase: "denied", message: decision.denial.message, denialReason: decision.denial.reason });
    return {
      status: "error",
      error: decision.denial.message,
      denial: { reason: decision.denial.reason, capability: tool.id },
    };
  }

  // #195: the SAME input-contract gate `callTool` runs, at the SAME point — after policy, before
  // the rate limiter and any connector work. One shared `validateInput`, never a second copy.
  const inputCheck = validateInput(tool.input, input, registry.ir.resources);
  if (!inputCheck.ok) {
    const text = inputInvalidMessage(tool.id, inputCheck.problems, inputCheck.truncated);
    audit({ phase: "denied", message: text, denialReason: INPUT_INVALID_DENIAL_REASON });
    return {
      status: "error",
      error: text,
      denial: {
        reason: INPUT_INVALID_DENIAL_REASON,
        capability: tool.id,
        problems: inputCheck.problems,
        ...(inputCheck.truncated ? { truncated: true as const } : {}),
      },
    };
  }

  // #45 (ADD-45 D-2/D-3): the SAME rate-limit evaluation step `callTool` calls, at the SAME
  // point — immediately after `evaluatePolicy` allows, before any connector work. One shared
  // function in @archstone/emitter-support, never a second copy here (the ADD-30 defect class).
  const rateDecision = await evaluateRateLimit(tool, { principal: opts?.caller?.principal }, opts?.rateLimitCounter);
  if (!rateDecision.allowed) {
    audit({ phase: "denied", message: rateDecision.denial.message, denialReason: rateDecision.denial.reason });
    return {
      status: "error",
      error: rateDecision.denial.message,
      denial: { reason: rateDecision.denial.reason, capability: tool.id },
    };
  }

  const env = opts?.env ?? {};
  const result = await invokeConnectorRest(tool, input, {
    env,
    fetchImpl: opts?.fetchImpl,
    caller: opts?.caller,
    allowedHosts: opts?.allowedHosts,
    onResponse: opts?.onResponse,
    identityAdapter: opts?.identityAdapter,
    sqlSessionGucPrefix: opts?.sqlSessionGucPrefix,
    connector: opts?.connector,
  });
  if (!result.ok) {
    // ADD-44 Amendment 2 (archstone#34): `reachedConnector` mirrors `callTool`'s derivation —
    // `status !== 0` iff invokeRest received a response, never true for a pre-dispatch
    // short-circuit or a network-level exception, both of which leave `status` at its default.
    const text = result.error ?? "invocation failed";
    audit({ phase: "failed", message: text, reachedConnector: result.status !== 0 });
    return { status: "error", error: text };
  }

  // Mirrors `callTool`'s gate (runtime/src/server.ts): a binding with a `response:` mapping
  // and/or an `extract:` block is MAPPED + VALIDATED. Before this, an extract:-only capability
  // (no `response:` at all) fell through to raw pass-through below, skipping extract:'s
  // required/degraded enforcement entirely.
  if (tool.response || tool.extract) {
    const mapped = applyResponseMapping(tool, result.data, registry.ir.resources);
    if (mapped.status === "violation") {
      const missing = mapped.missing ?? [];
      // The record carries the SAME contract-violation sentence the MCP path returns as tool
      // content. `ExecuteResult` itself carries only `missing` — deliberately, that shape is
      // published — so without the shared helper the two consumers' records would describe one
      // failure in two ways, which is exactly the drift one record builder exists to prevent.
      // ADD-44 Amendment 2: reachable only after `invokeRest` returned `ok: true` — a response
      // was, by construction, received.
      audit({ phase: "failed", message: contractViolationMessage(tool.id, missing, mapped.withheld, mapped.invalid), reachedConnector: true });
      return { status: "violation", missing, ...(mapped.invalid ? { invalid: mapped.invalid } : {}), ...(mapped.withheld ? { withheld: mapped.withheld } : {}) };
    }
    if (mapped.status === "degraded") {
      // `succeeded`: every required field was present; only an optional one was absent (or withheld).
      audit({ phase: "succeeded" });
      return { status: "degraded", data: mapped.data, degraded: mapped.degraded ?? [], ...(mapped.invalid ? { invalid: mapped.invalid } : {}), ...(mapped.withheld ? { withheld: mapped.withheld } : {}) };
    }
    audit({ phase: "succeeded" });
    return { status: "ok", data: mapped.data };
  }

  // An origin-checked output on a pass-through tool (only a hand-written IR gets here — the
  // compiler refuses it): the raw body would carry the unchecked link. Fail closed, as callTool does.
  const refusal = passThroughRefusal(tool, registry.ir.resources);
  if (refusal) {
    audit({ phase: "failed", message: refusal, reachedConnector: true });
    return { status: "error", error: refusal };
  }

  // Neither `response:` nor `extract:`: raw pass-through (mirrors server.ts's unbound-mapping
  // behavior, ADD-0008 §3). The declared outputSchema is not enforced for these tools.
  const data = result.data;
  // #44: `status.output` stays unpopulated — `result.data` is precisely the payload the record
  // must never carry.
  audit({ phase: "succeeded" });
  if (data && typeof data === "object" && !Array.isArray(data)) {
    return { status: "ok", data: data as Record<string, unknown> };
  }
  return { status: "ok" };
}
