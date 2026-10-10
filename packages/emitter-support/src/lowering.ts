// @archstone/emitter-support — semantic-type → JSON-Schema lowering
//
// Moved out of @archstone/runtime's mcp.ts (ADD-0008 #27), unchanged logic. This is the
// ONLY place semantic types get lowered to JSON Schema — every format an emitter targets
// (MCP's inputSchema/outputSchema today; Anthropic/OpenAI/Gemini tool envelopes later)
// shares this, never re-implements it. No MCP SDK here — the SDK-specific tool shape
// (McpToolDef) stays in @archstone/runtime.

import { originListOf, type IRField, type IRResourceRegistry, type SemanticType } from "@archstone/compiler";

type JsonSchema = Record<string, unknown>;

/** How closed the lowering is. `open` is the output/descriptive lowering. `extraction` is the
 *  closed, refuse-don't-degrade lowering a model must satisfy (ADR-0011). `input` (#195) is the
 *  closed lowering advertised as a tool's `inputSchema` and enforced by `validateInput`: objects
 *  are closed, but an unknown or self-referential resource still degrades to `{type:object}`
 *  rather than throwing, so listing tools never fails on an odd artifact. */
type LowerMode = "open" | "input" | "extraction";

/** MCP tool names are stricter than capability ids — sanitize `tourism.search` → `tourism_search`. */
export function toolName(id: string): string {
  return id.replace(/[^a-zA-Z0-9_-]/g, "_");
}

function semanticJsonSchema(semantic: SemanticType, values: string[] | undefined, mode: LowerMode): JsonSchema {
  const closed = mode !== "open" ? { additionalProperties: false } : {};
  switch (semantic) {
    case "location":
      return { type: "string", description: "A place — city, region, or address." };
    case "date-range":
      return {
        type: "object",
        properties: { from: { type: "string", format: "date" }, to: { type: "string", format: "date" } },
        required: ["from", "to"],
        ...closed,
      };
    case "party":
      return {
        type: "object",
        properties:
          mode === "input"
            ? { adults: { type: "integer", minimum: 0 }, children: { type: "integer", minimum: 0 } }
            : { adults: { type: "integer" }, children: { type: "integer" } },
        required: ["adults"],
        ...closed,
      };
    case "preference-set":
      return { type: "array", items: { type: "string" } };
    case "money":
      return {
        type: "object",
        properties: { amount: { type: "number" }, currency: { type: "string" } },
        required: ["amount", "currency"],
        ...closed,
      };
    case "time-slot":
    case "datetime":
      return { type: "string", format: "date-time" };
    case "date":
      return { type: "string", format: "date" };
    case "web-page":
      // Output-only, origin-checked. `format: uri` is safe to advertise because the mapper emits
      // the normalised href, never the provider's raw string. No `pattern` built from the
      // declared origins: the mapper already enforces the stronger rule, and a pattern would only
      // add a way for a strict client to reject a value the mapper accepted.
      return { type: "string", format: "uri" };
    case "image":
      // Output-only, origin-checked, same lowering as `web-page`: the mapper emits the normalised
      // href, so `format: uri` holds; no `pattern`, and (for a list) no `minItems`, so an array
      // shortened by per-item withholding still validates. The fallback description lives at the
      // property level (see `imageFallbackDescription`), never on `items`.
      return { type: "string", format: "uri" };
    case "quantity":
      return { type: "number" };
    case "enum":
      return { type: "string", enum: values ?? [] };
    case "identifier":
    case "string":
    case "text":
    default:
      return { type: "string" };
  }
}

/**
 * Lower a resolved resource (looked up by canonical name in the registry) to a typed,
 * described object schema. `visited` guards against recursive/self-referential resources
 * (R-3): a name already being expanded stops at a generic `{type:object}`. An unknown name
 * (validation floor) also degrades to `{type:object}` rather than crashing.
 *
 * Under `strict` both of those degradations are refused instead — see `extractionJsonSchema`.
 */
function resourceJsonSchema(name: string, resources: IRResourceRegistry, visited: ReadonlySet<string>, mode: LowerMode): JsonSchema {
  const fields = resources[name];
  if (!fields || visited.has(name)) {
    if (mode === "extraction") throw new ExtractionSchemaError(!fields ? `resource '${name}' is not in the registry` : `resource '${name}' is self-referential through a \`type:\` field`);
    return { type: "object" };
  }
  const next = new Set(visited).add(name);
  return lowerObject(fields, resources, next, mode);
}

/** #81 (ADD-12 §8.1): tag a resource's object schema with `$row: "ok" | "error"` (a `const`
 *  discriminator — the same shape an OpenAPI `oneOf` import maps its own `const` onto), and
 *  add `$row` to `required` so a client can always branch on it. */
function taggedRowSchema(schema: JsonSchema, tag: "ok" | "error"): JsonSchema {
  const properties = { ...(schema.properties as JsonSchema | undefined), $row: { const: tag } };
  const required = [...((schema.required as string[] | undefined) ?? []), "$row"];
  return { ...schema, properties, required };
}

/** #81: when a `collection:` field is the one `response.onError` targets, its `outputSchema`
 *  items admit BOTH row shapes (`items: { oneOf: [...] }`) instead of only the success
 *  resource's — the MCP scenario and the OpenAPI `oneOf` import scenario fall out of the same
 *  discriminator shape (ADD-12 §8.1). */
export interface OnErrorFieldSchema {
  field: string; // the output field name `response:` binds to (D-7)
  errorResource: string;
}

/** What a model is told about an `image` property when the author wrote no description: the URL
 *  is for showing to a person, not for fetching. An authored description always wins. */
const IMAGE_FALLBACK_DESCRIPTION = "An image URL to show a person. Do not fetch it.";

function fieldJsonSchema(
  f: IRField,
  resources: IRResourceRegistry,
  visited: ReadonlySet<string>,
  mode: LowerMode,
  onError: OnErrorFieldSchema | undefined,
): JsonSchema {
  const base: JsonSchema = f.description ? { description: f.description } : {};
  if (mode === "extraction") {
    // An origin-bound type is output-only: a link a model produces is exactly what it exists to
    // keep out. Refused here, by name, rather than lowered into a schema a model could satisfy.
    const semantic = f.type.kind === "scalar" ? f.type.semantic : f.type.kind === "list" ? f.type.items : undefined;
    if (semantic !== undefined && originListOf(semantic) !== undefined) {
      throw new ExtractionSchemaError(`field '${f.name}' is of type ${semantic}, which is output-only and never an extraction target`);
    }
  }
  if (f.type.kind === "list") {
    const fallback = f.type.items === "image" && !f.description ? { description: IMAGE_FALLBACK_DESCRIPTION } : {};
    return { ...base, ...fallback, type: "array", items: semanticJsonSchema(f.type.items, f.type.values, mode) };
  }
  if (f.type.kind === "collection") {
    if (onError && onError.field === f.name) {
      const success = taggedRowSchema(resourceJsonSchema(f.type.of, resources, visited, mode), "ok");
      const error = taggedRowSchema(resourceJsonSchema(onError.errorResource, resources, visited, mode), "error");
      return { ...base, type: "array", items: { oneOf: [success, error] } };
    }
    return { ...base, type: "array", items: resourceJsonSchema(f.type.of, resources, visited, mode) };
  }
  if (f.type.kind === "resource") {
    // `ref:`-originated ("by identity") fields are a bare id — never expand through the
    // resource registry (ADD-25 D-2). `type:`/resource-typed ("by representation") fields
    // keep the existing full-object lowering.
    if (f.type.identity) return { ...base, type: "string" };
    return { ...base, ...resourceJsonSchema(f.type.name, resources, visited, mode) };
  }
  // The AUTHORED description wins. A semantic type's generic text ("A place — city, region, or
  // address.") is a fallback for a field that declares none — never a replacement for one that
  // does. Before this, the spread order silently discarded the manifest's own sentence for any
  // semantic type that carries a description — `location` is the only one today, which is exactly
  // why this went unnoticed: it looks correct on every other field. Tolerable while a description
  // is documentation; not once it is the instruction a model extracts against. The precedence is
  // fixed for the rule, not for the one case, so a semantic type that gains a description later
  // cannot reintroduce it. Re-asserting the key rather than reversing the spread keeps every OTHER key
  // (type, format, properties, required, enum) semantic-owned, and keeps emitted key order
  // byte-identical for the fields this does not change.
  const semantic = semanticJsonSchema(f.type.semantic, f.type.values, mode);
  if (f.type.semantic === "image" && !f.description) return { ...semantic, description: IMAGE_FALLBACK_DESCRIPTION };
  return f.description ? { ...base, ...semantic, description: f.description } : { ...base, ...semantic };
}

/** The one walker. Both public lowerings below go through it; neither re-implements it. */
function lowerObject(
  fields: IRField[],
  resources: IRResourceRegistry,
  visited: ReadonlySet<string>,
  mode: LowerMode,
  onError?: OnErrorFieldSchema,
): JsonSchema {
  const properties: JsonSchema = {};
  const required: string[] = [];
  for (const f of fields) {
    properties[f.name] = fieldJsonSchema(f, resources, visited, mode, onError);
    if (f.required) required.push(f.name);
  }
  const schema: JsonSchema = { type: "object", properties };
  if (required.length > 0) schema.required = required;
  if (mode !== "open") schema.additionalProperties = false;
  return schema;
}

/** Lower an IR field list to a JSON Schema object, resolving resource/collection field
 *  types through the registry (typed, described). Used for both input and output schemas.
 *  `onError` (#81, ADD-12 §8.1) widens the ONE collection field it names to admit both the
 *  success and the declared error row shape — pass `tool.response`'s `field`/`onError` when
 *  generating a tool's outputSchema; omit for input schemas and for every other caller. */
export function objectJsonSchema(
  fields: IRField[],
  resources: IRResourceRegistry = {},
  visited: ReadonlySet<string> = new Set(),
  onError?: OnErrorFieldSchema,
): JsonSchema {
  return lowerObject(fields, resources, visited, "open", onError);
}

/** Lower IR input fields to a JSON Schema object (the tool's inputSchema).
 *
 *  #195: the schema is CLOSED (`additionalProperties: false` at every object level, composites
 *  included) and `party` counts carry `minimum: 0`, because `validateInput` enforces exactly this
 *  and an advertised contract the runtime does not hold to is the defect. Both are produced here,
 *  by the one walker, so what is advertised and what is enforced cannot diverge. */
export function inputJsonSchema(fields: IRField[], resources: IRResourceRegistry = {}): JsonSchema {
  return lowerObject(fields, resources, new Set(), "input");
}

/**
 * Thrown by `extractionJsonSchema` when a resource cannot be lowered into a CLOSED schema —
 * an unknown resource name, or a `type:`-recursive one whose expansion the cycle guard stops.
 *
 * Both degrade to an open `{type: "object"}` in the ordinary lowering, which is the right
 * answer for an MCP `outputSchema` (a document describing a response) and the wrong one here:
 * an extraction schema with an open object inside it is open, and a guarantee with a hole in it
 * that nobody is told about is worse than a refusal. `validateExtraction` refuses the same
 * resources through the same check, so the schema and the validator are never in a state where
 * one accepts what the other cannot describe.
 */
export class ExtractionSchemaError extends Error {
  constructor(reason: string) {
    super(`cannot build a closed extraction schema: ${reason}`);
    this.name = "ExtractionSchemaError";
  }
}

/**
 * Lower an IR field list to a **closed** JSON Schema — the shape a model is required to
 * produce (ADR-0011).
 *
 * A sibling of `objectJsonSchema`, never a replacement for it. The open lowering is correct for
 * what it was built for: an MCP `outputSchema` describes what a tool returns, and a client
 * validates a response against it. An extraction schema states what the model may emit, and one
 * that permits anything extra is not fail-closed. Both walk the same fields through the same
 * recursion — `lowerObject` — so the two can never disagree about a field's type, its
 * required-ness, or its description.
 *
 * `additionalProperties: false` is emitted at every object level: the root, an expanded
 * `type:`-resource field, the `items` of a `collection:`, and the three composite semantic
 * shapes (`money`, `party`, `date-range`). A `ref:` field stays a bare string, unexpanded, as
 * everywhere else.
 *
 * Throws `ExtractionSchemaError` rather than degrading to an open object — see that class.
 */
export function extractionJsonSchema(fields: IRField[], resources: IRResourceRegistry = {}): JsonSchema {
  return lowerObject(fields, resources, new Set(), "extraction");
}
