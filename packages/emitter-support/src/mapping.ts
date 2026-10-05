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
// Origin-bound output types (`web-page`): the mapper is type-aware for these and only these. Every
// value whose declared type is origin-bound — a mapped field, a field of a nested resource value, a
// field of each collection row, an error row's field, an `extract:` field — is checked against the
// tool's declared `origins` (see origins.ts). A passing value is replaced by its normalised href.
// A failing one is treated as ABSENT and the existing required-ness rule decides: optional → the
// field is omitted and the result is `degraded`; required → `violation`. Withheld field names are
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
}

/** Per-call state for the origin check: the tool's normalised origin lists, computed once. */
interface OriginGuard {
  tool: IRTool;
  resources: IRResourceRegistry;
  allowed: Map<keyof IROrigins, ReadonlySet<string>>;
  reaches: Map<string, boolean>; // resource name → does its type graph reach an origin-bound type
}

/** Names collected while checking one value: every withheld field, and the required ones. */
interface WithheldAcc {
  withheld: string[];
  required: string[];
}

function newGuard(tool: IRTool, resources: IRResourceRegistry): OriginGuard {
  return { tool, resources, allowed: new Map(), reaches: new Map() };
}

function allowedFor(g: OriginGuard, list: keyof IROrigins): ReadonlySet<string> {
  let set = g.allowed.get(list);
  if (!set) {
    set = allowedOrigins(g.tool.origins, list);
    g.allowed.set(list, set);
  }
  return set;
}

/** Can a value of this type contain an origin-bound value anywhere? Static, memoised per resource,
 *  so a tool with no origin-bound type pays one walk of its type graph and nothing per value. */
function typeReaches(g: OriginGuard, type: IRType, visiting: Set<string> = new Set()): boolean {
  if (type.kind === "scalar") return originListOf(type.semantic) !== undefined;
  if (type.kind === "list") return originListOf(type.items) !== undefined;
  if (type.kind === "resource" && type.identity) return false; // a bare id
  const name = type.kind === "collection" ? type.of : type.name;
  const known = g.reaches.get(name);
  if (known !== undefined) return known;
  if (visiting.has(name)) return false; // a cycle adds nothing the first visit does not see
  visiting.add(name);
  const result = (g.resources[name] ?? []).some((f) => typeReaches(g, f.type, visiting));
  visiting.delete(name);
  g.reaches.set(name, result);
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Check the declared fields of one resource value (an object), returning the value to keep — the
 *  same object when nothing changed, a shallow copy when a field was normalised or withheld.
 *  Recursion follows the data, which is finite, so a self-referential resource is checked at every
 *  depth the provider actually sends. */
function guardObject(g: OriginGuard, resource: string, value: Record<string, unknown>, path: string, acc: WithheldAcc): Record<string, unknown> {
  let out = value;
  for (const f of g.resources[resource] ?? []) {
    if (!Object.prototype.hasOwnProperty.call(value, f.name)) continue;
    const v = value[f.name];
    if (v === undefined || v === null || !typeReaches(g, f.type)) continue;
    const childPath = `${path}.${f.name}`;
    const r = guardValue(g, f.type, v, childPath, acc);
    if (r.keep && r.value === v) continue;
    if (out === value) out = { ...value };
    if (r.keep) {
      out[f.name] = r.value;
    } else {
      delete out[f.name];
      acc.withheld.push(childPath);
      if (f.required) acc.required.push(childPath);
    }
  }
  return out;
}

/**
 * Check one present value of a declared type. `keep: false` means the value itself is withheld —
 * the caller names it, because only the caller knows the field's effective required-ness. Fields
 * withheld deeper inside (a nested resource, a collection row) are named into `acc` here.
 */
function guardValue(g: OriginGuard, type: IRType, value: unknown, path: string, acc: WithheldAcc): { keep: boolean; value: unknown } {
  if (!typeReaches(g, type)) return { keep: true, value };
  if (type.kind === "scalar") {
    const r = checkOrigin(value, allowedFor(g, originListOf(type.semantic)!));
    return r.ok ? { keep: true, value: r.href } : { keep: false, value: undefined };
  }
  if (type.kind === "list") {
    // Not authorable today (`list:` does not admit an origin-bound type), but a hand-written IR
    // can carry one: all or nothing, so a list is never silently shortened.
    if (!Array.isArray(value)) return { keep: false, value: undefined };
    const allowed = allowedFor(g, originListOf(type.items)!);
    const hrefs: string[] = [];
    for (const item of value) {
      const r = checkOrigin(item, allowed);
      if (!r.ok) return { keep: false, value: undefined };
      hrefs.push(r.href);
    }
    return { keep: true, value: hrefs };
  }
  if (type.kind === "resource") {
    if (!isPlainObject(value)) return { keep: true, value };
    return { keep: true, value: guardObject(g, type.name, value, path, acc) };
  }
  // collection
  if (!Array.isArray(value)) return { keep: true, value };
  let changed = false;
  const rows = value.map((row) => {
    if (!isPlainObject(row)) return row;
    const kept = guardObject(g, type.of, row, path, acc);
    if (kept !== row) changed = true;
    return kept;
  });
  return { keep: true, value: changed ? rows : value };
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
  guard: OriginGuard,
): { obj: Record<string, unknown>; missing: string[]; degraded: string[]; withheld: WithheldAcc } {
  const obj: Record<string, unknown> = {};
  if (tag) obj.$row = tag;
  const missing: string[] = [];
  const degraded: string[] = [];
  const withheld: WithheldAcc = { withheld: [], required: [] };
  for (const f of fields) {
    const path = byPath?.get(f.name) ?? `$.${f.name}`;
    const value = firstMatch(item, path);
    if (value === undefined || value === null) {
      if (f.required) missing.push(f.name);
      else degraded.push(f.name);
      continue;
    }
    const checked = guardValue(guard, f.type, value, f.name, withheld);
    if (!checked.keep) {
      // Withheld: absent, and required-ness decides — but named as withheld, never as missing.
      withheld.withheld.push(f.name);
      if (f.required) withheld.required.push(f.name);
      continue;
    }
    obj[f.name] = checked.value;
  }
  return { obj, missing, degraded, withheld };
}

/**
 * Map + validate a provider body against the tool's response mapping and/or `extract:` block. A
 * required field — per the resource registry for `response:`, or per `tool.output` directly for
 * `extract:` (there is no resource here), unless loosened by `requiredOverride` — that resolves
 * to nothing (on any item, for `response:`; at the body root, for `extract:`) is a VIOLATION; an
 * absent optional field DEGRADES. An empty collection is OK (emptiness is not drift). Both
 * mechanisms write into the SAME accumulators, so a caller sees one merged result no matter which
 * one (or both) a tool declares.
 */
export function applyResponseMapping(tool: IRTool, body: unknown, resources: IRResourceRegistry): MappingResult {
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
  const guard = newGuard(tool, resources);
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
        const { obj, missing: rowMissing, degraded: rowDegraded, withheld: rowWithheld } = mapRow(item, successFields, pathByName, undefined, guard);
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
          const { obj, missing: rowMissing, withheld: rowWithheld } = mapRow(item, errorFields, errorPathByName, "error", guard);
          rowWithheld.withheld.forEach((w) => withheld.add(w));
          if (rowMissing.length > 0 || rowWithheld.required.length > 0) {
            rowViolation(index, rowMissing, rowWithheld);
          } else {
            mapped.push(obj);
            usable++;
          }
          return;
        }
        const { obj, missing: rowMissing, degraded: rowDegraded, withheld: rowWithheld } = mapRow(item, successFields, pathByName, "ok", guard);
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

      // The same origin check as a `response:` field, whatever the output field's kind.
      const check = (value: unknown): boolean => {
        const acc: WithheldAcc = { withheld: [], required: [] };
        const r = field ? guardValue(guard, field.type, value, fm.name, acc) : { keep: true, value };
        absorb(acc);
        if (!r.keep) {
          withheld.add(fm.name);
          if (required) requiredWithheld.add(fm.name);
          return false;
        }
        data[fm.name] = r.value;
        return true;
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
    return result;
  }
  const status: MappingStatus = degraded.size > 0 || withheld.size > 0 ? "degraded" : "ok";
  const result: MappingResult = { status, data };
  if (degraded.size > 0) result.degraded = [...degraded];
  if (withheld.size > 0) result.withheld = [...withheld];
  if (rowViolations.length > 0) result.rowViolations = rowViolations;
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
  const guard = newGuard(tool, resources);
  if (!tool.output.some((f) => typeReaches(guard, f.type))) return undefined;
  return `capability '${tool.id}' declares an origin-checked output field, but its binding has no response: or extract: mapping, so the value cannot be checked — response withheld.`;
}
