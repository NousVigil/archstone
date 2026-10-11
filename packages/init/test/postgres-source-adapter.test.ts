import { describe, it, expect } from "vitest";
import { postgresAdapter, REASON_CODES, valueOrUndefined, type CatalogSnapshot, type DraftOperation } from "@archstone/init";
import { quoteIdent, renderSelect } from "../src/adapters/postgres/render";
import { assertAdapterConformance } from "./conformance";
import { REPORTING_CATALOG, reportingDraft } from "./pg-catalog";

// ADR-0012 D-10 — the Postgres `SourceAdapter`: pure, one candidate per relation, over a catalog
// snapshot the host already read.

const op = (key: string): DraftOperation => {
  const found = reportingDraft().operations.find((o) => o.key === key);
  if (!found) throw new Error(`no candidate ${key}`);
  return found;
};

describe("the shared SourceAdapter conformance suite", () => {
  it("passes, with and without a catalog", () => {
    assertAdapterConformance(postgresAdapter, [
      { origin: "pg", catalog: REPORTING_CATALOG, dsnEnvVar: "REPORTING_DSN" },
      { origin: "empty catalog", catalog: { relations: [], deferred: [] }, dsnEnvVar: "REPORTING_DSN" },
      { origin: "no catalog", dsnEnvVar: "REPORTING_DSN" },
      { origin: "no variable name", catalog: REPORTING_CATALOG },
    ]);
  });

  it("is pure and deterministic: the same snapshot yields the same model", () => {
    expect(reportingDraft()).toEqual(reportingDraft());
  });
});

describe("one candidate per relation", () => {
  it("keys each as `SELECT <schema>.<relation>` and never merges or splits them", () => {
    const draft = reportingDraft();
    expect(draft.operations.map((o) => [o.key, o.method, o.path])).toEqual([
      ["SELECT app.positions_v", "SELECT", "app.positions_v"],
      ["SELECT app.accounts", "SELECT", "app.accounts"],
      ["SELECT app.blobs", "SELECT", "app.blobs"],
      ['SELECT Odd"Schema.we"ird', "SELECT", 'Odd"Schema.we"ird'],
    ]);
    expect(draft.source).toEqual({ adapter: "postgres", origin: "postgres catalog via REPORTING_DSN" });
    expect(draft.sql).toEqual({ engine: "postgres", dsnEnvVar: "REPORTING_DSN" });
    expect(draft.baseUrl.derivation).toBe("absent");
  });

  it("states the relation, and the effect only as a labelled guess", () => {
    const view = op("SELECT app.positions_v");
    expect(view.sql?.relation).toEqual({ schema: "app", name: "positions_v", kind: "view" });
    expect(view.effectHint).toMatchObject({ value: "read", derivation: "heuristic" });
    expect(view.input).toEqual([]);
  });

  it("describes each row from the catalog: declared type, declared required-ness, declared nullability", () => {
    const accounts = op("SELECT app.accounts");
    expect(accounts.response.kind).toBe("array");
    if (accounts.response.kind !== "array" || accounts.response.items.kind !== "object") throw new Error("expected an array of objects");
    const byName = Object.fromEntries(accounts.response.items.properties.map((p) => [p.name, p]));
    expect(Object.keys(byName)).toEqual(["id", "name", "balance", "active", "opened_at"]);
    expect(byName["id"]).toMatchObject({ declaredRequired: { derivation: "declared", value: true } });
    expect(byName["id"]!.node).toMatchObject({ kind: "scalar", type: { value: "identifier", source: "app.accounts.id" }, nullable: { value: false } });
    expect(byName["balance"]).toMatchObject({ declaredRequired: { value: false } });
    expect(byName["balance"]!.node).toMatchObject({ type: { value: "string" }, nullable: { value: true } });
    expect(byName["active"]!.node).toMatchObject({ type: { value: "boolean" } });
    expect(byName["opened_at"]!.node).toMatchObject({ type: { value: "datetime" } });
    expect(accounts.response.items.name).toMatchObject({ derivation: "declared", value: "accounts" });
  });
});

describe("columns with no CDL type are left out, per column, and said so", () => {
  it("json, jsonb and array columns raise column-type-not-expressible and never reach the select", () => {
    const accounts = op("SELECT app.accounts");
    expect(accounts.notes.filter((n) => n.code === "column-type-not-expressible").map((n) => [n.scope, n.target])).toEqual([
      ["field", "SELECT app.accounts#meta"],
      ["field", "SELECT app.accounts#tags"],
    ]);
    expect(accounts.sql!.select).toBe('SELECT "id", "name", "balance", "active", "opened_at"\nFROM "app"."accounts"');
    // The candidate itself is still offered.
    expect(accounts.notes.some((n) => REASON_CODES[n.code].skipsOperation)).toBe(false);
  });

  it("boolean is expressible", () => {
    expect(op("SELECT app.accounts").notes.map((n) => n.target)).not.toContain("SELECT app.accounts#active");
  });

  it("a relation with no expressible column is skipped with no-expressible-columns, and carries no sql source", () => {
    const blobs = op("SELECT app.blobs");
    expect(blobs.notes.map((n) => n.code)).toEqual(["column-type-not-expressible", "column-type-not-expressible", "no-expressible-columns"]);
    expect(REASON_CODES["no-expressible-columns"].skipsOperation).toBe(true);
    expect(blobs.sql).toBeUndefined();
    expect(blobs.response).toEqual({ kind: "unknown" });
  });

  it("a column no JSONPath can address is left out of the select, with the existing field-scope code", () => {
    const weird = op('SELECT Odd"Schema.we"ird');
    expect(weird.notes.map((n) => [n.code, n.target])).toEqual([["field-path-not-expressible", `SELECT Odd"Schema.we"ird#it's`]]);
    expect(weird.sql!.select).toBe('SELECT "a""b", "has space"\nFROM "Odd""Schema"."we""ird"');
  });
});

describe("lookup columns and the suggested key", () => {
  it("offers a single-column key as the suggestion, and a view none", () => {
    expect(op("SELECT app.accounts").sql!.keyColumns).toEqual(["id"]);
    expect(op("SELECT app.positions_v").sql!.keyColumns).toEqual([]);
  });

  it("offers each selectable column with a legal name and a scalar type as a bound parameter", () => {
    const view = op("SELECT app.positions_v").sql!;
    expect(view.lookupColumns.map((c) => c.field.name)).toEqual(["tenant_id", "id", "label", "qty"]);
    const id = view.lookupColumns.find((c) => c.field.name === "id")!;
    expect(id.field.in).toBe("param");
    expect(valueOrUndefined(id.field.type)).toBe("quantity");
    expect(valueOrUndefined(id.field.required)).toBe(true);
    expect(id.predicate).toBe('"id" = $1');
    // `has space` and `a"b` are not legal field names; they are selected but cannot be keyed on.
    const weird = op('SELECT Odd"Schema.we"ird').sql!;
    expect(weird.lookupColumns).toEqual([]);
    expect(weird.keyColumns).toEqual([]);
  });

  it("does not suggest a key the candidate cannot look up by", () => {
    const catalog: CatalogSnapshot = {
      relations: [{ schema: "s", name: "t", kind: "table", keyColumns: ["a b"], columns: [{ name: "a b", dataType: "integer", isNullable: "NO" }, { name: "v", dataType: "text", isNullable: "YES" }] }],
      deferred: [],
    };
    expect(reportingDraft(catalog).operations[0]!.sql!.keyColumns).toEqual([]);
  });
});

describe("quoting", () => {
  it("doubles every double quote, and quotes always", () => {
    expect(quoteIdent("plain")).toBe('"plain"');
    expect(quoteIdent('a"b"')).toBe('"a""b"""');
    expect(quoteIdent("Mixed Case")).toBe('"Mixed Case"');
    expect(renderSelect("s", "r", ["x", 'y"'])).toBe('SELECT "x", "y"""\nFROM "s"."r"');
  });

  it("leaves out a name with a control character instead of escaping it", () => {
    const catalog: CatalogSnapshot = {
      relations: [
        { schema: "s", name: "t", kind: "table", keyColumns: [], columns: [{ name: "ok", dataType: "text", isNullable: "NO" }, { name: "bad\ncol", dataType: "text", isNullable: "NO" }] },
        { schema: "s", name: "line\nbreak", kind: "table", keyColumns: [], columns: [{ name: "ok", dataType: "text", isNullable: "NO" }] },
      ],
      deferred: [],
    };
    const [t, broken] = reportingDraft(catalog).operations;
    expect(t!.sql!.select).toBe('SELECT "ok"\nFROM "s"."t"');
    expect(t!.notes.map((n) => n.code)).toEqual(["column-type-not-expressible"]);
    expect(broken!.notes.map((n) => n.code)).toEqual(["unsupported-connector"]);
    expect(broken!.sql).toBeUndefined();
  });
});

describe("what the adapter does not propose", () => {
  it("reports a foreign table as a manifest note and never as a candidate", () => {
    const draft = reportingDraft();
    expect(draft.notes).toEqual([
      expect.objectContaining({ code: "foreign-table-deferred", scope: "manifest", target: "app.remote_things" }),
    ]);
    expect(draft.operations.map((o) => o.path)).not.toContain("app.remote_things");
    expect(REASON_CODES["foreign-table-deferred"].skipsOperation).toBe(false);
  });

  it("proposes nothing it was not handed: a name absent from the snapshot appears nowhere in the model", () => {
    const text = JSON.stringify(reportingDraft({ relations: [REPORTING_CATALOG.relations[0]!], deferred: [] }));
    expect(text).not.toMatch(/accounts|blobs|Odd|remote_things/);
  });

  it("without a catalog, or without a variable NAME, it returns notes and no candidates — and never echoes a connection string", () => {
    expect(postgresAdapter.adapt({ origin: "x" }).notes.map((n) => n.code)).toEqual(["unsupported-operation-shape"]);
    const secret = "postgres://role:hunter2@db.internal/app";
    const draft = postgresAdapter.adapt({ origin: "x", catalog: REPORTING_CATALOG, dsnEnvVar: secret });
    expect(draft.operations).toEqual([]);
    expect(draft.sql).toBeUndefined();
    expect(JSON.stringify(draft)).not.toContain("hunter2");
  });
});

describe("reason codes", () => {
  it("registers the five new codes with the dispositions the ADR gives them", () => {
    expect(REASON_CODES["column-type-not-expressible"].skipsOperation).toBe(false);
    expect(REASON_CODES["no-expressible-columns"].skipsOperation).toBe(true);
    expect(REASON_CODES["foreign-table-deferred"].skipsOperation).toBe(false);
    expect(REASON_CODES["unknown-lookup-column"].skipsOperation).toBe(true);
    expect(REASON_CODES["list-has-no-isolation-test"].skipsOperation).toBe(false);
  });
});
