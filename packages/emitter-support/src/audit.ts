// @archstone/emitter-support — the Execution audit record (#44 / ADD-44)
//
// One record per capability invocation ATTEMPT — the answer to Rule #7's "who invoked what,
// when, with what outcome", including the attempts that were refused before a backend was ever
// contacted.
//
// WHERE THE RECORD IS BUILT AND WHY IT IS HERE. The two audited consumers — @archstone/runtime's
// `callTool` and @archstone/agent's `executeCapability` — are the same two sites that already
// call `evaluatePolicy`, so authorization and audit are decided at ONE seam: a path that skips
// the gate also skips the record rather than emitting one that falsely implies a gate ran. They
// both build through the single builder below, never through two independent assemblies (the
// #30 defect class: two builders drift, and the drift is invisible until an auditor compares an
// `mcp` record to a `function-calling` one).
//
// WHY NOT `onResponse`. #39's hook fires at exactly ONE of the fifteen places an invocation
// attempt terminates, and #39's own rules REQUIRE it not to fire at the other fourteen — which
// include every governance-relevant one (policy denial, lifecycle block, unbound binding,
// missing credential, allowlist rejection). The hook is correct and must stay correct; it is
// simply not an audit emission point and cannot be made into one without breaking it. What #44
// does reuse from #39 is its surface and its discipline, verbatim: one options bag, fire and
// forget, never awaited, throw/rejection caught at the call site and logged once.
//
// WHY `invokeRest` NEVER READS THE SINK. `verifyTool` forwards the identical options bag into
// `invokeRest`; a sink read there would make "the contract prober emits nothing" unimplementable
// without a special case. Because the record is built by the CONSUMER, non-emission by the
// prober follows from where the code lives and needs no code at all.
//
// PURE apart from the clock and the id it generates. Nothing here reads the filesystem, opens a
// socket, or holds state across invocations, so it works unchanged on a stateless edge runtime.

import type { IRTool } from "@archstone/compiler";
import type { PolicyDenialReason } from "./policy";

/**
 * The record's denial vocabulary: the policy evaluator's four codes, copied verbatim, plus
 * exactly TWO non-policy refusal codes (ADD-56 widens this from one to two).
 *
 * `phase: "denied"` has two PRODUCERS, not two codes: the policy evaluator is one, and the
 * exposure gate — `lifecycleExposure` (`exposure.ts`) — is the other. The exposure gate itself
 * now has two DISTINCT denying outcomes, each its own code:
 *  - `lifecycle_blocked` — a `retired` capability: a business withdrew it. A GOVERNANCE fact,
 *    remedied only by a business decision to un-retire it.
 *  - `lifecycle_unevaluatable` (ADD-56) — a `lifecycle` value this build does not recognize at
 *    all (an unrecognized string, a non-string, or an absent field on a hand-written or
 *    forward-versioned artifact, ADD-56 D-1). A COMPATIBILITY fact, remedied only by upgrading
 *    the runtime or recompiling with a compatible builder — no business decision is possible.
 * Recording either as `failed` would conflate "refused by governance/compatibility" with "the
 * backend broke" in the one log where that distinction is the entire product (ADD-44). Conflating
 * the two denial CODES with each other is the narrower version of the same mistake — see
 * `exposure.ts`'s `lifecycleExposure` doc comment and ADD-56's Challenge section for why they
 * must stay distinguishable.
 *
 * **`PolicyDenialReason` stays exactly four and is NOT widened** — the evaluator can never
 * return either lifecycle code, and this union exists precisely so it does not have to.
 *
 * **Standing rule: every member has exactly one enumerated producer, and this set grows only by
 * an architecture decision naming the new producer.** Today: four from `evaluatePolicy`, two
 * from the exposure gate's two denying branches (ADD-24 D-10 named `lifecycle_blocked`'s
 * producer; ADD-56 D-1/D-3 names `lifecycle_unevaluatable`'s), and one from `evaluateRateLimit`
 * (ADD-45 D-2 names `rate_limit_exceeded`'s producer — the "counter would exceed maxInvocations"
 * branch specifically; the *other* fail-closed branch of that same function, "rateLimit declared
 * but no counter supplied", deliberately reuses `policy_unevaluatable` rather than adding a
 * second new code — see `evaluateRateLimit`'s own doc comment for why that is the same meaning,
 * not a different one wearing the same name), and one from the input-contract gate (#195:
 * `validateInput` refusing a call whose arguments do not match the declared input fields —
 * `input_invalid`'s single named producer, run after policy and before the rate limiter). Without that rule the enum is a list; with it, it
 * is a contract — and it is permanent the moment a customer filters on one of these strings.
 */
export type ExecutionDenialReason =
  | PolicyDenialReason
  | "lifecycle_blocked"
  | "lifecycle_unevaluatable"
  | "rate_limit_exceeded"
  | "input_invalid";

/** The non-policy refusal code for a `retired` capability. Spelled to match the agent-facing
 *  `LIFECYCLE_BLOCKED_META_KEY` the MCP surface already ships — one concept, one spelling,
 *  across both surfaces. */
export const LIFECYCLE_BLOCKED_REASON = "lifecycle_blocked" satisfies ExecutionDenialReason;

/** ADD-56: the non-policy refusal code for a capability whose declared `lifecycle` this build
 *  does not recognize at all — distinct from `LIFECYCLE_BLOCKED_REASON` (`retired`) because the
 *  two are different facts with different remediations (see `ExecutionDenialReason`'s own doc
 *  comment). Spelled to match the agent-facing `LIFECYCLE_UNEVALUATABLE_META_KEY` the MCP
 *  surface ships alongside it — one concept, one spelling, across both surfaces. */
export const LIFECYCLE_UNEVALUATABLE_REASON = "lifecycle_unevaluatable" satisfies ExecutionDenialReason;

/** #195: the refusal code for arguments that do not match the capability's declared input
 *  contract. Spelled to match the agent-facing `INPUT_INVALID_META_KEY` suffix on the MCP surface. */
export const INPUT_INVALID_DENIAL_REASON = "input_invalid" satisfies ExecutionDenialReason;

/**
 * The protocol surface the call arrived on — **fixed by the emitting call site, never
 * host-configurable, defaultable, or overridable.** A host-settable value is not evidence: an
 * auditor must be able to trust that a record claiming `mcp` came from the MCP path.
 *
 * Note the one case readers expect to go the other way: a call arriving through
 * `@archstone/agent`'s `mcpHandler` records `mcp`, not `function-calling` — the value names the
 * protocol, not the npm package that mounted it.
 */
export type ExecutionConsumer = "mcp" | "function-calling";

/** Terminal phases only. `pending`/`running` exist in the schema for a lifecycle model this
 *  increment deliberately does not build: one record per attempt makes them unreachable. A
 *  future progress/streaming increment emitting them would be WIDENING the sink contract from
 *  one record per attempt to many, and every consumer written against "one line per attempt"
 *  would be affected. */
export type ExecutionPhase = "succeeded" | "failed" | "denied";

export interface ExecutionStatus {
  phase: ExecutionPhase;
  /** The human error text the consumer already returns for this outcome, VERBATIM. The record
   *  copies; it never authors, re-words, enriches, or re-classifies. That is what keeps it a
   *  witness to shipped behaviour rather than a second, drifting description of it — and it is
   *  what lets a deployer grep the audit log for the same string the agent was shown. */
  message?: string;
  denialReason?: ExecutionDenialReason;
  /** ADD-44 Amendment 2 (archstone#34): present only when `phase` is `"failed"`. `true` when
   *  `invokeRest` received a response from the connector (a non-2xx status, or a response that
   *  failed the declared mapping); `false` when the attempt never got one — a missing binding
   *  prerequisite or a network-level failure before any response arrived. Absent on `succeeded`
   *  and `denied`, where it would be a constant carrying no information. Doc 6 §3's billing rule:
   *  billable iff `phase === "succeeded"` or (`phase === "failed"` and `reachedConnector === true`). */
  reachedConnector?: boolean;
}

/**
 * One `Execution` record — the shape of `execution.schema.json`, which every emitted record is
 * tested against using the compiled schema (`@archstone/schema`'s `validateExecution`), never a
 * hand-written literal.
 *
 * **What this record deliberately has no field for, and never acquires one:** the caller
 * credential, any header, any URL or resolved `baseUrl`, any query string or request body, the
 * backend's response payload, the backend's HTTP status code, `caller.tenantId`, and the
 * capability's `effect`. Redaction here is structural first and a scrub second: there is
 * nowhere for a secret to land, and the scrub is defence in depth for the refactor that widens
 * where input flows.
 */
export interface ExecutionRecord {
  apiVersion: "archstone/v1";
  kind: "Execution";
  metadata: {
    /** Unique per attempt, never reused, never derived from the capability id, the input, the
     *  principal, or the timestamp alone. It is the record's only handle: a derived id collides
     *  silently under concurrency, and a deployer de-duplicating on it would delete real
     *  evidence. */
    id: string;
    /** The unsanitized CDL id — never the MCP-sanitized advertised tool name. Two capabilities
     *  can advertise under one sanitized name; the CDL id is the only stable key an auditor can
     *  join on against the manifest. */
    capabilityId: string;
    provider: string;
    /** Pass-through from what the host supplied; never synthesized, defaulted, or derived. */
    sessionId?: string;
    workflowId?: string;
    startedAt: string;
    completedAt: string;
  };
  spec: {
    input: Record<string, unknown>;
    consumer: ExecutionConsumer;
    /** Omitted — not `null`, not `""`, not the literal `"anonymous"` — when the invocation
     *  supplied no principal. An explicit `principal: ""` is PRESENT and is recorded as `""`.
     *  The presence or absence of this key is also the only way a deployer recovers the
     *  "anonymous vs. wrong principal" distinction that `principal_not_allowed` deliberately
     *  does not carry (see `buildExecutionRecord`). */
    principal?: string;
    /** Always present, possibly empty. Ids only. */
    policyRuleIds: string[];
  };
  status: ExecutionStatus;
}

/**
 * A deployer-supplied audit sink: one call per invocation attempt, on the two audited consumers.
 *
 * **THE AUDIT TRAIL IS BEST-EFFORT AND LOSSY BY DESIGN. It is not a guaranteed-complete record
 * and must not be a deployment's sole audit control.** A sink that throws, rejects, or hangs
 * must never break or delay the invocation it observes — and a guaranteed-complete trail is the
 * other side of that same coin. This increment chose the invocation. So when a sink fails, the
 * record is **lost**, and the only trace is one line on stderr, emitted once per failure and
 * never deduplicated or rate-limited into silence. A regulated reader who sees the word "audit"
 * will assume completeness; this statement lives on the type because a deployer wires the type
 * and may never read the guide.
 *
 * Called synchronously, immediately before the consumer returns its result. The returned value
 * is never awaited and never inspected: a Promise's rejection is caught and logged, and nothing
 * a sink does — success, throw, rejection, hang, or mutating the record it was handed — is
 * observable by the AI agent or changes the invocation's result by a single byte.
 *
 * The record handed over is freshly built for this attempt and shares no reference with the
 * input the capability was invoked with, so a sink may hold, mutate, or store it freely.
 */
export type AuditSink = (record: ExecutionRecord) => void | Promise<void>;

/** The fixed, non-reversible marker a scrubbed credential is replaced by. Carries no length,
 *  prefix, suffix, or hash of the value it replaced, and is identical for every value it
 *  replaces — two records scrubbed of two different tokens are indistinguishable. */
export const REDACTED = "[redacted]";

// A process-local monotonic counter, used ONLY by the fallback id path below. Not a
// correlation seam and not exposed.
let idCounter = 0;

interface CryptoLike {
  randomUUID?: () => string;
}

/** Unique per attempt. `crypto.randomUUID()` where the runtime has it (Node 19+, Workers,
 *  browsers); otherwise a counter+entropy composite, so two invocations one millisecond apart
 *  still differ — the timestamp alone is never the id. */
function newExecutionId(): string {
  const c = (globalThis as { crypto?: CryptoLike }).crypto;
  if (typeof c?.randomUUID === "function") return c.randomUUID();
  idCounter += 1;
  return `exec-${Date.now().toString(36)}-${idCounter.toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** The attempt clock. Both readings are RFC 3339 / ISO 8601 `date-time` strings. */
export function auditNow(): string {
  return new Date().toISOString();
}

/**
 * Deep-copy `value`, replacing every OCCURRENCE of one of `secrets` inside any string with
 * `REDACTED`.
 *
 * Two jobs in one pass, both load-bearing:
 *
 *  1. **Copy** — the record must share no reference with the object the capability was invoked
 *     with, so a sink that mutates what it receives can neither corrupt that input nor affect
 *     any other record.
 *  2. **Scrub** — defence in depth. A caller credential structurally cannot reach `spec.input`
 *     today (it arrives on `opts.caller` and is substituted deep inside the REST provider,
 *     while capability input interpolates only into `{param}` placeholders). The scrub is the
 *     rule that survives the next refactor: it holds even if an agent passes a token as an
 *     input field, even if a future connector shape widens where input flows, and even if an
 *     error message ever embeds a caller-derived value.
 *
 * **Substring, not whole-value equality — deliberately stronger than "a field equal to the
 * token".** The property a deployer needs, and the property the redaction test asserts, is that
 * the credential appears NOWHERE in the emitted bytes; whole-value matching would satisfy a
 * field walk and still leak a token embedded in a longer string. It can happen: the
 * caller-influenced-`baseUrl` allowlist rejection interpolates the RESOLVED host into its error
 * message, and that host is built from `${caller.*}` substitution. The cost is accepted with
 * eyes open — a pathologically short credential over-redacts unrelated text — because in an
 * evidentiary log over-redaction is a visible nuisance and under-redaction is a security
 * regression on the increment that introduced caller credentials.
 *
 * `seen` makes a circular input safe to copy — an unserializable input is the reference sink's
 * problem to report, never a reason for the invocation to fail.
 */
function copyAndScrub(value: unknown, secrets: readonly string[], seen: Map<object, unknown>): unknown {
  if (typeof value === "string") {
    let out = value;
    for (const secret of secrets) out = out.split(secret).join(REDACTED);
    return out;
  }
  if (typeof value !== "object" || value === null) return value;

  if (seen.has(value)) return seen.get(value);

  if (Array.isArray(value)) {
    const out: unknown[] = [];
    seen.set(value, out);
    for (const item of value) out.push(copyAndScrub(item, secrets, seen));
    return out;
  }

  const out: Record<string, unknown> = {};
  seen.set(value, out);
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = copyAndScrub(v, secrets, seen);
  }
  return out;
}

/** What the consumer knows about the caller at the moment it records. Deliberately NOT a
 *  `CallerContext`: that type lives in `@archstone/provider-rest`, and this package must never
 *  learn about HTTP — the same reason the policy evaluator takes a bare principal.
 *
 *  **BF-1 (code review, #44): every string-valued field on this object except `principal` is a
 *  scrub target — discovered generically at `Object.entries` time in `callerSecrets` below,
 *  never by naming fields.** The bug this fixes: `${caller.tenantId}` can be substituted into a
 *  binding's `baseUrl`, and a caller-influenced-baseUrl allowlist rejection embeds the RESOLVED
 *  host in `InvokeResult.error` — which `buildExecutionRecord` copies verbatim into
 *  `status.message` (BR-15). A scrub keyed to the single named field `accessToken` never saw
 *  `tenantId`, so that value reached an emitted record unscrubbed. Naming `tenantId` here too
 *  would only move the bug to the NEXT field `CallerContext` grows — the fix is that this
 *  interface's *shape* is documentation, and `callerSecrets` reads whatever fields the caller
 *  actually supplies at runtime, not this interface's declared list. */
export interface AuditCaller {
  /** The exact value handed to `evaluatePolicy` on the same call. Reading the principal from a
   *  second source is how the record and the decision come to disagree. The one field the
   *  generic scrub deliberately exempts (BR-35 > BR-10: a redacted-but-present `spec.principal`
   *  keeps the disclosure seam; a scrubbed one would not). */
  principal?: string;
  /** The caller credential — one example of the generic rule above, not a special case of it.
   *  Documented explicitly because it is the field a scrub MUST cover; kept as a named property
   *  (rather than folded into an index signature) purely so callers keep constructing this type
   *  with the field they already know about. Never written to the record under any key: one
   *  field cannot be simultaneously redacted and audited, which is exactly why the principal and
   *  the credential are two fields and never one. */
  accessToken?: string;
}

/**
 * Every scrub-target STRING VALUE carried on `caller`, `principal` excepted — read generically
 * via `Object.entries`, not a fixed list of names (see `AuditCaller`'s doc-comment / BF-1). A
 * `CallerContext` value (from `@archstone/provider-rest`) legitimately carries fields this
 * package's `AuditCaller` type never names — `tenantId` today, whatever is added next — and
 * every one of them is caught here without this file changing.
 *
 * Filters to non-empty strings for the reason the original `accessToken`-only check always did:
 * scrubbing `""` would replace every empty string in the record with the marker — destroying
 * evidence to protect nothing. A non-string field (there are none today) is silently skipped
 * rather than coerced — the record must never be the thing that throws on a malformed caller.
 */
function callerSecrets(caller: AuditCaller | undefined): string[] {
  if (!caller) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(caller)) {
    if (key === "principal") continue;
    if (typeof value === "string" && value !== "") out.push(value);
  }
  return out;
}

export interface BuildExecutionRecordInput {
  tool: IRTool;
  input: Record<string, unknown>;
  consumer: ExecutionConsumer;
  caller?: AuditCaller;
  sessionId?: string;
  workflowId?: string;
  /** Taken by the consumer BEFORE the exposure gate and before policy evaluation, so a refused
   *  attempt still has a real start time — an attempt that cannot be placed on a timeline is
   *  useless to the first person reviewing an incident. */
  startedAt: string;
  status: ExecutionStatus;
}

/**
 * Build one terminal `Execution` record. The single builder both audited consumers use.
 *
 * **A note that is a rule, not a comment.** `principal_not_allowed` deliberately does NOT
 * distinguish "you supplied no principal" from "you supplied one that is not on the list", and
 * this record must not reconstitute that distinction — no second code, no flag, no differing
 * message. It is a founder-ratified disclosure decision under Rule #7, not a loss of fidelity:
 * a denial that told the two apart would hand anyone who can vary the principal an enumeration
 * oracle, one refused call at a time, the moment the code is surfaced back through the tool
 * boundary. The deployer's legitimate version of the question is already answered without a new
 * code — `spec.principal` present means a principal was supplied and rejected, absent means
 * anonymous. Do not "improve" this.
 */
export function buildExecutionRecord(args: BuildExecutionRecordInput): ExecutionRecord {
  const { tool, consumer, caller, status } = args;

  // BF-1: every string field on `caller` except `principal`, discovered generically — see
  // `callerSecrets`'s own doc-comment for why this is not `[caller?.accessToken]` any more.
  const secrets = callerSecrets(caller);
  const scrub = <T,>(v: T): T => copyAndScrub(v, secrets, new Map()) as T;

  const record: ExecutionRecord = {
    apiVersion: "archstone/v1",
    kind: "Execution",
    metadata: {
      id: newExecutionId(),
      capabilityId: tool.id,
      provider: tool.provider,
      startedAt: args.startedAt,
      completedAt: auditNow(),
    },
    spec: {
      input: scrub(args.input),
      consumer,
      // Ids only — never the rules' `allow`/`deny` arrays, which would write an allow-list into
      // an evidentiary log and hand anyone with log access an enumeration oracle. Populated
      // identically on EVERY phase: on an allowed record this reads "these were in force and
      // were satisfied", never "these fired". A rule whose `id` is not a string (one of the
      // conditions that makes a policy unevaluatable in the first place) is omitted rather than
      // coerced — the record must never be the thing that throws on a malformed artifact.
      policyRuleIds: (tool.policyRules ?? []).map((r) => r?.id).filter((id): id is string => typeof id === "string"),
    },
    status: { phase: status.phase },
  };

  if (args.sessionId !== undefined) record.metadata.sessionId = args.sessionId;
  if (args.workflowId !== undefined) record.metadata.workflowId = args.workflowId;
  // Absent stays absent. An explicit `""` is present and is recorded as `""`.
  if (caller?.principal !== undefined) record.spec.principal = scrub(caller.principal);
  if (status.message !== undefined) record.status.message = scrub(status.message);
  if (status.denialReason !== undefined) record.status.denialReason = status.denialReason;
  // ADD-44 Amendment 2 (archstone#34): present only when the caller sets it, which the two
  // audited consumers do only on `phase: "failed"` — never synthesized here for any other phase.
  if (status.reachedConnector !== undefined) record.status.reachedConnector = status.reachedConnector;

  // `status.output` is NEVER populated, on any phase — the schema has the property and this
  // emitter has no code path that writes it. Rule #7's non-negotiable is "with what OUTCOME",
  // not "with what data": a response body is where a token-issuing or PII-returning capability
  // puts its most sensitive bytes, and writing it to a retained, line-oriented log would make
  // the audit trail the deployment's largest exfiltration surface. Revisit only under Rule
  // #10's Demanded gate — two independent deployers, with a redaction grammar designed BEFORE
  // it ships, never alongside.
  return record;
}

/**
 * Hand a record to the sink — fire and forget, exactly the discipline #39 established for
 * `onResponse` and for the same reason: observability must never break the business invocation
 * it observes.
 *
 * A sink failure means **evidence was lost**, and the operator is the only party who can ever
 * know, so every failure is reported — once per failure, naming the capability, never
 * deduplicated, rate-limited, or suppressed into silence. Nothing here ever reaches the agent.
 * stderr, never stdout: on the stdio transport stdout IS the MCP protocol channel.
 */
export function emitExecutionRecord(sink: AuditSink | undefined, record: ExecutionRecord): void {
  if (!sink) return;
  const id = record.metadata.capabilityId;
  try {
    const maybePromise = sink(record);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch((err: unknown) => {
        console.error(`archstone: audit sink rejected for capability '${id}' — record lost:`, err);
      });
    }
  } catch (err) {
    console.error(`archstone: audit sink threw for capability '${id}' — record lost:`, err);
  }
}

/** The minimal write target the reference sink needs — `process.stderr`, a
 *  `fs.createWriteStream(path)`, or anything else with a `write`. Deliberately not typed as a
 *  Node stream: this package imports no `node:` module and must stay usable on an edge runtime. */
export interface AuditWritable {
  write(chunk: string): unknown;
}

/**
 * The reference sink: one `JSON.stringify(record)` + `\n` per record, straight through.
 *
 * No buffering, no batching, no retention, no rotation, no shipping, no network connection —
 * one line, one write. A sink is a function, so everything else is the deployer's to wrap.
 *
 * **It cannot be pointed at stdout.** On the stdio transport stdout *is* the MCP protocol
 * channel, so a JSON Lines logger writing there would interleave audit records into the
 * JSON-RPC stream and corrupt every subsequent message — an audit feature that breaks the
 * server it audits. `process.stdout` is refused at construction time, loudly, rather than
 * discovered as a garbled session.
 *
 * Defaults to `process.stderr`. On a runtime that has no `process.stderr` (an edge host),
 * construction throws immediately — a deployer error worth discovering at wiring time rather
 * than as a stream of caught sink failures at invocation time. Supply your own target there.
 *
 * Serialization failures (a circular or `BigInt`-bearing input) surface as ordinary sink
 * failures: the invocation is unaffected and the loss is announced on stderr. Archstone does
 * not coerce the input to make it serializable — that would silently record something other
 * than what was actually invoked.
 */
export function jsonLinesAuditSink(target?: AuditWritable): AuditSink {
  const proc = (globalThis as { process?: { stdout?: unknown; stderr?: AuditWritable } }).process;
  if (target !== undefined && proc?.stdout !== undefined && (target as unknown) === proc.stdout) {
    throw new Error(
      "jsonLinesAuditSink: refusing to write audit records to stdout — stdout is the MCP protocol channel. Use stderr or a file stream.",
    );
  }
  const out = target ?? proc?.stderr;
  if (!out || typeof out.write !== "function") {
    throw new Error(
      "jsonLinesAuditSink: no write target — this runtime has no process.stderr, so pass one explicitly.",
    );
  }
  return (record) => {
    out.write(`${JSON.stringify(record)}\n`);
  };
}
