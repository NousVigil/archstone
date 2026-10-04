// Real-Postgres fixture for the `*.integration.test.ts` suites (ADR-0012 D-3/D-4/D-7/D-9).
//
// Gated on ARCHSTONE_TEST_PG_URL: an ADMIN url (superuser in CI and in the documented local
// container) used ONLY here, to create and drop the fixture. No provider call ever runs as it —
// every invocation goes through a per-role DSN handed to the provider as `${ENV_VAR}`, exactly as
// a deployment would. Unset, the suites are `describe.skip`ped and `pnpm test` stays offline.
//
// Isolation per run: a fresh database `archstone_it_<suffix>` and roles `archstone_it_<suffix>_*`
// (roles are cluster-global, hence the suffix). `teardown()` drops both, so a failed run leaves
// nothing a re-run could trip over, and two concurrent runs never share state.
//
// Lives under providers/sql because this is the package that owns `pg` — `@archstone/runtime`'s
// verify suite imports it by relative path rather than gaining a `pg` dependency of its own.

import { randomBytes } from "node:crypto";
import { describe } from "vitest";
import pg from "pg";
import type { ConnectionEntry } from "../../src/index";

export const ADMIN_URL = process.env.ARCHSTONE_TEST_PG_URL;

/** `describe` when a database is configured; otherwise `describe.skip`, with the reason in the
 *  suite name so the skip explains itself in the reporter output. */
export function describePostgres(name: string, fn: () => void): void {
  if (ADMIN_URL) describe(name, fn);
  else describe.skip(`${name} [skipped: set ARCHSTONE_TEST_PG_URL to run against a real Postgres]`, fn);
}

/** The env-var names each role's DSN is published under — the bindings reference these as
 *  `dsn: "${…}"`, the production shape. */
export const DSN_VARS = {
  runtime: "IT_RUNTIME_DSN", // least privilege: LOGIN, SELECT grants only, owns nothing, no BYPASSRLS
  superuser: "IT_SUPERUSER_DSN",
  bypassrls: "IT_BYPASSRLS_DSN",
  ownerWithGrant: "IT_OWNER_DSN", // owns app.owned_by_owner (owner's implicit privileges intact)
  ownerNoGrant: "IT_OWNER_NO_GRANT_DSN", // owns app.owned_no_grant, then REVOKE ALL from itself (EC-8a)
  writer: "IT_WRITER_DSN", // SELECT + INSERT on app.scratch only — to prove READ ONLY, not missing privilege, blocks a write
} as const;

export type RoleKey = keyof typeof DSN_VARS;

export interface PgFixture {
  database: string;
  /** `{ IT_RUNTIME_DSN: "postgres://…", … }` — pass as `opts.env`. A role the admin cannot
   *  create (superuser / BYPASSRLS without superuser rights) is absent. */
  env: Record<string, string>;
  /** Which privileged roles could actually be created with the admin's own rights. */
  created: Record<RoleKey, boolean>;
  /** Run SQL as the admin, inside the fixture database. */
  admin(sql: string, params?: unknown[]): Promise<pg.QueryResult>;
  teardown(): Promise<void>;
}

/** Ids are stable so tests can name rows; `tenant_id` is what the RLS policy compares. */
export const SEED = {
  acme: [
    { id: 1, label: "acme-alpha" },
    { id: 2, label: "acme-beta" },
  ],
  beta: [
    { id: 3, label: "beta-alpha" },
    { id: 4, label: "beta-beta" },
    { id: 5, label: "beta-gamma" },
  ],
} as const;

function dsnFor(adminUrl: string, database: string, user: string, password: string): string {
  const u = new URL(adminUrl);
  u.username = encodeURIComponent(user);
  u.password = encodeURIComponent(password);
  u.pathname = `/${database}`;
  return u.toString();
}

function quoteLiteral(s: string): string {
  return `'${s.replace(/'/g, "''")}'`;
}

export async function createPgFixture(): Promise<PgFixture> {
  if (!ADMIN_URL) throw new Error("createPgFixture called without ARCHSTONE_TEST_PG_URL");
  const suffix = randomBytes(4).toString("hex");
  const database = `archstone_it_${suffix}`;
  const role = (k: string) => `archstone_it_${suffix}_${k}`;
  const password = randomBytes(12).toString("hex");

  const server = new pg.Client({ connectionString: ADMIN_URL });
  await server.connect();
  const me = (await server.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user")).rows[0] as {
    rolsuper: boolean;
    rolbypassrls: boolean;
  };
  const roleNames = {
    runtime: role("runtime"),
    superuser: role("super"),
    bypassrls: role("bypass"),
    ownerWithGrant: role("owner"),
    ownerNoGrant: role("owner_ng"),
    writer: role("writer"),
  } satisfies Record<RoleKey, string>;
  const created: Record<RoleKey, boolean> = {
    runtime: true,
    superuser: me.rolsuper,
    bypassrls: me.rolsuper || me.rolbypassrls,
    ownerWithGrant: true,
    ownerNoGrant: true,
    writer: true,
  };

  let db: pg.Client | undefined;
  const teardown = async () => {
    await db?.end().catch(() => undefined);
    // Not `WITH (FORCE)` first: `pg.Pool#end()` resolves before its sockets have closed, and a
    // forced drop terminates those backends under clients that no longer listen for errors —
    // an unhandled 57P01 in the test worker. Wait for them to go instead; force only as a last
    // resort so a leaked connection can never leave the database behind.
    for (let attempt = 0; ; attempt++) {
      try {
        await server.query(`DROP DATABASE IF EXISTS ${database}`);
        break;
      } catch (err) {
        if ((err as { code?: string }).code !== "55006" || attempt >= 50) {
          await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
          break;
        }
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    for (const name of Object.values(roleNames)) await server.query(`DROP ROLE IF EXISTS ${name}`);
    await server.end();
  };

  try {
    const pw = quoteLiteral(password);
    await server.query(`CREATE ROLE ${roleNames.runtime} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    if (created.superuser) await server.query(`CREATE ROLE ${roleNames.superuser} LOGIN SUPERUSER PASSWORD ${pw}`);
    if (created.bypassrls) await server.query(`CREATE ROLE ${roleNames.bypassrls} LOGIN NOSUPERUSER BYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${roleNames.ownerWithGrant} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${roleNames.ownerNoGrant} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${roleNames.writer} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE DATABASE ${database}`);

    const adminDb = new URL(ADMIN_URL);
    adminDb.pathname = `/${database}`;
    db = new pg.Client({ connectionString: adminDb.toString() });
    await db.connect();
    const r = roleNames;
    await db.query(`
      CREATE SCHEMA app;
      GRANT USAGE ON SCHEMA app TO ${r.runtime}, ${r.ownerWithGrant}, ${r.ownerNoGrant}, ${r.writer};

      -- The RLS-protected table. Typed columns exist for R-3 (what the pg driver returns per type).
      CREATE TABLE app.holdings (
        id          int4 PRIMARY KEY,
        tenant_id   text NOT NULL,
        label       text NOT NULL,
        amount      numeric(12,2) NOT NULL,
        big         bigint NOT NULL,
        qty         int4 NOT NULL,
        as_of       timestamptz NOT NULL,
        trade_date  date NOT NULL,
        active      boolean NOT NULL,
        note        text            -- nullable on purpose
      );
      ALTER TABLE app.holdings ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.holdings FORCE ROW LEVEL SECURITY;
      -- current_setting(…, true): NULL when unset, so an unset GUC matches no row (fail closed).
      CREATE POLICY tenant_isolation ON app.holdings USING (tenant_id = current_setting('app.tenant_id', true));

      -- Identical shape and data, NO row-level security: what a mis-provisioned table looks like.
      CREATE TABLE app.holdings_open (LIKE app.holdings INCLUDING ALL);

      -- D-9 layer 4 targets.
      CREATE TABLE app.owned_by_owner (id int4);
      ALTER TABLE app.owned_by_owner OWNER TO ${r.ownerWithGrant};
      CREATE TABLE app.owned_no_grant (id int4);
      ALTER TABLE app.owned_no_grant OWNER TO ${r.ownerNoGrant};
      REVOKE ALL ON app.owned_no_grant FROM ${r.ownerNoGrant};

      -- D-4 / D-9 layer 2 target: a table the writer role really may INSERT into.
      CREATE TABLE app.scratch (id serial PRIMARY KEY, note text);
      GRANT SELECT, INSERT ON app.scratch TO ${r.writer};
      GRANT USAGE ON SEQUENCE app.scratch_id_seq TO ${r.writer};

      GRANT SELECT ON app.holdings, app.holdings_open TO ${r.runtime}, ${r.ownerNoGrant}, ${r.writer};
    `);
    if (created.bypassrls) await db.query(`GRANT USAGE ON SCHEMA app TO ${r.bypassrls}; GRANT SELECT ON app.holdings TO ${r.bypassrls}`);

    const rows: unknown[][] = [];
    for (const [tenant, list] of Object.entries(SEED)) {
      for (const { id, label } of list) {
        rows.push([id, tenant, label, `${id}234.50`, `900719925474099${id}`, id * 7, `2026-10-0${id}T12:34:56.789Z`, `2026-10-0${id}`, id % 2 === 1, id === 1 ? null : `note ${id}`]);
      }
    }
    for (const table of ["app.holdings", "app.holdings_open"]) {
      for (const row of rows) {
        await db.query(
          `INSERT INTO ${table} (id, tenant_id, label, amount, big, qty, as_of, trade_date, active, note) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          row,
        );
      }
    }
  } catch (err) {
    await teardown().catch(() => undefined);
    throw err;
  }

  const env: Record<string, string> = {};
  for (const [key, envVar] of Object.entries(DSN_VARS) as [RoleKey, string][]) {
    if (created[key]) env[envVar] = dsnFor(ADMIN_URL, database, roleNames[key], password);
  }
  return { database, env, created, admin: (sql, params) => db!.query(sql, params), teardown };
}

/** End every pool a test registry opened — a live `pg.Pool` keeps the vitest worker alive and
 *  blocks `DROP DATABASE … WITH (FORCE)` only by being rude, not by being correct. */
export async function endPools(registry: Map<string, ConnectionEntry>): Promise<void> {
  for (const entry of registry.values()) await (entry.pool as unknown as pg.Pool).end().catch(() => undefined);
  registry.clear();
}
