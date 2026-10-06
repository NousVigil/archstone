// @archstone/emitter-support — Response mapper (ADD-12 / RFC-0006).
//
// Applies a tool's IRResponseMapping to a live provider body: locate the item list,
// map each item's resource fields, and validate required fields. Pure (no MCP, no HTTP,
// no I/O) so the contract probe (#18) replays the exact same code path — one
// behaviour, tested once. Required-ness is read from the resource registry (not the
// mapping), so this can never disagree with the emitted outputSchema (ADD-11).
//
// Moved out of @archstone/runtime's mapping.ts (ADD-0008 #27), unchanged logic.
//
// Extended (per the accepted architecture decision extending ADD-12) to also evaluate
// `tool.extract`: additional SCALAR output fields read straight off the raw body ROOT — never
// `mapping.collection`-scoped items — with required-ness sourced from `tool.output` directly
// (there is no resource registry entry for a scalar field). Both mechanisms write into the SAME
// `data`/`missing`/`degraded` accumulators below: one `MappingResult`, one merged violation
// message when either side is missing a required field, never two separate error paths.
//
// #82 (ADD-12 §8.2): `extract:` also admits an array of one semantic scalar type — the loop
// below switches from `firstMatch` to "all matches" when the declared output field's IRType is
// `list` (issue #63's kind), and an empty match set is OK (mirrors `collection`'s existing
// empty-is-OK rule below), never DEGRADED.
//
// #81 (ADD-12 §8.1): a `response:` mapping may declare `onError` — a row-level discriminator
// that classifies each collection item BEFORE the success mapping runs. A row matching `when`
// is mapped against `onError.errorResource` (via `onError.map`, same shape as the success
// `map:` — a field with no entry there falls back to a same-named key on the item) and tagged
// `$row: "error"`; every other row is mapped against `resource` exactly as without this block
// and tagged `$row: "ok"`, required fields enforced in full. A non-error row missing one of
// those required fields is a PER-ROW violation, named but never silently dropped and never
// loosening any other row's required-ness. The whole-response VIOLATION fires only when the
// collection is non-empty and zero rows end up usable (mapped, whether `ok` or `error`).
//
// #146 — the mapping boundary holds at every level. Each found value is PROJECTED against its
// declared type: a nested resource value becomes a new object holding only that resource's declared
// fields (read by name — CDL has no per-nested-field path), recursively, through `collection:` rows
// too; a composite semantic value (`money`, `party`, `date-range`) keeps only its declared keys; a
// `ref:` slot takes a bare primitive id only; a value whose shape does not fit its declared type is
// ABSENT. Required-ness is evaluated at each level, and a failure bubbles to the nearest optional
// slot, which is dropped (`degraded`); with no optional slot on the way up, the row fails exactly
// as a missing top-level required field does. An undeclared provider key never reaches a model,
// however deep it sits (ADR-0008).
//
// Origin-bound output types (`web-page`): checked inside the same walk, at the scalar leaves. Every
// value whose declared type is origin-bound — a mapped field, a field of a nested resource value, a
// field of each collection row, an error row's field, an `extract:` field — is checked against the
// tool's declared `origins` (see origins.ts). A passing value is replaced by its normalised href.
// A failing one is treated as ABSENT and the existing required-ness rule decides: optional → the
// field is omitted and the result is `degraded`; required → absent, bubbling as above. Withheld field names are
// reported in their own list, `withheld` — never in `degraded`, which keeps meaning "the provider
// did not send it" — and never with the value, which is provider-controlled text.

import {
  evalPath,
  originListOf,
  type IRField,
  type IROrigins,
  type IRResourceRegistry,
  type IRTool,
  type IRType,
  type IRDiscriminator,
  type SemanticType,
} from "@archstone/compiler";
import { allowedOrigins, checkOrigin } from "./origins";

export type MappingStatus = "ok" | "degraded" | "violation";

/** One collection row that matched neither the success shape (fully) nor the declared error
 *  shape — #81's "row missing a required field, and not declared as a row-level error, still
 *  violates" scenario. Named so a caller can tell it apart from a declared error row (which
 *  lands in `data`, tagged `$row: "error"`) and from the whole-response VIOLATION (which this
 *  is deliberately NOT, as long as some other row is usable). */
export interface RowViolation {
  index: number; // position in the collection (0-based)
  missing: string[]; // the resource's required field(s) this row did not carry
  /** Field(s) of this row whose value was outside the declared origins and therefore withheld —
   *  present only when there is one. Names only, never the value. */
  withheld?: string[];
}

export interface MappingResult {
  status: MappingStatus;
  data?: Record<string, unknown>; // { [outputField]: mappedArray | mappedObject } — matches outputSchema
  missing?: string[]; // required fields absent → VIOLATION (fail-closed, no raw fallback)
  degraded?: string[]; // optional fields absent → DEGRADED (returned, field omitted)
  /** #81: present iff `response.onError` is declared AND at least one row failed to match
   *  either the success or the declared error shape. Never present without `onError` — without
   *  it, a row missing a required field is exactly the whole-response VIOLATION it always was. */
  rowViolations?: RowViolation[];
  /**
   * Fields whose value is of an origin-bound type (`web-page`) and was outside the tool's declared
   * origins, so it was withheld — treated as absent, never forwarded. Names only (a nested field is
   * dotted, `host.profileUrl`), never the value. Present only when non-empty, so a mapping that
   * withholds nothing has exactly the shape it had before this member existed.
   *
   * Distinct from `degraded` on purpose: `degraded` says the provider did not send an optional
   * field; this says the provider sent a value that breaks the declared guarantee. An optional
   * field withheld makes the status `degraded` without appearing in that list; a required one
   * makes it a `violation`.
   */
  withheld?: string[];
  /**
   * Only when the caller passed `collectUndeclared` (`verify` does; serving never does): the
   * dotted names of undeclared keys dropped from nested values (`host.phone`; collection rows
   * share a path, no index), deduped and capped. Names only, never values. Informational — it
   * never changes `status`. Top-level unmapped keys are not listed: dropping those is the
   * long-standing, documented contract (ADR-0008).
   */
  undeclaredNested?: string[];
}

/**
 * Per-call state for the one projection walk: the tool's normalised origin lists (computed once),
 * which resources can carry an origin-bound value, and — only when a caller asks for it (`verify`)
 * — the names of the undeclared keys the walk dropped from nested values.
 */
interface Walk {
  tool: IRTool;
  resources: IRResourceRegistry;
  allowed: Map<keyof IROrigins, ReadonlySet<string>>;
  reaches: Map<string, boolean>; // resource name → can a value of it contain an origin-bound value
  undeclared?: Set<string>;
}

/** Names collected while projecting one top-level value: every withheld field (whatever became of
 *  the value it sat in — the provider sent it), and the optional slots dropped below the top. */
interface WalkAcc {
  withheld: string[];
  degraded: string[];
}

/** The same shape `mapRow` has always returned for its withheld names: every one, and the
 *  required ones that fail the row. */
interface WithheldAcc {
  withheld: string[];
  required: string[];
}

/**
 * Nested resource levels the walk will project. Recursion follows the data, which `JSON.parse`
 * produces as a finite tree, so a self-referential resource terminates on its own; the cap only
 * stops a hostile body from exhausting the stack. A value deeper than this is ABSENT — never
 * forwarded unprojected — and its slot's required-ness decides.
 */
const MAX_NESTED_DEPTH = 32;

/** How many undeclared nested key names one mapping collects for `verify`. Names only, deduped. */
const MAX_UNDECLARED = 50;

/**
 * The declared shape of each composite semantic scalar — the keys its JSON-Schema lowering
 * (lowering.ts) declares, and which of them it requires. The mapper copies only these keys out of
 * a provider object; `nested-mapping.test.ts` pins this table to the lowering so the two cannot drift.
 */
const COMPOSITE_SHAPES: Readonly<Partial<Record<SemanticType, { required: readonly string[]; optional: readonly string[] }>>> = {
  "date-range": { required: ["from", "to"], optional: [] },
  party: { required: ["adults"], optional: ["children"] },
  money: { required: ["amount", "currency"], optional: [] },
};

function newWalk(tool: IRTool, resources: IRResourceRegistry, collectUndeclared: boolean): Walk {
  // Recomputed per call, deliberately not cached on the registry object: a stale "no" would be a
  // fail-open, and the fixed point costs a few passes over a handful of resources.
  const w: Walk = { tool, resources, allowed: new Map(), reaches: reachingResources(resources) };
  if (collectUndeclared) w.undeclared = new Set();
  return w;
}

function allowedFor(w: Walk, list: keyof IROrigins): ReadonlySet<string> {
  let set = w.allowed.get(list);
  if (!set) {
    set = allowedOrigins(w.tool.origins, list);
    w.allowed.set(list, set);
  }
  return set;
}

/**
 * Which resources can contain an origin-bound value anywhere, computed once per call as a least
 * fixed point over the whole registry: every resource starts at "no" and is raised while one of its
 * fields reaches an origin-bound type directly or through a resource already known to. A cycle
 * therefore cannot cut the walk short and leave a wrong "no" behind — `Host → Agency → Host` is
 * decided by iteration, not by whichever resource the walk happened to enter first.
 */
function reachingResources(resources: IRResourceRegistry, throughIdentity = true): Map<string, boolean> {
  const reaches = new Map<string, boolean>(Object.keys(resources).map((name) => [name, false]));
  const fieldReaches = (type: IRType): boolean => {
    if (type.kind === "scalar") return originListOf(type.semantic) !== undefined;
    if (type.kind === "list") return originListOf(type.items) !== undefined;
    if (type.kind === "resource" && type.identity && !throughIdentity) return false;
    return reaches.get(type.kind === "collection" ? type.of : type.name) === true;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const [name, fields] of Object.entries(resources)) {
      if (reaches.get(name)) continue;
      if (fields.some((f) => fieldReaches(f.type))) {
        reaches.set(name, true);
        changed = true;
      }
    }
  }
  return reaches;
}

/** Can a value of this type contain an origin-bound value anywhere? An identity (`ref:`) slot
 *  counts when the resource it names does: a well-formed id carries no link, but a provider that
 *  puts the whole object there would otherwise route an unchecked one around the check. */
function typeReaches(w: Pick<Walk, "reaches">, type: IRType): boolean {
  if (type.kind === "scalar") return originListOf(type.semantic) !== undefined;
  if (type.kind === "list") return originListOf(type.items) !== undefined;
  return w.reaches.get(type.kind === "collection" ? type.of : type.name) === true;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function isPrimitive(v: unknown): v is string | number | boolean {
  return typeof v === "string" || typeof v === "number" || typeof v === "boolean";
}

function hasOwn(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

function noteUndeclared(w: Walk, path: string): void {
  if (w.undeclared && w.undeclared.size < MAX_UNDECLARED) w.undeclared.add(path);
}

/**
 * The outcome of projecting one present value against its declared type. A failure says why the
 * value is absent and carries the names that matter if its slot is required:
 *   - `invalid` — the value itself does not have the declared shape (`missing: [path]`);
 *   - `withheld` — the value itself is an origin-bound value outside the declared origins, or a
 *     mis-shaped value of a type that can carry one (`withheld: [path]`, as #145 names it);
 *   - `nested` — a required field somewhere inside it failed (the deepest names, dotted).
 */
type Absent = { ok: false; reason: "invalid" | "withheld" | "nested"; missing: string[]; withheld: string[] };
type Projected = { ok: true; value: unknown } | Absent;

const ok = (value: unknown): Projected => ({ ok: true, value });

/** The value itself does not fit its declared type. A type that can carry an origin-bound value
 *  names it withheld (it cannot be walked, so it cannot be checked — #145's rule); any other names
 *  it missing. Either way it is absent and never forwarded. */
function misfit(w: Walk, type: IRType, path: string, acc: WalkAcc): Projected {
  if (typeReaches(w, type)) {
    acc.withheld.push(path);
    return { ok: false, reason: "withheld", missing: [], withheld: [path] };
  }
  return { ok: false, reason: "invalid", missing: [path], withheld: [] };
}

/** One semantic scalar value: an origin-bound one is checked and normalised; a composite one
 *  (`money`, `party`, `date-range`) keeps only its declared keys; `preference-set` is an array of
 *  primitives; anything else must be a JSON primitive. */
function projectSemantic(w: Walk, semantic: SemanticType, value: unknown, path: string, acc: WalkAcc): Projected {
  const type: IRType = { kind: "scalar", semantic };
  const list = originListOf(semantic);
  if (list !== undefined) {
    const r = checkOrigin(value, allowedFor(w, list));
    if (r.ok) return ok(r.href);
    acc.withheld.push(path);
    return { ok: false, reason: "withheld", missing: [], withheld: [path] };
  }
  const shape = COMPOSITE_SHAPES[semantic];
  if (shape) {
    // A primitive carries no keys, so nothing undeclared can ride along: passed as it always was
    // (a provider that sends `price: 120` is common). An object keeps only the declared keys.
    if (isPrimitive(value)) return ok(value);
    if (!isPlainObject(value)) return misfit(w, type, path, acc);
    const out: Record<string, unknown> = {};
    for (const k of shape.required) {
      if (!hasOwn(value, k) || !isPrimitive(value[k])) return misfit(w, type, path, acc);
      out[k] = value[k];
    }
    for (const k of shape.optional) {
      if (!hasOwn(value, k) || value[k] === undefined || value[k] === null) continue;
      // A declared key of the wrong shape is dropped and named as what it is — a mis-shaped
      // optional sub-value (`degraded`), never as an undeclared key.
      if (isPrimitive(value[k])) out[k] = value[k];
      else acc.degraded.push(`${path}.${k}`);
    }
    const declared = new Set([...shape.required, ...shape.optional]);
    for (const k of Object.keys(value)) if (!declared.has(k)) noteUndeclared(w, `${path}.${k}`);
    return ok(out);
  }
  if (semantic === "preference-set") {
    return Array.isArray(value) && value.every(isPrimitive) ? ok([...value]) : misfit(w, type, path, acc);
  }
  return isPrimitive(value) ? ok(value) : misfit(w, type, path, acc);
}

/**
 * Project one present value against its declared type, building a fresh value that holds only
 * what the declaration names — at every level, not just the top. This is the one walk: the #145
 * origin check happens inside it, at the scalar leaves, so the two can never cover different
 * ground. `depth` counts nested resource levels (see MAX_NESTED_DEPTH).
 */
function projectValue(w: Walk, type: IRType, value: unknown, path: string, acc: WalkAcc, depth: number): Projected {
  if (type.kind === "scalar") return projectSemantic(w, type.semantic, value, path, acc);
  if (type.kind === "list") {
    // All or nothing: a list is never silently shortened. The first failing item names the list.
    if (!Array.isArray(value)) return misfit(w, type, path, acc);
    const items: unknown[] = [];
    for (const item of value) {
      const r = projectSemantic(w, type.items, item, path, acc);
      if (!r.ok) return r;
      items.push(r.value);
    }
    return ok(items);
  }
  if (type.kind === "resource") {
    // `ref:` — a bare id (ADD-25 D-2). A primitive passes; an object or array in the id's place is
    // the resource itself, and is absent. It is never reduced to an id: the IR names no identity key.
    if (type.identity) return isPrimitive(value) ? ok(value) : misfit(w, type, path, acc);
    return projectResource(w, type, type.name, value, path, acc, depth + 1);
  }
  // collection: an array of plain objects, each projected. A row that fails makes the whole slot
  // absent — rows are never silently lost (the top-level rule without `onError`).
  if (!Array.isArray(value)) return misfit(w, type, path, acc);
  const rows: unknown[] = [];
  const missing = new Set<string>();
  const withheld = new Set<string>();
  let failed: Absent | undefined;
  for (const row of value) {
    const r = projectResource(w, type, type.of, row, path, acc, depth + 1);
    if (r.ok) {
      rows.push(r.value);
    } else {
      failed = r;
      r.missing.forEach((m) => missing.add(m));
      r.withheld.forEach((m) => withheld.add(m));
    }
  }
  if (!failed) return ok(rows);
  // A row that is itself mis-shaped names the collection slot the way a mis-shaped slot does.
  if (failed.reason !== "nested" && missing.size + withheld.size <= 1) return failed;
  return { ok: false, reason: "nested", missing: [...missing], withheld: [...withheld] };
}

/**
 * Project one resource value: a NEW object holding only the resource's declared fields, each read
 * by name off the provider object (CDL has no per-nested-field path) and projected in turn. Every
 * other key is dropped — the ADR-0008 guarantee, at this level as at the top.
 *
 * Required-ness is evaluated here: a required field that is absent or fails makes this whole value
 * absent, carrying the deepest names up so the nearest optional slot can absorb it (or, with none,
 * the response fails). An optional field that fails is dropped and named in `degraded` — but only
 * if this value survives; a value that is itself dropped reports only its own slot. An optional
 * field the provider simply did not send is not reported below the top level, as it never was.
 */
function projectResource(w: Walk, slotType: IRType, name: string, value: unknown, path: string, acc: WalkAcc, depth: number): Projected {
  const fields = w.resources[name];
  if (!fields || !isPlainObject(value) || depth > MAX_NESTED_DEPTH) return misfit(w, slotType, path, acc);
  const out: Record<string, unknown> = {};
  const missing: string[] = [];
  const withheld: string[] = [];
  const childAcc: WalkAcc = { withheld: acc.withheld, degraded: [] };
  for (const f of fields) {
    const childPath = `${path}.${f.name}`;
    const v = hasOwn(value, f.name) ? value[f.name] : undefined;
    if (v === undefined || v === null) {
      if (f.required) missing.push(childPath);
      continue;
    }
    const r = projectValue(w, f.type, v, childPath, childAcc, depth);
    if (r.ok) {
      out[f.name] = r.value;
    } else if (f.required) {
      missing.push(...r.missing);
      withheld.push(...r.withheld);
    } else if (r.reason !== "withheld") {
      childAcc.degraded.push(childPath);
    }
  }
  if (w.undeclared) {
    const declared = new Set(fields.map((f) => f.name));
    for (const k of Object.keys(value)) if (!declared.has(k)) noteUndeclared(w, `${path}.${k}`);
  }
  if (missing.length > 0 || withheld.length > 0) return { ok: false, reason: "nested", missing, withheld };
  acc.degraded.push(...childAcc.degraded);
  return ok(out);
}

/** First JSONPath match, or undefined when the path resolves to nothing. */
function firstMatch(json: unknown, path: string): unknown {
  const matches = evalPath(json, path);
  return matches.length > 0 ? matches[0] : undefined;
}

/** #81 — does one collection item match a row-error discriminator? `exists` checks presence at
 *  `path`; `equals` checks JSON equality against the first match; declaring neither (shape-valid
 *  but pointless) matches on plain presence, the same floor `exists` alone would give. */
function matchesDiscriminator(item: unknown, when: IRDiscriminator): boolean {
  const matches = evalPath(item, when.path);
  const present = matches.length > 0 && matches[0] !== undefined && matches[0] !== null;
  if (when.exists !== undefined) return present === when.exists;
  if ("equals" in when) return present && JSON.stringify(matches[0]) === JSON.stringify(when.equals);
  return present;
}

/** Map one declared row (success or #81 error) shape against an item, by field name → path —
 *  a field with no entry in `byPath` falls back to a same-named key on the item (`$.<name>`),
 *  the default for both shapes when their own `map:` omits a field. Returns the mapped object
 *  plus which required fields were absent. */
function mapRow(
  item: unknown,
  fields: IRField[],
  byPath: Map<string, string> | undefined,
  tag: "ok" | "error" | undefined,
  walk: Walk,
): { obj: Record<string, unknown>; missing: string[]; degraded: string[]; withheld: WithheldAcc } {
  const obj: Record<string, unknown> = {};
  if (tag) obj.$row = tag;
  const missing: string[] = [];
  const acc: WalkAcc = { withheld: [], degraded: [] };
  const required: string[] = [];
  for (const f of fields) {
    const path = byPath?.get(f.name) ?? `$.${f.name}`;
    const value = firstMatch(item, path);
    if (value === undefined || value === null) {
      if (f.required) missing.push(f.name);
      else acc.degraded.push(f.name);
      continue;
    }
    const r = projectValue(walk, f.type, value, f.name, acc, 0);
    if (r.ok) {
      obj[f.name] = r.value;
    } else if (f.required) {
      // Absent, and required: the row fails. A withheld value is named as withheld, never as
      // missing; a failure deeper down carries the deepest names (`host.name`).
      missing.push(...r.missing);
      required.push(...r.withheld);
    } else if (r.reason !== "withheld") {
      // An optional slot absorbs the failure: omitted, and degraded. A withheld optional value
      // is reported in `withheld` only, as #145 defined it.
      acc.degraded.push(f.name);
    }
  }
  const uniq = (xs: string[]): string[] => [...new Set(xs)];
  return { obj, missing: uniq(missing), degraded: uniq(acc.degraded), withheld: { withheld: uniq(acc.withheld), required: uniq(required) } };
}

/**
 * Map + validate a provider body against the tool's response mapping and/or `extract:` block. A
 * required field — per the resource registry for `response:`, or per `tool.output` directly for
 * `extract:` (there is no resource here), unless loosened by `requiredOverride` — that resolves
 * to nothing (on any item, for `response:`; at the body root, for `extract:`) is a VIOLATION; an
 * absent optional field DEGRADES. An empty collection is OK (emptiness is not drift). Both
 * mechanisms write into the SAME accumulators, so a caller sees one merged result no matter which
 * one (or both) a tool declares.
 *
 * Every mapped value is PROJECTED against its declared type at every nesting level: a nested
 * resource keeps only its declared fields, a composite semantic value only its declared keys, and a
 * value that does not fit its declared shape is absent (#146). `options.collectUndeclared` (off by
 * default; `verify` turns it on) adds `undeclaredNested` — the dotted names, never the values, of
 * the undeclared keys dropped from nested values. It never changes the status.
 */
export function applyResponseMapping(
  tool: IRTool,
  body: unknown,
  resources: IRResourceRegistry,
  options?: { collectUndeclared?: boolean },
): MappingResult {
  const mapping = tool.response;
  const extract = tool.extract;
  if (!mapping && !extract) return { status: "ok", data: {} }; // caller guards on tool.response || tool.extract; defensive

  const missing = new Set<string>();
  const degraded = new Set<string>();
  const withheld = new Set<string>();
  const requiredWithheld = new Set<string>();
  const rowViolations: RowViolation[] = [];
  const data: Record<string, unknown> = {};
  let wholeResponseViolation = false;
  const walk = newWalk(tool, resources, options?.collectUndeclared === true);
  const absorb = (acc: WithheldAcc): void => {
    acc.withheld.forEach((w) => withheld.add(w));
    acc.required.forEach((w) => requiredWithheld.add(w));
  };

  if (mapping) {
    const resourceFields = resources[mapping.resource] ?? [];
    const requiredByName = new Map(resourceFields.map((f) => [f.name, f.required]));
    const typeByName = new Map(resourceFields.map((f) => [f.name, f.type]));
    const pathByName = new Map(mapping.fields.map((fm) => [fm.name, fm.path]));
    // The success shape's field list is `mapping.fields` (only the fields THIS binding
    // declares a path for — a resource field with no `map:` entry is simply never populated,
    // exactly as before #81), with required-ness read from the resource registry and
    // `requiredOverride` folded in so `mapRow`'s generic required check applies uniformly.
    // The declared type rides along for the origin check; a field the registry does not know
    // keeps an ordinary type, which the check passes through untouched.
    const successFields: IRField[] = mapping.fields.map((fm) => ({
      name: fm.name,
      required: (requiredByName.get(fm.name) ?? true) && fm.requiredOverride !== false,
      type: typeByName.get(fm.name) ?? { kind: "scalar", semantic: "text" },
    }));
    const items: unknown[] = mapping.collection ? evalPath(body, mapping.collection) : [body];
    const onError = mapping.onError;
    // errorResource's OWN `map:` (optional — a delta ratified after §8.1's initial shipment):
    // same field-mapping shape as the success `map:`. A field with no entry here falls back to
    // `mapRow`'s same-named-key default (`$.<fieldName>`) — the pre-existing behaviour.
    const errorPathByName = new Map((onError?.map ?? []).map((fm) => [fm.name, fm.path]));
    const errorRequiredOverrideByName = new Map((onError?.map ?? []).map((fm) => [fm.name, fm.requiredOverride]));
    const errorFields: IRField[] = (resources[onError?.errorResource ?? ""] ?? []).map((f) => ({
      name: f.name,
      required: f.required && errorRequiredOverrideByName.get(f.name) !== false,
      type: f.type,
    }));

    if (!onError) {
      // Unchanged pre-#81 behaviour: every row mapped against `resource`, any missing required
      // field anywhere is a whole-response VIOLATION (no per-row distinction to make). A required
      // field withheld by the origin check counts the same way, as it does for a missing one.
      const mapped: Record<string, unknown>[] = [];
      for (const item of items) {
        const { obj, missing: rowMissing, degraded: rowDegraded, withheld: rowWithheld } = mapRow(item, successFields, pathByName, undefined, walk);
        rowMissing.forEach((m) => missing.add(m));
        rowDegraded.forEach((d) => degraded.add(d));
        absorb(rowWithheld);
        mapped.push(obj);
      }
      data[mapping.field] = mapping.collection ? mapped : mapped[0];
    } else {
      // #81: classify each row first. A declared error row is mapped against `errorResource`
      // and tagged; everything else is mapped against `resource`, tagged, and a row that fails
      // required-ness there is a PER-ROW violation — named, dropped from `data`, never folded
      // into the shared `missing` set (which would wrongly fail every OTHER row too).
      const mapped: Record<string, unknown>[] = [];
      let usable = 0;
      // A row's withheld names always reach the response-level `withheld` list — the provider sent
      // an off-origin value whether or not the row survived — but a REQUIRED withheld field fails
      // only its own row, exactly as a missing required field does here.
      const rowViolation = (index: number, rowMissing: string[], rowWithheld: WithheldAcc): void => {
        const rv: RowViolation = { index, missing: rowMissing };
        if (rowWithheld.withheld.length > 0) rv.withheld = rowWithheld.withheld;
        rowViolations.push(rv);
      };
      items.forEach((item, index) => {
        if (matchesDiscriminator(item, onError.when)) {
          const { obj, missing: rowMissing, withheld: rowWithheld } = mapRow(item, errorFields, errorPathByName, "error", walk);
          rowWithheld.withheld.forEach((w) => withheld.add(w));
          if (rowMissing.length > 0 || rowWithheld.required.length > 0) {
            rowViolation(index, rowMissing, rowWithheld);
          } else {
            mapped.push(obj);
            usable++;
          }
          return;
        }
        const { obj, missing: rowMissing, degraded: rowDegraded, withheld: rowWithheld } = mapRow(item, successFields, pathByName, "ok", walk);
        rowWithheld.withheld.forEach((w) => withheld.add(w));
        if (rowMissing.length > 0 || rowWithheld.required.length > 0) {
          rowViolation(index, rowMissing, rowWithheld);
        } else {
          rowDegraded.forEach((d) => degraded.add(d));
          mapped.push(obj);
          usable++;
        }
      });
      data[mapping.field] = mapped;
      if (items.length > 0 && usable === 0) wholeResponseViolation = true;
    }
  }

  if (extract) {
    // Body-root only, deliberately: `extract:` never scopes into `mapping.collection`'s items —
    // it reaches capability-level scalars, not per-item fields (that stays `response.map`'s job).
    const outputByName = new Map(tool.output.map((f) => [f.name, f]));
    for (const fm of extract) {
      const field = outputByName.get(fm.name);
      const required = (field?.required ?? true) && fm.requiredOverride !== false;

      // The same projection — and with it the same origin check — as a `response:` field,
      // whatever the output field's kind. A name `tool.output` does not know is projected as
      // text: a primitive passes, anything else is absent (fail closed).
      const type: IRType = field?.type ?? { kind: "scalar", semantic: "text" };
      const check = (value: unknown): void => {
        const acc: WalkAcc = { withheld: [], degraded: [] };
        const r = projectValue(walk, type, value, fm.name, acc, 0);
        acc.withheld.forEach((w) => withheld.add(w));
        if (r.ok) {
          acc.degraded.forEach((d) => degraded.add(d));
          data[fm.name] = r.value;
        } else if (required) {
          r.missing.forEach((m) => missing.add(m));
          r.withheld.forEach((w) => requiredWithheld.add(w));
        } else if (r.reason !== "withheld") {
          degraded.add(fm.name);
        }
      };

      if (field?.type.kind === "list") {
        // #82: an array output field — ALL matches, not just the first. An empty match set is
        // OK (mirrors `collection`'s existing empty-is-OK rule above), never DEGRADED.
        check(evalPath(body, fm.path));
        continue;
      }

      const value = firstMatch(body, fm.path);
      if (value === undefined || value === null) {
        if (required) missing.add(fm.name);
        else degraded.add(fm.name);
        continue;
      }
      check(value);
    }
  }

  if (missing.size > 0 || requiredWithheld.size > 0 || wholeResponseViolation) {
    // Every row failed (#81's "every row fails" scenario): `missing` never accumulated
    // per-row failures (that would wrongly implicate every OTHER row), so when it is what
    // makes this a whole-response VIOLATION, name the union of what each failing row lacked —
    // `contractViolationMessage` still has something to say. A row that failed only because a
    // required value was withheld is already named in `withheld`.
    if (missing.size === 0 && requiredWithheld.size === 0) for (const rv of rowViolations) rv.missing.forEach((m) => missing.add(m));
    const result: MappingResult = { status: "violation", missing: [...missing] };
    if (withheld.size > 0) result.withheld = [...withheld];
    if (rowViolations.length > 0) result.rowViolations = rowViolations;
    if (walk.undeclared && walk.undeclared.size > 0) result.undeclaredNested = [...walk.undeclared];
    return result;
  }
  const status: MappingStatus = degraded.size > 0 || withheld.size > 0 ? "degraded" : "ok";
  const result: MappingResult = { status, data };
  if (degraded.size > 0) result.degraded = [...degraded];
  if (withheld.size > 0) result.withheld = [...withheld];
  if (rowViolations.length > 0) result.rowViolations = rowViolations;
  if (walk.undeclared && walk.undeclared.size > 0) result.undeclaredNested = [...walk.undeclared];
  return result;
}

/**
 * The human text a contract VIOLATION is reported with — one spelling, shared by both
 * invocation consumers (#44).
 *
 * Extracted rather than duplicated because the audit record must carry, verbatim, the message
 * the consumer already surfaces, and the two consumers surface a violation differently: the MCP
 * path returns this exact sentence as tool content (five shipped assertions pin it byte-for-
 * byte), while the embedded path returns `{status:"violation", missing}` with no text at all.
 * Without one shared spelling, an `mcp` record and a `function-calling` record for the identical
 * failure would read differently — precisely the drift a single record builder exists to
 * prevent, and invisible until an auditor compares the two.
 */
export function contractViolationMessage(capabilityId: string, missing: readonly string[], withheld: readonly string[] = []): string {
  if (withheld.length === 0) {
    return `contract violation: capability '${capabilityId}' — provider response is missing required field(s): ${missing.join(", ")}. Declared output shape not met; raw body withheld.`;
  }
  // A withheld field was present: it is named as withheld, with the reason, never as missing —
  // and never with its value, which is provider-controlled text.
  const parts: string[] = [];
  if (missing.length > 0) parts.push(`is missing required field(s): ${missing.join(", ")}`);
  parts.push(`carries a value outside the declared origins in field(s): ${withheld.join(", ")} (withheld)`);
  return `contract violation: capability '${capabilityId}' — provider response ${parts.join("; and ")}. Declared output shape not met; raw body withheld.`;
}

/** The model-facing note for a mapping that withheld an optional field's value. Names fields only. */
export function withheldNote(withheld: readonly string[]): string {
  return `note: field(s) withheld — value outside the declared origins: ${withheld.join(", ")}`;
}

/**
 * The refusal for a tool whose output reaches an origin-bound type but whose binding declares
 * neither `response:` nor `extract:`, so the mapper — and with it the origin check — never runs.
 *
 * The compiler refuses this combination (`web-page-needs-mapping`); this is the runtime floor for
 * an IR that did not come from it (a hand-written or forward-versioned artifact loaded through
 * `fromIR`). Without it, such a tool would forward the provider body raw, link and all. Returns
 * `undefined` when the tool is fine to pass through. Names the capability, never a value.
 */
export function passThroughRefusal(tool: IRTool, resources: IRResourceRegistry): string | undefined {
  if (tool.response || tool.extract) return undefined;
  // Reachability by representation only — the compiler's definition (`web-page-needs-mapping`
  // does not follow `ref:`), so a manifest the compiler accepts is never refused here.
  const reach = { reaches: reachingResources(resources, false) };
  const reaches = (type: IRType): boolean => !(type.kind === "resource" && type.identity) && typeReaches(reach, type);
  if (!tool.output.some((f) => reaches(f.type))) return undefined;
  return `capability '${tool.id}' declares an origin-checked output field, but its binding has no response: or extract: mapping, so the value cannot be checked — response withheld.`;
}
