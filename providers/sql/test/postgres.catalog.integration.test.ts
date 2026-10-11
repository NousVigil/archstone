// `introspectCatalog` against a REAL Postgres (ADR-0012 D-10; issue #87): the catalog read is scoped
// to what the runtime role can actually SELECT, in the query itself, and an over-privileged
// connection is refused with D-9's message before anything is read.
//
// Skipped locally unless ARCHSTONE_TEST_PG_URL is set, and a failure (never a skip) in CI — see
// CONTRIBUTING.md.

import { afterAll, beforeAll, expect, it } from "vitest";
import { introspectCatalog, type CatalogRelation, type CatalogSnapshot, type ConnectionEntry } from "../src/index";
import { createPgFixture, describePostgres, endPools, DSN_VARS, type PgFixture } from "./support/postgres";

describePostgres("introspectCatalog against a real Postgres", () => {
  let fx: PgFixture;
  const registries: Map<string, ConnectionEntry>[] = [];

  async function read(dsnVar: string) {
    const connectionRegistry = new Map<string, ConnectionEntry>();
    registries.push(connectionRegistry);
    return introspectCatalog(dsnVar, fx.env[dsnVar]!, { connectionRegistry });
  }

  async function snapshot(): Promise<CatalogSnapshot> {
    const result = await read(DSN_VARS.runtime);
    if (!result.ok) throw new Error(result.error);
    return result.snapshot;
  }

  const relation = (s: CatalogSnapshot, schema: string, name: string): CatalogRelation | undefined =>
    s.relations.find((r) => r.schema === schema && r.name === name);

  beforeAll(async () => {
    fx = await createPgFixture();
    const runtime = fx.env[DSN_VARS.runtime]!;
    const role = decodeURIComponent(new URL(runtime).username);
    await fx.admin(`
      -- A schema the role holds NO usage on, with a table it nonetheless holds SELECT on.
      CREATE SCHEMA sealed;
      CREATE TABLE sealed.secrets (id int4 PRIMARY KEY, token text);
      GRANT SELECT ON sealed.secrets TO ${role};

      -- A column-level grant: two of three columns.
      CREATE TABLE app.partial (a int4 PRIMARY KEY, b text, hidden text);
      GRANT SELECT (a, b) ON app.partial TO ${role};
      -- A table the role has no privilege on at all, and one it holds only a column-less privilege on.
      CREATE TABLE app.nothing (id int4);
      CREATE TABLE app.insert_only (id int4);
      GRANT INSERT ON app.insert_only TO ${role};
      -- A table readable through PUBLIC.
      CREATE TABLE app.everyone (id int4 PRIMARY KEY);
      GRANT SELECT ON app.everyone TO PUBLIC;

      CREATE MATERIALIZED VIEW app.summary AS SELECT 1 AS n, label FROM app.holdings;
      GRANT SELECT ON app.summary TO ${role};

      CREATE TABLE app.events (id int4, at timestamptz NOT NULL) PARTITION BY RANGE (at);
      CREATE TABLE app.events_2026 PARTITION OF app.events FOR VALUES FROM ('2026-01-01') TO ('2027-01-01');
      GRANT SELECT ON app.events, app.events_2026 TO ${role};

      CREATE EXTENSION postgres_fdw;
      CREATE SERVER elsewhere FOREIGN DATA WRAPPER postgres_fdw OPTIONS (host 'localhost', dbname 'nowhere');
      CREATE FOREIGN TABLE app.remote_things (id int4) SERVER elsewhere;
      GRANT SELECT ON app.remote_things TO ${role};
      -- Another foreign table, with no grant: not even deferred.
      CREATE FOREIGN TABLE app.remote_private (id int4) SERVER elsewhere;

      CREATE DOMAIN app.short_name AS varchar(20);
      CREATE TYPE app.mood AS ENUM ('ok', 'bad');
      CREATE TABLE app.kinds (
        id int4 PRIMARY KEY, name app.short_name NOT NULL, label varchar(40), amount numeric(10,2), at timestamp,
        tags text[], doc jsonb, raw json, feeling app.mood, flag boolean, big bigint, ratio double precision, born date, uid uuid
      );
      GRANT SELECT ON app.kinds TO ${role};
      -- Composite primary key: no key is offered.
      CREATE TABLE app.pairs (a int4, b int4, PRIMARY KEY (a, b));
      GRANT SELECT ON app.pairs TO ${role};
    `);
  }, 60_000);

  afterAll(async () => {
    for (const r of registries) await endPools(r);
    await fx?.teardown();
  }, 60_000);

  it("proposes what the runtime role can SELECT, with the columns and the key", async () => {
    const s = await snapshot();
    expect(relation(s, "app", "holdings")).toMatchObject({ kind: "table", keyColumns: ["id"] });
    expect(relation(s, "app", "holdings")!.columns.map((c) => c.name)).toEqual(["id", "tenant_id", "label", "amount", "big", "qty", "as_of", "trade_date", "active", "note"]);
    expect(relation(s, "app", "holdings")!.columns.find((c) => c.name === "note")).toEqual({ name: "note", dataType: "text", isNullable: "YES" });
    expect(relation(s, "app", "holdings")!.columns.find((c) => c.name === "label")).toEqual({ name: "label", dataType: "text", isNullable: "NO" });
    expect(relation(s, "app", "positions_v")).toMatchObject({ kind: "view", keyColumns: [] });
    expect(relation(s, "app", "positions_v")!.columns.map((c) => c.name)).toEqual(["tenant_id", "id", "label", "qty"]);
    expect(relation(s, "app", "summary")).toMatchObject({ kind: "materialized_view" });
    expect(relation(s, "app", "everyone")).toMatchObject({ kind: "table", keyColumns: ["id"] });
    // Readable through PUBLIC: the fixture grants SELECT on app.owned_public to PUBLIC.
    expect(relation(s, "app", "owned_public")).toMatchObject({ kind: "table" });
  });

  it("proposes nothing the role cannot SELECT, and names none of it anywhere in the snapshot", async () => {
    const s = await snapshot();
    const text = JSON.stringify(s);
    // No USAGE on the schema, although SELECT was granted on its table.
    expect(relation(s, "sealed", "secrets")).toBeUndefined();
    expect(text).not.toMatch(/sealed|secrets|token/);
    // The base table behind the curated view, and the tables with no grant.
    expect(relation(s, "app", "positions")).toBeUndefined();
    expect(text).not.toMatch(/internal_cost|"positions"|owned_by_owner|owned_no_grant|scratch|r7_owned|"nothing"|insert_only|remote_private/);
  });

  it("returns only the granted columns of a column-level grant", async () => {
    const s = await snapshot();
    expect(relation(s, "app", "partial")!.columns.map((c) => c.name)).toEqual(["a", "b"]);
    expect(JSON.stringify(s)).not.toContain("hidden");
    expect(relation(s, "app", "partial")!.keyColumns).toEqual(["a"]);
  });

  it("offers no key when the key column cannot be selected, nor a composite key", async () => {
    await fx.admin(`CREATE TABLE app.keyless_grant (id int4 PRIMARY KEY, v text); GRANT SELECT (v) ON app.keyless_grant TO ${decodeURIComponent(new URL(fx.env[DSN_VARS.runtime]!).username)}`);
    const s = await snapshot();
    expect(relation(s, "app", "keyless_grant")).toMatchObject({ keyColumns: [], columns: [{ name: "v" }] });
    expect(relation(s, "app", "pairs")!.keyColumns).toEqual([]);
  });

  it("folds a partition into its parent, and defers a foreign table", async () => {
    const s = await snapshot();
    expect(relation(s, "app", "events")).toMatchObject({ kind: "partitioned_table" });
    expect(relation(s, "app", "events_2026")).toBeUndefined();
    expect(relation(s, "app", "remote_things")).toBeUndefined();
    expect(s.deferred).toEqual([{ schema: "app", name: "remote_things", kind: "foreign_table" }]);
  });

  it("reports types in information_schema's vocabulary, domains as their base type", async () => {
    const s = await snapshot();
    const types = Object.fromEntries(relation(s, "app", "kinds")!.columns.map((c) => [c.name, c.dataType]));
    expect(types).toEqual({
      id: "integer",
      name: "character varying",
      label: "character varying",
      amount: "numeric",
      at: "timestamp without time zone",
      tags: "ARRAY",
      doc: "jsonb",
      raw: "json",
      feeling: "USER-DEFINED",
      flag: "boolean",
      big: "bigint",
      ratio: "double precision",
      born: "date",
      uid: "uuid",
    });
    // And those are exactly what information_schema says for the same columns.
    const reference = await fx.admin(`SELECT column_name, data_type FROM information_schema.columns WHERE table_schema = 'app' AND table_name = 'kinds'`);
    expect(Object.fromEntries(reference.rows.map((r: { column_name: string; data_type: string }) => [r.column_name, r.data_type]))).toEqual(types);
  });

  it("refuses an over-privileged connection with D-9's message and reads nothing", async () => {
    const cases: Array<[keyof typeof DSN_VARS, RegExp]> = [
      ["ownerWithGrant", /owns app\.owned_by_owner, which it also holds a grant on/],
      ["superuser", /rolsuper = true/],
      ["bypassrls", /rolbypassrls = true/],
    ];
    for (const [key, message] of cases) {
      if (!fx.created[key]) continue;
      const result = await read(DSN_VARS[key]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatch(message);
        expect(result.error).toMatch(/see the topology guide$/);
        expect(result.incomplete).toBeUndefined();
      }
    }
  });
});
