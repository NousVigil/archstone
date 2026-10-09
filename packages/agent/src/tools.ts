// @archstone/agent — tool-definition envelopes per target format (ADD-0008 #28)
//
// Thin wrappers over @archstone/emitter-support's neutral JSON-Schema lowering
// (inputJsonSchema) — every format shares that ONE lowering; only the envelope shape
// differs (CLAUDE.md: "lowering lives only in @archstone/emitter-support, never
// re-implemented"). The advertised `name` itself (sanitized via `toolName()`) now comes
// straight from Registry.invocableTools() (ADD-30 D-3) — this file no longer re-derives
// the invocable filter or re-runs the sanitizer. Gemini additionally needs a dialect-subset
// sanitizer, since its function-calling Schema object is NOT full JSON Schema — see
// sanitizeGeminiSchema below.

// #126 — `effect` and these envelopes: why nothing is emitted here.
//
// `@archstone/runtime`'s MCP emitter now lowers a capability's `effect` into MCP tool
// annotations (`readOnlyHint`/`destructiveHint`/`idempotentHint`, server.ts's
// `effectAnnotations`), because an MCP client is REMOTE and can act only on what crosses the
// wire. #126 asks for "the equivalent where the target format has one". Each format below was
// checked against its live reference before concluding, and none has one:
//
//   anthropic         The Messages API tool definition takes `name`/`description`/
//                     `input_schema` plus exactly six optional properties — `cache_control`,
//                     `strict`, `defer_loading`, `allowed_callers`, `input_examples`,
//                     `eager_input_streaming` (platform.claude.com "Tool reference" §Tool
//                     definition properties, checked 2026-08-25). None annotates side effects.
//   openai-chat       A Chat Completions tool is `{type, function: {name, description,
//                     parameters}}` — no `strict` and no side-effect field at this level
//                     (developers.openai.com/api/docs/guides/function-calling, checked
//                     2026-09-24). This is `"openai"`'s pre-existing, unchanged shape.
//   openai-responses  A Responses API tool is flat: `{type, name, description, parameters,
//                     strict}` (developers.openai.com/api/docs/guides/function-calling,
//                     checked 2026-09-24). Read-only and destructive hints appear in OpenAI's
//                     docs ONLY when describing MCP servers/connectors — i.e. they are MCP's
//                     annotations, reached through MCP, not a native field of this envelope.
//                     Do not be misled by a search result that says otherwise; that conflation
//                     is exactly why this was read at source.
//   gemini            `FunctionDeclaration` does carry a `behavior` field, and it is NOT an
//                     equivalent: its values are BLOCKING/NON_BLOCKING and they control whether
//                     the model waits for the tool response in the Live API — an
//                     async-execution concern, not a side-effect annotation (checked
//                     2026-08-25). Mapping `irreversible` onto it would be a category error
//                     dressed as a feature.
//   json-schema       Archstone's own neutral envelope, so nothing stops us adding a field —
//                     which is precisely why we don't. This consumer is IN-PROCESS and already
//                     holds `archstone.registry`; `effect` is one property lookup away on the
//                     IR and was never withheld from them. The asymmetry that makes #126 a bug
//                     for MCP simply does not exist here, and widening a published type to
//                     restate a fact the caller can already read would be an unratified API
//                     change, not a fix.
//
// So: no invention, in either direction — `tools()` gains no field, and no format gets a
// hand-rolled stand-in. `test/tools.test.ts` pins each envelope's exact key set so that a
// future contributor adding one has to change a test that says why it is absent. Revisit per
// format, against that format's live reference, if a provider ships a real equivalent.

import { Registry, inputJsonSchema } from "@archstone/emitter-support";

type JsonSchema = Record<string, unknown>;

export type ToolFormat =
  | "anthropic"
  /** @deprecated Ambiguous across OpenAI's two APIs — use `"openai-chat"` (Chat Completions)
   *  or `"openai-responses"` (Responses API) instead. Kept as an alias of `"openai-chat"` on
   *  both the tools axis (unchanged) and the structured-output axis (changed by #89 — see
   *  CHANGELOG). */
  | "openai"
  | "openai-chat"
  | "openai-responses"
  | "gemini"
  | "json-schema";

export interface AnthropicToolDef {
  name: string;
  description: string;
  input_schema: JsonSchema;
}

/** Chat Completions' nested tool shape — `"openai"` (deprecated alias) emits this unchanged. */
export interface OpenAIChatToolDef {
  type: "function";
  function: { name: string; description: string; parameters: JsonSchema };
}

/** @deprecated Renamed to `OpenAIChatToolDef` by #89 — this alias exists so existing type-level
 *  consumers do not break. */
export type OpenAIToolDef = OpenAIChatToolDef;

/** The Responses API's flat tool shape (developers.openai.com/api/docs/guides/function-calling,
 *  checked 2026-09-24). `strict` is always `false` — see extract.ts's header for why. */
export interface OpenAIResponsesToolDef {
  type: "function";
  name: string;
  description: string;
  parameters: JsonSchema;
  strict: false;
}

/** Gemini's native `FunctionDeclaration` shape is flat — {name, description, parameters} —
 *  unlike OpenAI's `{type:"function", function:{...}}` wrapper (verified against
 *  ai.google.dev/api/caching#FunctionDeclaration, checked 2026-07-17). */
export interface GeminiToolDef {
  name: string;
  description: string;
  parameters: JsonSchema;
}

/** The neutral shape — no provider envelope — for non-agent-SDK consumers. */
export interface JsonSchemaToolDef {
  name: string;
  description: string;
  schema: JsonSchema;
}

export type ToolDef = AnthropicToolDef | OpenAIChatToolDef | OpenAIResponsesToolDef | GeminiToolDef | JsonSchemaToolDef;

/**
 * Gemini's function-calling Schema object is a documented SUBSET of OpenAPI 3.0 schema —
 * verified against the live API reference (ai.google.dev/api/caching#Schema, checked
 * 2026-07-17, per ADD-0008 §4/R-4's explicit instruction not to hand-roll this from
 * memory). Supported keys: type, format, title, description, nullable, enum, maxItems,
 * minItems, properties, required, minProperties, maxProperties, minLength, maxLength,
 * pattern, example, anyOf, propertyOrdering, default, items, minimum, maximum. NOT
 * supported (stripped here): additionalProperties, $ref, allOf, oneOf, if/then/else,
 * const, patternProperties, not, exclusiveMinimum/Maximum, multipleOf, prefixItems.
 *
 * This pass USED to be a no-op on current output. It no longer is: `extractionJsonSchema`
 * (ADR-0011) emits `additionalProperties: false`, which is not in the list above, so this is
 * the first key the sanitizer actually removes — and removing it is what ADR-0011's R-2
 * describes, on the TOOL axis only: the model is not told the object is closed, while
 * `validateExtraction` closes it regardless. A quality difference, never a safety one.
 *
 * The structured-output axis is a DIFFERENT Gemini surface (`response_format.schema`) whose own
 * reference does list `additionalProperties`, so `extract.ts` does not route through here. The
 * function-calling reference could not be re-read at the address cited above (checked again
 * 2026-08-30, the anchor no longer resolves), so this list is deliberately left exactly as it
 * was verified in 2026-07 rather than widened on the strength of the other surface's docs.
 * Re-verify at source before changing it.
 */
const GEMINI_ALLOWED_KEYS = new Set([
  "type",
  "format",
  "title",
  "description",
  "nullable",
  "enum",
  "maxItems",
  "minItems",
  "properties",
  "required",
  "minProperties",
  "maxProperties",
  "minLength",
  "maxLength",
  "pattern",
  "example",
  "anyOf",
  "propertyOrdering",
  "default",
  "items",
  "minimum",
  "maximum",
]);

export function sanitizeGeminiSchema(schema: JsonSchema): JsonSchema {
  const out: JsonSchema = {};
  for (const [key, value] of Object.entries(schema)) {
    if (!GEMINI_ALLOWED_KEYS.has(key)) continue;
    if (key === "properties" && value && typeof value === "object") {
      const props: JsonSchema = {};
      for (const [name, propSchema] of Object.entries(value as JsonSchema)) {
        props[name] = sanitizeGeminiSchema(propSchema as JsonSchema);
      }
      out.properties = props;
    } else if (key === "items" && value && typeof value === "object") {
      out.items = sanitizeGeminiSchema(value as JsonSchema);
    } else {
      out[key] = value;
    }
  }
  return out;
}

/**
 * One capability/resource, one format, one envelope. Extracted from `buildToolDefs` so the
 * extraction surface (`extract.ts`, ADR-0011) wraps a schema in exactly the shape this file
 * already ships, rather than restating four provider envelopes a second time. The only thing
 * that varies between the two callers is which schema goes in and what the description says.
 */
export function toolEnvelope(format: ToolFormat, name: string, description: string, schema: JsonSchema): ToolDef {
  switch (format) {
    case "anthropic":
      return { name, description, input_schema: schema };
    case "openai": // deprecated alias of "openai-chat" (#89) — tools axis unchanged
    case "openai-chat":
      return { type: "function", function: { name, description, parameters: schema } };
    case "openai-responses":
      return { type: "function", name, description, parameters: schema, strict: false };
    case "gemini":
      return { name, description, parameters: sanitizeGeminiSchema(schema) };
    case "json-schema":
      return { name, description, schema };
    default:
      // ADD-56 D-5: zero-risk hardening, NOT a fix to a reachable defect. `format` is supplied
      // directly by the trusted host program calling `tools(format)` — it never originates from
      // a `fromIR` artifact or any other externally-sourced data (unlike `lifecycle`, ADD-56's
      // actual defect). Reachable only by a caller bypassing this package's own `ToolFormat`
      // type checking (an `as`/`any` cast on a value it constructs itself). Before this branch,
      // that case silently returned `undefined` where `ToolDef[]` is declared, crashing the
      // caller downstream on `.map`/spread instead of here, with a clear cause.
      throw new Error(
        `toolEnvelope: unrecognized tool format: ${String(format)} (expected one of "anthropic", ` +
          `"openai", "openai-chat", "openai-responses", "gemini", "json-schema")`,
      );
  }
}

/** Lower every invocable capability to `format`'s tool-definition envelope. Reads the
 *  (name, tool) pairs Registry already derived (ADD-30 D-3) instead of re-deriving the
 *  invocable filter or re-running `toolName()` here.
 *
 *  ADD-24 (#55): mirrors `@archstone/runtime`'s `toolDefinitions()` (server.ts) — the shared
 *  `registry.getExposure` (ADD-24 D-6/R-5) is consulted here too, so this, the OTHER surface
 *  that tells a host what capabilities exist, is no longer lifecycle-blind. A bound tool whose
 *  exposure is `listed:false` (lifecycle `experimental`/`retired`) is dropped from the returned
 *  list entirely, exactly as the MCP path drops it. A tool carrying a `hint` (beta/deprecated,
 *  or a yellow/red health reading) has its text appended to `description` — the only
 *  per-format-envelope rendering of the neutral exposure emitter-support computed. */
export function buildToolDefs(registry: Registry, format: ToolFormat): ToolDef[] {
  const resources = registry.ir.resources;
  const tools = registry.listedTools();
  const describe = (t: (typeof tools)[number]["tool"]): string => {
    const hint = registry.getExposure(t.id).hint;
    return hint ? `${t.description} (${hint.text})` : t.description;
  };
  return tools.map(({ name, tool: t }) => toolEnvelope(format, name, describe(t), inputJsonSchema(t.input, resources)));
}
