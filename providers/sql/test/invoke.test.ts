import { EventEmitter } from "node:events";
import { Pool, type PoolConfig } from "pg";
import { describe, it, expect, vi } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeSql, ensureConnection, checkConnectionPrivileges, jsonSafeTypeParser, type PgPool, type PgPoolClient, type ConnectionEntry } from "../src/index";

const tool: IRTool = {
  id: "reporting.portfolio-summary",
  description: "Portfolio summary.",
  effect: "read",
  provider: "warehouse",
  policies: [],
  input: [{ name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } }],
  output: [],
  connector: {
    type: "sql",
    sql: {
      engine: "postgres",
      dsn: "${DATABASE_URL}",
      statementKind: "select",
      query: "SELECT id, headline FROM reporting.portfolio_summary_v WHERE id = $1",
      params: ["id"],
    },
  },
};

/** ADR-0012 D-9 ruling 1's per-transaction read, as a passing role on one server and database. */
const SERVER_A = { server_started: "2026-10-05T08:00:00.123456", database_oid: 16384 };
const PASSING_ROW = { rolsuper: false, rolbypassrls: false, ...SERVER_A };
const isRead = (text: string) => text.includes("pg_postmaster_start_time()");
const isOwnership = (text: string) => text.includes("role_table_grants");

/** A fake pool that records every query issued against it — no real Postgres involved. */
function fakePool(rows: Array<Record<string, unknown>>, roleRow?: Record<string, unknown>) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const released = vi.fn();
  const client: PgPoolClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (isRead(text)) return { rows: [{ ...PASSING_ROW, ...roleRow }] };
      if (text.includes("role_table_grants")) {
        return { rows: [] }; // no owned-and-granted relation by default
      }
      if (text === "SELECT id, headline FROM reporting.portfolio_summary_v WHERE id = $1") {
        return { rows };
      }
      return { rows: [] };
    }),
    release: released,
  };
  const pool: PgPool = { connect: vi.fn(async () => client) };
  return { pool, client, queries, released };
}

function baseOpts(pool: PgPool, extra: Record<string, unknown> = {}) {
  return {
    env: { DATABASE_URL: "postgres://runtime@localhost/app" },
    pgPoolFactory: () => pool,
    connectionRegistry: new Map<string, ConnectionEntry>(),
    identityAdapter: (principal: string | undefined) => (principal === "tenant-a" ? { tenantId: "acme" } : undefined),
    caller: { principal: "tenant-a" },
    ...extra,
  };
}

describe("invokeSql — D-4 transaction mechanics", () => {
  it("runs BEGIN, SET TRANSACTION READ ONLY, the D-9 read, layer 4, set_config per claim, the query, COMMIT, then releases", async () => {
    const { pool, queries, released } = fakePool([{ id: "1", headline: "Q1" }]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result).toEqual({ ok: true, status: 200, data: [{ id: "1", headline: "Q1" }] });
    // One checkout, one transaction: D-9 is judged inside it (ADR-0012 D-9 rulings 1–2), not on
    // a separate connection first.
    const texts = queries.map((q) => q.text);
    expect(texts[0]).toBe("BEGIN");
    expect(texts[1]).toBe("SET TRANSACTION READ ONLY");
    // The start time is rendered in UTC with a fixed format, so the layer-4 key does not depend
    // on the session's TimeZone or DateStyle and keeps microseconds.
    expect(texts[2]).toMatch(/^SELECT rolsuper, rolbypassrls,\s+to_char\(pg_postmaster_start_time\(\) AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS\.US'\) AS server_started,\s+\(SELECT oid FROM pg_database WHERE datname = current_database\(\)\) AS database_oid\s+FROM pg_roles WHERE rolname = current_user$/);
    expect(isOwnership(texts[3])).toBe(true); // first transaction on this key: layer 4 runs here
    expect(texts[4]).toBe("SELECT set_config($1, $2, true)");
    expect(queries[4].params).toEqual(["app.tenantId", "acme"]);
    expect(texts[5]).toBe("SELECT id, headline FROM reporting.portfolio_summary_v WHERE id = $1");
    expect(queries[5].params).toEqual(["1"]);
    expect(texts[6]).toBe("COMMIT");
    expect(texts).toHaveLength(7);
    expect(pool.connect).toHaveBeenCalledTimes(1);
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("honors a custom sqlSessionGucPrefix", async () => {
    const { pool, queries } = fakePool([]);
    await invokeSql(tool, { id: "1" }, baseOpts(pool, { sqlSessionGucPrefix: "custom." }));
    const setConfig = queries.find((q) => q.text === "SELECT set_config($1, $2, true)");
    expect(setConfig?.params).toEqual(["custom.tenantId", "acme"]);
  });

  it("rolls back and returns a failure on a query error, and still releases the connection", async () => {
    const released = vi.fn();
    const client: PgPoolClient = {
      query: vi.fn(async (text: string) => {
        if (isRead(text)) return { rows: [PASSING_ROW] };
        if (isOwnership(text)) return { rows: [] };
        if (text === "BEGIN" || text === "SET TRANSACTION READ ONLY" || text === "ROLLBACK") return { rows: [] };
        if (text === "SELECT set_config($1, $2, true)") return { rows: [] };
        throw new Error("relation does not exist");
      }),
      release: released,
    };
    const pool: PgPool = { connect: vi.fn(async () => client) };
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
      expect(result).toEqual({ ok: false, status: 0, error: "query failed (error code unknown)" });
      expect(released).toHaveBeenCalledTimes(1); // the transaction's — there is no separate check connection
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("invokeSql — D-3 identity-adapter fail-closed gate", () => {
  it("refuses before any connection is used when identityAdapter is unset", async () => {
    const { pool } = fakePool([]);
    const result = await invokeSql(tool, { id: "1" }, {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map(),
      caller: { principal: "tenant-a" },
    });
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("refuses before any connection is used when identityAdapter cannot resolve this principal", async () => {
    const { pool } = fakePool([]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool, { caller: { principal: "unknown-session" } }));
    expect(result.ok).toBe(false);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("refuses before any connection is used when identityAdapter returns an empty claims object", async () => {
    const { pool } = fakePool([]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool, { identityAdapter: () => ({}) }));
    expect(result.ok).toBe(false);
    expect(result.status).toBe(0);
    expect(result.error).toContain("no session identity resolved for this caller");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it.each([
    ["an empty-string claim value", { tenantId: "" }],
    ["a null claim value", { tenantId: null }],
    ["a string instead of a claims object", "beta"],
    ["an array instead of a claims object", ["acme"]],
  ])("refuses before any connection is used when identityAdapter returns %s", async (_label, claims) => {
    const { pool } = fakePool([]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool, { identityAdapter: () => claims }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no session identity resolved for this caller");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("refuses the principal 'constructor' looked up in a parsed identity map (resolves to Object, not claims)", async () => {
    const { pool } = fakePool([]);
    const map = JSON.parse('{"tenant-a":{"tenantId":"acme"}}') as Record<string, Record<string, string>>;
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool, {
      identityAdapter: (principal: string | undefined) => (principal !== undefined ? map[principal] : undefined),
      caller: { principal: "constructor" },
    }));
    expect(result.ok).toBe(false);
    expect(result.error).toContain("no session identity resolved for this caller");
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("a capability input literally named tenantId has no bearing on the session claim", async () => {
    const { pool, queries } = fakePool([]);
    await invokeSql(tool, { id: "1", tenantId: "attacker-supplied" }, baseOpts(pool));
    const setConfig = queries.find((q) => q.text === "SELECT set_config($1, $2, true)");
    expect(setConfig?.params).toEqual(["app.tenantId", "acme"]); // from identityAdapter, never from input
  });
});

describe("invokeSql — D-9 over-privileged connection detection", () => {
  /** Neither a claim nor the declared query reached the database, and the transaction rolled back. */
  function expectRefusedInsideTransaction(texts: string[]) {
    expect(texts.some((t) => t === "SELECT set_config($1, $2, true)")).toBe(false);
    expect(texts.some((t) => t.startsWith("SELECT id, headline"))).toBe(false);
    expect(texts.at(-1)).toBe("ROLLBACK");
    expect(texts).not.toContain("COMMIT");
  }

  it("refuses a superuser connection, naming rolsuper, before any claim is set or the query runs", async () => {
    const { pool, queries, released } = fakePool([{ id: "1" }], { rolsuper: true, rolbypassrls: false });
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rolsuper/);
    expectRefusedInsideTransaction(queries.map((q) => q.text));
    expect(released).toHaveBeenCalledTimes(1);
  });

  it("refuses a BYPASSRLS role, naming rolbypassrls", async () => {
    const { pool, queries } = fakePool([], { rolsuper: false, rolbypassrls: true });
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rolbypassrls/);
    expectRefusedInsideTransaction(queries.map((q) => q.text));
  });

  it("refuses a role that owns a relation it also holds a grant on, naming the exact schema.relation", async () => {
    const queries: Array<{ text: string }> = [];
    const client: PgPoolClient = {
      query: vi.fn(async (text: string) => {
        queries.push({ text });
        if (isRead(text)) return { rows: [PASSING_ROW] };
        if (isOwnership(text)) return { rows: [{ schema_name: "reporting", relation_name: "portfolio_summary_v" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool: PgPool = { connect: vi.fn(async () => client) };
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reporting\.portfolio_summary_v/);
    expectRefusedInsideTransaction(queries.map((q) => q.text));
  });

  it("does NOT refuse a role that owns a relation it holds no grant on (EC-8a)", async () => {
    const { pool } = fakePool([{ id: "1" }]); // default fakePool returns no owned-and-granted rows
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(true);
  });

  // NF-1 (ADR-0012 Risk R-7, BR-15a) — pins the DOCUMENTED BOUNDARY of the ownership check, not
  // a desired safety property: it queries only `pg_class`/`information_schema.role_table_grants`
  // filtered to `current_user`/`PUBLIC`, with NO role-membership traversal (no `pg_auth_members`,
  // no recursive/`WITH RECURSIVE` membership walk, no `SET ROLE`). A future edit that
  // accidentally "fixes" R-7 by adding membership traversal must change this test — on purpose,
  // not silently — the same way a future edit that accidentally NARROWS the check further must
  // also fail it.
  it("the ownership check queries only pg_class/role_table_grants filtered to current_user/PUBLIC — no role-membership traversal (R-7's documented boundary)", async () => {
    const { pool, queries } = fakePool([{ id: "1" }]);
    await invokeSql(tool, { id: "1" }, baseOpts(pool));
    const ownershipQuery = queries.find((q) => isOwnership(q.text))?.text ?? "";
    expect(ownershipQuery).toMatch(/FROM pg_class c/);
    expect(ownershipQuery).toMatch(/JOIN pg_namespace n/);
    expect(ownershipQuery).toMatch(/FROM information_schema\.role_table_grants g/);
    expect(ownershipQuery).toMatch(/g\.grantee IN \(current_user, 'PUBLIC'\)/);
    // The documented gap itself: no visibility into membership NOT already active in this
    // session (NOINHERIT-mediated or SECURITY DEFINER-mediated grants) — R-7/BR-15a.
    expect(ownershipQuery).not.toMatch(/pg_auth_members/i);
    expect(ownershipQuery).not.toMatch(/WITH RECURSIVE/i);
    expect(ownershipQuery).not.toMatch(/SET ROLE/i);
    expect(ownershipQuery).not.toMatch(/SECURITY DEFINER/i);
  });

  it("reads layer 3 in every transaction, and runs layer 4 once per server and database", async () => {
    const { pool, client } = fakePool([{ id: "1" }]);
    const opts = baseOpts(pool);
    await invokeSql(tool, { id: "1" }, opts);
    await invokeSql(tool, { id: "1" }, opts);
    const texts = (client.query as ReturnType<typeof vi.fn>).mock.calls.map(([text]: [string]) => text);
    expect(texts.filter(isRead)).toHaveLength(2);
    expect(texts.filter(isOwnership)).toHaveLength(1);
  });

  it("ensureConnection runs no check: it returns the pool and no refusal, and checks nothing out", () => {
    const { pool } = fakePool([]);
    const opts = baseOpts(pool);
    const connection = ensureConnection("DATABASE_URL", "postgres://runtime@localhost/app", opts);
    expect(connection.pool).toBe(pool);
    expect(connection.pool !== undefined && connection.refusal).toBeUndefined();
    expect(pool.connect).not.toHaveBeenCalled();
  });
});

describe("invokeSql — D-9 re-runs after a server change (ADR-0012, amended 2026-10-05)", () => {
  type Server = { server_started: string; database_oid: number; rolsuper: boolean; rolbypassrls: boolean; owned: Array<Record<string, unknown>> };
  const passing = (started: string, oid: number): Server => ({ server_started: started, database_oid: oid, rolsuper: false, rolbypassrls: false, owned: [] });

  /** A DSN whose name can be re-pointed: each checkout lands on whichever server `route` names at
   *  that moment, and keeps it for the whole transaction (a backend does not move mid-transaction).
   *  Every query is recorded with the server it ran on. */
  function topologyPool(servers: Record<string, Server>, first: string) {
    const state = { route: first, checkout: undefined as Error | undefined, read: undefined as Error | undefined, ownership: undefined as Error | undefined };
    const log: Array<{ server: string; text: string }> = [];
    let releases = 0;
    const connect = vi.fn(async (): Promise<PgPoolClient> => {
      if (state.checkout) throw state.checkout;
      const server = state.route;
      return {
        query: vi.fn(async (text: string) => {
          log.push({ server, text });
          const s = servers[server];
          if (isRead(text)) {
            if (state.read) throw state.read;
            return { rows: [{ rolsuper: s.rolsuper, rolbypassrls: s.rolbypassrls, server_started: s.server_started, database_oid: s.database_oid }] };
          }
          if (isOwnership(text)) {
            if (state.ownership) throw state.ownership;
            return { rows: s.owned };
          }
          if (text.startsWith("SELECT id")) return { rows: [{ id: "1" }] };
          return { rows: [] };
        }),
        release: vi.fn(() => {
          releases++;
        }),
      };
    });
    const ownershipRuns = (server?: string) => log.filter((q) => isOwnership(q.text) && (server === undefined || q.server === server)).length;
    return { pool: { connect } as PgPool, connect, state, log, ownershipRuns, releases: () => releases };
  }
  const ok = { ok: true, status: 200, data: [{ id: "1" }] };
  const call = (opts: ReturnType<typeof baseOpts>) => invokeSql(tool, { id: "1" }, opts);

  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      return await fn();
    } finally {
      stderr.mockRestore();
    }
  }

  it("a server change (new start time) re-runs layer 4 once, and not again", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384), b: passing("2026-10-05T09:30:00.000002", 16384) }, "a");
    const opts = baseOpts(t.pool);
    expect(await call(opts)).toEqual(ok);
    expect(await call(opts)).toEqual(ok);
    expect(t.ownershipRuns("a")).toBe(1);

    t.state.route = "b"; // failover or a re-pointed name: same DSN, another server process
    for (let i = 0; i < 3; i++) expect(await call(opts)).toEqual(ok);
    expect(t.ownershipRuns("b")).toBe(1);
    expect(t.ownershipRuns()).toBe(2);
  });

  it("a database change on the same server (new oid, same start time) re-runs layer 4 too", async () => {
    const started = "2026-10-05T08:00:00.000001";
    const t = topologyPool({ a: passing(started, 16384), recreated: passing(started, 24576) }, "a");
    const opts = baseOpts(t.pool);
    expect(await call(opts)).toEqual(ok);
    t.state.route = "recreated";
    expect(await call(opts)).toEqual(ok);
    expect(await call(opts)).toEqual(ok);
    expect(t.ownershipRuns("a")).toBe(1);
    expect(t.ownershipRuns("recreated")).toBe(1);
  });

  it("two servers alternating behind one DSN run layer 4 once each", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384), b: passing("2026-10-05T08:00:00.000002", 16384) }, "a");
    const opts = baseOpts(t.pool);
    for (let i = 0; i < 6; i++) {
      t.state.route = i % 2 === 0 ? "a" : "b";
      expect(await call(opts)).toEqual(ok);
    }
    expect(t.ownershipRuns("a")).toBe(1);
    expect(t.ownershipRuns("b")).toBe(1);
  });

  it("no set_config is sent before the verdict: the read, then layer 4 when needed, then the claims — on every transaction", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384), b: passing("2026-10-05T09:00:00.000001", 16384) }, "a");
    const opts = baseOpts(t.pool);
    await call(opts);
    await call(opts); // key judged: no layer 4
    t.state.route = "b";
    await call(opts); // new key: layer 4 again
    const transactions: string[][] = [];
    for (const { text } of t.log) {
      if (text === "BEGIN") transactions.push([]);
      transactions.at(-1)!.push(isRead(text) ? "read" : isOwnership(text) ? "layer4" : text.startsWith("SELECT set_config") ? "claim" : text.startsWith("SELECT id") ? "query" : text);
    }
    expect(transactions).toEqual([
      ["BEGIN", "SET TRANSACTION READ ONLY", "read", "layer4", "claim", "query", "COMMIT"],
      ["BEGIN", "SET TRANSACTION READ ONLY", "read", "claim", "query", "COMMIT"],
      ["BEGIN", "SET TRANSACTION READ ONLY", "read", "layer4", "claim", "query", "COMMIT"],
    ]);
  });

  it("concurrent transactions on a key with no verdict await the one in-flight check: layer 4 runs once, and no claim is set before it settles", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384) }, "a");
    const opts = baseOpts(t.pool);
    let settle!: () => void;
    const gate = new Promise<void>((resolve) => { settle = resolve; });
    t.connect.mockImplementation(async () => {
      const client: PgPoolClient = {
        query: vi.fn(async (text: string) => {
          t.log.push({ server: "a", text });
          if (isRead(text)) return { rows: [{ ...PASSING_ROW, server_started: "2026-10-05T08:00:00.000001" }] };
          if (isOwnership(text)) {
            await gate;
            return { rows: [] };
          }
          if (text.startsWith("SELECT id")) return { rows: [{ id: "1" }] };
          return { rows: [] };
        }),
        release: vi.fn(),
      };
      return client;
    });
    const calls = Promise.all([1, 2, 3].map(() => call(opts)));
    await vi.waitFor(() => expect(t.log.filter((q) => isRead(q.text))).toHaveLength(3));
    expect(t.log.some((q) => q.text.startsWith("SELECT set_config"))).toBe(false);
    settle();
    for (const result of await calls) expect(result).toEqual(ok);
    expect(t.ownershipRuns()).toBe(1);
  });

  it("a role turning rolbypassrls mid-life refuses the next transaction, and every later call without a checkout", async () => {
    const servers = { a: passing("2026-10-05T08:00:00.000001", 16384) };
    const t = topologyPool(servers, "a");
    const opts = baseOpts(t.pool);
    expect(await call(opts)).toEqual(ok);

    servers.a.rolbypassrls = true; // ALTER ROLE … BYPASSRLS on the same server: layer 3 sees it
    const refused = await call(opts);
    expect(refused).toEqual({
      ok: false,
      status: 0,
      error: "connection for 'DATABASE_URL' uses a role with rolbypassrls = true; the runtime role must not bypass row-level security — see the topology guide",
    });
    expect(t.log.at(-1)!.text).toBe("ROLLBACK");
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(t.releases()).toBe(2); // exactly once per checkout, the refused one included

    servers.a.rolbypassrls = false; // fixed — but a refusal holds until restart (ruling 3)
    for (let i = 0; i < 3; i++) expect(await call(opts)).toEqual(refused);
    expect(t.connect).toHaveBeenCalledTimes(2);
    expect(await checkConnectionPrivileges("DATABASE_URL", "postgres://runtime@localhost/app", opts)).toEqual({ ok: false, error: refused.error });
    expect(t.connect).toHaveBeenCalledTimes(2);
  });

  it("a call queued on a saturated pool is refused once it gets a client, if a refusal was cached while it waited — nothing runs on that client", async () => {
    const t = topologyPool({ a: { ...passing("2026-10-05T08:00:00.000001", 16384), rolbypassrls: true } }, "a");
    const opts = baseOpts(t.pool);
    const original = t.connect.getMockImplementation()!;
    let grant!: () => void;
    const freed = new Promise<void>((resolve) => { grant = resolve; });
    let queued: PgPoolClient | undefined;
    t.connect.mockImplementationOnce(original).mockImplementationOnce(async () => {
      await freed; // the pool's one client is busy with the first call
      queued = await original();
      return queued;
    });
    const first = call(opts);
    const second = call(opts); // already past the cached-refusal check, waiting in connect()
    const refused = await first;
    expect(refused.ok).toBe(false);
    expect(opts.connectionRegistry.get("postgres://runtime@localhost/app")!.refusal).toBe(refused.error);
    const queriesBefore = t.log.length;
    grant();
    expect(await second).toEqual(refused);
    expect(queued!.query).not.toHaveBeenCalled();
    expect(t.log).toHaveLength(queriesBefore);
    expect(queued!.release).toHaveBeenCalledTimes(1);
    expect(t.releases()).toBe(2);
  });

  it("a mid-life layer-4 refusal is cached for the DSN and survives routing back to a passing server", async () => {
    const t = topologyPool(
      {
        a: passing("2026-10-05T08:00:00.000001", 16384),
        b: { ...passing("2026-10-05T09:00:00.000001", 16384), owned: [{ schema_name: "reporting", relation_name: "portfolio_summary_v" }] },
      },
      "a",
    );
    const opts = baseOpts(t.pool);
    expect(await call(opts)).toEqual(ok);
    t.state.route = "b";
    const refused = await call(opts);
    expect(refused.ok).toBe(false);
    expect(refused.error).toBe(
      "connection for 'DATABASE_URL' owns reporting.portfolio_summary_v, which it also holds a grant on — the runtime role must not own any relation it can query — see the topology guide",
    );
    t.state.route = "a";
    for (let i = 0; i < 3; i++) expect(await call(opts)).toEqual(refused);
    expect(t.connect).toHaveBeenCalledTimes(2);
  });

  it.each([
    ["the D-9 read", "read" as const, Object.assign(new Error("permission denied for function pg_postmaster_start_time"), { code: "42501" }), "query failed (SQLSTATE 42501)"],
    ["layer 4's query", "ownership" as const, Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }), "query failed (ECONNRESET)"],
  ])("a failure of %s fails the call through 'query failed', caches nothing, and the next call reads again", async (_label, which, err, expected) => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384) }, "a");
    const opts = baseOpts(t.pool);
    t.state[which] = err;
    expect(await quietly(() => call(opts))).toEqual({ ok: false, status: 0, error: expected });
    expect(t.log.some((q) => q.text.startsWith("SELECT set_config"))).toBe(false);
    expect(t.log.at(-1)!.text).toBe("ROLLBACK");
    expect(t.releases()).toBe(1);
    const entry = opts.connectionRegistry.get("postgres://runtime@localhost/app")!;
    expect(entry.refusal).toBeUndefined();
    expect(entry.ownership.size).toBe(0);

    t.state[which] = undefined;
    expect(await call(opts)).toEqual(ok);
    expect(t.ownershipRuns()).toBe(which === "ownership" ? 2 : 1);
  });

  it("a read that names no server start time or database oid is a failed read, not a verdict", async () => {
    const { pool } = fakePool([{ id: "1" }], { server_started: null });
    const opts = baseOpts(pool);
    expect(await quietly(() => invokeSql(tool, { id: "1" }, opts))).toEqual({ ok: false, status: 0, error: "query failed (error code unknown)" });
    const entry = opts.connectionRegistry.get("postgres://runtime@localhost/app")!;
    expect(entry.refusal).toBeUndefined();
    expect(entry.ownership.size).toBe(0);
  });

  it("concurrent transactions sharing a failing in-flight layer-4 check all fail, and the next call runs it again", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384) }, "a");
    const opts = baseOpts(t.pool);
    let fail!: (err: Error) => void;
    const pending = new Promise<never>((_resolve, reject) => { fail = reject; });
    const original = t.connect.getMockImplementation()!;
    t.connect.mockImplementation(async () => {
      const client = await original();
      const query = client.query;
      client.query = vi.fn(async (text: string, params?: unknown[]) => {
        if (isOwnership(text)) {
          t.log.push({ server: "a", text });
          return pending;
        }
        return query(text, params);
      });
      return client;
    });
    const calls = quietly(() => Promise.all([1, 2, 3].map(() => call(opts))));
    await vi.waitFor(() => expect(t.log.filter((q) => isRead(q.text))).toHaveLength(3));
    fail(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    for (const result of await calls) expect(result).toEqual({ ok: false, status: 0, error: "query failed (ECONNRESET)" });
    expect(t.ownershipRuns()).toBe(1);

    t.connect.mockImplementation(original);
    expect(await call(opts)).toEqual(ok);
    expect(t.ownershipRuns()).toBe(2);
  });

  it("a failed layer-4 check that is cleared never clobbers a newer check already in flight for its key", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384) }, "a");
    const opts = baseOpts(t.pool);
    const key = "2026-10-05T08:00:00.000001|16384";
    let fail!: (err: Error) => void;
    const original = t.connect.getMockImplementation()!;
    t.connect.mockImplementationOnce(async () => {
      const client = await original();
      const query = client.query;
      client.query = vi.fn(async (text: string, params?: unknown[]) =>
        isOwnership(text) ? new Promise<never>((_resolve, reject) => { fail = reject; }) : query(text, params),
      );
      return client;
    });
    const first = quietly(() => call(opts));
    await vi.waitFor(() => expect(fail).toBeTypeOf("function"));
    const entry = opts.connectionRegistry.get("postgres://runtime@localhost/app")!;
    // Simulate a newer check replacing the pending one before it settles.
    const newer = Promise.resolve({ ok: true } as const);
    entry.ownership.set(key, newer);
    fail(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
    expect((await first).ok).toBe(false);
    expect(entry.ownership.get(key)).toBe(newer);
    expect(await call(opts)).toEqual(ok);
    expect(t.ownershipRuns()).toBe(0); // served by the newer verdict, not a re-run
  });

  it("the startup check records its verdict against the key it reached: a process that never fails over runs layer 4 once", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384) }, "a");
    const opts = baseOpts(t.pool);
    expect(await checkConnectionPrivileges("DATABASE_URL", "postgres://runtime@localhost/app", opts)).toEqual({ ok: true });
    expect(t.log.map((q) => (isRead(q.text) ? "read" : isOwnership(q.text) ? "layer4" : q.text))).toEqual([
      "BEGIN",
      "SET TRANSACTION READ ONLY",
      "read",
      "layer4",
      "COMMIT",
    ]);
    for (let i = 0; i < 3; i++) expect(await call(opts)).toEqual(ok);
    expect(t.ownershipRuns()).toBe(1);
    expect(t.connect).toHaveBeenCalledTimes(4); // its own checkout, then one per call
  });

  it("a refusal reached by the startup check refuses every call without a checkout", async () => {
    const t = topologyPool({ a: { ...passing("2026-10-05T08:00:00.000001", 16384), rolsuper: true } }, "a");
    const opts = baseOpts(t.pool);
    const check = await checkConnectionPrivileges("DATABASE_URL", "postgres://runtime@localhost/app", opts);
    expect(check.ok).toBe(false);
    expect(t.log.at(-1)!.text).toBe("ROLLBACK");
    expect(t.releases()).toBe(1);
    const error = check.ok ? "" : check.error;
    for (let i = 0; i < 2; i++) expect(await call(opts)).toEqual({ ok: false, status: 0, error });
    expect(t.connect).toHaveBeenCalledTimes(1);
  });

  it("the startup check fails closed when the read cannot complete, and caches nothing", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384) }, "a");
    const opts = baseOpts(t.pool);
    t.state.read = Object.assign(new Error("permission denied for function pg_postmaster_start_time"), { code: "42501" });
    expect(await quietly(() => checkConnectionPrivileges("DATABASE_URL", "postgres://runtime@localhost/app", opts))).toEqual({
      ok: false,
      error: "connection privilege check failed (SQLSTATE 42501)",
      incomplete: true,
    });
    expect(t.log.at(-1)!.text).toBe("ROLLBACK");
    expect(t.releases()).toBe(1);
    t.state.read = undefined;
    expect(await checkConnectionPrivileges("DATABASE_URL", "postgres://runtime@localhost/app", opts)).toEqual({ ok: true });
  });

  it("the startup check's own checkout failure fails closed and caches nothing", async () => {
    const t = topologyPool({ a: passing("2026-10-05T08:00:00.000001", 16384) }, "a");
    const opts = baseOpts(t.pool);
    t.state.checkout = Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });
    expect(await quietly(() => checkConnectionPrivileges("DATABASE_URL", "postgres://runtime@localhost/app", opts))).toEqual({
      ok: false,
      error: "pool checkout failed while checking connection privileges (ECONNREFUSED)",
      incomplete: true,
    });
    t.state.checkout = undefined;
    expect(await call(opts)).toEqual(ok);
  });

  it("refusal strings carry no server start time, database oid, host or driver text", async () => {
    const started = "2026-10-05T08:00:00.123456";
    const dsn = "postgres://app_runtime:s3cret@db.internal:5432/app";
    const cases: Array<Partial<Server>> = [
      { rolsuper: true },
      { rolbypassrls: true },
      { owned: [{ schema_name: "reporting", relation_name: "portfolio_summary_v" }] },
    ];
    for (const unsafe of cases) {
      const t = topologyPool({ a: { ...passing(started, 16384), ...unsafe } }, "a");
      const opts = baseOpts(t.pool, { env: { DATABASE_URL: dsn } });
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const result = await call(opts);
        const startup = await checkConnectionPrivileges("DATABASE_URL", dsn, opts);
        expect(result.ok).toBe(false);
        expect(result.error).toMatch(/^connection for 'DATABASE_URL' /);
        for (const text of [result.error, startup.ok ? "" : startup.error, ...stderr.mock.calls.map((c) => c.join(" "))]) {
          for (const leak of [started, "2026-10-05", "16384", "db.internal", "app_runtime", "s3cret", "5432", "postgres://"]) expect(text).not.toContain(leak);
        }
      } finally {
        stderr.mockRestore();
      }
    }
  });
});

describe("D-9 caches only a verdict: a transient failure is retried (#122)", () => {
  // Layer 4's own failing check, retried by the next call, is
  // "concurrent transactions sharing a failing in-flight layer-4 check all fail, and the next call runs it again" above.
  const DSN = "postgres://runtime@localhost/app";
  const KEY = `${PASSING_ROW.server_started}|${PASSING_ROW.database_oid}`;
  const refused = () => Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" });

  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      return await fn();
    } finally {
      stderr.mockRestore();
    }
  }

  /** A pool whose first checkout is refused and every later one gets a passing client. */
  function flakyCheckoutPool() {
    const { client, queries } = fakePool([{ id: "1" }]);
    const connect = vi.fn<() => Promise<PgPoolClient>>().mockRejectedValueOnce(refused()).mockResolvedValue(client);
    return { pool: { connect } as PgPool, connect, queries };
  }

  it("checkConnectionPrivileges: a first checkout refused by the network is no verdict — the next check on the same registry passes", async () => {
    const { pool, connect } = flakyCheckoutPool();
    const opts = baseOpts(pool);
    expect(await quietly(() => checkConnectionPrivileges("DATABASE_URL", DSN, opts))).toEqual({
      ok: false,
      error: "pool checkout failed while checking connection privileges (ECONNREFUSED)",
      incomplete: true,
    });
    expect(await checkConnectionPrivileges("DATABASE_URL", DSN, opts)).toEqual({ ok: true });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(opts.connectionRegistry.get(DSN)!.refusal).toBeUndefined();
  });

  it("invokeSql: a first checkout refused by the network fails closed, and the next call on the same registry serves", async () => {
    const { pool, connect } = flakyCheckoutPool();
    const opts = baseOpts(pool);
    expect(await quietly(() => invokeSql(tool, { id: "1" }, opts))).toEqual({ ok: false, status: 0, error: "pool checkout failed (ECONNREFUSED)" });
    expect(await invokeSql(tool, { id: "1" }, opts)).toEqual({ ok: true, status: 200, data: [{ id: "1" }] });
    expect(connect).toHaveBeenCalledTimes(2);
    expect(opts.connectionRegistry.get(DSN)!.refusal).toBeUndefined();
  });

  it("invokeSql: the first transaction's D-9 read failing (backend terminated) fails closed with a ROLLBACK, and the next call is judged afresh and serves", async () => {
    const { client: healthy, queries } = fakePool([{ id: "1" }]);
    const dying: string[] = [];
    const first: PgPoolClient = {
      query: vi.fn(async (text: string) => {
        dying.push(text);
        if (isRead(text)) throw Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" });
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const connect = vi.fn<() => Promise<PgPoolClient>>().mockResolvedValueOnce(first).mockResolvedValue(healthy);
    const opts = baseOpts({ connect });
    expect(await quietly(() => invokeSql(tool, { id: "1" }, opts))).toEqual({ ok: false, status: 0, error: "query failed (SQLSTATE 57P01)" });
    expect(dying.at(-1)).toBe("ROLLBACK");
    expect(dying.some((t) => isOwnership(t) || t.startsWith("SELECT set_config") || t.startsWith("SELECT id"))).toBe(false);
    expect(first.release).toHaveBeenCalledTimes(1);
    const entry = opts.connectionRegistry.get(DSN)!;
    expect(entry.refusal).toBeUndefined();
    expect(entry.ownership.size).toBe(0);

    expect(await invokeSql(tool, { id: "1" }, opts)).toEqual({ ok: true, status: 200, data: [{ id: "1" }] });
    // Judged afresh: the read, then layer 4 — whose verdict is the only one the map now holds.
    expect(queries.filter((q) => isRead(q.text))).toHaveLength(1);
    expect(queries.filter((q) => isOwnership(q.text))).toHaveLength(1);
    expect(entry.refusal).toBeUndefined();
    expect([...entry.ownership.keys()]).toEqual([KEY]);
    expect(await entry.ownership.get(KEY)).toEqual({ ok: true });
  });
});

describe("invokeSql — response mapping surface (D-7)", () => {
  it("returns the driver's rows (made JSON-safe, #146) as data — undeclared columns are dropped later, by applyResponseMapping, not here", async () => {
    const { pool } = fakePool([{ id: "1", headline: "Q1", internal_notes: "secret" }]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.data).toEqual([{ id: "1", headline: "Q1", internal_notes: "secret" }]);
  });
});

describe("invokeSql — connection lifecycle (D-5, BR-24)", () => {
  it("a pool-checkout failure returns the same fail-closed shape invokeRest returns for a fetch failure", async () => {
    const pool: PgPool = { connect: vi.fn(async () => { throw new Error("pool exhausted"); }) };
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
      expect(result).toEqual({ ok: false, status: 0, error: "pool checkout failed (error code unknown)" });
    } finally {
      stderr.mockRestore();
    }
  });

  it("an idle client's 'error' on the pool is logged to stderr without the DSN or driver message, and the pool keeps serving", async () => {
    const { pool: base, client } = fakePool([{ id: "1" }]);
    const pool: PgPool & EventEmitter = Object.assign(new EventEmitter(), { connect: base.connect });
    const opts = baseOpts(pool, { env: { DATABASE_URL: "postgres://runtime:s3cret@db.internal:5432/app" } });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write");
    try {
      expect((await invokeSql(tool, { id: "1" }, opts)).ok).toBe(true);
      const entry = opts.connectionRegistry.get("postgres://runtime:s3cret@db.internal:5432/app")!;
      const ownership = entry.ownership.get(`${SERVER_A.server_started}|${SERVER_A.database_oid}`);
      expect(ownership).toBeDefined();
      expect(pool.listenerCount("error")).toBe(1);

      const message = 'terminating connection due to administrator command (host "db.internal", user "runtime")';
      expect(() => pool.emit("error", Object.assign(new Error(message), { code: "57P01" }))).not.toThrow();

      expect(stderr).toHaveBeenCalledTimes(1);
      const line = stderr.mock.calls[0].join(" ");
      expect(line).toContain("'DATABASE_URL'");
      expect(line).toContain("SQLSTATE 57P01");
      for (const leak of ["postgres://", "s3cret", "db.internal", "runtime", "terminating connection"]) expect(line).not.toContain(leak);
      expect(stdout).not.toHaveBeenCalled();

      // No eviction: the same entry (pool and layer-4 verdict) serves the next call, and layer 4
      // is not re-run — the server behind the DSN did not change.
      expect((await invokeSql(tool, { id: "1" }, opts)).ok).toBe(true);
      expect(opts.connectionRegistry.get("postgres://runtime:s3cret@db.internal:5432/app")).toBe(entry);
      expect(entry.pool).toBe(pool);
      expect(entry.ownership.get(`${SERVER_A.server_started}|${SERVER_A.database_oid}`)).toBe(ownership);
      const ownershipCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls.filter(([text]: [string]) => isOwnership(text)).length;
      expect(ownershipCalls).toBe(1);
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
    }
  });

  it("labels only a SQLSTATE-shaped code as SQLSTATE: a socket code is 'error code X', anything else 'error code unknown'", async () => {
    const { pool: base } = fakePool([{ id: "1" }]);
    const pool: PgPool & EventEmitter = Object.assign(new EventEmitter(), { connect: base.connect });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await invokeSql(tool, { id: "1" }, baseOpts(pool));
      pool.emit("error", Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" }));
      pool.emit("error", new Error("Connection terminated unexpectedly"));
      pool.emit("error", Object.assign(new Error("x"), { code: "postgres://runtime@db.internal" }));
      pool.emit("error", Object.assign(new Error("write EPIPE"), { code: "EPIPE" })); // five letters, still not a SQLSTATE
      const lines = stderr.mock.calls.map((c) => c.join(" "));
      expect(lines[0]).toContain("failed (error code ECONNRESET)");
      expect(lines[1]).toContain("failed (error code unknown)");
      expect(lines[2]).toContain("failed (error code unknown)");
      expect(lines[3]).toContain("failed (error code EPIPE)");
      for (const line of lines) {
        expect(line).not.toContain("SQLSTATE");
        expect(line).not.toContain("closed by the server");
        expect(line).not.toContain("db.internal");
      }
    } finally {
      stderr.mockRestore();
    }
  });

  it("a checked-out client whose backend dies mid-call does not crash the process: the call fails closed and the next one succeeds", async () => {
    const { client: healthy } = fakePool([{ id: "1" }]);
    // A client whose connection dies between checkout and BEGIN: pg emits 'error' on the client
    // itself (pg-pool's idle listener is detached while it is checked out), then rejects queries.
    const dying = Object.assign(new EventEmitter(), {
      query: vi.fn(async (text: string) => {
        if (text === "BEGIN") {
          dying.emit("error", Object.assign(new Error("terminating connection due to administrator command"), { code: "57P01" }));
          throw new Error("Connection terminated unexpectedly");
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    });
    const freshClient = Object.assign(new EventEmitter(), healthy);
    const queue = [dying, freshClient];
    const opened = new Set<EventEmitter>();
    const pool: PgPool & EventEmitter = Object.assign(new EventEmitter(), {
      connect: vi.fn(async () => {
        const next = queue.shift()!;
        // pg-pool emits 'connect' once per newly opened client, not per checkout.
        if (!opened.has(next)) {
          opened.add(next);
          pool.emit("connect", next);
        }
        return next;
      }),
    });
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const opts = baseOpts(pool);
      // First call: the transaction gets the dying client.
      const failed = await invokeSql(tool, { id: "1" }, opts);
      expect(failed).toEqual({ ok: false, status: 0, error: "query failed (error code unknown)" });
      expect(dying.listenerCount("error")).toBe(1);
      expect(dying.release).toHaveBeenCalledTimes(1);
      // One line, from the failed call's own operator log — the client's 'error' listener itself
      // stays silent, so a mid-call death is not reported twice.
      expect(stderr).toHaveBeenCalledTimes(1);
      expect(stderr.mock.calls[0].join(" ")).toContain("query failed for 'DATABASE_URL' (error code unknown): Connection terminated unexpectedly");

      expect(await invokeSql(tool, { id: "1" }, opts)).toEqual({ ok: true, status: 200, data: [{ id: "1" }] });
    } finally {
      stderr.mockRestore();
    }
  });

  it("a pool and client without `on` (a minimal fake) still work — no listener is required", async () => {
    const { pool } = fakePool([{ id: "1" }]); // plain objects: no `on` on the pool or the client
    expect(pool.on).toBeUndefined();
    expect((await invokeSql(tool, { id: "1" }, baseOpts(pool))).ok).toBe(true);
  });

  it("a missing dsn env var fails closed with a missing-env-var message", async () => {
    const { pool } = fakePool([]);
    const result = await invokeSql(tool, { id: "1" }, { ...baseOpts(pool), env: {} });
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/missing env var\(s\): DATABASE_URL/);
  });

  it("an empty-string dsn env var fails closed with 'no dsn resolved', before any pool is made", async () => {
    const { pool } = fakePool([]);
    const pgPoolFactory = vi.fn(() => pool);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool, { env: { DATABASE_URL: "" }, pgPoolFactory }));
    expect(result).toEqual({ ok: false, status: 0, error: "capability 'reporting.portfolio-summary': no dsn resolved" });
    expect(pgPoolFactory).not.toHaveBeenCalled();
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("has no SQL connector -> a clean, consistent failure", async () => {
    const restTool: IRTool = { ...tool, connector: { type: "rest" } };
    const { pool } = fakePool([]);
    const result = await invokeSql(restTool, { id: "1" }, baseOpts(pool));
    expect(result).toEqual({ ok: false, status: 0, error: "capability 'reporting.portfolio-summary' has no SQL connector" });
  });
});

describe("invokeSql — driver errors never reach the caller (#120)", () => {
  const DSN = "postgres://app_runtime:p%40ss%2Fw0rd@10.0.3.7:5432/app";
  const PASSWORD_DECODED = "p@ss/w0rd";
  const LEAKS = ["10.0.3.7", "5432", "app_runtime", "db.internal", "postgres://", "p%40ss", PASSWORD_DECODED];

  type ClientScript = (text: string) => Promise<{ rows: Array<Record<string, unknown>> }>;
  function clientOf(script: ClientScript): PgPoolClient {
    return { query: vi.fn(script), release: vi.fn() };
  }
  const healthyCheck: ClientScript = async (text) => {
    if (isRead(text)) return { rows: [PASSING_ROW] };
    return { rows: [] };
  };

  async function run(pool: PgPool, opts: Record<string, unknown> = {}) {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    try {
      const result = await invokeSql(tool, { id: "1" }, baseOpts(pool, { env: { DATABASE_URL: DSN }, ...opts }));
      return { result, lines: stderr.mock.calls.map((c) => c.join(" ")), stdoutCalls: stdout.mock.calls.length, logCalls: log.mock.calls.length };
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      log.mockRestore();
    }
  }

  /** `run`, through the eager startup check (`serve`/`verify`) instead of an invocation. */
  async function runStartup(pool: PgPool) {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    try {
      const check = await checkConnectionPrivileges("DATABASE_URL", DSN, baseOpts(pool, { env: { DATABASE_URL: DSN } }));
      return { check, lines: stderr.mock.calls.map((c) => c.join(" ")), stdoutCalls: stdout.mock.calls.length, logCalls: log.mock.calls.length };
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      log.mockRestore();
    }
  }

  function expectNoLeak(text: string | undefined, extra: string[] = []) {
    for (const leak of [...LEAKS, ...extra]) expect(text).not.toContain(leak);
  }

  it("site 1 — startup check checkout failure: errno code only to the caller, scrubbed driver text to stderr", async () => {
    const message = "connect ECONNREFUSED 10.0.3.7:5432";
    const pool: PgPool = { connect: vi.fn(async () => { throw Object.assign(new Error(message), { code: "ECONNREFUSED" }); }) };
    const { check, lines, stdoutCalls, logCalls } = await runStartup(pool);
    expect(check).toEqual({ ok: false, error: "pool checkout failed while checking connection privileges (ECONNREFUSED)", incomplete: true });
    expectNoLeak(check.ok ? "" : check.error, [message]);
    expect(lines).toEqual([`archstone: pool checkout failed while checking connection privileges for 'DATABASE_URL' (ECONNREFUSED): ${message}`]);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  const deniedRead = (message: string): ClientScript => async (text) => {
    if (isRead(text)) throw Object.assign(new Error(message), { code: "42501" });
    return { rows: [] };
  };

  it("site 2 — startup check read failure: SQLSTATE only to the caller; the DSN and its password are scrubbed from stderr", async () => {
    const message = `permission denied for function pg_postmaster_start_time (user "app_runtime", dsn ${DSN}, password ${PASSWORD_DECODED})\nDETAIL: line two`;
    const pool: PgPool = { connect: vi.fn(async () => clientOf(deniedRead(message))) };
    const { check, lines, stdoutCalls, logCalls } = await runStartup(pool);
    expect(check).toEqual({ ok: false, error: "connection privilege check failed (SQLSTATE 42501)", incomplete: true });
    expectNoLeak(check.ok ? "" : check.error, ["permission denied"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "archstone: connection privilege check failed for 'DATABASE_URL' (SQLSTATE 42501): " +
        'permission denied for function pg_postmaster_start_time (user "app_runtime", dsn [dsn], password [redacted]) DETAIL: line two',
    );
    for (const secret of [DSN, "p%40ss%2Fw0rd", PASSWORD_DECODED, "\n"]) expect(lines[0]).not.toContain(secret);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("site 2 — per-transaction read failure: the existing 'query failed' path, SQLSTATE only to the caller, scrubbed on stderr", async () => {
    const message = `permission denied for function pg_postmaster_start_time (dsn ${DSN})`;
    const pool: PgPool = { connect: vi.fn(async () => clientOf(deniedRead(message))) };
    const { result, lines, stdoutCalls, logCalls } = await run(pool);
    expect(result).toEqual({ ok: false, status: 0, error: "query failed (SQLSTATE 42501)" });
    expectNoLeak(result.error, ["permission denied", "pg_postmaster_start_time"]);
    expect(lines).toEqual(["archstone: query failed for 'DATABASE_URL' (SQLSTATE 42501): permission denied for function pg_postmaster_start_time (dsn [dsn])"]);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("site 3 — a pool factory that throws: code only to the caller, the DSN scrubbed from stderr", async () => {
    const message = `invalid connection string ${DSN}`;
    const { result, lines, stdoutCalls, logCalls } = await run({ connect: vi.fn() }, {
      pgPoolFactory: () => { throw new Error(message); },
    });
    expect(result).toEqual({ ok: false, status: 0, error: "pool creation failed (error code unknown)" });
    expectNoLeak(result.error, ["invalid connection string"]);
    expect(lines).toEqual(["archstone: pool creation failed for 'DATABASE_URL' (error code unknown): invalid connection string [dsn]"]);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("site 3 — a pool factory that throws is not cached: no registry entry, and the next call creates the pool and proceeds (D-5)", async () => {
    const healthy: PgPool = { connect: vi.fn(async () => clientOf(healthyCheck)) };
    const factory = vi
      .fn<(dsn: string) => PgPool>()
      .mockImplementationOnce(() => { throw new Error(`invalid connection string ${DSN}`); })
      .mockImplementation(() => healthy);
    const connectionRegistry = new Map<string, ConnectionEntry>();
    const first = await run(healthy, { pgPoolFactory: factory, connectionRegistry });
    expect(first.result).toEqual({ ok: false, status: 0, error: "pool creation failed (error code unknown)" });
    expect(connectionRegistry.size).toBe(0);

    const second = await run(healthy, { pgPoolFactory: factory, connectionRegistry });
    expect(second.result).toEqual({ ok: true, status: 200, data: [] });
    expect(factory).toHaveBeenCalledTimes(2);
    expect(connectionRegistry.get(DSN)?.pool).toBe(healthy);
  });

  it("site 4 — per-call checkout failure: errno code only to the caller, host and role only on stderr", async () => {
    const message = 'password authentication failed for user "app_runtime" at db.internal';
    const connect = vi
      .fn<() => Promise<PgPoolClient>>()
      .mockRejectedValueOnce(Object.assign(new Error(message), { code: "ENOTFOUND" }));
    const { result, lines, stdoutCalls, logCalls } = await run({ connect });
    expect(result).toEqual({ ok: false, status: 0, error: "pool checkout failed (ENOTFOUND)" });
    expectNoLeak(result.error, [message]);
    expect(lines).toEqual([`archstone: pool checkout failed for 'DATABASE_URL' (ENOTFOUND): ${message}`]);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("site 5 — query failure: SQLSTATE only to the caller; no SQLSTATE class passes driver detail through", async () => {
    const message = 'duplicate key value violates unique constraint "accounts_email_key" on host 10.0.3.7';
    const connect = vi
      .fn<() => Promise<PgPoolClient>>()
      .mockResolvedValueOnce(
        clientOf(async (text) => {
          if (text.startsWith("SELECT id")) throw Object.assign(new Error(message), { code: "23505" });
          return healthyCheck(text);
        }),
      );
    const { result, lines, stdoutCalls, logCalls } = await run({ connect });
    expect(result).toEqual({ ok: false, status: 0, error: "query failed (SQLSTATE 23505)" });
    expectNoLeak(result.error, ["accounts_email_key", "duplicate key"]);
    expect(lines).toEqual([`archstone: query failed for 'DATABASE_URL' (SQLSTATE 23505): ${message}`]);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("an error with no code, or a code that is not code-shaped, reports 'error code unknown' and never echoes the code", async () => {
    const connect = vi
      .fn<() => Promise<PgPoolClient>>()
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "postgres://app_runtime@10.0.3.7" }));
    const { result, lines } = await run({ connect });
    expect(result.error).toBe("pool checkout failed (error code unknown)");
    expect(lines[0]).toContain("(error code unknown): boom");
    expectNoLeak(lines[0]);
  });

  it("a non-Error rejection, or one whose message is not a string, still yields the fixed caller string — logging never throws", async () => {
    const connect = vi
      .fn<() => Promise<PgPoolClient>>()
      .mockRejectedValueOnce(Object.create(null))
      .mockRejectedValueOnce(Object.assign(new Error(), { message: { host: "10.0.3.7" } }));
    const pool: PgPool = { connect };
    const first = await run(pool);
    expect(first.result).toEqual({ ok: false, status: 0, error: "pool checkout failed (error code unknown)" });
    expect(first.lines).toEqual(["archstone: pool checkout failed for 'DATABASE_URL' (error code unknown): (non-string error)"]);
    // Through the startup check, so this rejection lands on its own checkout (site 1).
    const second = await runStartup(pool);
    expect(second.check).toEqual({ ok: false, error: "pool checkout failed while checking connection privileges (error code unknown)", incomplete: true });
    expect(second.lines).toEqual([
      "archstone: pool checkout failed while checking connection privileges for 'DATABASE_URL' (error code unknown): (non-string error)",
    ]);
  });
});

describe("a literal (non-${VAR}) dsn is never echoed (#121)", () => {
  const LITERAL_DSN = "postgres://app:s3cr3tPW@db.internal:5432/app";
  const LEAKS = [LITERAL_DSN, "s3cr3tPW", "db.internal", "app:", "postgres://", "5432"];
  const literalTool: IRTool = { ...tool, connector: { type: "sql", sql: { ...tool.connector!.sql!, dsn: LITERAL_DSN } } };

  it("invokeSql refuses a literal dsn before any connection is used, naming no part of it", async () => {
    const { pool } = fakePool([]);
    const pgPoolFactory = vi.fn(() => pool);
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      const result = await invokeSql(literalTool, { id: "1" }, baseOpts(pool, { pgPoolFactory }));
      expect(result).toEqual({
        ok: false,
        status: 0,
        error: "capability 'reporting.portfolio-summary': sql dsn is not a ${VAR} reference; refusing before any connection is used",
      });
      for (const leak of LEAKS) expect(result.error).not.toContain(leak);
      expect(pgPoolFactory).not.toHaveBeenCalled();
      expect(pool.connect).not.toHaveBeenCalled();
      for (const call of stderr.mock.calls) for (const leak of LEAKS) expect(call.join(" ")).not.toContain(leak);
    } finally {
      stderr.mockRestore();
    }
  });

  it.each([
    ["rolsuper", { rolsuper: true, rolbypassrls: false }, undefined, /^connection for '\(unnamed dsn\)' uses a role with rolsuper = true/],
    ["rolbypassrls", { rolsuper: false, rolbypassrls: true }, undefined, /^connection for '\(unnamed dsn\)' uses a role with rolbypassrls = true/],
    ["ownership", undefined, { schema_name: "reporting", relation_name: "portfolio_summary_v" }, /^connection for '\(unnamed dsn\)' owns reporting\.portfolio_summary_v/],
  ])("the startup check called directly with a literal dsn as dsnEnvVar names it '(unnamed dsn)' in the %s refusal", async (_label, roleRow, ownedRow, expected) => {
    const client: PgPoolClient = {
      query: vi.fn(async (text: string) => {
        if (isRead(text)) return { rows: [{ ...PASSING_ROW, ...roleRow }] };
        if (isOwnership(text)) return { rows: ownedRow ? [ownedRow] : [] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool: PgPool = { connect: vi.fn(async () => client) };
    const check = await checkConnectionPrivileges(LITERAL_DSN, LITERAL_DSN, { pgPoolFactory: () => pool, connectionRegistry: new Map() });
    expect(check.ok).toBe(false);
    const error = check.ok ? "" : check.error;
    expect(error).toMatch(expected);
    for (const leak of LEAKS) expect(error).not.toContain(leak);
  });

  it.each([
    ["rolsuper", { rolsuper: true, rolbypassrls: false }],
    ["rolbypassrls", { rolsuper: false, rolbypassrls: true }],
  ])("a ${DATABASE_URL} dsn still names DATABASE_URL in the %s refusal", async (_label, roleRow) => {
    const { pool } = fakePool([], roleRow);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/^connection for 'DATABASE_URL' uses a role with /);
  });
});

describe("invokeSql — rows leave the provider JSON-safe (#146)", () => {
  class Interval {
    hours = 1;
  }
  it("Date → ISO string; bigint → string; non-finite → null; Buffer and class instances → null; jsonb walked", async () => {
    const { pool } = fakePool([
      {
        id: "1",
        at: new Date("2026-10-03T12:34:56.789Z"),
        bad: new Date("nope"),
        big: 9007199254740993n,
        nan: Number.NaN,
        blob: Buffer.from("secret"),
        bytes: new Uint8Array([1, 2]),
        span: new Interval(),
        doc: { when: new Date("2026-01-01T00:00:00.000Z"), list: [1, Buffer.from("x")], ok: true },
        proto: JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as Record<string, unknown>,
        nothing: null,
      },
    ]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.data).toEqual([
      {
        id: "1",
        at: "2026-10-03T12:34:56.789Z",
        bad: null,
        big: "9007199254740993",
        nan: null,
        blob: null,
        bytes: null,
        span: null,
        doc: { when: "2026-01-01T00:00:00.000Z", list: [1, null], ok: true },
        proto: JSON.parse('{"__proto__": {"polluted": true}, "a": 1}') as Record<string, unknown>,
        nothing: null,
      },
    ]);
    expect(JSON.stringify(result.data)).not.toContain("secret");
    // A jsonb `__proto__` key stays an own data property; it never becomes the row's prototype.
    const proto = (result.data as Array<Record<string, Record<string, unknown>>>)[0].proto;
    expect(Object.getPrototypeOf(proto)).toBe(Object.prototype);
    expect(Object.prototype.hasOwnProperty.call(proto, "__proto__")).toBe(true);
    expect((proto as { polluted?: unknown }).polluted).toBeUndefined();
    expect(JSON.stringify(proto)).toBe('{"__proto__":{"polluted":true},"a":1}');
  });
});

describe("jsonSafeTypeParser — the pool's type parsers (#146)", () => {
  it("DATE stays Postgres's 'YYYY-MM-DD' text, whatever the process TZ", () => {
    const previous = process.env.TZ;
    process.env.TZ = "Pacific/Kiritimati";
    try {
      expect(jsonSafeTypeParser(1082)("2026-10-03")).toBe("2026-10-03");
      expect(jsonSafeTypeParser(1182)("{2026-10-03,NULL,2026-10-04}")).toEqual(["2026-10-03", null, "2026-10-04"]);
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("timestamp (no zone) is read as UTC and sent as an ISO instant with Z, whatever the process TZ", () => {
    const previous = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(jsonSafeTypeParser(1114)("2026-10-03 12:34:56.789")).toBe("2026-10-03T12:34:56.789Z");
      expect(jsonSafeTypeParser(1114)("2026-10-03 12:34:56")).toBe("2026-10-03T12:34:56.000Z");
      expect(jsonSafeTypeParser(1115)('{"2026-10-03 12:34:56",NULL}')).toEqual(["2026-10-03T12:34:56.000Z", null]);
      expect(jsonSafeTypeParser(1114)("infinity")).toBe("infinity");
      expect(jsonSafeTypeParser(1114)("0044-03-15 12:00:00 BC")).toBe("0044-03-15 12:00:00 BC");
    } finally {
      if (previous === undefined) delete process.env.TZ;
      else process.env.TZ = previous;
    }
  });

  it("is exported for a caller-supplied pool to install (pg accepts it as `types.getTypeParser`)", () => {
    const pool = new Pool({ connectionString: "postgres://nobody@127.0.0.1:1/none", types: { getTypeParser: jsonSafeTypeParser } as PoolConfig["types"] });
    const installed = (pool as unknown as { options: { types: { getTypeParser: typeof jsonSafeTypeParser } } }).options.types;
    expect(installed.getTypeParser(1082)("2026-10-03")).toBe("2026-10-03");
    void pool.end();
  });

  it("timestamptz is an ISO instant in UTC; infinity stays text", () => {
    expect(jsonSafeTypeParser(1184)("2026-10-03 14:34:56.789+02")).toBe("2026-10-03T12:34:56.789Z");
    expect(jsonSafeTypeParser(1185)('{"2026-10-03 14:34:56+02"}')).toEqual(["2026-10-03T12:34:56.000Z"]);
    expect(jsonSafeTypeParser(1184)("infinity")).toBe("infinity");
  });

  it("every other type keeps pg's own parser (int4 → number, int8 → string, bool → boolean)", () => {
    expect(jsonSafeTypeParser(23)("21")).toBe(21);
    expect(jsonSafeTypeParser(20)("9007199254740993")).toBe("9007199254740993");
    expect(jsonSafeTypeParser(16)("t")).toBe(true);
  });
});
