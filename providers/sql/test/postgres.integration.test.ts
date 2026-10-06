// `invokeSql` against a REAL Postgres (ADR-0012 D-3, D-4, D-7, D-9). The unit suite
// (invoke.test.ts) proves what we send the driver through a fake pool; this one proves what
// Postgres does with it. Skipped unless ARCHSTONE_TEST_PG_URL is set — see CONTRIBUTING.md.

import { afterAll, beforeAll, expect, it, vi } from "vitest";
import pg from "pg";
import type { IRResourceRegistry, IRTool } from "@archstone/compiler";
import { describeShape } from "@archstone/compiler";
import { applyResponseMapping, objectJsonSchema } from "@archstone/emitter-support";
import { invokeSql, checkConnectionPrivileges, type ConnectionEntry, type PgPool, type SqlInvokeOptions } from "../src/index";
import { ADMIN_URL, createPgFixture, describePostgres, endPools, DSN_VARS, SEED, type PgFixture, type RoleKey } from "./support/postgres";

function sqlTool(query: string, params: string[], dsnVar: string = DSN_VARS.runtime, extra: Partial<IRTool> = {}): IRTool {
  return {
    id: "reporting.holdings",
    description: "Holdings.",
    effect: "read",
    provider: "warehouse",
    policies: [],
    input: params.map((name) => ({ name, required: true, type: { kind: "scalar", semantic: "identifier" } })),
    output: [],
    connector: { type: "sql", sql: { engine: "postgres", dsn: `\${${dsnVar}}`, statementKind: "select", query, params } },
    ...extra,
  };
}

const ALL_ROWS = sqlTool("SELECT id, label FROM app.holdings ORDER BY id", []);

/** tenant-a → acme, tenant-b → beta, tenant-empty → a tenant that exists but owns no rows. */
const identityAdapter = (principal: string | undefined) =>
  principal === "tenant-a" ? { tenant_id: "acme" } : principal === "tenant-b" ? { tenant_id: "beta" } : principal === "tenant-empty" ? { tenant_id: "gamma" } : undefined;

describePostgres("invokeSql against a real Postgres", () => {
  let fx: PgFixture;
  const registries: Map<string, ConnectionEntry>[] = [];

  /** A fresh registry per call site, so D-9's per-DSN check cache never leaks between tests. */
  function opts(principal: string, extra: Partial<SqlInvokeOptions> = {}): SqlInvokeOptions {
    const connectionRegistry = new Map<string, ConnectionEntry>();
    registries.push(connectionRegistry);
    return { env: fx.env, identityAdapter, caller: { principal }, connectionRegistry, ...extra };
  }

  beforeAll(async () => {
    fx = await createPgFixture();
  }, 60_000);

  afterAll(async () => {
    for (const r of registries) await endPools(r);
    await fx?.teardown();
  }, 60_000);

  // ---------------------------------------------------------------- scenario 1: RLS end to end
  // set_config('app.tenant_id', …, true) → current_setting('app.tenant_id', true) → the policy.

  it("RLS: tenant A sees only A's rows", async () => {
    const result = await invokeSql(ALL_ROWS, {}, opts("tenant-a"));
    expect(result).toEqual({ ok: true, status: 200, data: SEED.acme.map((r) => ({ ...r })) });
  });

  it("RLS: tenant B sees only B's rows", async () => {
    const result = await invokeSql(ALL_ROWS, {}, opts("tenant-b"));
    expect(result).toEqual({ ok: true, status: 200, data: SEED.beta.map((r) => ({ ...r })) });
  });

  it("RLS: a resolved claim for a tenant that owns no rows returns zero rows, not an error", async () => {
    const result = await invokeSql(ALL_ROWS, {}, opts("tenant-empty"));
    expect(result).toEqual({ ok: true, status: 200, data: [] });
  });

  it("RLS: the identical request by id returns the row to its tenant and nothing to the other", async () => {
    const byId = sqlTool("SELECT id, label FROM app.holdings WHERE id = $1", ["id"]);
    expect((await invokeSql(byId, { id: 1 }, opts("tenant-a"))).data).toEqual([{ id: 1, label: "acme-alpha" }]);
    expect((await invokeSql(byId, { id: 1 }, opts("tenant-b"))).data).toEqual([]);
  });

  it("D-4: the session GUC is transaction-scoped — a pooled connection carries no identity into the next checkout", async () => {
    const o = opts("tenant-a", { poolConfig: { max: 1 } }); // one connection, so the next checkout IS the same one
    expect((await invokeSql(ALL_ROWS, {}, o)).ok).toBe(true);
    const entry = [...o.connectionRegistry!.values()][0];
    const client = await entry.pool.connect();
    try {
      const { rows } = await client.query("SELECT current_setting('app.tenant_id', true) AS tenant, (SELECT count(*)::int FROM app.holdings) AS visible");
      // Postgres resets an is_local setting to its pre-transaction value; for a never-set
      // placeholder GUC that reads back as '' rather than NULL. Either way it matches no row.
      expect(rows[0].tenant === null || rows[0].tenant === "").toBe(true);
      expect(rows[0].visible).toBe(0);
    } finally {
      client.release();
    }
  });

  // -------------------------------------------- D-5: what an idle pooled connection does on death
  //
  // When Postgres terminates a pooled connection — a restart, a failover,
  // `idle_session_timeout`, `pg_terminate_backend` — the dead connection emits 'error'. Unlistened,
  // that is an unhandled 'error' event and the `serve` process exits. `ensureConnection` attaches
  // the listeners when it creates the pool:
  // - IDLE: pg-pool drops the client and re-emits on the pool; the pool listener logs it (env
  //   var name + error code only) and the next checkout opens a fresh connection.
  // - CHECKED OUT: pg-pool's own listener is detached during checkout, so every client gets a
  //   permanent silent one ('connect'); the in-flight call fails closed and release() drops it.
  // Both backends are terminated for real here, from the admin connection.
  it("D-5: an idle connection terminated by the server is logged and dropped, and the pool keeps serving", async () => {
    const o = opts("tenant-a");
    expect((await invokeSql(ALL_ROWS, {}, o)).ok).toBe(true);
    const pool = [...o.connectionRegistry!.values()][0].pool as unknown as pg.Pool;
    expect(pool.listenerCount("error")).toBe(1);
    expect(pool.idleCount).toBeGreaterThan(0);

    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const poolError = new Promise<Error>((resolve) => pool.once("error", resolve));
      const runtimeRole = decodeURIComponent(new URL(fx.env[DSN_VARS.runtime]).username);
      const { rows } = await fx.admin(
        "SELECT pg_terminate_backend(pid) AS terminated FROM pg_stat_activity WHERE datname = current_database() AND usename = $1 AND state = 'idle'",
        [runtimeRole],
      );
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((r) => r.terminated === true)).toBe(true);

      let timer: NodeJS.Timeout | undefined;
      const err = await Promise.race([
        poolError,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("pool never saw the terminated backend")), 10_000);
        }),
      ]).finally(() => clearTimeout(timer));
      expect((err as Error & { code?: string }).code).toBe("57P01"); // admin_shutdown
      for (let i = 0; pool.totalCount > 0 && i < 100; i++) await new Promise((r) => setTimeout(r, 50));
      expect(pool.totalCount).toBe(0); // pg-pool discarded the dead client itself

      const line = stderr.mock.calls.map((c) => c.join(" ")).find((l) => l.includes(DSN_VARS.runtime));
      expect(line).toContain("SQLSTATE 57P01");
      expect(line).not.toContain(runtimeRole);
      expect(line).not.toContain(fx.env[DSN_VARS.runtime]);
    } finally {
      stderr.mockRestore();
    }

    // Still alive, and the same pool opens a fresh connection for the next call.
    expect(await invokeSql(ALL_ROWS, {}, o)).toEqual({ ok: true, status: 200, data: SEED.acme.map((r) => ({ ...r })) });
  });

  it("D-5: a CHECKED-OUT connection terminated by the server does not crash the process, and the pool keeps serving", async () => {
    const o = opts("tenant-a");
    expect((await invokeSql(ALL_ROWS, {}, o)).ok).toBe(true);
    const pool = [...o.connectionRegistry!.values()][0].pool as unknown as pg.Pool;

    const client = (await pool.connect()) as pg.PoolClient;
    const opened = pool.totalCount;
    let released = false;
    try {
      // pg-pool detaches its idle listener on checkout: only ours remains.
      expect(client.listenerCount("error")).toBe(1);
      const { rows } = await client.query("SELECT pg_backend_pid() AS pid");
      const pid = rows[0].pid as number;

      const clientError = new Promise<Error>((resolve) => client.once("error", resolve));
      const terminated = await fx.admin("SELECT pg_terminate_backend($1) AS ok", [pid]);
      expect(terminated.rows[0].ok).toBe(true);

      let timer: NodeJS.Timeout | undefined;
      const err = await Promise.race([
        clientError,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("checked-out client never saw its terminated backend")), 10_000);
        }),
      ]).finally(() => clearTimeout(timer));
      expect((err as Error & { code?: string }).code).toBe("57P01");
      // Still here: the error had a listener, so it did not take the worker down.
      await expect(client.query("SELECT 1")).rejects.toThrow();
      client.release();
      released = true;
      expect(pool.totalCount).toBe(opened - 1); // release() of a dead client removes it from the pool
    } finally {
      if (!released) client.release();
    }

    expect(await invokeSql(ALL_ROWS, {}, o)).toEqual({ ok: true, status: 200, data: SEED.acme.map((r) => ({ ...r })) });
  });

  // ------------------------------------------------------- scenario 3: D-9 over-privileged roles

  const refusals: Array<[RoleKey, RegExp]> = [
    ["superuser", /uses a role with rolsuper = true; the runtime role must not be a superuser — see the topology guide$/],
    ["bypassrls", /uses a role with rolbypassrls = true; the runtime role must not bypass row-level security — see the topology guide$/],
    ["ownerWithGrant", /owns app\.owned_by_owner, which it also holds a grant on — the runtime role must not own any relation it can query — see the topology guide$/],
  ];
  for (const [key, message] of refusals) {
    it(`D-9: a ${key} connection is refused with the shipped message, before the query runs`, async (ctx) => {
      if (!fx.created[key]) ctx.skip(); // the admin url's own role could not create this one
      const tool = sqlTool("SELECT id FROM app.holdings", [], DSN_VARS[key]);
      const result = await invokeSql(tool, {}, opts("tenant-a"));
      expect(result.ok).toBe(false);
      expect(result.error).toMatch(new RegExp(`^connection for '${DSN_VARS[key]}' `));
      expect(result.error).toMatch(message);
    });
  }

  it("D-9: an owner refusal is real ownership + the owner's IMPLICIT privileges — no explicit GRANT was ever issued", async () => {
    // Postgres reports an owner's default privileges through information_schema.role_table_grants
    // (relacl NULL ⇒ acldefault), so "owns a relation it holds a grant on" is true of every
    // relation a role owns until it revokes its own privileges. Pinned so nobody "fixes" the
    // ownership query into one that only sees explicit grants.
    const { rows } = await fx.admin(
      "SELECT relacl IS NULL AS implicit FROM pg_class WHERE oid = 'app.owned_by_owner'::regclass",
    );
    expect(rows[0].implicit).toBe(true);
  });

  it("D-9: the least-privilege runtime role passes every check and reads", async () => {
    const result = await invokeSql(ALL_ROWS, {}, opts("tenant-a"));
    expect(result.ok).toBe(true);
  });

  it("D-9 EC-8a: a role that owns a relation but revoked its own privileges on it is NOT refused (and RLS still applies to what it reads)", async () => {
    const tool = sqlTool("SELECT id, label FROM app.holdings ORDER BY id", [], DSN_VARS.ownerNoGrant);
    const result = await invokeSql(tool, {}, opts("tenant-b"));
    expect(result).toEqual({ ok: true, status: 200, data: SEED.beta.map((r) => ({ ...r })) });
  });

  // ------------------------------------- D-9 re-runs after a server change (amended 2026-10-05)
  //
  // Layer 3 is read inside every transaction; layer 4's verdict is cached per DSN per (server
  // start time, database oid). What the unit suite proves with a fake pool, pinned here against
  // what Postgres actually lets an unprivileged role read and what it does under a live pool.
  // Not covered here: restarting the server under a live pool (a new start time), which the CI
  // service container gives the suite no way to do.

  const runtimeRole = () => decodeURIComponent(new URL(fx.env[DSN_VARS.runtime]).username);
  const ownershipKeys = (o: SqlInvokeOptions) => [...[...o.connectionRegistry!.values()][0].ownership.keys()];

  it("D-9 ruling 1: the unprivileged runtime role executes the per-transaction read, and layer 4 is keyed by this server and database", async () => {
    const o = opts("tenant-a");
    const check = await checkConnectionPrivileges(DSN_VARS.runtime, fx.env[DSN_VARS.runtime], o);
    expect(check).toEqual({ ok: true });
    expect((await invokeSql(ALL_ROWS, {}, o)).ok).toBe(true);
    expect((await invokeSql(ALL_ROWS, {}, o)).ok).toBe(true);
    const { rows } = await fx.admin(
      // The key is session-independent: UTC, fixed format, microseconds kept.
      "SELECT to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD\"T\"HH24:MI:SS.US') AS started, oid::text AS oid FROM pg_database WHERE datname = current_database()",
    );
    expect(ownershipKeys(o)).toEqual([`${rows[0].started}|${rows[0].oid}`]); // judged once: at startup
    expect(rows[0].started).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}$/);
  });

  it("D-9 R-9: with EXECUTE on pg_postmaster_start_time() revoked, the startup check and every call fail closed, and nothing is cached", async (ctx) => {
    if (!fx.created.superuser) ctx.skip(); // revoking a catalog function's EXECUTE takes a superuser admin
    const o = opts("tenant-a");
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await fx.admin("REVOKE EXECUTE ON FUNCTION pg_postmaster_start_time() FROM PUBLIC");
    try {
      expect(await checkConnectionPrivileges(DSN_VARS.runtime, fx.env[DSN_VARS.runtime], o)).toEqual({
        ok: false,
        error: "connection privilege check failed (SQLSTATE 42501)",
        incomplete: true,
      });
      expect(await invokeSql(ALL_ROWS, {}, o)).toEqual({ ok: false, status: 0, error: "query failed (SQLSTATE 42501)" });
      const entry = [...o.connectionRegistry!.values()][0];
      expect(entry.refusal).toBeUndefined();
      expect(entry.ownership.size).toBe(0);
    } finally {
      await fx.admin("GRANT EXECUTE ON FUNCTION pg_postmaster_start_time() TO PUBLIC");
      stderr.mockRestore();
    }
    // A failed read was not a verdict: once readable again, the same DSN serves.
    expect(await invokeSql(ALL_ROWS, {}, o)).toEqual({ ok: true, status: 200, data: SEED.acme.map((r) => ({ ...r })) });
  });

  it("D-9 ruling 3: ALTER ROLE … BYPASSRLS on the runtime role under a live pool refuses the next call, and every later one without a checkout", async (ctx) => {
    if (!fx.created.bypassrls) ctx.skip(); // granting BYPASSRLS takes a superuser admin
    const o = opts("tenant-a");
    expect((await invokeSql(ALL_ROWS, {}, o)).ok).toBe(true);
    const pool = [...o.connectionRegistry!.values()][0].pool as unknown as pg.Pool;
    const connect = vi.spyOn(pool, "connect");
    const expected = {
      ok: false,
      status: 0,
      error: `connection for '${DSN_VARS.runtime}' uses a role with rolbypassrls = true; the runtime role must not bypass row-level security — see the topology guide`,
    };
    await fx.admin(`ALTER ROLE ${runtimeRole()} BYPASSRLS`);
    try {
      expect(await invokeSql(ALL_ROWS, {}, o)).toEqual(expected);
      expect(connect).toHaveBeenCalledTimes(1);
    } finally {
      await fx.admin(`ALTER ROLE ${runtimeRole()} NOBYPASSRLS`);
    }
    // Fixed on the server, but a refusal is the DSN's verdict until restart.
    for (let i = 0; i < 2; i++) expect(await invokeSql(ALL_ROWS, {}, o)).toEqual(expected);
    expect(connect).toHaveBeenCalledTimes(1);
    expect(pool.idleCount).toBe(pool.totalCount); // the refused transaction was released, rolled back
  });

  it("D-9 ruling 2: a name re-pointed at another database is judged on its own, and its refusal survives routing back", async () => {
    // A proxy alias moved to another database on the same server: same DSN, new database oid.
    // Database `<fixture>_b` has a table the runtime role owns (implicit grant intact), so layer 4
    // refuses there and nowhere else.
    const other = `${fx.database}_b`;
    await fx.admin(`CREATE DATABASE ${other}`);
    const otherAdmin = new URL(ADMIN_URL!);
    otherAdmin.pathname = `/${other}`;
    const setup = new pg.Client({ connectionString: otherAdmin.toString() });
    const pools: pg.Pool[] = [];
    let registry: Map<string, ConnectionEntry> | undefined;
    try {
      await setup.connect();
      await setup.query(`CREATE TABLE public.owned_elsewhere (id int4); ALTER TABLE public.owned_elsewhere OWNER TO ${runtimeRole()}`);
      await setup.end();

      const runtimeOther = new URL(fx.env[DSN_VARS.runtime]);
      runtimeOther.pathname = `/${other}`;
      const targets = { a: new pg.Pool({ connectionString: fx.env[DSN_VARS.runtime] }), b: new pg.Pool({ connectionString: runtimeOther.toString() }) };
      pools.push(targets.a, targets.b);
      let route: keyof typeof targets = "a";
      const router = {
        connect: () => targets[route].connect(),
        on: (event: string, listener: (...args: never[]) => void) => {
          for (const p of pools) p.on(event as "error", listener as (err: Error) => void);
        },
      };
      const o = opts("tenant-a", { pgPoolFactory: () => router as unknown as PgPool });
      registry = o.connectionRegistry;
      const read = sqlTool("SELECT 1 AS one", []);

      expect(await invokeSql(read, {}, o)).toEqual({ ok: true, status: 200, data: [{ one: 1 }] });
      route = "b";
      const refused = await invokeSql(read, {}, o);
      expect(refused).toEqual({
        ok: false,
        status: 0,
        error: `connection for '${DSN_VARS.runtime}' owns public.owned_elsewhere, which it also holds a grant on — the runtime role must not own any relation it can query — see the topology guide`,
      });
      expect(ownershipKeys(o)).toHaveLength(2); // one verdict per (server, database) reached
      route = "a";
      expect(await invokeSql(read, {}, o)).toEqual(refused);
    } finally {
      registry?.clear(); // the router has no `end`: its pools are ended below, not by endPools
      await setup.end().catch(() => undefined);
      for (const p of pools) await p.end().catch(() => undefined);
      for (let attempt = 0; ; attempt++) {
        try {
          await fx.admin(`DROP DATABASE IF EXISTS ${other}`);
          break;
        } catch (err) {
          if ((err as { code?: string }).code !== "55006" || attempt >= 50) {
            await fx.admin(`DROP DATABASE IF EXISTS ${other} WITH (FORCE)`);
            break;
          }
          await new Promise((r) => setTimeout(r, 100));
        }
      }
    }
  });

  // ----------------------------------------------------- scenario 4: read-only transaction (D-4)
  //
  // Tested at `invokeSql` with a hand-built IRTool. A data-modifying CTE — `WITH w AS (INSERT …)
  // SELECT …` — begins with WITH and contains SELECT, so D-9 layer 1 (compiler/src/validate.ts,
  // SQL_LEADING_KEYWORD_RE plus the "contains SELECT" check) ADMITS it at `apply`: this is
  // exactly the statement layer 2 exists for. The writer role really holds INSERT on the table,
  // so the refusal below is Postgres's read-only transaction, not a missing privilege.

  it("D-4/D-9 layer 2: a write smuggled in a WITH … SELECT is refused by the read-only transaction, nothing is written, and the connection is released", async () => {
    const smuggled = sqlTool("WITH w AS (INSERT INTO app.scratch (note) VALUES ($1) RETURNING id) SELECT id FROM w", ["note"], DSN_VARS.writer);
    const o = opts("tenant-a", { poolConfig: { max: 1 } });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let result: Awaited<ReturnType<typeof invokeSql>>;
    let lines: string[];
    try {
      result = await invokeSql(smuggled, { note: "should never land" }, o);
      lines = stderr.mock.calls.map((c) => c.join(" "));
    } finally {
      stderr.mockRestore(); // also clears the recorded calls, hence `lines` above
    }
    expect(result.ok).toBe(false);
    // The caller gets the SQLSTATE only (25006, read_only_sql_transaction), never the driver's text.
    expect(result.error).toBe("query failed (SQLSTATE 25006)");
    // The operator's stderr line carries it. Postgres names the statement's top-level command
    // tag — SELECT, for a data-modifying CTE — not the INSERT inside it. The write is blocked all
    // the same (asserted just below).
    expect(lines).toEqual([
      `archstone: query failed for '${DSN_VARS.writer}' (SQLSTATE 25006): cannot execute SELECT in a read-only transaction`,
    ]);

    const { rows } = await fx.admin("SELECT count(*)::int AS n FROM app.scratch");
    expect(rows[0].n).toBe(0);

    const pool = [...o.connectionRegistry!.values()][0].pool as unknown as pg.Pool;
    expect(pool.totalCount).toBe(1);
    expect(pool.idleCount).toBe(1); // released, not leaked
    // …and released CLEAN: the next invocation on that same single connection is not stuck in
    // an aborted transaction.
    const read = sqlTool("SELECT count(*)::int AS n FROM app.scratch", [], DSN_VARS.writer);
    expect(await invokeSql(read, {}, o)).toEqual({ ok: true, status: 200, data: [{ n: 0 }] });
  });

  it("D-4: a sequence bump (nextval) is also a write the read-only transaction refuses", async () => {
    const tool = sqlTool("SELECT nextval('app.scratch_id_seq') AS id", [], DSN_VARS.writer);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let result: Awaited<ReturnType<typeof invokeSql>>;
    let lines: string[];
    try {
      result = await invokeSql(tool, {}, opts("tenant-a"));
      lines = stderr.mock.calls.map((c) => c.join(" "));
    } finally {
      stderr.mockRestore(); // also clears the recorded calls, hence `lines` above
    }
    expect(result).toEqual({ ok: false, status: 0, error: "query failed (SQLSTATE 25006)" });
    expect(lines).toEqual([
      `archstone: query failed for '${DSN_VARS.writer}' (SQLSTATE 25006): cannot execute nextval() in a read-only transaction`,
    ]);
  });

  // --------------------------------------------------------------- scenario 5: types (R-3, D-7)
  //
  // D-7 says rows reach `applyResponseMapping` as the driver returns them, "numeric/bigint/
  // timestamp as strings unless a deployer overrides type parsers". What `pg` 8 actually returns
  // is pinned below, then run through the unmodified mapping and compared against the
  // outputSchema the same semantic types lower to. Findings are pinned as they ARE today, named
  // "R-3 finding:"; the fixes are `it.todo`s — out of scope for a test-only change.

  const TYPED_QUERY = "SELECT id, label, amount, big, qty, as_of, trade_date, active, note FROM app.holdings WHERE id = $1";
  const typedTool = sqlTool(TYPED_QUERY, ["id"], DSN_VARS.runtime, {
    output: [{ name: "holdings", required: true, type: { kind: "collection", of: "Holding" } }],
    response: {
      resource: "Holding",
      field: "holdings",
      collection: "$[*]",
      fields: ["id", "label", "amount", "big", "qty", "as_of", "trade_date", "active", "note"].map((name) => ({ name, path: `$.${name}` })),
    },
  });
  const resources: IRResourceRegistry = {
    Holding: [
      { name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } },
      { name: "label", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "amount", required: true, type: { kind: "scalar", semantic: "quantity" } },
      { name: "big", required: true, type: { kind: "scalar", semantic: "quantity" } },
      { name: "qty", required: true, type: { kind: "scalar", semantic: "quantity" } },
      { name: "as_of", required: true, type: { kind: "scalar", semantic: "datetime" } },
      { name: "trade_date", required: true, type: { kind: "scalar", semantic: "date" } },
      // CDL has no boolean semantic type; `string` is the closest an author can declare.
      { name: "active", required: true, type: { kind: "scalar", semantic: "string" } },
      { name: "note", required: false, type: { kind: "scalar", semantic: "text" } },
    ],
  };
  const itemSchema = (objectJsonSchema(typedTool.output, resources).properties as Record<string, { items: { properties: Record<string, { type: string; format?: string }> } }>)
    .holdings.items.properties;

  /** What the MCP client sees: mapped data after a JSON round trip. */
  async function mappedRow(id: number, principal: string) {
    const result = await invokeSql(typedTool, { id }, opts(principal));
    expect(result.ok).toBe(true);
    const raw = (result.data as Array<Record<string, unknown>>)[0];
    const mapped = applyResponseMapping(typedTool, result.data, resources);
    const wire = JSON.parse(JSON.stringify(mapped.data)) as { holdings: Array<Record<string, unknown>> };
    return { raw, mapped, wire: wire.holdings[0], shape: describeShape(result.data) };
  }

  it("R-3: text and int4 arrive as string and number, and satisfy their lowered schema", async () => {
    const { raw, wire } = await mappedRow(3, "tenant-b");
    expect(raw.label).toBe("beta-alpha");
    expect(raw.qty).toBe(21);
    expect(itemSchema.label.type).toBe("string");
    expect(itemSchema.qty.type).toBe("number");
    expect(typeof wire.label).toBe("string");
    expect(typeof wire.qty).toBe("number");
  });

  it("R-3 finding: numeric arrives as a STRING ('3234.50'), but a `quantity` outputSchema says number", async () => {
    const { raw, wire } = await mappedRow(3, "tenant-b");
    expect(raw.amount).toBe("3234.50");
    expect(itemSchema.amount.type).toBe("number");
    expect(typeof wire.amount).toBe("string"); // structuredContent fails its own outputSchema
  });

  it("R-3 finding: bigint arrives as a STRING (exact, beyond 2^53), but a `quantity` outputSchema says number", async () => {
    const { raw, wire } = await mappedRow(3, "tenant-b");
    expect(raw.big).toBe("9007199254740993"); // > Number.MAX_SAFE_INTEGER: a number would lose it
    expect(Number(raw.big)).toBe(9007199254740992); // what a naive number coercion would report
    expect(typeof wire.big).toBe("string");
  });

  it("R-3 fix (#146): timestamptz arrives as an ISO date-time string, and is fingerprinted as the string it is on the wire", async () => {
    const { raw, wire, shape, mapped } = await mappedRow(3, "tenant-b");
    expect(raw.as_of).toBe("2026-10-03T12:34:56.789Z");
    expect(wire.as_of).toBe("2026-10-03T12:34:56.789Z");
    expect(mapped.status).toBe("ok"); // a required datetime is present, not absent
    expect(itemSchema.as_of).toMatchObject({ type: "string", format: "date-time" });
    expect(shape["$[].as_of"]).toBe("string");
  });

  it("R-3 fix (#146): date arrives as 'YYYY-MM-DD', independent of the process's TZ", async () => {
    const previous = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati"; // UTC+14: pg's default date parser would build new Date(y, m, d) here
    try {
      const { raw, wire } = await mappedRow(3, "tenant-b");
      expect(raw.trade_date).toBe("2026-10-03");
      expect(itemSchema.trade_date).toMatchObject({ type: "string", format: "date" });
      expect(wire.trade_date).toBe("2026-10-03");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("R-3 finding: boolean arrives as a boolean, and CDL has no boolean semantic type to declare it truthfully", async () => {
    const { raw, wire } = await mappedRow(3, "tenant-b");
    expect(raw.active).toBe(true);
    expect(itemSchema.active.type).toBe("string");
    expect(typeof wire.active).toBe("boolean");
  });

  it("R-3: a NULL in an optional column degrades (field omitted) — mapping treats null as absent", async () => {
    const { raw, mapped } = await mappedRow(1, "tenant-a");
    expect(raw.note).toBeNull();
    expect(mapped.status).toBe("degraded");
    expect(mapped.degraded).toEqual(["note"]);
    expect(mapped.data!.holdings).toEqual([expect.not.objectContaining({ note: expect.anything() })]);
  });

  it("R-3: a NULL in a column the resource declares required is a whole-response violation", async () => {
    const strict: IRResourceRegistry = { Holding: resources.Holding.map((f) => (f.name === "note" ? { ...f, required: true } : f)) };
    const result = await invokeSql(typedTool, { id: 1 }, opts("tenant-a"));
    expect(applyResponseMapping(typedTool, result.data, strict)).toMatchObject({ status: "violation", missing: ["note"] });
  });

  it.todo("R-3 fix: numeric/bigint reach a `quantity` field as a JSON number (or the lowering admits the string form) — needs a decision: pg type parsers vs. mapping-time coercion");
  it.todo("R-3 fix: CDL can declare a boolean column (no boolean semantic type exists)");
});
