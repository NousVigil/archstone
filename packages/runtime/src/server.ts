// @archstone/runtime — MCP server construction (fs-free)
//
// Builds an MCP Server from a Registry and routes invocations through the REST provider
// (#6). This is the ONLY place the MCP SDK appears (alongside stdio's transport wiring in
// mcp.ts and the /http subpath's transport wiring in http.ts) — semantic-type → JSON-Schema
// lowering itself now lives in @archstone/emitter-support (ADD-0008 #27), never here.
//
// Extracted out of mcp.ts (ADD-0008 #27) specifically so this module's graph never reaches
// registry.ts's buildRegistry/@archstone/schema `load()` (the fs edge) — only stdio's
// `serveStdio` (mcp.ts) needs disk access. `http.ts` (the /http subpath) imports only this
// file, so a consumer depending on that subpath alone stays fs-free.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  type CallToolResult,
  type ToolAnnotations,
} from "@modelcontextprotocol/sdk/types.js";
import type { IRTool } from "@archstone/compiler";
import {
  Registry,
  inputJsonSchema,
  objectJsonSchema,
  applyResponseMapping,
  contractViolationMessage,
  passThroughRefusal,
  withheldNote,
  evaluatePolicy,
  evaluateRateLimit,
  auditNow,
  buildExecutionRecord,
  emitExecutionRecord,
  LIFECYCLE_BLOCKED_REASON,
  LIFECYCLE_UNEVALUATABLE_REASON,
  type ExecutionStatus,
  type PolicyDecision,
} from "@archstone/emitter-support";
// ADR-0012 D-5/D-6: this file is reachable from THREE surfaces — `serveStdio` (mcp.ts, Node-
// only), `runtime/src/http.ts` (the edge-safe `/http` subpath), and
// `examples/demo/remote-mcp-worker` (imports the package ROOT directly, bundled for Cloudflare
// Workers). It therefore imports the EDGE-SAFE dispatcher (`./connector-rest`), never the full
// one (`./connector`, which imports `@archstone/provider-sql` -> `pg`) — confirmed by
// `packages/runtime/test/boundary.test.ts` and a measured `wrangler deploy --dry-run` bundle
// size. A Node-only caller (the CLI's stdio `serve`) that wants `sql`-bound capabilities to work
// supplies `opts.connector` (see `./connector-rest`'s `InvokeOptions.connector`); this file
// itself never branches on that decision — `invokeConnectorRest` does, once.
import { invokeConnectorRest, type InvokeOptions as ConnectorInvokeOptions } from "./connector-rest";

type InvokeOptions = ConnectorInvokeOptions;

type JsonSchema = Record<string, unknown>;

/**
 * #126: the subset of MCP's `ToolAnnotations` this emitter is entitled to populate from CDL.
 *
 * Derived from the SDK's own `ToolAnnotations` via `Pick` rather than re-declared, so the three
 * field names are checked against the installed SDK at compile time instead of being trusted to
 * a comment. Confirmed present on the tool definition at the version `^1.12.0` resolves to
 * (1.30.0): `ToolSchema.annotations` is `ToolAnnotationsSchema.optional()`, and that schema
 * declares `title`, `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`.
 *
 * The two members deliberately NOT picked, because no CDL field means them:
 *  - `openWorldHint` — whether the tool's domain of interaction is open or closed. Archstone
 *    knows a capability's `effect`, never the shape of the world behind its connector. A guess
 *    here would be indistinguishable, to a client, from a fact.
 *  - `title` — a display concern with no CDL source; `description` already carries the
 *    business-authored text (plus any exposure hint, ADD-24).
 */
export type McpToolAnnotations = Pick<ToolAnnotations, "readOnlyHint" | "destructiveHint" | "idempotentHint">;

/**
 * #126: lower a capability's `effect` — the one field `archstone init` refuses to guess and
 * insists a human confirm — into MCP tool annotations, so the client's tool-confirmation dialog
 * can tell `tourism.search` from a capability that charges a card. Before this, `effect` was
 * compiled, carried through the IR, and dropped here: `McpToolDef` had no field for it and
 * `toolDefinitions` never read it, so the ONLY human-in-the-loop mechanism that exists today
 * (`human-approval` is declared and unenforced — `apply` says so) decided blind.
 *
 * The mapping, exactly and only:
 *   read         → readOnlyHint: true
 *   irreversible → destructiveHint: true,  idempotentHint: false
 *   write        → destructiveHint: false
 *
 * `write`'s single `false` is not a no-op: per the SDK's own schema docs, `destructiveHint`
 * DEFAULTS TO TRUE when absent, so stating it is the only thing that keeps a `write` from
 * reaching the client indistinguishable from an `irreversible`. Conversely `read` needs no
 * `destructiveHint` — the same docs describe that field as meaningful only when `readOnlyHint`
 * is false.
 *
 * The seam in this mapping, named rather than papered over: MCP describes
 * `destructiveHint: false` as a tool whose updates are purely additive, whereas CDL's `write`
 * means "modifies, reversibly" — `examples/manifests/booking`'s `tourism.cancel` is an
 * `effect: write` and is plainly not additive. The two vocabularies are adjacent, not
 * identical, and #126 ratified this pairing as the closest available fit, not a perfect one.
 * Read `destructiveHint: false` here as *not irreversible*, the distinction CDL actually draws.
 * Do not "improve" this into a finer per-capability judgement: CDL has no additivity primitive,
 * so anything more specific would be invented rather than derived — the same reasoning that
 * keeps `openWorldHint` off the list above.
 *
 * **This is a hint, not a control.** Nothing in Archstone gates, refuses, or retries on the
 * value — deliberately (#126, Not in scope). MCP's own spec says as much of every annotation,
 * and a client is free to ignore all of it.
 *
 * WHY THIS LIVES HERE AND NOT IN @archstone/emitter-support. CLAUDE.md puts lowering that is
 * *shared* between emitters in emitter-support; `readOnlyHint`/`destructiveHint`/
 * `idempotentHint` are MCP-protocol vocabulary with, as of this increment, exactly one
 * consumer. Every target format `@archstone/agent`'s `tools()` emits was checked against its
 * live reference before this call was made — the field lists, references and dates are in
 * `packages/agent/src/tools.ts`'s header comment, pinned by `packages/agent/test/tools.test.ts`
 * — and NONE has an equivalent field, so there is nothing to share. Note that `effect` itself
 * still reaches every `@archstone/agent` consumer: they hold the Registry and read it off the
 * IR directly, which is exactly why nothing needed inventing there. `exposure.ts` — the neutral
 * presentation module, and the obvious tempting
 * home — states the rule this follows verbatim: "MCP-specific rendering ... belongs only in
 * @archstone/runtime's server.ts, never here." Move it to emitter-support the day a second
 * emitter needs it, and not before: re-encoding `read|write|irreversible` into some other
 * neutral vocabulary one layer down would add a translation with no second reader, when the IR
 * already carries the fact in the neutral vocabulary that matters.
 *
 * TOTAL, on purpose — same trust boundary and same reasoning as `lifecycleExposure`'s
 * `default` branch (ADD-56 D-1). `effect`'s static type is a closed three-member union, but the
 * value reaches this function un-runtime-validated whenever the Registry was built by
 * `fromIR`'s `json as IR` cast (`agent/src/index.ts`, which validates only `version === "0"`)
 * and served through `mcpHandler` → `createHttpHandler` → `createMcpServer` → here. A
 * hand-written or forward-versioned artifact can carry any string. That case returns
 * `undefined` — NO annotations at all — rather than any positive claim, so the client falls
 * back to MCP's own documented defaults (`readOnlyHint: false`, `destructiveHint: true`), which
 * are the cautious reading. The one outcome that must never be reachable from an unrecognized
 * value is `readOnlyHint: true`, and returning nothing is the only answer that guarantees it.
 */
export function effectAnnotations(effect: IRTool["effect"]): McpToolAnnotations | undefined {
  switch (effect) {
    case "read":
      return { readOnlyHint: true };
    case "irreversible":
      return { destructiveHint: true, idempotentHint: false };
    case "write":
      return { destructiveHint: false };
    default:
      // Unrecognized `effect` across the `fromIR` trust boundary — claim nothing. See above.
      return undefined;
  }
}

export interface McpToolDef {
  name: string;
  description: string;
  inputSchema: JsonSchema;
  outputSchema?: JsonSchema;
  /** #126: derived from the capability's `effect` — see `effectAnnotations`. Absent only when
   *  `effect` is a value this build does not recognize (possible solely via `fromIR`). */
  annotations?: McpToolAnnotations;
}

/** The MCP tool list: only invocable (bound) capabilities become tools — Registry's
 *  `invocableTools()` (ADD-30 D-3) is the single source of truth shared by this function
 *  (what's listed) and `callTool` (what's resolvable, via `getCapability`), keeping the two
 *  consistent. Input and output fields lower against the IR resource registry, so a
 *  `collection: Stay` output emits a typed, described `outputSchema` (not a bare
 *  `{type:object}`).
 *
 *  ADD-24: a bound tool whose combined exposure (`registry.getExposure`, lifecycle + optional
 *  health) is `listed:false` (lifecycle `experimental`/`retired`) is dropped from the returned
 *  list entirely — unlisted, per D-10, though `experimental` remains callable by id (see
 *  `callTool`). A tool carrying a `hint` (beta/deprecated, or a yellow/red health reading) has
 *  its text appended to `description` — the only MCP-specific rendering of the neutral
 *  exposure the emitter-support layer computed.
 *
 *  #126: every listed tool also carries `annotations` derived from its `effect`
 *  (`effectAnnotations`), so the client's confirmation dialog stops treating a search and a
 *  payment identically. Both transports reach this one function — stdio via `serveStdio`'s
 *  `createMcpServer`, HTTP via `createHttpHandler`'s — so there is no second place to keep in
 *  step. */
export function toolDefinitions(registry: Registry): McpToolDef[] {
  const resources = registry.ir.resources;
  return registry
    .listedTools()
    .map(({ name, tool: t }) => {
      const hint = registry.getExposure(t.id).hint;
      const def: McpToolDef = {
        name,
        description: hint ? `${t.description} (${hint.text})` : t.description,
        inputSchema: inputJsonSchema(t.input, resources),
      };
      if (t.output.length > 0) {
        // #81 (ADD-12 §8.1): a declared `onError` widens the ONE collection field it targets to
        // admit both row shapes in outputSchema — see objectJsonSchema's own doc comment.
        const onError = t.response?.onError ? { field: t.response.field, errorResource: t.response.onError.errorResource } : undefined;
        def.outputSchema = objectJsonSchema(t.output, resources, undefined, onError);
      }
      const annotations = effectAnnotations(t.effect);
      if (annotations) def.annotations = annotations;
      return def;
    });
}

export interface CallResult {
  content: { type: "text"; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  _meta?: Record<string, unknown>;
}

/** #19 ADD-19 Rev 2 D-6: the namespaced `_meta` key a VIOLATION result's structured error
 *  object is carried under. Never populated on `structuredContent` (D-3′) — the reference
 *  MCP SDK client validates `structuredContent` against `outputSchema` whenever the tool
 *  declares one, regardless of `isError`, so a non-conforming error object there crashes the
 *  client. `_meta` is untouched by that validation and passes through the client's zod parse
 *  unstripped (`ResultSchema`/`RequestMetaSchema` are `z.looseObject`). */
export const CONTRACT_VIOLATION_META_KEY = "dev.archstone/contract_violation";

/** ADD-24 D-11: the namespaced `_meta` key a `retired` (or otherwise `invocable:false`)
 *  tool's rejection is carried under — reuses `CONTRACT_VIOLATION_META_KEY`'s precedent
 *  (ADD-19 Rev 2 D-3′/D-6) verbatim: never `structuredContent`, so the reference SDK client's
 *  unconditional `structuredContent`-against-`outputSchema` validation never sees it. A
 *  distinct key (not `CONTRACT_VIOLATION_META_KEY`) so a client distinguishes "this call was
 *  blocked before any connector work" from "the provider's response violated the contract". */
export const LIFECYCLE_BLOCKED_META_KEY = "dev.archstone/lifecycle_blocked";

/** ADD-56 D-2/OQ-56-B: the namespaced `_meta` key an unrecognized-lifecycle rejection is
 *  carried under — a DISTINCT key from `LIFECYCLE_BLOCKED_META_KEY`, mirroring
 *  `POLICY_DENIED_META_KEY` vs. `LIFECYCLE_BLOCKED_META_KEY` being genuinely distinct keys
 *  rather than one key with a varying `error` string inside it. `retired` (a governance
 *  refusal) and an unrecognized `lifecycle` (a compatibility refusal) are different facts with
 *  different remediations and must be trivially distinguishable to a client — see
 *  `exposure.ts`'s `Exposure.blockedReason` doc comment. */
export const LIFECYCLE_UNEVALUATABLE_META_KEY = "dev.archstone/lifecycle_unevaluatable";

/** #43 ADD-43: the namespaced `_meta` key a POLICY denial is carried under — the third use of
 *  the ADD-19 Rev 2 D-3′/D-6 precedent, verbatim: never `structuredContent`, because the
 *  reference SDK client validates that against the tool's `outputSchema` unconditionally (not
 *  gated on `isError`) and an error object there crashes it. A distinct key from the other two
 *  so a client can tell "refused by policy before any connector work" from "blocked by
 *  lifecycle" from "the provider's response violated the contract" — the three are mutually
 *  exclusive on one call (BR-27). The object discloses the reason code and the capability id
 *  and NOTHING about the policy itself: no metadata.id, no allow/deny entry, no other
 *  principal's identifier (BR-30, Rule #7 — the MCP client is the untrusted side). */
export const POLICY_DENIED_META_KEY = "dev.archstone/policy_denied";

/** Route an MCP tool call to the REST provider and format the result as MCP content. */
export async function callTool(
  registry: Registry,
  name: string,
  args: Record<string, unknown>,
  opts?: InvokeOptions,
): Promise<CallResult> {
  const tool = registry.getCapability(name);
  if (!tool) {
    // #44: NO audit record. `metadata.capabilityId` is required and the only value available
    // here is an unvalidated, caller-chosen string that is not a CDL id — writing it there
    // would put unbounded attacker-controlled values into the audit log's primary correlation
    // key, in a file a compliance process treats as evidence. An `Execution` record audits a
    // capability invocation attempt; a call naming no capability is a protocol-level event and
    // belongs to the host's own mount-point instrumentation. Named residual, deliberately
    // accepted: tool-name probing (and the collision defence, which also lands here) is
    // invisible to the audit trail.
    return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
  }

  // #44: the attempt clock starts HERE — before the exposure gate and before policy evaluation,
  // so every refused attempt still carries a real `startedAt` and can be placed on a timeline.
  // With no sink configured this is a strict no-op: no clock read, no id, no record, no
  // allocation, and every result byte-for-byte what it was before this increment.
  const auditSink = opts?.auditSink;
  const startedAt = auditSink ? auditNow() : "";
  const audit = (status: ExecutionStatus): void => {
    if (!auditSink) return;
    emitExecutionRecord(
      auditSink,
      buildExecutionRecord({
        tool,
        input: args,
        // Fixed by this call site, never host-configurable: an auditor must be able to trust
        // that a record claiming `mcp` came from the MCP path. `mcpHandler` mounts this same
        // path and therefore also records `mcp` — the value names the protocol surface the call
        // arrived on, not the npm package that mounted it.
        consumer: "mcp",
        caller: opts?.caller,
        sessionId: opts?.sessionId,
        workflowId: opts?.workflowId,
        startedAt,
        status,
      }),
    );
  };

  // ADD-24 D-10/D-11: `lifecycle: retired` sets `invocable:false` (health never does, D-9) —
  // checked immediately after resolution, before any connector/response work, same call-site
  // discipline the `contract_violation` check already uses downstream.
  //
  // ADD-56 D-1/D-2: `lifecycleExposure` is now TOTAL — an unrecognized `lifecycle` value (only
  // reachable via a hand-written or forward-versioned `fromIR` artifact, ADD-0008 D-2) ALSO sets
  // `invocable:false`, distinguished from `retired` by `exposure.blockedReason`. The two are
  // different facts with different remediations (governance vs. compatibility — see
  // `exposure.ts`'s `Exposure.blockedReason` doc comment) and MUST NOT share a message or a
  // `denialReason`. `exposure.blockedReason === "unevaluatable"` is the only branch this can take
  // here: the `undefined` case (D-4's unknown-id fallback) cannot occur, because `tool` above was
  // already resolved via `getCapability`, which reads the identical `exposureById` map.
  const exposure = registry.getExposure(tool.id);
  if (!exposure.invocable) {
    if (exposure.blockedReason === "unevaluatable") {
      const text = `capability '${tool.id}' declares a lifecycle this build does not recognize and cannot evaluate — refusing (fail-closed).`;
      // #44: `denied`, never `failed` — refusing on a compatibility gap is not a backend
      // failure. Deliberately distinct denialReason/message/meta-key from the `retired` branch
      // below (ADD-56 D-2/D-3) — never `LIFECYCLE_BLOCKED_REASON`.
      audit({ phase: "denied", message: text, denialReason: LIFECYCLE_UNEVALUATABLE_REASON });
      return {
        content: [{ type: "text", text }],
        _meta: {
          [LIFECYCLE_UNEVALUATABLE_META_KEY]: { error: "lifecycle_unevaluatable", capability: tool.id, lifecycle: tool.lifecycle },
        },
        isError: true,
      };
    }
    const text = `capability '${tool.id}' is retired and can no longer be invoked.`;
    // #44: `denied`, never `failed` — a refusal by lifecycle is a refusal by governance, and
    // recording it as a failure would conflate it with "the backend broke" in the one log where
    // that distinction is the entire product. This gate is the SECOND (and only other) producer
    // of `phase: "denied"`, and the reason code the policy evaluator can never return. It runs
    // before policy deliberately, so a capability that is both retired and policy-denied records
    // `lifecycle_blocked`, matching the pinned gate order.
    audit({ phase: "denied", message: text, denialReason: LIFECYCLE_BLOCKED_REASON });
    return {
      content: [{ type: "text", text }],
      _meta: { [LIFECYCLE_BLOCKED_META_KEY]: { error: "lifecycle_blocked", capability: tool.id, lifecycle: tool.lifecycle } },
      isError: true,
    };
  }

  // #43 (ADD-43 D-5/D-6): THE policy evaluation point, called unconditionally — for every tool,
  // including one with no resolved policy, because `authenticated` enforcement now lives here
  // rather than inside `invokeRest` (D-4). Deliberately AFTER the ADD-24 exposure gate above, so
  // a `retired` capability reports `lifecycle_blocked` and never `policy_denied` (BR-34), and
  // strictly BEFORE `invokeRest`, so a denial does zero connector work: no env/caller
  // resolution, no URL building, no fetch, and no `onResponse` firing (BR-25).
  // #48: a `resolveCaller` that THREW for this request (rather than returning, even
  // `undefined`) short-circuits straight to a `policy_unevaluatable` denial for every
  // capability, bypassing `evaluatePolicy` entirely — identity extraction itself failed here,
  // which is strictly less trustworthy than "no credential offered" and must fail closed
  // regardless of whether THIS capability happens to declare `policies:[authenticated]`
  // (ADD-42 R-11). Reuses the evaluator's own reason code and this function's existing
  // policy-denial response shaping verbatim — no parallel response path.
  const decision: PolicyDecision = opts?.callerResolutionFailed
    ? {
        allowed: false,
        denial: {
          reason: "policy_unevaluatable",
          message: `capability '${tool.id}' could not be evaluated — caller identity could not be established (resolveCaller failed) — refusing (fail-closed).`,
        },
      }
    : evaluatePolicy(tool, {
        principal: opts?.caller?.principal,
        credentialPresent: opts?.caller?.accessToken !== undefined,
      });
  if (!decision.allowed) {
    // #44: the evaluator's OWN reason code, copied verbatim — no re-spelling, no mapping table,
    // no superset for the policy case. The message is likewise the evaluator's, unaltered:
    // the record copies, it never authors.
    audit({ phase: "denied", message: decision.denial.message, denialReason: decision.denial.reason });
    return {
      content: [{ type: "text", text: decision.denial.message }],
      _meta: {
        [POLICY_DENIED_META_KEY]: {
          error: "policy_denied",
          // `tool.id` — the unsanitized CDL id, never the MCP-sanitized advertised `name`
          // lookup key (BR-28, mirroring ADD-19 and ADD-30 BR-7).
          capability: tool.id,
          reason: decision.denial.reason,
        },
      },
      isError: true,
    };
  }

  // #45 (ADD-45 D-2/D-3): the rate-limit evaluation step, called at the SAME point as the policy
  // evaluator above — immediately after it allows, strictly before `invokeRest` — so a
  // rate-limited call does exactly as much connector work as a policy-denied one: none. Reuses
  // the identical `policy_denied` `_meta` shape and audit wiring; only the reason code differs.
  const rateDecision = await evaluateRateLimit(tool, { principal: opts?.caller?.principal }, opts?.rateLimitCounter);
  if (!rateDecision.allowed) {
    audit({ phase: "denied", message: rateDecision.denial.message, denialReason: rateDecision.denial.reason });
    return {
      content: [{ type: "text", text: rateDecision.denial.message }],
      _meta: {
        [POLICY_DENIED_META_KEY]: {
          error: "policy_denied",
          capability: tool.id,
          reason: rateDecision.denial.reason,
        },
      },
      isError: true,
    };
  }

  const result = await invokeConnectorRest(tool, args, opts);
  if (!result.ok) {
    // #44: every attempt that never completed a usable round-trip — unbound capability, missing
    // env var, missing caller credential, no baseUrl, an allowlist rejection, a missing path
    // parameter, a network error, a non-2xx response — records `failed` carrying the shipped
    // error text verbatim, so a deployer greps the audit log and finds the same string the
    // agent was shown.
    // ADD-44 Amendment 2 (archstone#34): `reachedConnector` disambiguates the billable/
    // non-billable split inside `failed` — `status !== 0` iff invokeRest received a response
    // (a non-2xx), never true for a pre-dispatch short-circuit or a network-level exception,
    // both of which leave `status` at its zero default.
    const text = result.error ?? "invocation failed";
    audit({ phase: "failed", message: text, reachedConnector: result.status !== 0 });
    return { content: [{ type: "text", text }], isError: true };
  }

  // #12 (ADD-12), extended by `extract:` (per the accepted architecture decision extending
  // ADD-12): a binding with a `response:` mapping and/or an `extract:` block is now MAPPED +
  // VALIDATED against the declared output — the outputSchema (ADD-11) becomes an enforced
  // contract, not just declared, for every field either mechanism reaches. No new branch: both
  // read through the one `applyResponseMapping` call and its one `MappingResult` below.
  if (tool.response || tool.extract) {
    const mapped = applyResponseMapping(tool, result.data, registry.ir.resources);
    if (mapped.status === "violation") {
      // Fail closed (D-6): the declared output shape was not met — no raw pass-through.
      const missing = mapped.missing ?? [];
      // The text is unchanged byte-for-byte; it moved into a shared helper (#44) only so the
      // embedded consumer, whose own result carries no text, records the identical sentence.
      const text = contractViolationMessage(tool.id, missing, mapped.withheld);
      // #19 (ADD-19 Rev 2 D-3′/D-6): structured error object lives in `_meta`, never
      // `structuredContent` — the reference SDK client validates `structuredContent` against
      // the tool's `outputSchema` unconditionally (not gated on `isError`), so a VIOLATION
      // object there (which never conforms to the success outputSchema) crashes the client
      // (verified live against the SDK's own InMemoryTransport, R2.0/R2.2). `capability` is
      // `tool.id`, the unsanitized CDL id — never the MCP-sanitized `name` lookup key (BR-7).
      // #44: a VIOLATION is `failed` — the declared output shape was not met.
      // ADD-44 Amendment 2: this branch is reachable only after `invokeRest` returned `ok: true`
      // — a response was, by construction, received — so `reachedConnector` is unconditionally
      // true here, never derived from a `status` check the way the `!result.ok` branch needs.
      audit({ phase: "failed", message: text, reachedConnector: true });
      return {
        content: [{ type: "text", text }],
        // `withheld` (field names only) rides along only when a value was withheld by the origin
        // check, so every other violation keeps exactly the shape shipped clients assert.
        _meta: {
          [CONTRACT_VIOLATION_META_KEY]: {
            error: "contract_violation",
            capability: tool.id,
            missing,
            ...(mapped.withheld ? { withheld: mapped.withheld } : {}),
          },
        },
        isError: true,
      };
    }
    const content: CallResult["content"] = [{ type: "text", text: JSON.stringify(mapped.data, null, 2) }];
    if (mapped.status === "degraded" && (mapped.degraded ?? []).length > 0) {
      content.push({ type: "text", text: `note: optional field(s) absent (degraded): ${(mapped.degraded ?? []).join(", ")}` });
    }
    if (mapped.withheld) content.push({ type: "text", text: withheldNote(mapped.withheld) });
    // #44: `degraded` records `succeeded`, NOT `failed` — every *required* field was present and
    // an optional one was not, so the invocation succeeded. Pinned in a comment because
    // "degraded" reads like a failure and the next reader will guess otherwise.
    audit({ phase: "succeeded" });
    return { content, structuredContent: mapped.data, isError: false };
  }

  // An origin-checked output on a pass-through tool: the compiler refuses this, so only a
  // hand-written IR gets here — and the raw body would carry the unchecked link. Fail closed.
  const refusal = passThroughRefusal(tool, registry.ir.resources);
  if (refusal) {
    audit({ phase: "failed", message: refusal, reachedConnector: true });
    return { content: [{ type: "text", text: refusal }], isError: true };
  }

  // Neither `response:` nor `extract:`: today's raw pass-through (rollout-safe). The declared
  // outputSchema is NOT yet enforced for these tools — add a `response:` and/or `extract:` block
  // to close the loop (ADD-12 R-3).
  const out: CallResult = { content: [{ type: "text", text: JSON.stringify(result.data ?? null, null, 2) }], isError: false };
  if (tool.output.length > 0) {
    const data = result.data;
    if (data && typeof data === "object" && !Array.isArray(data)) {
      out.structuredContent = data as Record<string, unknown>;
    }
  }
  // #44: `status.output` is deliberately NOT populated here (nor anywhere) — `result.data` is
  // exactly the payload the record must never carry.
  audit({ phase: "succeeded" });
  return out;
}

/** Build an MCP Server that lists and invokes the registry's tools. */
export function createMcpServer(registry: Registry, opts?: InvokeOptions): Server {
  const server = new Server({ name: "archstone", version: "0" }, { capabilities: { tools: {} } });

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: toolDefinitions(registry) }));

  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    const args = (req.params.arguments ?? {}) as Record<string, unknown>;
    const result = await callTool(registry, req.params.name, args, opts);
    return result as CallToolResult;
  });

  return server;
}
