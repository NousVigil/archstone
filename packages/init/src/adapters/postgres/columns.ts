// @archstone/init — Postgres adapter, column → CDL semantic type (ADR-0012 D-10)
//
// Pure, mechanical mapping from `information_schema.columns.data_type` ground truth to CDL's
// closed `SemanticType` set — no guessing, no LLM. `cdl.schema.json`'s semantic types
// (`location`, `date-range`, `party`, `preference-set`, `money`, `identifier`, `string`, `text`,
// `time-slot`, `quantity`, `enum`, `date`, `datetime`, `boolean`) have no faithful member for a
// Postgres `json`/`jsonb` or array column (a `boolean` column maps to `boolean`) — this is a TOOL limitation, not a CDL gap (D-10),
// and is reported with the reason code `column-type-not-expressible` rather than guessed around,
// mirroring internal ADD-37's own precedent for an unmappable OpenAPI construct
// (`field-path-not-expressible`).
//
// PURE: no fs, no network, no clock. The live `information_schema` query itself is issued by
// the HOST (through `invokeConnector`/`invokeSql`, ADR-0012 D-10's "reuses invokeConnector, not
// a bespoke ad-hoc pg client") — this module only decides what a already-observed column NAME
// means, exactly the same "adapters are pure, the host does the I/O" split `SourceAdapter`
// already establishes for the OpenAPI adapter (D-11's reference-fetching precedent).

import type { SemanticType } from "@archstone/compiler";

export const COLUMN_TYPE_NOT_EXPRESSIBLE = "column-type-not-expressible" as const;

export interface ColumnMapped {
  ok: true;
  type: SemanticType;
}

export interface ColumnSkipped {
  ok: false;
  reasonCode: typeof COLUMN_TYPE_NOT_EXPRESSIBLE;
  detail: string;
}

export type ColumnMapping = ColumnMapped | ColumnSkipped;

/** Postgres `information_schema.columns.data_type` values with no expressible CDL semantic
 *  type (D-10) — raw JSON, and every array form (`data_type` is literally `"ARRAY"`
 *  for any array column; the element type lives in a separate catalog column this function
 *  never needs, because the whole column is skipped regardless of its element type). */
const INEXPRESSIBLE = new Set(["json", "jsonb", "array"]);

/**
 * Map one Postgres column's declared type to a CDL semantic type, from `information_schema`
 * ground truth — never a spec's possibly-stale declaration (there is no spec here; the catalog
 * IS the source of truth, which is why D-10 calls this "more reliable than the OpenAPI
 * adapter's declared/observed distinction").
 */
export function mapColumnType(pgDataType: string, columnName: string): ColumnMapping {
  const normalized = pgDataType.toLowerCase();
  if (INEXPRESSIBLE.has(normalized)) {
    return {
      ok: false,
      reasonCode: COLUMN_TYPE_NOT_EXPRESSIBLE,
      detail: `column '${columnName}' has Postgres type '${pgDataType}', which has no expressible CDL semantic type — skipped, not guessed`,
    };
  }
  if (/^(timestamp|timestamptz)/.test(normalized)) return { ok: true, type: "datetime" };
  if (normalized === "date") return { ok: true, type: "date" };
  if (["integer", "bigint", "smallint", "numeric", "real", "double precision", "decimal"].includes(normalized)) {
    return { ok: true, type: "quantity" };
  }
  if (normalized === "uuid") return { ok: true, type: "identifier" };
  if (normalized === "boolean") return { ok: true, type: "boolean" };
  // Every remaining textual type (`text`, `character varying`, `character`, `citext`, …)
  // defaults to CDL `string` — the same defensive default `compiler/src/compile.ts`'s
  // `lowerType` already applies for an unrecognized shape.
  return { ok: true, type: "string" };
}

/** D-10 / BR-19: `is_nullable = 'NO'` directly names required-ness — no probing needed, unlike
 *  the OpenAPI adapter's declared/observed distinction (the catalog already IS the ground
 *  truth). */
export function isRequiredColumn(isNullable: "YES" | "NO" | string): boolean {
  return isNullable === "NO";
}
