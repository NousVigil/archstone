// @archstone/agent — the embedded SDK (RFC-0008 / ADD-0008 #28)
//
// Root entry ONLY: fromIR, tools(format), execute(). Zero @modelcontextprotocol/sdk
// reachability from this entry's module graph — the `/mcp` subpath (mcpHandler, #29,
// out of scope here) is the only place this package reaches the MCP SDK, transitively via
// @archstone/runtime's `/http` subpath. Dependencies: @archstone/compiler (types),
// @archstone/emitter-support, @archstone/provider-rest — no @archstone/runtime, no MCP SDK,
// no node:fs/node:path (see test/boundary.test.ts).

import type { IR } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";
import { buildToolDefs, type ToolFormat, type ToolDef } from "./tools";
import { buildExtractor, type Extractor } from "./extract";
import { executeCapability, type ExecuteOptions, type ExecuteResult } from "./execute";

export type {
  ToolFormat,
  ToolDef,
  AnthropicToolDef,
  OpenAIChatToolDef,
  OpenAIResponsesToolDef,
  /** @deprecated Renamed to `OpenAIChatToolDef` by #89. */
  OpenAIToolDef,
  GeminiToolDef,
  JsonSchemaToolDef,
} from "./tools";
export { sanitizeGeminiSchema } from "./tools";
export type { ExecuteOptions, ExecuteResult, ExecuteDenial } from "./execute";
/** ADR-0011 / #11: the extraction surface — what a model must PRODUCE, and the boundary its
 *  answer passes through. Schema and judge are one object by construction; see `extract.ts`. */
export type {
  Extractor,
  StructuredOutputDef,
  AnthropicStructuredOutput,
  OpenAIChatStructuredOutput,
  OpenAIResponsesStructuredOutput,
  /** @deprecated Renamed to `OpenAIResponsesStructuredOutput` by #89. */
  OpenAIStructuredOutput,
  GeminiStructuredOutput,
  JsonSchemaStructuredOutput,
} from "./extract";
export { UnknownResourceError } from "./extract";
export type { ExtractionResult, ExtractionStatus } from "@archstone/emitter-support";
/** #43: the closed set of policy denial reason codes carried on `ExecuteResult.denial`.
 *  Re-exported so a consumer can name/exhaustively switch on it without importing
 *  `@archstone/emitter-support` — type-only, no runtime edge (test/boundary.test.ts). */
export type { PolicyDenialReason } from "@archstone/emitter-support";
/** `CallerContext` is the type of `ExecuteOptions.caller` (and of what the `/mcp` subpath's
 *  `resolveCaller` returns). Re-exported for the same reason as `FetchLike`: a consumer must be
 *  able to name it without importing `@archstone/provider-rest`, which is a transitive
 *  dependency of this package and not a declared dependency of theirs (#46). Type-only — no
 *  runtime edge, no change to this entry's import graph (test/boundary.test.ts). */
export type { FetchLike, CallerContext } from "@archstone/provider-rest";
export { Registry, UnknownSemanticTypeError } from "@archstone/emitter-support";
/** #44: the audit sink surface. Re-exported here (and from `@archstone/runtime`) so a deployer
 *  wires a sink from the package they already depend on, rather than adding
 *  `@archstone/emitter-support` — a transitive dependency of this one — to their own manifest.
 *  `jsonLinesAuditSink` is the shipped reference sink and imports no `node:` module, so the
 *  root entry's fs-free/SDK-free property is unchanged (test/boundary.test.ts). */
export {
  jsonLinesAuditSink,
  REDACTED,
  LIFECYCLE_BLOCKED_REASON,
  LIFECYCLE_UNEVALUATABLE_REASON,
} from "@archstone/emitter-support";
export type {
  AuditSink,
  AuditWritable,
  ExecutionRecord,
  ExecutionStatus,
  ExecutionPhase,
  ExecutionConsumer,
  ExecutionDenialReason,
} from "@archstone/emitter-support";

/** Thrown by fromIR() when the artifact isn't a `version: "0"` IR — D-2's one enforced
 *  public contract surface (ADD-0008 §3). Fail-closed: missing, wrong-typed, or a future
 *  version all throw rather than proceeding on a shape this package doesn't recognize. */
export class InvalidArtifactError extends Error {
  constructor(reason: string) {
    super(`invalid archstone IR artifact: ${reason}`);
    this.name = "InvalidArtifactError";
  }
}

/** The embedded SDK object returned by fromIR() — wraps a Registry over the compiled IR. */
export interface Archstone {
  readonly registry: Registry;
  tools(format: ToolFormat): ToolDef[];
  /** ADR-0011: an extractor for one declared resource — the schema a model is given and the
   *  boundary its answer passes through, bound together. Throws `UnknownResourceError` for a
   *  resource the artifact does not declare, and `ExtractionSchemaError` for one that cannot
   *  be lowered into a closed schema. */
  extractor(resource: string, format: ToolFormat): Extractor;
  execute(capabilityId: string, input: Record<string, unknown>, opts?: ExecuteOptions): Promise<ExecuteResult>;
}

/**
 * Construct an embedded Archstone instance from a compiled IR artifact (produced by
 * `archstone build`, ADD-0008 #27). Fail-closed: only `version` is validated before the
 * artifact is trusted — the rest of the shape is treated as opaque/trusted once that check
 * passes (D-2: the IR is not a documented public contract).
 *
 * #214: throws `UnknownSemanticTypeError` (naming the type and the field path) when the
 * artifact uses a semantic type this build does not know, instead of lowering it as `string`.
 */
export function fromIR(json: unknown): Archstone {
  if (typeof json !== "object" || json === null) {
    throw new InvalidArtifactError("expected an object");
  }
  const version = (json as { version?: unknown }).version;
  if (version !== "0") {
    throw new InvalidArtifactError(`unsupported version ${JSON.stringify(version)} (expected "0")`);
  }

  const registry = new Registry(json as IR);
  // ADD-30 D-2: refuse before `tools()`/`execute()` are ever reachable — a tool-name
  // collision would otherwise let `execute()` silently resolve a shared advertised name to
  // whichever colliding capability the registry happened to index first (BR-6).
  if (registry.toolNameCollisions.length > 0) {
    const detail = registry.toolNameCollisions.map((c) => `'${c.name}' (${c.ids.join(", ")})`).join("; ");
    throw new InvalidArtifactError(`ambiguous tool name(s): ${detail}`);
  }

  return {
    registry,
    tools: (format) => buildToolDefs(registry, format),
    extractor: (resource, format) => buildExtractor(registry, resource, format),
    execute: (capabilityId, input, opts) => executeCapability(registry, capabilityId, input, opts),
  };
}
