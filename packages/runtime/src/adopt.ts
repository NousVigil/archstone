// @archstone/runtime — Adoption planner (ADD-117 / ADR-0008).
//
// Turns a field ADD-114's drift NAMED into a field the manifest DECLARES. This module is the
// pure half: it decides what could be adopted and why each rejected candidate was rejected.
// It touches no disk, asks no human, and mutates nothing — the CLI owns all three (D-6), which
// is what lets every rule below be tested without a temp directory or a terminal.
//
// The rules exist because ADR-0008 draws a hard line: an undeclared field never reaches a
// model. Adoption is the ONLY way across that line, and it is deliberately a human act.

import type { IRTool, IRResourceRegistry, JsonType, SemanticType, ShapeDiff } from "@archstone/compiler";

/** Why a named path cannot be adopted. Stated, never silently skipped — a candidate that
 *  disappears from the report reads as "there was nothing there". */
export type AdoptionRefusal =
  | "outside-collection"
  | "nested"
  | "not-a-leaf"
  | "already-declared"
  /** #82 (ADD-12 §8.2): an observed array field whose elements are objects. Distinct from
   *  `not-a-leaf` — an object array needs a declared row/resource shape to adopt into, which
   *  this increment does not ratify (§8.4 founder ruling: "deferred — ADD ulterior"; core #49
   *  is where that reopens). */
  | "array-of-objects-unresolved"
  /** #82 follow-up (#290): an observed array field whose element type was never recorded — it
   *  has only ever been seen empty. Distinct from `not-a-leaf`: the field genuinely IS
   *  adoptable as a scalar array, there is just nothing yet to infer its `list:` semantic type
   *  from. Re-probing after the backend returns at least one element resolves it. */
  | "array-element-type-unknown";

export interface AdoptableField {
  adoptable: true;
  /** The JSONPath the drift reported, e.g. `$.stays[].boardType`. */
  path: string;
  /** The resource field name (inside the collection) or output field name (outside it, #82)
   *  it would become, e.g. `boardType` or `warnings`. */
  field: string;
  /** The path written into the binding's `response.map` (relative to the collection item) or,
   *  for a #82 scalar-array candidate, into `extract:` (body-root, all-matches — `$.foo[*]`). */
  itemPath: string;
  observed: JsonType;
  /** What it is declared as. See ADD-117 §3 — the table is deliberately dull. For a #82
   *  scalar-array candidate, this is the ELEMENT's semantic type (`list: <semantic>`, not
   *  `type: <semantic>` — the field itself is an array). */
  semantic: SemanticType;
  /** Which file(s) this candidate is written into, and how (#82). `"resource-field"` (the
   *  original shape): the mapped RESOURCE gains a `type:` field, the binding's `response.map`
   *  gains an entry. `"output-array"`: the CAPABILITY's own `output:` gains a `list:` field,
   *  the binding's `extract:` (created if absent) gains an entry — there is no resource
   *  involved. The CLI's write path branches on this; `planAdoption` never writes anything
   *  itself (D-6). */
  kind: "resource-field" | "output-array";
}

export interface UnadoptableField {
  adoptable: false;
  path: string;
  observed: JsonType;
  reason: AdoptionRefusal;
  /** One sentence an operator can act on, or at least understand. */
  detail: string;
}

export type AdoptionCandidate = AdoptableField | UnadoptableField;

export interface AdoptionPlan {
  capabilityId: string;
  /** The resource the binding's `response:` maps onto — the file a field would be added to. */
  resource?: string;
  candidates: AdoptionCandidate[];
}

/**
 * ADD-117 §3. An observed JSON type becomes exactly one CDL semantic type, or nothing.
 *
 * Deliberately NOT clever. `string` does not become `date` however much a value looked like
 * one, because the shape records types and never values — there is nothing here to
 * pattern-match, and inferring a date from a field NAME is exactly the guess this project
 * refuses to make. `number` does not become `money`, because whether a number is a price is a
 * business fact and `money` carries a currency this field does not have. The human can widen
 * either afterwards; the manifest is theirs.
 */
function semanticFor(observed: JsonType): SemanticType | undefined {
  if (observed === "string") return "text";
  if (observed === "number") return "quantity";
  // An observed JSON boolean records the JSON TYPE, which is exactly what `boolean` is; no value is
  // interpreted. A later non-boolean value fails loudly at the mapping boundary.
  if (observed === "boolean") return "boolean";
  return undefined;
}

function refusalDetail(reason: AdoptionRefusal, observed: JsonType): string {
  switch (reason) {
    case "outside-collection":
      return "outside the collection this capability maps; it is not a field of the resource";
    case "nested":
      return "nested, or a provider key containing a dot — indistinguishable here; either way the resource field would have to be another resource, which adoption does not create";
    case "not-a-leaf":
      return `observed as ${observed}, which is a structure rather than a value`;
    case "already-declared":
      return "already declared by this capability";
    case "array-of-objects-unresolved":
      return "an array of objects needs a declared row/resource shape to adopt into, which core #49 (lifting the one-output-field cap) has not ratified yet — declare it by hand once that lands";
    case "array-element-type-unknown":
      return "observed only as an empty array so far — no element has ever been recorded, so there is nothing to infer a list: semantic type from yet";
  }
}

/**
 * The path prefix every field of one collection item shares.
 *
 * A binding's `collection` is a JSONPath over the payload (`$.stays[*]`); a recorded shape
 * flattens an array to its first element (`$.stays[]`). One translation, here, rather than two
 * conventions leaking into every comparison below. A capability with no `collection` maps a
 * single object, whose fields hang off the root.
 */
function itemPrefix(collection: string | undefined): string {
  if (!collection) return "$";
  return collection.replace(/\[\*\]/g, "[]");
}

/**
 * What could be declared, and why the rest could not.
 *
 * Only `drift.added` is considered: `removed` is a loss with nothing to declare, and `retyped`
 * needs a judgment no shape comparison can make — is `price_per_night` the old `pricePerNight`,
 * or a new field that happens to look like it? ADR-0008 puts both out of scope, and the diff
 * still names them so a human can act.
 *
 * #290 follow-up: a scalar-array field is adoptable (`kind: "output-array"`, #82) under all
 * three tool shapes — `response:` WITH a `collection:`, `response:` WITHOUT one (a single-object
 * mapping, where the response root IS the mapped item), and no `response:` at all (an
 * `extract:`-only tool). Only fields genuinely INSIDE a real per-item `collection:` still go
 * through the resource-field path below unchanged; nothing else assumes a `collection:` exists,
 * and nothing assumes `tool.response` exists at all. A field with no response-mapping mechanism
 * to write a plain scalar into (no `mapping`) is simply not offered as a resource-field
 * candidate — `extract:` remains the only mechanism such a tool has, and that mechanism only
 * reaches arrays (#82) and (unchanged, pre-#290) whatever `extract:` already declares.
 */
export function planAdoption(tool: IRTool, drift: ShapeDiff, resources: IRResourceRegistry): AdoptionPlan {
  const mapping = tool.response;
  const hasCollection = Boolean(mapping?.collection);
  const prefix = itemPrefix(mapping?.collection);
  const declared = mapping
    ? new Set<string>([...mapping.fields.map((f) => f.name), ...(resources[mapping.resource] ?? []).map((f) => f.name)])
    : new Set<string>();
  const declaredOutput = new Set<string>(tool.output.map((f) => f.name));

  const refuse = (path: string, observed: JsonType, reason: AdoptionRefusal): UnadoptableField => ({
    adoptable: false,
    path,
    observed,
    reason,
    detail: refusalDetail(reason, observed),
  });

  /** Is `path` under the mapping's own root — the collection item's prefix when a real
   *  `collection:` exists, or the response root itself (`prefix === "$"`) when `response:` maps
   *  a single object? Both are "the field this mapping's `map:` could plausibly reach" — the
   *  pre-#290 meaning of `outsideCollection`, unchanged. */
  const withinMappingRoot = (path: string): boolean => path.startsWith(`${prefix}.`);

  /** Is `path` a field INSIDE a real per-item `collection:` specifically (never true when
   *  `response:` has no `collection:`, or there is no `response:` at all)? Used ONLY to decide
   *  whether an array stays out of scope for #82's output-array handling (nested per-item
   *  arrays are unsupported, unchanged from before #290) — every top-level array otherwise
   *  hangs directly off the response root and is always eligible. */
  const insideRealCollectionItem = (path: string): boolean => hasCollection && withinMappingRoot(path);

  // `path[]` element-detail entries (the SAME flattening `describeShape` records for any array)
  // tell us what an array's items look like, without a second traversal. Keyed by the array's
  // own base path.
  const elementTypeOf = new Map<string, JsonType>();
  for (const { path, type } of drift.added) {
    if (path.endsWith("[]")) elementTypeOf.set(path.slice(0, -2), type);
  }

  // Every array base path this run has anything to say about — from a literal `{type:"array"}`
  // entry, OR (#290: "$.x[] alone with a scalar type") from an element-detail entry alone, when
  // the base array path itself is unchanged (already declared, or simply not part of this diff).
  const arrayBases = new Set<string>();
  for (const { path, type } of drift.added) if (type === "array") arrayBases.add(path);
  for (const base of elementTypeOf.keys()) arrayBases.add(base);

  // Only the bases OUTSIDE a real collection item are handled as #82 output-array candidates
  // here — one candidate per base, collapsing its own `{type:"array"}` entry and its `[]`
  // element-detail entry into one verdict. A base found literally inside a collection item
  // (e.g. `$.stays[].amenities`) is left untouched here and falls through to the per-item loop
  // below, unchanged from before #290 (arrays there stay unsupported, refused the same way any
  // other structured per-item field is).
  const outsideArrayBases = new Set<string>();
  for (const base of arrayBases) if (!insideRealCollectionItem(base)) outsideArrayBases.add(base);

  const candidates: AdoptionCandidate[] = [];

  for (const base of outsideArrayBases) {
    const field = base.replace(/^\$\.?/, "").split(".").pop() ?? base;
    if (declaredOutput.has(field)) {
      candidates.push(refuse(base, "array", "already-declared"));
      continue;
    }
    const elementType = elementTypeOf.get(base);
    if (elementType === "object") {
      candidates.push(refuse(base, "array", "array-of-objects-unresolved"));
      continue;
    }
    if (elementType === undefined) {
      // Seen only as an empty array so far (no `[]` element-detail entry at all) — genuinely
      // adoptable once an element is observed, just not yet (#290: distinct from `not-a-leaf`).
      candidates.push(refuse(base, "array", "array-element-type-unknown"));
      continue;
    }
    const semantic = semanticFor(elementType);
    if (!semantic) {
      // An element type CDL has no semantic for (e.g. null or object) — genuinely not adoptable.
      candidates.push(refuse(base, "array", "not-a-leaf"));
      continue;
    }
    candidates.push({ adoptable: true, path: base, field, itemPath: `${base}[*]`, observed: "array", semantic, kind: "output-array" });
  }

  for (const { path, type: observed } of drift.added) {
    if (outsideArrayBases.has(path)) continue; // its base's verdict, above, already speaks for it
    if (path.endsWith("[]") && outsideArrayBases.has(path.slice(0, -2))) continue; // ditto, its element-detail half

    if (!mapping) continue; // no response: mapping at all — no resource-field mechanism (#290)

    if (!withinMappingRoot(path)) {
      candidates.push(refuse(path, observed, "outside-collection"));
      continue;
    }
    const rest = path.slice(prefix.length + 1);
    if (rest.includes("[")) {
      candidates.push(refuse(path, observed, "nested"));
      continue;
    }
    // A dot here is either a nested object (`address.city`) or a single provider key that
    // contains a dot. Those two are INDISTINGUISHABLE in this flattened space — the same
    // collision `describeShape` documents — so there is one refusal, not a coin flip between
    // two, and its detail says so. Either way the answer is the same: not adopted.
    if (rest.includes(".")) {
      candidates.push(refuse(path, observed, "nested"));
      continue;
    }
    const semantic = semanticFor(observed);
    if (!semantic) {
      candidates.push(refuse(path, observed, "not-a-leaf"));
      continue;
    }
    if (declared.has(rest)) {
      candidates.push(refuse(path, observed, "already-declared"));
      continue;
    }
    candidates.push({ adoptable: true, path, field: rest, itemPath: `$.${rest}`, observed, semantic, kind: "resource-field" });
  }

  return { capabilityId: tool.id, resource: mapping?.resource, candidates };
}

/** The adoptable candidates, in the order they would be offered. */
export function adoptable(plan: AdoptionPlan): AdoptableField[] {
  return plan.candidates.filter((c): c is AdoptableField => c.adoptable);
}
