// A catalog snapshot as the host would hand it to the Postgres adapter, and the Draft Model and
// Decision Record the adapter and emitter tests share. Hand-written: nothing here opens a socket.

import { postgresAdapter, type CatalogColumn, type CatalogSnapshot, type DecisionRecord, type DraftModel } from "@archstone/init";

const col = (name: string, dataType: string, isNullable: "YES" | "NO" = "YES"): CatalogColumn => ({ name, dataType, isNullable });

export const REPORTING_CATALOG: CatalogSnapshot = {
  relations: [
    // A curated view, as in the sql-reporting example: it has no key the catalog can name.
    {
      schema: "app",
      name: "positions_v",
      kind: "view",
      keyColumns: [],
      columns: [col("tenant_id", "text"), col("id", "integer"), col("label", "text"), col("qty", "integer")],
    },
    // A table with a single-column key, a boolean, and two columns with no CDL type.
    {
      schema: "app",
      name: "accounts",
      kind: "table",
      keyColumns: ["id"],
      columns: [
        col("id", "uuid", "NO"),
        col("name", "character varying", "NO"),
        col("balance", "numeric"),
        col("active", "boolean", "NO"),
        col("meta", "jsonb"),
        col("tags", "ARRAY"),
        col("opened_at", "timestamp with time zone", "NO"),
      ],
    },
    // Nothing a capability could carry: every column is json or an array.
    { schema: "app", name: "blobs", kind: "table", keyColumns: [], columns: [col("doc", "jsonb", "NO"), col("tags", "ARRAY")] },
    // Identifiers that need quoting, and a column that can be neither keyed on nor addressed.
    {
      schema: 'Odd"Schema',
      name: 'we"ird',
      kind: "table",
      keyColumns: [],
      columns: [col('a"b', "text", "NO"), col("has space", "text"), col("it's", "text")],
    },
  ],
  deferred: [{ schema: "app", name: "remote_things", kind: "foreign_table" }],
};

export function reportingDraft(catalog: CatalogSnapshot = REPORTING_CATALOG): DraftModel {
  return postgresAdapter.adapt({ origin: "postgres catalog via REPORTING_DSN", catalog, dsnEnvVar: "REPORTING_DSN" });
}

export function reportingDecisions(overrides: Partial<DecisionRecord> = {}): DecisionRecord {
  return {
    version: "0",
    company: { id: "harborline", name: "Harborline Capital" },
    decisions: [
      { operation: "SELECT app.positions_v", keep: true, capabilityId: "reporting.get-position", effect: "read", lookupColumn: "id", resourceName: "Position" },
      { operation: "SELECT app.accounts", keep: true, capabilityId: "reporting.list-accounts", effect: "read", resourceName: "Account" },
    ],
    ...overrides,
  };
}
