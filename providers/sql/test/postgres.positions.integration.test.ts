// The production topology against a REAL Postgres (ADR-0012 D-3, D-4, D-9; issue #153): a
// migrations role OWNS the data and a curated view, the runtime role owns nothing and holds
// SELECT on the view alone, and a FORCEd row-level-security policy compares `tenant_id` with
// `app.current_tenant_id()` — a function that RAISES when the session has no tenant. This is the
// shape `examples/manifests/sql-reporting` documents; postgres.integration.test.ts covers the
// same machinery against a table the runtime role reads directly.
//
// Skipped locally unless ARCHSTONE_TEST_PG_URL is set, and a failure (never a skip) in CI — see
// CONTRIBUTING.md.

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import type { IRTool } from "@archstone/compiler";
import { invokeSql, checkConnectionPrivileges, type ConnectionEntry, type PgPool, type SqlInvokeOptions } from "../src/index";
import { createPgFixture, describePostgres, endPools, DSN_VARS, SEED, type PgFixture } from "./support/postgres";

function sqlTool(query: string, params: string[] = [], dsnVar: string = DSN_VARS.runtime): IRTool {
  return {
    id: "reporting.positions",
    description: "Positions.",
    effect: "read",
    provider: "warehouse",
    policies: [],
    input: params.map((name) => ({ name, required: true, type: { kind: "scalar", semantic: "identifier" } })),
    output: [],
    connector: { type: "sql", sql: { engine: "postgres", dsn: `\${${dsnVar}}`, statementKind: "select", query, params } },
  };
}

const LIST = sqlTool("SELECT id, label FROM app.positions_v ORDER BY id");
const BY_ID = sqlTool("SELECT id, label FROM app.positions_v WHERE id = $1", ["id"]);
// What a belt-and-braces author writes: a tenant predicate in the query itself…
const LIST_WITH_PREDICATE = sqlTool("SELECT id, label FROM app.positions_v WHERE tenant_id = 'acme' ORDER BY id");
// …and what the claims look like from inside the database.
const SESSION = sqlTool("SELECT id, label, current_setting('app.tenant_id', true) AS claim, pg_backend_pid() AS pid FROM app.positions_v ORDER BY id");

const identityAdapter = (principal: string | undefined) =>
  principal === "tenant-a" ? { tenant_id: "acme" } : principal === "tenant-b" ? { tenant_id: "beta" } : undefined;

const rowsOf = (tenant: keyof typeof SEED) => SEED[tenant].map((r) => ({ ...r }));

describePostgres("curated view + migrations-owner topology against a real Postgres", () => {
  let fx: PgFixture;
  const registries: Map<string, ConnectionEntry>[] = [];

  function opts(principal: string | undefined, extra: Partial<SqlInvokeOptions> = {}): SqlInvokeOptions {
    const connectionRegistry = new Map<string, ConnectionEntry>();
    registries.push(connectionRegistry);
    return { env: fx.env, identityAdapter, caller: principal === undefined ? undefined : { principal }, connectionRegistry, ...extra };
  }

  /** A raw client as the given role — what a deployer's own tooling would hold. */
  async function rawClient(dsnVar: string): Promise<pg.Client> {
    const client = new pg.Client({ connectionString: fx.env[dsnVar] });
    await client.connect();
    return client;
  }
  const sqlstate = async (p: Promise<unknown>) => ((await p.then(() => undefined, (e: unknown) => e)) as { code?: string } | undefined)?.code;

  beforeAll(async () => {
    fx = await createPgFixture();
  }, 60_000);

  afterAll(async () => {
    for (const r of registries) await endPools(r);
    await fx?.teardown();
  }, 60_000);

  // ------------------------------------------------------------ the shape of the fixture itself

  it("fixture: the runtime role owns nothing, holds SELECT on the view only, and the view is not the table", async () => {
    const runtime = decodeURIComponent(new URL(fx.env[DSN_VARS.runtime]).username);
    const { rows } = await fx.admin(
      `SELECT c.relname, pg_get_userbyid(c.relowner) AS owner, c.relrowsecurity AS rls, c.relforcerowsecurity AS forced,
              has_table_privilege($1, c.oid, 'SELECT') AS can_select,
              has_table_privilege($1, c.oid, 'INSERT') AS can_insert
       FROM pg_class c WHERE c.oid IN ('app.positions'::regclass, 'app.positions_v'::regclass) ORDER BY c.relname`,
      [runtime],
    );
    expect(rows).toEqual([
      expect.objectContaining({ relname: "positions", rls: true, forced: true, can_select: false, can_insert: false }),
      expect.objectContaining({ relname: "positions_v", can_select: true, can_insert: false }),
    ]);
    expect(rows[0].owner).toBe(rows[1].owner); // the view reads the table as its owner, which FORCE subjects to the policy
    expect(rows[0].owner).not.toBe(runtime);
    const owned = await fx.admin("SELECT count(*)::int AS n FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = $1)", [runtime]);
    expect(owned.rows[0].n).toBe(0);
  });

  // ------------------------------------------------------------------ isolation, positive and negative

  it("tenant A receives exactly its rows through the curated view; the base table's internal column never appears", async () => {
    const result = await invokeSql(LIST, {}, opts("tenant-a"));
    expect(result).toEqual({ ok: true, status: 200, data: rowsOf("acme") });
    // `SELECT *` over the view is exactly the curated columns: internal_cost stays behind it.
    const star = await invokeSql(sqlTool("SELECT * FROM app.positions_v ORDER BY id"), {}, opts("tenant-a"));
    expect(star.data).toEqual(SEED.acme.map((r) => ({ tenant_id: "acme", id: r.id, label: r.label, qty: r.id * 7 })));
  });

  it("tenant B, given the identical input, receives zero rows — and its own rows when it asks for them", async () => {
    expect(await invokeSql(BY_ID, { id: 1 }, opts("tenant-a"))).toEqual({ ok: true, status: 200, data: [{ id: 1, label: "acme-alpha" }] });
    expect(await invokeSql(BY_ID, { id: 1 }, opts("tenant-b"))).toEqual({ ok: true, status: 200, data: [] });
    expect(await invokeSql(LIST, {}, opts("tenant-b"))).toEqual({ ok: true, status: 200, data: rowsOf("beta") });
  });

  it("the same binding with the tenant predicate deleted returns the same rows as before — the database, not the query, holds the line", async () => {
    const withPredicate = await invokeSql(LIST_WITH_PREDICATE, {}, opts("tenant-a"));
    const without = await invokeSql(LIST, {}, opts("tenant-a"));
    expect(withPredicate).toEqual({ ok: true, status: 200, data: rowsOf("acme") });
    expect(without).toEqual(withPredicate);
    // And the predicate cannot be turned into a way IN: a literal naming another tenant, run as B, still yields nothing.
    expect(await invokeSql(LIST_WITH_PREDICATE, {}, opts("tenant-b"))).toEqual({ ok: true, status: 200, data: [] });
  });

  // ---------------------------------------------------- no leakage across a pool of one connection

  it("pool max:1, identities A, B, A: every call sees only its own rows and its own claim, on one and the same backend", async () => {
    const o = opts("tenant-a", { poolConfig: { max: 1 } });
    const as = (principal: string) => invokeSql(SESSION, {}, { ...o, caller: { principal } });
    const [first, second, third] = [await as("tenant-a"), await as("tenant-b"), await as("tenant-a")];
    for (const [result, tenant, claim] of [
      [first, "acme", "acme"],
      [second, "beta", "beta"],
      [third, "acme", "acme"],
    ] as const) {
      expect(result.ok).toBe(true);
      const data = result.data as Array<{ id: number; label: string; claim: string; pid: number }>;
      expect(data.map(({ id, label }) => ({ id, label }))).toEqual(rowsOf(tenant));
      expect(new Set(data.map((r) => r.claim))).toEqual(new Set([claim]));
    }
    const pids = new Set([first, second, third].map((r) => (r.data as Array<{ pid: number }>)[0].pid));
    expect(pids.size).toBe(1); // the pool really did hand the SAME connection to all three
    const pool = [...o.connectionRegistry!.values()][0].pool as unknown as pg.Pool;
    expect(pool.totalCount).toBe(1);
  });

  // ------------------------------------------------ no identity: refused before any connection is used

  it("a call with no resolvable identity is refused before the pool is even created — nothing connects, nothing is queried", async () => {
    const poolFactory = vi.fn<() => PgPool>(() => {
      throw new Error("a pool must not be created for a call without an identity");
    });
    const refusal = {
      ok: false,
      status: 0,
      error: "capability 'reporting.positions': no session identity resolved for this caller — identityAdapter is unset, or returned no claims for this principal; refusing before any connection is used",
    };
    for (const o of [
      opts("tenant-nobody", { pgPoolFactory: poolFactory }), // the adapter does not know this principal
      opts(undefined, { pgPoolFactory: poolFactory }), // no caller at all
      opts("tenant-a", { pgPoolFactory: poolFactory, identityAdapter: () => ({}) }), // resolves to an empty claims object
      opts("tenant-a", { pgPoolFactory: poolFactory, identityAdapter: undefined }), // no adapter configured
    ]) {
      expect(await invokeSql(LIST, {}, o)).toEqual(refusal);
      expect(o.connectionRegistry!.size).toBe(0); // no registry entry, hence no pool, hence no socket
    }
    expect(poolFactory).not.toHaveBeenCalled();
  });

  // ------------------------------------------- a policy that sees no setting fails closed (the function raises)

  it("fail closed: reading the view with no tenant set raises 28000 — not zero rows — for an unset setting and for an empty one", async () => {
    const client = await rawClient(DSN_VARS.runtime);
    try {
      // Never set on this session: current_setting(…, true) is NULL.
      expect(await sqlstate(client.query("SELECT * FROM app.positions_v"))).toBe("28000");

      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', '', true)");
      expect(await sqlstate(client.query("SELECT * FROM app.positions_v"))).toBe("28000");
      await client.query("ROLLBACK");

      // Set in a transaction, then gone: Postgres reads an is_local setting back as '' once the
      // transaction ends, which must fail closed exactly like NULL (ADR-0012 D-4's '' finding).
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', 'acme', true)");
      expect((await client.query("SELECT id FROM app.positions_v ORDER BY id")).rows).toEqual(SEED.acme.map((r) => ({ id: r.id })));
      await client.query("COMMIT");
      expect((await client.query("SELECT current_setting('app.tenant_id', true) AS t")).rows[0].t).toBe("");
      expect(await sqlstate(client.query("SELECT * FROM app.positions_v"))).toBe("28000");
    } finally {
      await client.end();
    }
  });

  it("the base table is not reachable by the runtime role at all: 42501, whatever the setting", async () => {
    const client = await rawClient(DSN_VARS.runtime);
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', 'acme', true)");
      expect(await sqlstate(client.query("SELECT * FROM app.positions"))).toBe("42501");
      await client.query("ROLLBACK");
    } finally {
      await client.end();
    }
  });

  // ------------------------------------------------------------ read-only: which refusal comes first
  //
  // FINDING (identical on Postgres 16 and 18), pinned as observed. Both layers refuse a write; what
  // differs is which SQLSTATE the caller sees:
  //   - a BASE TABLE: `SET TRANSACTION READ ONLY` wins (25006), whether or not the role holds the
  //     privilege — the executor's read-only check runs before its privilege check. Outside a
  //     read-only transaction the same statement is 42501.
  //   - a VIEW: the view's privilege check happens when the rewriter expands the view, ahead of the
  //     executor, so a role without the privilege gets 42501 even INSIDE a read-only transaction.
  //   - an UPDATE/DELETE of a table whose policy calls a function that raises: that function is
  //     evaluated during planning, so its own 28000 precedes both (see the test below).
  // The ADR's "READ ONLY rejects any write that reaches the database" holds; "a role without write
  // grants is rejected with permission denied" holds for the curated view. Neither is a SQLSTATE
  // a binding author or an operator should rely on being 25006 in general.

  it("read-only vs permission: the runtime role writing to the curated view gets 42501 inside the read-only transaction AND outside it", async () => {
    const client = await rawClient(DSN_VARS.runtime);
    try {
      expect(await sqlstate(client.query("INSERT INTO app.positions_v (tenant_id, id, label, qty) VALUES ('acme', 99, 'x', 1)"))).toBe("42501");
      for (const write of [
        "INSERT INTO app.positions_v (tenant_id, id, label, qty) VALUES ('acme', 99, 'x', 1)",
        "UPDATE app.positions_v SET label = 'x'",
        "DELETE FROM app.positions_v",
      ]) {
        await client.query("BEGIN READ ONLY");
        expect(await sqlstate(client.query(write))).toBe("42501");
        await client.query("ROLLBACK");
      }
    } finally {
      await client.end();
    }
  });

  it("read-only vs permission: against a base table the READ ONLY transaction speaks first (25006), a plain transaction gets 42501", async () => {
    const client = await rawClient(DSN_VARS.runtime);
    try {
      // app.holdings: the runtime role holds SELECT only. app.positions: it holds nothing.
      for (const write of ["UPDATE app.holdings SET label = 'x'", "DELETE FROM app.holdings", "INSERT INTO app.holdings (label) VALUES ('x')", "INSERT INTO app.positions (label) VALUES ('x')"]) {
        expect(await sqlstate(client.query(write))).toBe("42501");
        await client.query("BEGIN READ ONLY");
        expect(await sqlstate(client.query(write))).toBe("25006");
        await client.query("ROLLBACK");
      }
    } finally {
      await client.end();
    }
  });

  it("read-only vs permission: an UPDATE or DELETE of a table whose policy RAISES fails with the policy's own 28000 first, inside the READ ONLY transaction and outside it", async () => {
    // The planner evaluates the (STABLE) policy function while estimating the statement's
    // selectivity, so its exception surfaces before the executor's read-only and privilege checks.
    // An INSERT has no qual to estimate, hence the 42501 / 25006 pair above.
    const client = await rawClient(DSN_VARS.runtime);
    try {
      for (const write of ["UPDATE app.positions SET label = 'x'", "DELETE FROM app.positions"]) {
        expect(await sqlstate(client.query(write))).toBe("28000");
        await client.query("BEGIN READ ONLY");
        expect(await sqlstate(client.query(write))).toBe("28000");
        await client.query("ROLLBACK");
      }
    } finally {
      await client.end();
    }
  });

  it("through invokeSql, a write smuggled into WITH … SELECT is refused: 42501 against the view, 25006 against a table — and nothing is written either way", async () => {
    const viaView = sqlTool("WITH w AS (INSERT INTO app.positions_v (tenant_id, id, label, qty) VALUES ('acme', 99, 'x', 1) RETURNING id) SELECT id FROM w");
    const viaTable = sqlTool("WITH w AS (INSERT INTO app.holdings (id, tenant_id, label, amount, big, qty, as_of, trade_date, active) VALUES (99, 'acme', 'x', 1, 1, 1, now(), now(), true) RETURNING id) SELECT id FROM w");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await invokeSql(viaView, {}, opts("tenant-a"))).toEqual({ ok: false, status: 0, error: "query failed (SQLSTATE 42501)" });
      expect(await invokeSql(viaTable, {}, opts("tenant-a"))).toEqual({ ok: false, status: 0, error: "query failed (SQLSTATE 25006)" });
    } finally {
      stderr.mockRestore();
    }
    expect((await fx.admin("SELECT count(*)::int AS n FROM app.positions WHERE id = 99")).rows[0].n).toBe(0);
    expect((await fx.admin("SELECT count(*)::int AS n FROM app.holdings WHERE id = 99")).rows[0].n).toBe(0);
  });

  // -------------------------------------------------------------------------- R-7, with real roles
  //
  // ADR-0012 R-7: D-9 layer 4 refuses a connecting role that OWNS a relation it can also reach.
  // The query joins `pg_class.relowner = current_user` to `role_table_grants` rows whose grantee
  // is `current_user` or PUBLIC. A role that merely belongs to the role that owns app.r7_owned
  // satisfies neither half, so the check cannot see it — whether or not the membership is active:
  //
  //   - WITH INHERIT FALSE: the privileges are NOT active in the session. The role cannot read the
  //     table (42501) unless it issues `SET ROLE <group>`, which the provider never does. The
  //     catalog does not show the grant to this session at all (the group is not an enabled role).
  //     This is the boundary the ADR names, and why the topology guide forbids role-membership
  //     indirection.
  //   - WITH INHERIT TRUE: the privileges ARE active — the role reads the group's table — and the
  //     check STILL passes. role_table_grants does show the group's rows to this session, but the
  //     grantee filter (`current_user`, PUBLIC) discards them. This is a wider gap than the ADR's
  //     "visible at query time" wording implies; it is pinned here as observed.
  //
  // A role that owns a relation DIRECTLY and holds a grant on it is refused — covered by the
  // `ownerWithGrant` case in postgres.integration.test.ts and not repeated here.

  const r7 = async (dsnVar: string) => {
    const client = await rawClient(dsnVar);
    try {
      const grants = await client.query(
        "SELECT grantee::text AS grantee, current_user::text AS me FROM information_schema.role_table_grants WHERE table_schema = 'app' AND table_name = 'r7_owned'",
      );
      const owner = await client.query("SELECT pg_get_userbyid(relowner) AS owner, current_user::text AS me FROM pg_class WHERE oid = 'app.r7_owned'::regclass");
      return { grantees: new Set(grants.rows.map((r) => r.grantee as string)), me: owner.rows[0].me as string, owner: owner.rows[0].owner as string };
    } finally {
      await client.end();
    }
  };
  it("R-7: a role in the owning group WITH INHERIT FALSE — D-9 passes, the grant is not even visible, and the table is unreadable (42501)", async () => {
    const o = opts("tenant-a");
    expect(await checkConnectionPrivileges(DSN_VARS.memberNoInherit, fx.env[DSN_VARS.memberNoInherit], o)).toEqual({ ok: true });
    const seen = await r7(DSN_VARS.memberNoInherit);
    expect(seen.owner).not.toBe(seen.me);
    expect(seen.grantees.size).toBe(0); // not an enabled role: role_table_grants shows this session nothing
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await invokeSql(sqlTool("SELECT id FROM app.r7_owned", [], DSN_VARS.memberNoInherit), {}, o)).toEqual({
        ok: false,
        status: 0,
        error: "query failed (SQLSTATE 42501)",
      });
    } finally {
      stderr.mockRestore();
    }
  });

  it("R-7 (wider than the ADR words it): a role in the owning group WITH INHERIT TRUE reads the group's table and D-9 STILL passes", async () => {
    const o = opts("tenant-a");
    expect(await checkConnectionPrivileges(DSN_VARS.memberInherit, fx.env[DSN_VARS.memberInherit], o)).toEqual({ ok: true });
    const seen = await r7(DSN_VARS.memberInherit);
    expect(seen.owner).not.toBe(seen.me);
    // The catalog DOES show the inherited owner's privileges to this session — under the group's
    // name. Layer 4 asks for grantee = current_user or PUBLIC, so none of them count.
    expect([...seen.grantees]).toEqual([seen.owner]);
    expect(await invokeSql(sqlTool("SELECT id FROM app.r7_owned", [], DSN_VARS.memberInherit), {}, o)).toEqual({ ok: true, status: 200, data: [] });
  });
});
