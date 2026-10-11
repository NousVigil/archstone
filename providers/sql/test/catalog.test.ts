import { describe, expect, it } from "vitest";
import { introspectCatalog, type ConnectionEntry, type PgPool, type PgPoolClient } from "../src/index";

// `introspectCatalog` against a fake pool: what it sends and in what order, how it groups rows, and
// that a refusal or a failure ends the call without a catalog read. The privilege scoping itself
// lives in the query and is proven against a real Postgres (postgres.catalog.integration.test.ts).

type Row = Record<string, unknown>;

function fakePool(opts: { role?: Row; catalog?: Row[]; failOn?: RegExp; ownership?: Row[] }): { pool: PgPool; sent: string[] } {
  const sent: string[] = [];
  const client: PgPoolClient = {
    async query(text: string) {
      sent.push(text.split("\n")[0]!.trim());
      if (opts.failOn?.test(text)) throw Object.assign(new Error("boom"), { code: "42501" });
      if (text.includes("pg_postmaster_start_time")) {
        return { rows: [{ rolsuper: false, rolbypassrls: false, server_started: "2026-10-12T00:00:00.000000", database_oid: 1, ...opts.role }] };
      }
      if (text.includes("role_table_grants")) return { rows: opts.ownership ?? [] };
      if (text.includes("has_schema_privilege")) return { rows: opts.catalog ?? [] };
      return { rows: [] };
    },
    release() {},
  };
  return { pool: { connect: async () => client }, sent };
}

const row = (schema: string, name: string, relkind: string, column: string, dataType: string, isNullable: "YES" | "NO", key: string | null = null): Row => ({
  schema_name: schema,
  relation_name: name,
  relkind,
  column_name: column,
  data_type: dataType,
  is_nullable: isNullable,
  key_column: key,
});

function run(pool: PgPool) {
  const connectionRegistry = new Map<string, ConnectionEntry>();
  return introspectCatalog("CATALOG_DSN", "postgres://role:pw@db.test/app", { pgPoolFactory: () => pool, connectionRegistry });
}

describe("introspectCatalog", () => {
  it("reads in a READ ONLY transaction, after the D-9 checks, with one constant catalog query", async () => {
    const { pool, sent } = fakePool({ catalog: [] });
    const result = await run(pool);
    expect(result).toEqual({ ok: true, snapshot: { relations: [], deferred: [] } });
    expect(sent[0]).toBe("BEGIN");
    expect(sent[1]).toBe("SET TRANSACTION READ ONLY");
    expect(sent.findIndex((s) => s.startsWith("SELECT n.nspname"))).toBeGreaterThan(sent.findIndex((s) => s.startsWith("SELECT rolsuper")));
    expect(sent.at(-1)).toBe("COMMIT");
  });

  it("groups rows into relations in column order, keeps the key, and defers foreign tables", async () => {
    const { pool } = fakePool({
      catalog: [
        row("app", "orders", "r", "id", "integer", "NO", "id"),
        row("app", "orders", "r", "note", "text", "YES", "id"),
        row("app", "feed", "f", "a", "integer", "YES"),
        row("app", "recent", "m", "id", "integer", "YES"),
        row("app", "v", "v", "x", "text", "YES"),
        row("app", "wide", "p", "k", "uuid", "NO", "k"),
      ],
    });
    const result = await run(pool);
    if (!result.ok) throw new Error(result.error);
    expect(result.snapshot.relations.map((r) => [r.name, r.kind, r.keyColumns, r.columns.map((c) => c.name)])).toEqual([
      ["orders", "table", ["id"], ["id", "note"]],
      ["recent", "materialized_view", [], ["id"]],
      ["v", "view", [], ["x"]],
      ["wide", "partitioned_table", ["k"], ["k"]],
    ]);
    expect(result.snapshot.deferred).toEqual([{ schema: "app", name: "feed", kind: "foreign_table" }]);
    expect(result.snapshot.relations[0]!.columns[0]).toEqual({ name: "id", dataType: "integer", isNullable: "NO" });
  });

  it("refuses an over-privileged role with D-9's message and reads no catalog", async () => {
    const { pool, sent } = fakePool({ role: { rolsuper: true }, catalog: [row("app", "t", "r", "id", "integer", "NO")] });
    const result = await run(pool);
    expect(result).toEqual({
      ok: false,
      error: "connection for 'CATALOG_DSN' uses a role with rolsuper = true; the runtime role must not be a superuser — see the topology guide",
    });
    expect(sent.some((s) => s.startsWith("SELECT n.nspname"))).toBe(false);
    expect(sent.at(-1)).toBe("ROLLBACK");
  });

  it("refuses a role that owns a relation it can read (layer 4)", async () => {
    const { pool } = fakePool({ ownership: [{ schema_name: "app", relation_name: "mine" }] });
    const result = await run(pool);
    expect(result).toMatchObject({ ok: false });
    expect(!result.ok && result.error).toMatch(/owns app\.mine/);
    expect(!result.ok && result.incomplete).toBeUndefined();
  });

  it("marks a read that reached no verdict as incomplete, without echoing the driver or the dsn", async () => {
    const { pool } = fakePool({ failOn: /has_schema_privilege/ });
    const result = await run(pool);
    expect(result).toEqual({ ok: false, error: "catalog read failed (SQLSTATE 42501)", incomplete: true });
  });
});
