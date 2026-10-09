// Real-Postgres fixture for the `*.integration.test.ts` suites (ADR-0012 D-3/D-4/D-7/D-9).
//
// Gated on ARCHSTONE_TEST_PG_URL: an ADMIN url (superuser in CI and in the documented local
// container) used ONLY here, to create and drop the fixture. No provider call ever runs as it —
// every invocation goes through a per-role DSN handed to the provider as `${ENV_VAR}`, exactly as
// a deployment would.
//
// Locally, unset, the suites are `describe.skip`ped and `pnpm test` stays offline. In CI (the `CI`
// environment variable is set, as GitHub Actions does) they are MANDATORY: an unset URL, or a
// server that cannot be reached, fails the suite with a message instead of skipping it — a
// guarantee nobody ever ran is not a guarantee, and a silently skipped suite would report green.
//
// Isolation per run: a fresh database `archstone_it_<suffix>` and roles `archstone_it_<suffix>_*`
// (roles are cluster-global, hence the suffix). `teardown()` drops both, so a failed run leaves
// nothing a re-run could trip over, and two concurrent runs never share state.
//
// Lives under providers/sql because this is the package that owns `pg` — `@archstone/runtime`'s
// verify suite imports it by relative path rather than gaining a `pg` dependency of its own.

import { randomBytes } from "node:crypto";
import { beforeAll, describe, it } from "vitest";
import pg from "pg";
import type { ConnectionEntry } from "../../src/index";
import { createScriptDatabase as createSharedScriptDatabase, type ScriptDatabase } from "../../../../scripts/lib/script-database.mjs";

export const ADMIN_URL = process.env.ARCHSTONE_TEST_PG_URL;

/** True when the process runs under CI: `CI` set to anything but empty, `0` or `false`. */
export function runsInCi(env: NodeJS.ProcessEnv): boolean {
  const ci = env.CI?.trim().toLowerCase();
  return ci !== undefined && ci !== "" && ci !== "0" && ci !== "false";
}

/** What a suite does with this environment: `run` it, `skip` it with an explicit reason (local
 *  runs only), or `fail` (CI without a database — never a skip). */
export function gateFor(env: NodeJS.ProcessEnv): "run" | "skip" | "fail" {
  if (env.ARCHSTONE_TEST_PG_URL) return "run";
  return runsInCi(env) ? "fail" : "skip";
}

async function assertReachable(url: string): Promise<void> {
  const probe = new pg.Client({ connectionString: url, connectionTimeoutMillis: 10_000 });
  // An unhandled 'error' on an idle probe would take the worker down; the awaited calls report it.
  probe.on("error", () => undefined);
  try {
    await probe.connect();
    await probe.query("SELECT 1");
  } catch (err) {
    const code = (err as { code?: string }).code ?? "no error code";
    throw new Error(
      `ARCHSTONE_TEST_PG_URL is set but the Postgres server is unreachable (${code}). ` +
        `The real-Postgres suites are mandatory${runsInCi(process.env) ? " in CI" : " once the variable is set"}; refusing to skip. ` +
        `Check that the database service is up and the URL points at it.`,
    );
  } finally {
    await probe.end().catch(() => undefined);
  }
}

/** `describe` when a database is configured (failing, with a clear message, if the server cannot
 *  be reached); otherwise `describe.skip` locally — the reason is in the suite name so the skip
 *  explains itself in the reporter output — and a FAILING suite in CI. */
export function describePostgres(name: string, fn: () => void): void {
  const gate = gateFor(process.env);
  if (gate === "run") {
    describe(name, () => {
      beforeAll(() => assertReachable(ADMIN_URL!), 30_000);
      fn();
    });
  } else if (gate === "skip") {
    describe.skip(`${name} [skipped: set ARCHSTONE_TEST_PG_URL to run against a real Postgres]`, fn);
  } else {
    describe(name, () => {
      it("needs a real Postgres: ARCHSTONE_TEST_PG_URL must be set in CI", () => {
        throw new Error(
          "CI is set but ARCHSTONE_TEST_PG_URL is not: the real-Postgres suites are mandatory in CI and are never skipped there. " +
            "Point ARCHSTONE_TEST_PG_URL at the job's Postgres service (an admin url) — see CONTRIBUTING.md, \"Tests against a real Postgres\".",
        );
      });
    });
  }
}

/** The env-var names each role's DSN is published under — the bindings reference these as
 *  `dsn: "${…}"`, the production shape. */
export const DSN_VARS = {
  runtime: "IT_RUNTIME_DSN", // least privilege: LOGIN, SELECT grants only, owns nothing, no BYPASSRLS
  superuser: "IT_SUPERUSER_DSN",
  bypassrls: "IT_BYPASSRLS_DSN",
  ownerWithGrant: "IT_OWNER_DSN", // owns app.owned_by_owner (owner's implicit privileges intact)
  ownerNoGrant: "IT_OWNER_NO_GRANT_DSN", // owns app.owned_no_grant, then REVOKE ALL from itself (EC-8a)
  ownerPublic: "IT_OWNER_PUBLIC_DSN", // owns app.owned_public, revoked from itself but readable by PUBLIC: the grant is not its own, yet reaches it
  writer: "IT_WRITER_DSN", // SELECT + INSERT on app.scratch only — to prove READ ONLY, not missing privilege, blocks a write
  memberNoInherit: "IT_MEMBER_NOINHERIT_DSN", // R-7: member of the role that owns app.r7_owned, WITH INHERIT FALSE
  memberInherit: "IT_MEMBER_INHERIT_DSN", // R-7: member of the same role, WITH INHERIT TRUE
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
    ownerPublic: role("owner_pub"),
    writer: role("writer"),
    memberNoInherit: role("m_noinh"),
    memberInherit: role("m_inh"),
  } satisfies Record<RoleKey, string>;
  // Roles that are never connected as, so they have no DSN: the migrations owner of app.positions
  // and the NOLOGIN group whose ownership the R-7 members reach by membership.
  const supportRoles = { owner: role("migrations"), ownerGroup: role("r7_group") };
  const created: Record<RoleKey, boolean> = {
    runtime: true,
    superuser: me.rolsuper,
    bypassrls: me.rolsuper || me.rolbypassrls,
    ownerWithGrant: true,
    ownerNoGrant: true,
    ownerPublic: true,
    writer: true,
    memberNoInherit: true,
    memberInherit: true,
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
    for (const name of [...Object.values(roleNames), ...Object.values(supportRoles)]) await server.query(`DROP ROLE IF EXISTS ${name}`);
    await server.end();
  };

  try {
    const pw = quoteLiteral(password);
    await server.query(`CREATE ROLE ${roleNames.runtime} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    if (created.superuser) await server.query(`CREATE ROLE ${roleNames.superuser} LOGIN SUPERUSER PASSWORD ${pw}`);
    if (created.bypassrls) await server.query(`CREATE ROLE ${roleNames.bypassrls} LOGIN NOSUPERUSER BYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${roleNames.ownerWithGrant} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${roleNames.ownerNoGrant} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${roleNames.ownerPublic} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${roleNames.writer} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${supportRoles.owner} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${supportRoles.ownerGroup} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
    await server.query(`CREATE ROLE ${roleNames.memberNoInherit} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE ROLE ${roleNames.memberInherit} LOGIN NOSUPERUSER NOBYPASSRLS PASSWORD ${pw}`);
    await server.query(`CREATE DATABASE ${database}`);

    const adminDb = new URL(ADMIN_URL);
    adminDb.pathname = `/${database}`;
    db = new pg.Client({ connectionString: adminDb.toString() });
    await db.connect();
    const r = roleNames;
    const o = supportRoles;
    await db.query(`
      CREATE SCHEMA app;
      GRANT USAGE ON SCHEMA app TO ${r.runtime}, ${r.ownerWithGrant}, ${r.ownerNoGrant}, ${r.ownerPublic}, ${r.writer}, ${r.memberNoInherit}, ${r.memberInherit}, ${o.owner};

      -- The RLS-protected table. Typed columns exist for D-7 (what the pg driver returns per type).
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
      CREATE TABLE app.owned_public (id int4);
      ALTER TABLE app.owned_public OWNER TO ${r.ownerPublic};
      REVOKE ALL ON app.owned_public FROM ${r.ownerPublic};
      GRANT SELECT ON app.owned_public TO PUBLIC;

      -- D-4 / D-9 layer 2 target: a table the writer role really may INSERT into.
      CREATE TABLE app.scratch (id serial PRIMARY KEY, note text);
      GRANT SELECT, INSERT ON app.scratch TO ${r.writer};
      GRANT USAGE ON SEQUENCE app.scratch_id_seq TO ${r.writer};

      GRANT SELECT ON app.holdings, app.holdings_open TO ${r.runtime}, ${r.ownerNoGrant}, ${r.writer};

      -- R-7: a relation owned by a NOLOGIN group, reached by two members. Neither owns anything
      -- itself and neither holds a grant of its own on it.
      CREATE TABLE app.r7_owned (id int4);
      ALTER TABLE app.r7_owned OWNER TO ${o.ownerGroup};
      GRANT ${o.ownerGroup} TO ${r.memberNoInherit} WITH INHERIT FALSE, SET TRUE;
      GRANT ${o.ownerGroup} TO ${r.memberInherit} WITH INHERIT TRUE, SET TRUE;

      -- The production topology (ADR-0012 D-9): a migrations role OWNS the data and the curated
      -- view; the runtime role owns nothing, holds SELECT on the view only and has no grant on
      -- the base table. app.positions_v is the surface a binding queries; internal_cost is behind it.
      CREATE TABLE app.positions (
        tenant_id     text NOT NULL,
        id            int4 PRIMARY KEY,
        label         text NOT NULL,
        qty           int4 NOT NULL,
        internal_cost numeric(12,2) NOT NULL
      );
      ALTER TABLE app.positions OWNER TO ${o.owner};
      ALTER TABLE app.positions ENABLE ROW LEVEL SECURITY;
      ALTER TABLE app.positions FORCE ROW LEVEL SECURITY;   -- the owner is subject to the policy too

      -- Fails closed on an unset OR empty setting: after a transaction that set it with is_local,
      -- Postgres reads the setting back as '' (not NULL), so both spellings of "no identity" must raise.
      -- 28000 invalid_authorization_specification: no identity was established for this session.
      CREATE FUNCTION app.current_tenant_id() RETURNS text LANGUAGE plpgsql STABLE AS $fn$
      DECLARE
        tenant text := current_setting('app.tenant_id', true);
      BEGIN
        IF tenant IS NULL OR tenant = '' THEN
          RAISE EXCEPTION 'app.tenant_id is not set: no tenant identity for this session' USING ERRCODE = '28000';
        END IF;
        RETURN tenant;
      END
      $fn$;
      ALTER FUNCTION app.current_tenant_id() OWNER TO ${o.owner};
      CREATE POLICY tenant_isolation ON app.positions USING (tenant_id = app.current_tenant_id());

      -- Owned by the migrations role, so it reads the table as that role: subject to the FORCEd policy.
      CREATE VIEW app.positions_v WITH (security_barrier = true) AS
        SELECT tenant_id, id, label, qty FROM app.positions;
      ALTER VIEW app.positions_v OWNER TO ${o.owner};
      GRANT SELECT ON app.positions_v TO ${r.runtime};
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
    for (const [tenant, list] of Object.entries(SEED)) {
      for (const { id, label } of list) {
        await db.query("INSERT INTO app.positions (tenant_id, id, label, qty, internal_cost) VALUES ($1,$2,$3,$4,$5)", [tenant, id, label, id * 7, `${id}.25`]);
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

export type { ScriptDatabase } from "../../../../scripts/lib/script-database.mjs";

/**
 * A throwaway database built from a SQL script — `examples/manifests/sql-reporting/fixture.sql`
 * — rather than from this module's own fixture, so the example is proven against exactly the
 * text its README tells a reader to run. The work is done by `scripts/lib/script-database.mjs`,
 * which the release gate (#162) uses for the same example against the packed CLI; this wrapper
 * only supplies `pg` and the admin url, so the test and the gate cannot drift apart. Roles the
 * script creates are renamed run-unique; the runtime role is derived from the catalog (logs in,
 * NOSUPERUSER, NOBYPASSRLS, owns nothing) unless `runtimeRole` names it.
 */
export function createScriptDatabase(sql: string, runtimeRole?: string): Promise<ScriptDatabase> {
  if (!ADMIN_URL) throw new Error("createScriptDatabase called without ARCHSTONE_TEST_PG_URL");
  return createSharedScriptDatabase({ pg, adminUrl: ADMIN_URL, sql, runtimeRole });
}
