// @archstone/emitter-support — input contract enforcement (#195)
//
// `inputJsonSchema` (lowering.ts) advertises a capability's input contract; this module HOLDS
// callers to it. One pure function, called by both invocation paths (`callTool` in
// @archstone/runtime, `executeCapability` in @archstone/agent) after the policy gate and before
// the rate limiter and any connector work — so a malformed call spends no quota and reaches no
// backend.
//
// Structural over `IRField`, hand-written, no JSON Schema library: the same decision
// `extraction.ts` records (a second, derived representation of the contract drifts, and the
// drifted copy is the one that wins). Agreement with `inputJsonSchema` is pinned by a drift test.
//
// What it never does: coerce (`"42"` is not a number), default, repair, or drop. And it never
// returns a caller-supplied string — not a value, and not an undeclared key's name — because
// every byte of the arguments is attacker-controlled text that would otherwise travel into a
// model's context, a log line or an audit record. Problems carry a DECLARED field path and a
// fixed phrase, nothing else.
//
// Pure and target-agnostic: no MCP, no HTTP. `_meta` shaping lives in runtime/server.ts and the
// `ExecuteResult` shaping in agent/execute.ts.

import type { IRField, IRResourceRegistry, SemanticType } from "@archstone/compiler";

export interface InputProblem {
  /** Dotted path of DECLARED field names (`dates.from`, `tags[2]`); `$` is the argument object. */
  path: string;
  /** A short fixed phrase — never the offending value. */
  expected: string;
}

export type InputValidation = { ok: true } | { ok: false; problems: InputProblem[]; truncated?: true };

/** The most problems one refusal carries. A hostile caller cannot make the error arbitrarily large. */
export const MAX_INPUT_PROBLEMS = 16;

const UNDECLARED = "no undeclared properties";

/** The human sentence both consumers return and the audit record copies. Paths and phrases only. */
export function inputInvalidMessage(capabilityId: string, problems: InputProblem[], truncated?: boolean): string {
  const list = problems.map((p) => `${p.path} (expected ${p.expected})`).join("; ");
  return `input for capability '${capabilityId}' does not match its declared contract: ${list}${truncated ? "; further problems omitted" : ""}.`;
}

const DATE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DATE_TIME = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|[+-](\d{2}):(\d{2}))$/;

function realDate(y: number, m: number, d: number): boolean {
  if (m < 1 || m > 12 || d < 1) return false;
  const dim = [31, y % 4 === 0 && (y % 100 !== 0 || y % 400 === 0) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return d <= dim[m - 1];
}

function isDate(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = DATE.exec(v);
  return m !== null && realDate(Number(m[1]), Number(m[2]), Number(m[3]));
}

function isDateTime(v: unknown): boolean {
  if (typeof v !== "string") return false;
  const m = DATE_TIME.exec(v);
  if (m === null) return false;
  if (!realDate(Number(m[1]), Number(m[2]), Number(m[3]))) return false;
  if (Number(m[4]) > 23 || Number(m[5]) > 59 || Number(m[6]) > 60) return false;
  return m[7] === undefined || (Number(m[7]) <= 23 && Number(m[8]) <= 59);
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isCount = (v: unknown): boolean => typeof v === "number" && Number.isInteger(v) && v >= 0;
/** Absent: `undefined`, or `null` — the REST provider already skips both, so clients that send
 *  `null` for an optional field keep working. On a REQUIRED field `null` is still a problem. */
const isAbsent = (v: unknown): boolean => v === undefined || v === null;

class Collector {
  readonly problems: InputProblem[] = [];
  truncated = false;
  /** True once there is nothing left to learn: callers stop walking, so a huge list of bad items
   *  costs O(cap), not O(size). */
  get full(): boolean {
    return this.truncated;
  }
  add(path: string, expected: string): void {
    if (this.problems.length >= MAX_INPUT_PROBLEMS) {
      this.truncated = true;
      return;
    }
    this.problems.push({ path, expected });
  }
}

const join = (base: string, name: string): string => (base === "$" ? name : `${base}.${name}`);

/** Check one object's own keys against a declared member set; report ONE undeclared-key problem
 *  per object, naming the object's path and never the key. */
function checkUndeclared(value: Record<string, unknown>, declared: ReadonlySet<string>, path: string, out: Collector): void {
  for (const key of Object.keys(value)) {
    if (!declared.has(key)) {
      out.add(path, UNDECLARED);
      return;
    }
  }
}

function checkScalar(
  semantic: SemanticType,
  values: string[] | undefined,
  value: unknown,
  path: string,
  out: Collector,
): void {
  switch (semantic) {
    case "date-range": {
      if (!isObject(value)) return out.add(path, "object");
      checkUndeclared(value, new Set(["from", "to"]), path, out);
      for (const k of ["from", "to"] as const) {
        if (isAbsent(value[k])) out.add(join(path, k), "required");
        else if (!isDate(value[k])) out.add(join(path, k), "date (YYYY-MM-DD)");
      }
      return;
    }
    case "party": {
      if (!isObject(value)) return out.add(path, "object");
      checkUndeclared(value, new Set(["adults", "children"]), path, out);
      if (isAbsent(value.adults)) out.add(join(path, "adults"), "required");
      else if (!isCount(value.adults)) out.add(join(path, "adults"), "non-negative integer");
      if (!isAbsent(value.children) && !isCount(value.children)) out.add(join(path, "children"), "non-negative integer");
      return;
    }
    case "money": {
      if (!isObject(value)) return out.add(path, "object");
      checkUndeclared(value, new Set(["amount", "currency"]), path, out);
      if (isAbsent(value.amount)) out.add(join(path, "amount"), "required");
      else if (!isNumber(value.amount)) out.add(join(path, "amount"), "number");
      if (isAbsent(value.currency)) out.add(join(path, "currency"), "required");
      else if (typeof value.currency !== "string") out.add(join(path, "currency"), "string");
      return;
    }
    case "preference-set": {
      if (!Array.isArray(value)) return out.add(path, "array of strings");
      for (let i = 0; i < value.length && !out.full; i++) if (typeof value[i] !== "string") out.add(`${path}[${i}]`, "string");
      return;
    }
    case "time-slot":
    case "datetime":
      if (!isDateTime(value)) out.add(path, "date-time (RFC 3339)");
      return;
    case "date":
      if (!isDate(value)) out.add(path, "date (YYYY-MM-DD)");
      return;
    case "quantity":
      if (!isNumber(value)) out.add(path, "number");
      return;
    case "enum":
      if (typeof value !== "string") out.add(path, "string");
      else if (!(values ?? []).includes(value)) out.add(path, "one of the declared values");
      return;
    default:
      // location, identifier, string, text, web-page, image — and, as in the lowering, any value
      // this build does not recognise: a string.
      if (typeof value !== "string") out.add(path, "string");
  }
}

function checkObject(
  fields: IRField[],
  value: Record<string, unknown>,
  path: string,
  resources: IRResourceRegistry,
  visited: ReadonlySet<string>,
  out: Collector,
): void {
  checkUndeclared(value, new Set(fields.map((f) => f.name)), path, out);
  for (const f of fields) {
    if (out.full) return;
    const fieldPath = join(path, f.name);
    const v = Object.prototype.hasOwnProperty.call(value, f.name) ? value[f.name] : undefined;
    if (isAbsent(v)) {
      if (f.required) out.add(fieldPath, "required");
      continue;
    }
    checkField(f, v, fieldPath, resources, visited, out);
  }
}

function checkResource(
  name: string,
  value: unknown,
  path: string,
  resources: IRResourceRegistry,
  visited: ReadonlySet<string>,
  out: Collector,
): void {
  if (!isObject(value)) return out.add(path, "object");
  const fields = resources[name];
  // Mirrors the lowering: an unknown or self-referential resource is a generic `{type:object}`.
  if (!fields || visited.has(name)) return;
  checkObject(fields, value, path, resources, new Set(visited).add(name), out);
}

function checkField(
  f: IRField,
  value: unknown,
  path: string,
  resources: IRResourceRegistry,
  visited: ReadonlySet<string>,
  out: Collector,
): void {
  switch (f.type.kind) {
    case "scalar":
      return checkScalar(f.type.semantic, f.type.values, value, path, out);
    case "list": {
      if (!Array.isArray(value)) return out.add(path, "array");
      for (let i = 0; i < value.length && !out.full; i++) {
        checkScalar(f.type.items, f.type.values, value[i], `${path}[${i}]`, out);
      }
      return;
    }
    case "collection": {
      if (!Array.isArray(value)) return out.add(path, "array");
      for (let i = 0; i < value.length && !out.full; i++) {
        checkResource(f.type.of, value[i], `${path}[${i}]`, resources, visited, out);
      }
      return;
    }
    case "resource":
      // `ref:` fields are a bare id; `type:` fields are the full object — as in the lowering.
      if (f.type.identity) {
        if (typeof value !== "string") out.add(path, "string");
        return;
      }
      return checkResource(f.type.name, value, path, resources, visited, out);
  }
}

/**
 * Validate a call's arguments against a capability's declared input fields — the contract
 * `inputJsonSchema` advertises. See the file header for what it refuses and what it never does.
 */
export function validateInput(fields: IRField[], args: unknown, resources: IRResourceRegistry = {}): InputValidation {
  const out = new Collector();
  if (!isObject(args)) {
    out.add("$", "object");
  } else {
    checkObject(fields, args, "$", resources, new Set(), out);
  }
  if (out.problems.length === 0) return { ok: true };
  return out.truncated ? { ok: false, problems: out.problems, truncated: true } : { ok: false, problems: out.problems };
}
