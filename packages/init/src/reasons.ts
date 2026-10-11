// @archstone/init — reason codes: the scope boundary, made visible (ADD-37 R-6, D-7).
//
// `init` has exactly ONE disposition for anything it cannot handle: skip it, name it with a
// code from this list, and emit nothing for it. That rule is what keeps this increment from
// growing without a floor, and this enum is where the floor is written down — so a
// contributor adding support for a new construct must either reuse a code here or argue for
// a new one, in the open, rather than quietly half-handling it.
//
// TWO axes, deliberately not merged:
//   - `ReasonCode` (this file) — the disposition of ONE candidate (or of the manifest as a
//     whole) during inference and emission. A skip is informational: the run still succeeds.
//   - `LoopFailureCode` (loop.ts) — why NOTHING was written. A refusal is terminal.
// Merging them would let "we skipped one operation" and "we wrote no files" share a
// vocabulary, which is precisely the confusion D-7's two-terminal-states rule exists to
// prevent.

/**
 * Every reason `init` can give for skipping or degrading something.
 *
 * `skipsOperation: true` ⇒ the candidate produces NO files at all (D-7). `false` ⇒ the
 * candidate is still emitted, but something the source expressed did not survive the trip and
 * the report says so. A code is never "sometimes" one and sometimes the other.
 *
 * Codes marked *(adapter)* are not raised by any code shipping today: they belong to source
 * adapters (ADD-37 §6 step 5), which is exactly why they are declared here and not there —
 * the boundary is a property of `init`, not of whichever adapter happens to exist.
 */
export const REASON_CODES = {
  // ---- Candidate skipped (no files emitted for it) ----
  /** The human declined this candidate at the gate. Not an error; the common case for a
   *  40-operation spec, where most operations are not capabilities (product §3). */
  declined: { skipsOperation: true, summary: "declined at the human gate" },
  /** D-9 step 1: the response object has two or more array-of-object properties, so the item
   *  locus is ambiguous. Ambiguous is a refusal, never a guess — the same discipline the
   *  compiler's resource-name resolution already applies. */
  "ambiguous-collection": { skipsOperation: true, summary: "two or more candidate item collections in the response" },
  /** D-9 step 3: no component name, no singularizable collection property, and the Decision
   *  Record supplied none either. Inventing one is naming inference, which is deferred (D-8). */
  "resource-name-not-derivable": { skipsOperation: true, summary: "no grammar-valid resource name could be derived, and none was supplied" },
  /** Two kept candidates derive the SAME resource name from DIFFERENT field sets. One resource
   *  per capability (D-9 step 2) plus one file per name means the second would silently
   *  overwrite the first's fields. */
  "resource-name-conflict": { skipsOperation: true, summary: "another capability already claims this resource name with a different field set" },
  /** Two decisions carry the same capability id. The manifest cannot hold both, and choosing
   *  between them is not `init`'s call. */
  "capability-id-conflict": { skipsOperation: true, summary: "another decision already claims this capability id" },
  /** The confirmed capability id is not a legal CDL id (`domain.action`, both halves
   *  kebab-case). Refused per candidate rather than mangled into legality — a silently
   *  rewritten id is an id the human never agreed to. */
  "capability-id-invalid": { skipsOperation: true, summary: "not a valid CDL capability id (domain.action)" },
  /**
   * A Decision Record entry names an operation this Draft Model does not contain.
   *
   * The summary deliberately does NOT say "the source may have changed", which was the first
   * wording and was misleading in the common case: usually the source is fine and the author
   * wrote the key the way the DOCUMENT spells the path, while a candidate key carries the
   * server's base path too. The detail lists the real keys for exactly that reason.
   */
  "unknown-candidate": { skipsOperation: true, summary: "no candidate in the draft has this key" },
  /** The candidate has no method or no path, so no connector can be written. A capability with
   *  no binding is legal CDL but is not invocable, and emitting one silently would be a shell. */
  "unsupported-connector": { skipsOperation: true, summary: "no usable method/path for a REST connector" },
  /**
   * *(adapter)* An INPUT this version cannot place on the wire.
   *
   * The summary was widened rather than the enum, and for the same reason
   * `nested-object-not-mapped`'s was: the report renders ONE summary line per group, so a code
   * with several call sites owes a sentence that is true at all of them. The old wording —
   * "parameter location not modeled in v1" — was true only at the first.
   *
   * Call sites, all of which mean "the connector could not have carried this input":
   *   - a parameter in a location v1 does not model (`cookie`, `header`);
   *   - a parameter or body property whose schema is not a scalar (CDL input fields are);
   *   - a `requestBody` this adapter cannot read down to named scalar properties;
   *   - a `requestBody` on `GET`/`HEAD`, which `invokeRest` never sends;
   *   - a body property colliding with a path/query parameter — one CDL field, two wire values,
   *     and no body counterpart to `rest.query` to separate them.
   *
   * A `query` parameter on a method that also carries a body is NOT in this list (#63 Goal 2):
   * the binding writer marks it `onQuery: true` in `rest.query`, and `invokeRest` sends it on
   * the URL alongside the JSON body, so it no longer refuses the operation.
   *
   * Every one of them is a construct that would otherwise emit a capability that compiles,
   * serves, advertises itself to an agent, and then sends the wrong request — which is worse
   * than not emitting it, and is exactly what D-7 exists to prevent.
   */
  "unsupported-parameter-location": { skipsOperation: true, summary: "an input the connector cannot carry — unmodeled parameter location, non-scalar schema, or an unreadable request body" },
  /**
   * *(adapter)* A schema composition that requires a CHOICE only a human can make.
   *
   * Narrowed by ADD-37 Amendment 1 (D-10): `allOf` used to be in this list and is now MERGED,
   * because `allOf` is not a decision procedure at all — the merged shape is a total,
   * order-independent function of its members, so no choice is required. Filing it beside
   * `oneOf` was a category error: they are neighbours in OpenAPI's grammar, not in the
   * decision they demand.
   *
   * What remains here genuinely demands a choice: an `anyOf` with more than one non-null
   * member is real polymorphism (which shape is it?), and a `discriminator` marks polymorphism
   * explicitly — where it appears, the merged shape is stated not to be the whole story. Also
   * raised when a D-10.4 conflict could change the D-9 step-1 locus census, which is the one
   * place a field-level unknown may escalate to an operation skip.
   *
   * A `oneOf` with two or more non-null members no longer lands here: ADD-12 §8.1/§8.4 item 1
   * ratified ONE form of it (`oneOf[success, error]` under a scalar `const`), and every other
   * form is now refused with the `oneof-*` code that names what was missing — so the report
   * says which part of the ratified form the document failed, rather than "polymorphism".
   * A `oneOf` whose only member is not the null idiom (one member, or none) stays here.
   */
  "unsupported-composition": { skipsOperation: true, summary: "anyOf with more than one non-null member, a discriminator, or composed members that disagree about structure" },
  /**
   * *(adapter)* A `oneOf` with MORE THAN TWO non-null members (ADD-12 §8.1).
   *
   * The ratified mapping is `oneOf[success, error]` → `resource` + `onError.errorResource`: a
   * binding carries one success resource and one error resource. A third branch has nowhere to
   * land, and choosing which two of three are "the" shapes is a guess.
   */
  "oneof-too-many-branches": { skipsOperation: true, summary: "oneOf with more than two non-null members — only oneOf[success, error] maps onto a response" },
  /**
   * *(adapter)* A two-branch `oneOf` with no usable `const` discriminator (§8.4 item 1).
   *
   * The ratified form needs the document itself to say which branch is the error row: exactly
   * one branch declares exactly one property carrying a scalar `const`. Neither branch doing so,
   * both doing so, one branch carrying several, or a non-scalar `const` — each leaves "which row
   * is an error?" to a human, so the operation is refused rather than guessed at.
   */
  "oneof-no-discriminator": { skipsOperation: true, summary: "oneOf with no single scalar `const` property naming the error branch" },
  /**
   * *(adapter)* A `oneOf` member that is not an object shape — a scalar or an array branch.
   *
   * A success or error ROW is a resource, and a resource is an object with named fields. A
   * branch without named fields cannot become either.
   */
  "oneof-non-object-branch": { skipsOperation: true, summary: "oneOf member is not an object shape, so it cannot become a row resource" },
  /**
   * *(adapter)* The error branch of an otherwise-accepted `oneOf[success, error]` offers no
   * unambiguous source for the error resource's fields.
   *
   * `message` reads from `message` when the branch declares one, else from its ONE remaining
   * plain string property; zero candidates or several is a choice nobody made. Also raised
   * when `code` would have to come from a boolean discriminator (true/false is not a code), or
   * when a source property no JSONPath can address.
   */
  "oneof-error-fields-unresolved": { skipsOperation: true, summary: "oneOf error branch has no unambiguous code/message source" },
  /**
   * *(adapter or emitter)* An acceptable `oneOf[success, error]` somewhere other than the item
   * list the capability maps.
   *
   * `onError` classifies the rows of the binding's `collection:`, and nothing else (the
   * compiler refuses it without one). The same union at the response root, in a single-object
   * property, nested inside an item, or on a list the human did not choose as the locus has no
   * `onError` to land in — and mapping it as the success shape alone would silently flatten a
   * union the source stated, so the operation is refused instead.
   */
  "oneof-outside-collection": { skipsOperation: true, summary: "oneOf[success, error] is not the item list this capability maps — no onError can carry it" },
  /**
   * *(adapter)* Two `allOf` members supply DIFFERENT schemas for the same property key
   * (D-10.4). The merged property becomes `unknown` and is left out of the map.
   *
   * FIELD-scoped on purpose. The reason-code enum already field-scopes per-field unknowns
   * (`field-path-not-expressible`, `nested-object-not-mapped`), and escalating one bad
   * property to an operation skip would re-open the 100%-skip failure D-10 exists to close.
   * The single exception — a disagreement about whether the key is an array of objects, which
   * would make the locus census unsound — raises `unsupported-composition` instead, and must
   * stay exactly that narrow.
   */
  "composition-conflict": { skipsOperation: false, summary: "composed schemas disagree about this property — not mapped" },
  /**
   * *(adapter)* A declared security scheme that cannot be reduced to a connector header
   * (Amendment 1 §A-5 gap 3): `apiKey` in a query string or cookie, `oauth2`, `openIdConnect`.
   *
   * Skipped rather than emitted, and that direction is deliberate: emitting a connector that
   * silently drops the credential produces a capability that always 401s — a manifest that
   * compiles, serves, advertises a tool to an agent, and then fails every single call. Not
   * emitting it is the honest outcome, and the report names the scheme.
   */
  "unsupported-security-scheme": { skipsOperation: true, summary: "security scheme does not reduce to a connector header" },
  /** *(adapter)* A remote or circular `$ref`. */
  "unsupported-ref": { skipsOperation: true, summary: "remote or circular $ref not resolved in v1" },
  /** *(adapter)* A non-JSON media type (XML, multipart, binary). */
  "unsupported-media-type": { skipsOperation: true, summary: "non-JSON media type not modeled in v1" },
  /** *(adapter)* A free-form `additionalProperties` map — a shape with no named fields to map. */
  "unsupported-free-form-map": { skipsOperation: true, summary: "free-form map shape has no named fields to map" },
  /** *(adapter)* Webhooks, callbacks and links — an operation shape that is not a call. */
  "unsupported-operation-shape": { skipsOperation: true, summary: "webhook/callback/link operations are not capabilities in v1" },
  /**
   * *(adapter)* Every selectable column of a relation was left out (`column-type-not-expressible`,
   * or a name no JSONPath can address), so there is nothing to select and nothing to map. The
   * candidate is skipped; the per-column notes say why each column went.
   */
  "no-expressible-columns": { skipsOperation: true, summary: "every selectable column was left out, so there is nothing to select" },
  /**
   * The Decision Record names a `lookupColumn` this candidate does not offer — not a column of the
   * relation, not selectable, not a scalar the manifest can express, or not a legal CDL field name.
   * Refused per candidate rather than falling back to a list: the human asked for a lookup.
   */
  "unknown-lookup-column": { skipsOperation: true, summary: "the named lookup column is not one this relation offers" },

  // ---- Candidate emitted, but degraded (a report line, never a fallback into invention) ----
  /** D-9 step 1, last branch: the response is a scalar, an array of scalars, or has no
   *  derivable shape. The capability and its connector are emitted; there is NO resource, NO
   *  `output:` and NO `response:`. The honest degraded path (product §5). */
  "no-response-shape": { skipsOperation: false, summary: "no usable response shape — emitted without a resource, output or response mapping" },
  /**
   * A property of the response that did not make it into the capability's resource.
   *
   * TWO call sites, and the summary has to be true at both — it used to say "nested property
   * beyond depth 1", which is false at the second, and the report renders ONE summary line per
   * group, i.e. over instances where it does not hold:
   *
   *   - D-9 step 2 (field scope): a nested object/array under the chosen locus, neither
   *     flattened nor promoted. Recoverable by hand for an object, NOT for an array (D-16).
   *   - D-15 (operation scope): a scalar at the response root that the chosen COLLECTION locus
   *     leaves behind — `PartList`'s `total`/`page`/`limit` are depth-1 and nested inside
   *     nothing, so the old wording was simply wrong about them.
   *
   * The `detail` carries which case it is; the code is the category. No new reason code —
   * R-6's boundary moves by zero (Amendment 2 §B-6).
   */
  "nested-object-not-mapped": { skipsOperation: false, summary: "a response property was not mapped into this capability's resource" },
  /**
   * No JSONPath can address this property, so it cannot be mapped.
   *
   * Verified against the shipped evaluator rather than assumed: `$.price.usd` silently
   * navigates into a nested object instead of reading a key literally named `price.usd`, and
   * the bracket form `$['…']` — which handles dots, spaces, dashes, quotes and non-ASCII —
   * does NOT survive a `'`, a `\`, or a `[`/`]` inside the name. Such a field is left out of
   * the map with this note rather than mapped to a path that resolves to nothing, which the
   * response mapper would report forever after as drift that never existed.
   */
  "field-path-not-expressible": { skipsOperation: false, summary: "no JSONPath can address this property name — not mapped" },
  /** Product D-4: a field fell back to `string`/`text` because nothing in the source mechanically
   *  implied a richer semantic type. "This may be a `location`; only you know." */
  "semantic-type-degraded": { skipsOperation: false, summary: "semantic type fell back to string/text" },
  /** R-4, the increment's headline known miss: no source construct says "this path parameter is
   *  the identity of a resource another operation returns", so a cross-capability identity link
   *  is emitted as a scalar `identifier` rather than as `ref: <Resource>`. A tool limitation,
   *  never a language gap — `ref:` exists and only a human knows when it applies. */
  "identity-ref-not-inferred": { skipsOperation: false, summary: "emitted as `identifier`; this may be a `ref:` to a resource — only you know" },
  /** A 4xx/5xx response's BUSINESS meaning is not derivable, and `failures:` keys would be
   *  invented prose. Never emitted (ADD-37 §1's table); reported as an unmapped affordance. */
  "failures-not-emitted": { skipsOperation: false, summary: "error responses carry no derivable business meaning — no `failures:` emitted" },
  /** Challenge 2 item 2: a declared security scheme becomes a connector header with an
   *  `${ENV}` placeholder, NEVER `policies: [authenticated]` — which would compile, pass
   *  `apply`, and then fail every CLI invocation, since neither `serve` (stdio) nor `verify`
   *  has a caller-injection surface. */
  "security-scheme-not-a-policy": { skipsOperation: false, summary: "auth surfaced as a connector header placeholder, not as a policy" },
  /** §1.2: the required/optional classification rests on observed items only, not on a
   *  declaration. The report states the sample size — the difference between a measurement and
   *  a claim. */
  "required-classification-observational": { skipsOperation: false, summary: "required/optional classified from observed items only" },
  /**
   * *(adapter)* A column of a database relation that has no faithful CDL semantic type —
   * `json`/`jsonb` and array columns (ADR-0012 D-10) — or whose name no JSONPath can address. FIELD
   * scoped and non-skipping: the column is left out of the `SELECT` and the capability is still
   * emitted. A tool limitation, never a language gap.
   */
  "column-type-not-expressible": { skipsOperation: false, summary: "a column has no expressible CDL type — left out of the select" },
  /**
   * *(adapter)* A foreign table the runtime role can read. Manifest-level and not a candidate:
   * RLS cannot be enabled on a foreign table and reading one reaches a third host (ADR-0012 D-10),
   * so it is reported and deferred, never proposed.
   */
  "foreign-table-deferred": { skipsOperation: false, summary: "a foreign table was reported, not proposed — RLS cannot cover it" },
  /**
   * A bounded list (`LIMIT 100`) never carries a contract: D-8's negative leg replays the identical
   * request under another identity and requires zero rows, and a list returns that identity's own
   * rows, so the contract would be red on its first replay. A lookup can.
   */
  "list-has-no-isolation-test": { skipsOperation: false, summary: "a list cannot carry a contract: its isolation replay returns the other identity's own rows" },
  /** *(adapter)* Pagination is visible in the source but is not modeled as a capability input. */
  "pagination-not-modeled": { skipsOperation: false, summary: "pagination is not modeled in v1" },
  /**
   * *(adapter)* #64: an OPTIONAL request-body property or query parameter whose shape the
   * connector cannot carry (nested object, array of non-scalars, object-valued/`deepObject`
   * query parameter) is left out of the capability's `input:` fields instead of refusing the
   * whole operation.
   *
   * FIELD-scoped, NON-skipping, and deliberately a NEW member rather than a reuse of
   * `unsupported-parameter-location` (that code is `skipsOperation: true` everywhere else — a
   * code is never sometimes one and sometimes the other) or `nested-object-not-mapped` (whose
   * summary is about the RESPONSE side; this is the input side, with the opposite consequence:
   * the agent cannot set the field at all, rather than "not mapped into the resource").
   *
   * "Optional" here means the schema's own raw `required[]` membership — NEVER the D-12-lowered
   * value, and independent of whether the enclosing `requestBody` itself is required. A property
   * or parameter genuinely listed in `required[]` still refuses with `unsupported-parameter-
   * location`, because omitting it would send a request the backend's own contract calls
   * invalid — exactly the mis-send D-7 forbids.
   */
  "input-property-omitted": {
    skipsOperation: false,
    summary: "an optional input the connector cannot carry was left out — the agent cannot set it",
  },
  /**
   * *(adapter)* The source declares a construct the adapter never reads.
   *
   * A NEW MEMBER, and R-6 makes that a scope decision, so here is the argument in the open —
   * the same way D-10's `composition-conflict` was taken.
   *
   * The category did not exist, and its absence is what made the `requestBody` defect possible.
   * Every other member of this enum names something the adapter LOOKED AT and could not carry.
   * This one names something it never looked at — the failure mode where a construct is not
   * merely unreported but unobserved, because every OpenAPI object was read by direct indexing
   * of the keys the adapter happened to know. Reusing an existing member would make the report
   * say something false about which of those two things happened, and the difference is exactly
   * the difference between a known limitation and a blind spot.
   *
   * It does NOT widen what the adapter attempts. It is the opposite: a standing admission of
   * everything it does not attempt, emitted from a key-coverage guard whose default is to
   * complain. That default is the property being bought — a key nobody has thought of, from a
   * future OpenAPI revision, or one a contributor forgets to declare when adding a feature, all
   * land here rather than in silence.
   *
   * NON-skipping, deliberately. Every real spec carries `tags`, and a guard that refuses
   * everything gets deleted. Where an unread key makes the emitted manifest actively WRONG
   * rather than merely incomplete, the adapter raises a specific refusal instead — see
   * `SILENTLY_WRONG` in `adapters/openapi/coverage.ts`, which is the short and argued list.
   */
  "source-construct-not-read": { skipsOperation: false, summary: "the source declares a construct this adapter does not read — nothing it expresses reached the manifest" },
  /** Challenge 2 item 3: no probe ran, so there is no recorded response, so there is no
   *  fingerprint and no `contract:` block. All-or-nothing — a placeholder fingerprint would
   *  make `verify` green against a fiction. */
  "contract-not-recorded": { skipsOperation: false, summary: "no probe ran — no fixture, no contract" },
  /** §1.3: a probe needs BUSINESS input (the fixture's `request` is capability input, not an
   *  HTTP request) and the source supplied no example, no default, and the human declined to
   *  type one. A report line, not a fallback. */
  "probe-input-unavailable": { skipsOperation: false, summary: "no sample input available for a probe" },

  // ---- Manifest-level ----
  /** §4 caveat 1: `capabilities.schema.json` sets `minItems: 1` on both `capabilities` and
   *  `providers`, so an empty confirmed set cannot produce a shape-valid manifest. `init`
   *  refuses to write anything rather than emit a manifest that fails its own compile check. */
  "empty-confirmed-set": { skipsOperation: true, summary: "no candidate was confirmed — nothing to emit" },
  /** `company.id` must match `^[a-z][a-z0-9-]*$` and is not derivable from an arbitrary source
   *  document. The Decision Record supplies it, or nothing is written. */
  "company-id-not-derivable": { skipsOperation: true, summary: "no valid company id was derived or supplied" },
} as const satisfies Record<string, { skipsOperation: boolean; summary: string }>;

/** The closed set of reasons `init` may give. Adding a member is a scope decision. */
export type ReasonCode = keyof typeof REASON_CODES;

/** Does this code mean the candidate produced no files at all? */
export function skipsOperation(code: ReasonCode): boolean {
  return REASON_CODES[code].skipsOperation;
}

/** What the code means, in one line — the spine of the human report. */
export function reasonSummary(code: ReasonCode): string {
  return REASON_CODES[code].summary;
}

/** Where a note applies: the whole manifest, one candidate operation, or one field. */
export type NoteScope = "manifest" | "operation" | "field";

/**
 * One thing `init` did not do, and why. Notes are DATA, not prose: the report renders them,
 * the tests assert on them, and a caller (a hosted flow, §9's forward constraint) can present
 * them however it likes without re-parsing English.
 */
export interface Note {
  code: ReasonCode;
  scope: NoteScope;
  /** What the note is about: an operation key, a `capabilityId`, or `capabilityId#field`. */
  target?: string;
  /** Source-specific detail — never a substitute for the code, always an addition to it. */
  detail?: string;
}

export function note(code: ReasonCode, scope: NoteScope, target?: string, detail?: string): Note {
  return { code, scope, ...(target !== undefined ? { target } : {}), ...(detail !== undefined ? { detail } : {}) };
}
