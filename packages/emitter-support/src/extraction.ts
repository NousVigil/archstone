// @archstone/emitter-support — model-output validation (ADR-0011)
//
// The mirror of `mapping.ts`. That file governs provider → model: a fresh object is built from
// the fields the manifest DECLARES, and everything else is dropped before a model sees it
// (ADR-0008). This file governs model → business system, on the same terms and with the same
// three outcomes: **undeclared model output never reaches a business system.**
//
// Validation is structural, over `IRField` — it does NOT compile the schema
// `extractionJsonSchema` emits and hand it to a schema library. Two representations of one
// contract drift, and the derived one would win; validating the source keeps the emitted schema
// an artifact of the contract rather than a second copy of it. It also keeps this package what
// it is: no filesystem, no MCP SDK, no runtime dependency.
//
// **What this proves is shape, never truth.** A fluent, well-typed hallucination passes every
// check here. See `ExtractionResult`.

import type { IRField, IRResourceRegistry, SemanticType } from "@archstone/compiler";
import { extractionJsonSchema } from "./lowering";
import { isMoneyShape } from "./money";

export type ExtractionStatus = "ok" | "degraded" | "violation";

/**
 * The outcome of validating one model-produced document against a declared field list.
 *
 * **`status` does not mean the extraction is correct.** It means the document has the shape the
 * manifest declares. A model that invents a plausible, correctly-typed value returns `ok`, and
 * nothing at this boundary can tell that apart from a true one — the same way a green `verify`
 * means a provider still answers in the recorded shape, not that its answers are right. Stated
 * here, on the type, because a deployer wires the type and may never read the guide.
 */
export interface ExtractionResult {
  status: ExtractionStatus;
  /** Declared fields only, and only when `status` is not `violation` — a violated document is
   *  withheld whole, exactly as a contract violation withholds a provider's raw body. An
   *  undeclared key cannot appear here under any input, at any depth. */
  data?: Record<string, unknown>;
  /** Declared **required** fields the document does not carry. Any entry ⇒ `violation`. */
  missing?: string[];
  /** Declared fields present with the wrong shape, as `path: expected <type>`. Any entry ⇒
   *  `violation`. **Never contains a value from the document** — the extraction input is by
   *  construction the most sensitive text in the deployment (the clinical note, the invoice,
   *  the claim), and an error that echoes it writes that text into whatever catches it. */
  invalid?: string[];
  /** Declared **optional** fields the document does not carry. Any entry (absent a violation)
   *  ⇒ `degraded`. */
  degraded?: string[];
  /** Keys the document carries that the manifest does not declare. **Dropped** — they never
   *  reach `data` — and named, which is the whole difference from silently discarding them.
   *
   *  This does not change `status`, deliberately. An undeclared key is a fact about *this
   *  inference* — drift, a prompt regression, a resource someone forgot to update — and the
   *  deployer's own threshold for it belongs in the deployer's own code. What is not
   *  negotiable is that it does not propagate; there is no passthrough option here for the
   *  same reason there is none in ADR-0008.
   *
   *  Note, as ADR-0008 R-2 notes for recorded shapes: a key NAME is itself informative even
   *  though no value is carried. That is strictly less exposure than the value would be, and it
   *  is the minimum that makes the signal usable at all. */
  undeclared?: string[];
}

/** What a leaf must be. `integer` is distinguished because the lowering emits it for `party`. */
type Leaf = "string" | "number" | "integer";

/** The composite semantic shapes, defined once so this file and `semanticJsonSchema` describe
 *  the same objects. Kept adjacent to the lowering's own literals by the conformance test,
 *  which fails if the two ever drift. */
const COMPOSITE: Partial<Record<SemanticType, { required: Record<string, Leaf>; optional?: Record<string, Leaf> }>> = {
  money: { required: { amount: "number", currency: "string" } },
  party: { required: { adults: "integer" }, optional: { children: "integer" } },
  "date-range": { required: { from: "string", to: "string" } },
};

/** Every semantic type that lowers to a bare JSON string. `format` is an annotation in this
 *  increment and is deliberately not enforced — stated in ADR-0011 rather than assumed, so
 *  nobody reads `format: date-time` here as a checked constraint. */
const STRING_SEMANTICS: ReadonlySet<SemanticType> = new Set<SemanticType>([
  "location", "identifier", "string", "text", "date", "datetime", "time-slot",
]);

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function leafOk(v: unknown, leaf: Leaf): boolean {
  if (leaf === "string") return typeof v === "string";
  if (leaf === "number") return typeof v === "number" && Number.isFinite(v);
  return typeof v === "number" && Number.isInteger(v);
}

interface Acc {
  missing: string[];
  invalid: string[];
  degraded: string[];
  undeclared: string[];
}

function join(path: string, key: string): string {
  return path ? `${path}.${key}` : key;
}

/** A composite semantic value (money/party/date-range) — same missing/invalid/undeclared rules
 *  as an object of declared fields, one level down. */
function checkComposite(
  spec: { required: Record<string, Leaf>; optional?: Record<string, Leaf> },
  value: unknown,
  path: string,
  acc: Acc,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    acc.invalid.push(`${path}: expected object`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  let failed = false;
  for (const [key, leaf] of Object.entries(spec.required)) {
    const v = value[key];
    if (v === undefined || v === null) {
      acc.missing.push(join(path, key));
      failed = true;
      continue;
    }
    if (!leafOk(v, leaf)) {
      acc.invalid.push(`${join(path, key)}: expected ${leaf}`);
      failed = true;
      continue;
    }
    out[key] = v;
  }
  for (const [key, leaf] of Object.entries(spec.optional ?? {})) {
    const v = value[key];
    if (v === undefined || v === null) continue; // an absent optional inside a composite is not
    // a degradation of the CAPABILITY's shape — `children` absent means a party of adults.
    if (!leafOk(v, leaf)) {
      acc.invalid.push(`${join(path, key)}: expected ${leaf}`);
      failed = true;
      continue;
    }
    out[key] = v;
  }
  const declared = new Set([...Object.keys(spec.required), ...Object.keys(spec.optional ?? {})]);
  for (const key of Object.keys(value)) if (!declared.has(key)) acc.undeclared.push(join(path, key));
  return failed ? undefined : out;
}

/** One declared field against its value. Returns the value to keep, or `undefined` if the field
 *  failed (in which case `acc` already names why). */
function checkField(f: IRField, value: unknown, path: string, resources: IRResourceRegistry, acc: Acc): unknown {
  if (f.type.kind === "collection") {
    if (!Array.isArray(value)) {
      acc.invalid.push(`${path}: expected array`);
      return undefined;
    }
    const fields = resources[f.type.of] ?? [];
    const items: Record<string, unknown>[] = [];
    let failed = false;
    value.forEach((item, i) => {
      const mapped = checkObject(fields, item, `${path}[${i}]`, resources, acc);
      if (mapped === undefined) failed = true;
      else items.push(mapped);
    });
    return failed ? undefined : items;
  }

  if (f.type.kind === "list") {
    // #63 — a LIST of one scalar semantic type, distinct from `collection` (a list of a
    // RESOURCE) above. Each item goes through the SAME scalar checker a bare `f.type.kind ===
    // "scalar"` field uses below — one classifier for a value's shape, whether it arrives alone
    // or inside a list, per this file's own "one classifier" discipline elsewhere in the repo.
    if (!Array.isArray(value)) {
      acc.invalid.push(`${path}: expected array`);
      return undefined;
    }
    const listType = f.type;
    const items: unknown[] = [];
    let failed = false;
    value.forEach((item, i) => {
      const checked = checkScalar(listType.items, listType.values, item, `${path}[${i}]`, acc);
      if (checked === undefined) failed = true;
      else items.push(checked);
    });
    return failed ? undefined : items;
  }

  if (f.type.kind === "resource") {
    // `ref:` — by identity, a bare id. Never expanded, here or in the lowering (ADD-25 D-2).
    if (f.type.identity) {
      if (typeof value !== "string") {
        acc.invalid.push(`${path}: expected string`);
        return undefined;
      }
      return value;
    }
    return checkObject(resources[f.type.name] ?? [], value, path, resources, acc);
  }

  return checkScalar(f.type.semantic, f.type.values, value, path, acc);
}

/** A single scalar value against its declared semantic type — the leaf check shared by a
 *  bare `scalar` field and by each item of a `list` field (#63), so the two can never drift. */
function checkScalar(semantic: SemanticType, values: string[] | undefined, value: unknown, path: string, acc: Acc): unknown {
  if (semantic === "money") {
    // #182: the same rule `mapping.ts` applies on the way out — one function, `isMoneyShape`. A
    // present value that fails it is invalid (no repair, ADR-0011), whether the field is required or not.
    if (!isMoneyShape(value)) {
      acc.invalid.push(isPlainObject(value) ? `${path}: expected money {amount: number, currency: three uppercase letters}` : `${path}: expected object`);
      return undefined;
    }
    for (const key of Object.keys(value)) if (key !== "amount" && key !== "currency") acc.undeclared.push(join(path, key));
    return { amount: value.amount, currency: value.currency };
  }
  const composite = COMPOSITE[semantic];
  if (composite) return checkComposite(composite, value, path, acc);

  if (semantic === "preference-set") {
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string")) {
      acc.invalid.push(`${path}: expected array of string`);
      return undefined;
    }
    return value;
  }

  if (semantic === "enum") {
    // No coercion, and no tolerance for a near-miss: an out-of-set value is a violation, and the
    // message names the field and the constraint, never what the model actually said.
    if (typeof value !== "string" || !(values ?? []).includes(value)) {
      acc.invalid.push(`${path}: expected one of ${(values ?? []).length} declared enum values`);
      return undefined;
    }
    return value;
  }

  if (semantic === "quantity") {
    if (!leafOk(value, "number")) {
      acc.invalid.push(`${path}: expected number`);
      return undefined;
    }
    return value;
  }

  if (STRING_SEMANTICS.has(semantic)) {
    if (typeof value !== "string") {
      acc.invalid.push(`${path}: expected string`);
      return undefined;
    }
    return value;
  }

  /* c8 ignore next 3 -- unreachable: SemanticType is closed and every member is handled above.
     Kept as a fail-closed floor rather than a cast, so a semantic type added without extending
     this file rejects instead of silently passing anything through. */
  acc.invalid.push(`${path}: unrecognized declared type`);
  return undefined;
}

// No cycle guard here, deliberately: `validateExtraction` calls `extractionJsonSchema` first,
// which refuses a `type:`-recursive resource outright. If that call returns, the type graph
// reachable from these fields is finite and acyclic, so this recursion terminates. One
// definition of "which resources can be extracted", in one place.
function checkObject(
  fields: IRField[],
  value: unknown,
  path: string,
  resources: IRResourceRegistry,
  acc: Acc,
): Record<string, unknown> | undefined {
  if (!isPlainObject(value)) {
    acc.invalid.push(`${path || "(root)"}: expected object`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  let failed = false;
  for (const f of fields) {
    const v = value[f.name];
    if (v === undefined || v === null) {
      if (f.required) {
        acc.missing.push(join(path, f.name));
        failed = true;
      } else {
        acc.degraded.push(join(path, f.name));
      }
      continue;
    }
    const kept = checkField(f, v, join(path, f.name), resources, acc);
    if (kept === undefined) failed = true;
    else out[f.name] = kept;
  }
  const declared = new Set(fields.map((f) => f.name));
  for (const key of Object.keys(value)) if (!declared.has(key)) acc.undeclared.push(join(path, key));
  return failed ? undefined : out;
}

/**
 * Validate a model-produced document against a declared field list (ADR-0011).
 *
 * Three outcomes, the same three `applyResponseMapping` returns on the other side of the same
 * boundary: a missing **required** field is a `violation`, a missing **optional** field
 * `degrade`s, and everything else is `ok`. There is no fourth state for an undeclared key —
 * it is dropped and named, and `status` is unmoved.
 *
 * **No coercion, ever.** `"42"` for a `quantity` is a violation, not a number; there are no
 * defaults, no repair, and no re-prompt. Every one of those turns a governance boundary into a
 * heuristic, and all of them share one consequence: a repaired extraction is indistinguishable
 * downstream from a correct one. A deployer who wants a retry loop writes it around a
 * `violation`, where their policy is visible in their own code.
 *
 * Refuses exactly what `extractionJsonSchema` refuses, by asking it — an unknown resource name
 * or a `type:`-recursive resource throws `ExtractionSchemaError` from here too. The alternative
 * is a second, independently-maintained definition of "which resources can be extracted", which
 * is precisely the drift this file exists to avoid.
 */
export function validateExtraction(
  fields: IRField[],
  document: unknown,
  resources: IRResourceRegistry = {},
): ExtractionResult {
  extractionJsonSchema(fields, resources); // refusal set defined once; the schema itself is the
  // consumer's to fetch when they want it, not this function's to return.

  const acc: Acc = { missing: [], invalid: [], degraded: [], undeclared: [] };
  const data = checkObject(fields, document, "", resources, acc);

  const violated = acc.missing.length > 0 || acc.invalid.length > 0;
  const result: ExtractionResult = {
    status: violated ? "violation" : acc.degraded.length > 0 ? "degraded" : "ok",
  };
  if (!violated && data !== undefined) result.data = data;
  if (acc.missing.length > 0) result.missing = acc.missing;
  if (acc.invalid.length > 0) result.invalid = acc.invalid;
  if (acc.degraded.length > 0) result.degraded = acc.degraded;
  if (acc.undeclared.length > 0) result.undeclared = acc.undeclared;
  return result;
}
