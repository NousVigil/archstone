// IR — Archstone Intermediate Representation.
//
// The normalized, TARGET-AGNOSTIC form the compiler EMITS and every emitter
// (MCP now; REST · GraphQL · SDK later) CONSUMES. This is the physical form of
// the moat (RFC-000B): `apply` compiles to IR — it never reads YAML and hits MCP
// directly. No emit-target format (JSON Schema, MCP shapes) appears here; the MCP
// emitter (#7) owns semantic-type → JSON-Schema lowering.

// Type-only: erased at compile time, so the neutral IR gains no runtime dependency.
import type { ShapeMap } from "./fingerprint";

export type SemanticType =
  | "location"
  | "date-range"
  | "party"
  | "preference-set"
  | "money"
  | "identifier"
  | "string"
  | "text"
  | "time-slot"
  | "quantity"
  | "enum"
  | "date"
  | "datetime"
  | "web-page" // Experimental, output-only — see ORIGIN_BOUND_TYPES below
  | "image"; // Experimental, output-only, origin-bound — an absolute https URL of a picture, shown and never fetched

/** The closed set of semantic types (mirrors cdl.schema.json). A field `type:` not in
 *  this set is a resource-typed reference, not a scalar. Shared by the compiler + resolver. */
export const SEMANTIC_TYPES: ReadonlySet<SemanticType> = new Set<SemanticType>([
  "location", "date-range", "party", "preference-set", "money", "identifier",
  "string", "text", "time-slot", "quantity", "enum", "date", "datetime", "web-page", "image",
]);

/**
 * A binding's declared origin lists (binding key `origins:`), one list per origin-bound
 * semantic type. Plain strings exactly as authored — the IR carries no URL type and parses
 * nothing; the semantic pass checks entry syntax, and the response mapper (emitter-support)
 * normalises and compares.
 */
export interface IROrigins {
  pages?: string[];
  images?: string[];
}

/** The `IROrigins` keys in the one order they are emitted, so authoring order never changes IR bytes. */
export const ORIGIN_LIST_KEYS: readonly (keyof IROrigins)[] = ["pages", "images"];

/**
 * Origin-bound semantic types → the `IROrigins` list their values are checked against.
 *
 * A value of one of these types is a link a person will be shown. A plain `string` can carry
 * any URL at all, so these types exist to say "this one must point at the provider's own
 * declared origin" — checked on output by the shared response mapper, refused on input and as
 * an extraction target, and never inferred. Written as a table so a further type with the same
 * guarantee is one enum member, one entry here and one more `IROrigins` list.
 */
export const ORIGIN_BOUND_TYPES: Readonly<Partial<Record<SemanticType, keyof IROrigins>>> = {
  "web-page": "pages",
  "image": "images",
};

/** The origin list a semantic type is bound to, or `undefined` for an ordinary type. */
export function originListOf(semantic: SemanticType): keyof IROrigins | undefined {
  return Object.prototype.hasOwnProperty.call(ORIGIN_BOUND_TYPES, semantic) ? ORIGIN_BOUND_TYPES[semantic] : undefined;
}

/** A capability's authored business-stability fact (RFC-0001 v0.4 §5.5 / D-11, ADD-24 D-1).
 *  Pure, compile-time, always present (default "stable" — compiler-applied, ADD-24 D-4).
 *  NEVER conflated with binding health: health is runtime/network-dependent (archstone
 *  verify) and is deliberately NOT an IR field — see ADD-24's Challenge section. Adding a
 *  `health` field here would make `compile(): IR` non-deterministic and network-dependent,
 *  breaking this file's purity contract (see compile.ts's own header comment). */
export type Lifecycle = "experimental" | "beta" | "stable" | "deprecated" | "retired";

/** The closed set of lifecycle states (mirrors cdl.schema.json's enum). */
export const LIFECYCLE_STATES: ReadonlySet<Lifecycle> = new Set<Lifecycle>([
  "experimental", "beta", "stable", "deprecated", "retired",
]);

/** A field's type, kept neutral — emitters lower this to their target format. */
export type IRType =
  | { kind: "scalar"; semantic: SemanticType; values?: string[] } // values = closed set for `enum`
  | { kind: "resource"; name: string; identity?: true } // a `ref:` field or a resource-typed field —
    // `identity: true` ⇒ came from `ref:` ("by identity", a bare id — never expand through the
    // resource registry); absent ⇒ came from `type:`/resource-typed field ("by representation",
    // today's full-object behavior). Any future consumer that branches on `kind === "resource"`
    // MUST check `identity` before treating the field as expandable (ADD-25 R-2).
  | { kind: "collection"; of: string } // a list of a resource
  | { kind: "list"; items: SemanticType; values?: string[] }; // a LIST of a scalar semantic type
    // (issue #63, `listField` in cdl.schema.json). `values` = closed set when `items` is `enum`.
    // Carries only the item's semantic shape — wire concerns (style/explode/query-vs-body
    // placement) live in `IRRestConnector.query`, never here (target-agnosticism).

export interface IRField {
  name: string;
  required: boolean;
  description?: string;
  type: IRType;
}

export interface IRRestConnector {
  baseUrl?: string;
  method: string;
  path: string;
  headers?: Record<string, string>;
  body?: string;
  // CDL input field name -> wire query-param name (issue #26), widened (#63) so an entry can
  // also carry `explode` (list-field wire form: repeated key vs. comma-joined — only meaningful
  // when the field's IRType is `list`) and `onQuery` (this field belongs on the query string
  // EVEN on a method that also carries a body, and must therefore be excluded from the JSON
  // body). A plain string is the pre-#63 shorthand (rename only) and keeps compiling unchanged.
  query?: Record<string, string | { name?: string; explode?: boolean; onQuery?: true }>;
}

/**
 * ADR-0012: a database bound directly as a capability's backend. Postgres only, read-only,
 * in v1. `dsn` is `${VAR}`-templated exactly as authored (BR-2) — resolved at invoke time by
 * the sql provider, never at compile time (no network call from `apply`, ADR-0005). `query` is
 * the entire, author-controlled, statically-declared SQL text; `params` binds it positionally
 * (`$1..$n`) to declared CDL input field names — there is deliberately no templating mechanism
 * here for a caller-influenced value (D-1's "the YAML author is not part of the security
 * boundary").
 */
export interface IRSqlConnector {
  engine: "postgres";
  dsn: string;
  statementKind: "select";
  query: string;
  params: string[];
}

/** Backend invocation data copied from the binding (not an emit-target concern). */
export interface IRConnector {
  type: "rest" | "graphql" | "grpc" | "sql" | "soap";
  rest?: IRRestConnector;
  sql?: IRSqlConnector; // ADR-0012 D-7 — additive, IR.version stays "0"
}

/** One resource field ← provider path (ADD-12). `path`/`collection` are validated
 *  JSONPath strings (syntax checked at compile time), evaluated by the runtime mapper. */
export interface IRFieldMapping {
  name: string; // a field of the mapped resource — the stable anchor
  path: string; // JSONPath into a single item (relative to `collection`, else the body root)
  requiredOverride?: false; // an explicit loosen: this field may be absent without a VIOLATION
}

/** A row-level classifier (ADD-12 §8.1): checked, per collection item, either by presence
 *  (`exists`) or by JSON equality (`equals`) against the value at `path` (relative to
 *  `collection`, else the body root). Exactly the shape an OpenAPI `oneOf[success,error]`
 *  `const` discriminator maps onto directly. */
export interface IRDiscriminator {
  path: string;
  equals?: unknown;
  exists?: boolean;
}

/** #81 (ADD-12 §8.1): a `response:` mapping's row-level error discriminator. `errorResource`
 *  is a second, error-shaped resource, resolved the same way `resource` is (P-7); `when`
 *  classifies each collection item BEFORE the success mapping runs — a match maps against
 *  `errorResource` and never touches the success resource's required-ness; a non-match maps
 *  against `resource` exactly as without this block. */
export interface IRResponseOnError {
  errorResource: string; // canonical (P-7) resource name
  when: IRDiscriminator;
  /** errorResource field ← provider path, same shape as the success `map:` (IRFieldMapping[]).
   *  Optional: a field with no entry here falls back to a same-named key on the item
   *  (`$.<fieldName>`) — the pre-existing default when the block omits its own `map:`. */
  map?: IRFieldMapping[];
}

/**
 * How a live provider response maps onto a named resource (binding `response:`).
 * The RESOURCE is the anchor: `map` binds resource fields to provider paths, and the
 * required set is read from the resource registry at execution — NOT stored here — so
 * the mapping and the emitted outputSchema can never disagree. `field` is the tool
 * output field the mapped result lands under (so structuredContent matches outputSchema).
 */
export interface IRResponseMapping {
  resource: string; // canonical (P-7) resource name
  field: string; // the output field the mapped array/object populates (D-7)
  collection?: string; // JSONPath to the item list; absent = single object at the body root
  fields: IRFieldMapping[];
  onError?: IRResponseOnError; // #81 (ADD-12 §8.1); absent = every row mapped against `resource`
}

/**
 * A binding's contract snapshot (ADD-18): what we last verified the provider returns.
 * `source: recorded` only — the golden fixture IS the contract, no upstream spec
 * required. Drives `archstone verify`, never the live invocation path. The fixture
 * FILE's own content (request + expects) is read directly by the runtime probe at
 * verify-time (D-6) — not lowered here, so the IR never depends on fs.
 */
export interface IRContract {
  fingerprint: string; // sha256:… of the recorded response SHAPE
  /**
   * The recorded shape itself — `path -> type`, values never present (ADD-114 D-1).
   *
   * Optional, and NARRATIVE ONLY: `fingerprint` above remains the sole authority for a
   * binding's health (ADD-114 D-2, preserving ADD-18 D-4). This exists so `verify` can name
   * WHICH paths moved instead of only reporting that a hash did. A contract without it
   * verifies exactly as it did before ADD-114.
   */
  shape?: ShapeMap;
  probeFixture: string; // path to the golden fixture, relative to the manifest dir
}

/**
 * One resolved Policy document (`*.policy.yaml`), lowered onto a tool (#43 / ADD-43 D-1).
 *
 * SHAPE ONLY — no evaluation lives in this file, and this type carries NO identity semantics:
 * no principal, no claims, no auth scheme, no verification config (ADD-42 §2's instruction to
 * #43, BR-7). The compiler decides *which* policies attach to *which* tools; whether a given
 * call is permitted is decided exactly once, in @archstone/emitter-support's evaluator.
 *
 * There is deliberately **no `constraints` member**: a non-empty `spec.constraints` is a
 * semantic error at authoring time (ADD-43 D-2) and an empty one is stripped at lowering
 * (D-3), so `constraints` reaches the IR by no path whatsoever. That is what lets the
 * evaluator's "deny anything I cannot fully evaluate" rule need no exception clause.
 */
export interface IRPolicyRule {
  id: string; // the policy document's metadata.id
  allow?: string[]; // principals permitted to invoke — exact, byte-for-byte matches (BR-9)
  deny?: string[]; // principals refused outright; deny always wins over allow (BR-15)
  /** #45 (ADD-45 D-1): the resolved `spec.rateLimit`, verbatim, once the compiler has already
   *  refused anything with a missing or invalid `maxInvocations`/`windowSeconds` (both required
   *  together — `policy-ratelimit-invalid`). Shape only, same discipline as `allow`/`deny`: the
   *  IR carries no counter, no clock, no store — evaluating it needs state, which is why it is a
   *  separate evaluation step (`evaluateRateLimit`, `@archstone/emitter-support`) from the pure
   *  `evaluatePolicy`, not a branch inside it. */
  rateLimit?: { maxInvocations: number; windowSeconds: number };
}

export interface IRTool {
  id: string; // e.g. tourism.search
  description: string;
  effect: "read" | "write" | "irreversible";
  provider: string;
  /** The capability's authored CDL policy TOKENS (`authenticated`, `tenant-scoped`, …) — a
   *  closed enum in cdl.schema.json. NOT policy documents: see `policyRules` below, and
   *  ADD-43 D-1 for why the two vocabularies carry deliberately different field names. */
  policies: string[];
  /** Resolved Policy DOCUMENTS scoped onto this capability (ADD-43 D-1). Absent when none
   *  resolved — which is every capability shipping today, so nothing changes meaning (BR-14).
   *  Inline per tool rather than a normalized top-level registry, so the evaluator stays a pure
   *  function of `(tool, caller)` with no lookup and no second argument. */
  policyRules?: IRPolicyRule[];
  lifecycle: Lifecycle; // always present, default "stable" (ADD-24 D-4) — never MCP-specific
  input: IRField[];
  output: IRField[];
  connector?: IRConnector; // present iff the capability has a binding (else: not invocable)
  response?: IRResponseMapping; // present iff the binding declares a response mapping (ADD-12)
  /** Present iff the binding declares an `extract:` block (per the accepted architecture
   *  decision extending ADD-12): additional SCALAR output fields populated straight from the
   *  raw provider body root, alongside (or instead of) `response`. Reuses `IRFieldMapping`
   *  verbatim — same fill-a-field-from-a-path shape `response.fields` already carries; the only
   *  difference is WHERE required-ness comes from at execution time (the output field itself,
   *  not a resource registry — there is no resource here), which is the mapper's decision, not
   *  this shape's. */
  extract?: IRFieldMapping[];
  contract?: IRContract; // present iff the binding declares a contract snapshot (ADD-18)
  /** Present iff the binding declares `origins:`. Absent otherwise, so every IR produced for a
   *  manifest without origin-bound types is unchanged. */
  origins?: IROrigins;
}

/**
 * Neutral resource registry: canonical (domain-qualified) resource name → its field list.
 * A resource field's `type` may itself be `resource`/`collection`, referencing another
 * entry BY NAME (no inlining) — this carries nesting/recursion without duplication and
 * stays target-agnostic. JSON Schema is NOT here; the MCP emitter lowers this on demand.
 */
export type IRResourceRegistry = Record<string, IRField[]>;

export interface IR {
  version: "0";
  company: { id: string; name?: string };
  tools: IRTool[];
  resources: IRResourceRegistry;
}
