import { EventEmitter } from "node:events";
import { describe, it, expect, vi } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeSql, type PgPool, type PgPoolClient, type ConnectionEntry } from "../src/index";

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

/** A fake pool that records every query issued against it — no real Postgres involved. */
function fakePool(rows: Array<Record<string, unknown>>, roleRow?: Record<string, unknown>) {
  const queries: Array<{ text: string; params?: unknown[] }> = [];
  const released = vi.fn();
  const client: PgPoolClient = {
    query: vi.fn(async (text: string, params?: unknown[]) => {
      queries.push({ text, params });
      if (text.includes("pg_roles") && text.includes("rolsuper")) {
        return { rows: roleRow ? [roleRow] : [{ rolsuper: false, rolbypassrls: false }] };
      }
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
  it("runs BEGIN, SET TRANSACTION READ ONLY, set_config per claim, the query, COMMIT, then releases", async () => {
    const { pool, queries, released } = fakePool([{ id: "1", headline: "Q1" }]);
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result).toEqual({ ok: true, status: 200, data: [{ id: "1", headline: "Q1" }] });
    // The first connection checkout runs D-9's over-privileged check (pg_roles, then the
    // ownership query) — cached thereafter. The transaction itself is a SECOND checkout.
    const texts = queries.map((q) => q.text);
    const beginIdx = texts.indexOf("BEGIN");
    expect(beginIdx).toBeGreaterThan(0);
    expect(texts[beginIdx + 1]).toBe("SET TRANSACTION READ ONLY");
    expect(texts[beginIdx + 2]).toBe("SELECT set_config($1, $2, true)");
    expect(queries[beginIdx + 2].params).toEqual(["app.tenantId", "acme"]);
    expect(texts[beginIdx + 3]).toBe("SELECT id, headline FROM reporting.portfolio_summary_v WHERE id = $1");
    expect(queries[beginIdx + 3].params).toEqual(["1"]);
    expect(texts[beginIdx + 4]).toBe("COMMIT");
    // Released once for the check's own connection, once for the transaction's.
    expect(released).toHaveBeenCalledTimes(2);
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
        if (text.includes("pg_roles")) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
        if (text.includes("role_table_grants")) return { rows: [] };
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
      expect(released).toHaveBeenCalledTimes(2); // the check's connection, and the transaction's
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
  it("refuses a superuser connection, naming rolsuper, before running the query", async () => {
    const { pool, queries } = fakePool([{ id: "1" }], { rolsuper: true, rolbypassrls: false });
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rolsuper/);
    expect(queries.some((q) => q.text === "BEGIN")).toBe(false);
  });

  it("refuses a BYPASSRLS role, naming rolbypassrls", async () => {
    const { pool } = fakePool([], { rolsuper: false, rolbypassrls: true });
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/rolbypassrls/);
  });

  it("refuses a role that owns a relation it also holds a grant on, naming the exact schema.relation", async () => {
    const queries: Array<{ text: string }> = [];
    const client: PgPoolClient = {
      query: vi.fn(async (text: string) => {
        queries.push({ text });
        if (text.includes("rolsuper")) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
        if (text.includes("role_table_grants")) return { rows: [{ schema_name: "reporting", relation_name: "portfolio_summary_v" }] };
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const pool: PgPool = { connect: vi.fn(async () => client) };
    const result = await invokeSql(tool, { id: "1" }, baseOpts(pool));
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/reporting\.portfolio_summary_v/);
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
    const ownershipQuery = queries.find((q) => q.text.includes("role_table_grants"))?.text ?? "";
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

  it("caches the over-privileged check across invocations on the same DSN (checked once, not per-call)", async () => {
    const { pool, client } = fakePool([{ id: "1" }]);
    const opts = baseOpts(pool);
    await invokeSql(tool, { id: "1" }, opts);
    await invokeSql(tool, { id: "1" }, opts);
    const roleCheckCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls.filter(([text]: [string]) => text.includes("rolsuper")).length;
    expect(roleCheckCalls).toBe(1);
  });
});

describe("invokeSql — response mapping surface (D-7)", () => {
  it("returns the driver's row array verbatim as data — undeclared columns are dropped later, by applyResponseMapping, not here", async () => {
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
      expect(result).toEqual({ ok: false, status: 0, error: "pool checkout failed while checking connection privileges (error code unknown)" });
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
      const check = entry.check;
      expect(pool.listenerCount("error")).toBe(1);

      const message = 'terminating connection due to administrator command (host "db.internal", user "runtime")';
      expect(() => pool.emit("error", Object.assign(new Error(message), { code: "57P01" }))).not.toThrow();

      expect(stderr).toHaveBeenCalledTimes(1);
      const line = stderr.mock.calls[0].join(" ");
      expect(line).toContain("'DATABASE_URL'");
      expect(line).toContain("SQLSTATE 57P01");
      for (const leak of ["postgres://", "s3cret", "db.internal", "runtime", "terminating connection"]) expect(line).not.toContain(leak);
      expect(stdout).not.toHaveBeenCalled();

      // No eviction: the same entry (pool and D-9 check) serves the next call, and the role
      // check is not re-run.
      expect((await invokeSql(tool, { id: "1" }, opts)).ok).toBe(true);
      expect(opts.connectionRegistry.get("postgres://runtime:s3cret@db.internal:5432/app")).toBe(entry);
      expect(entry.pool).toBe(pool);
      expect(entry.check).toBe(check);
      const roleCheckCalls = (client.query as ReturnType<typeof vi.fn>).mock.calls.filter(([text]: [string]) => text.includes("rolsuper")).length;
      expect(roleCheckCalls).toBe(1);
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
    const queue = [freshClient, dying, freshClient];
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
      // First call: the D-9 check uses freshClient; the transaction gets the dying client.
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
    if (text.includes("rolsuper")) return { rows: [{ rolsuper: false, rolbypassrls: false }] };
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

  function expectNoLeak(text: string | undefined, extra: string[] = []) {
    for (const leak of [...LEAKS, ...extra]) expect(text).not.toContain(leak);
  }

  it("site 1 — D-9 checkout failure: errno code only to the caller, scrubbed driver text to stderr", async () => {
    const message = "connect ECONNREFUSED 10.0.3.7:5432";
    const pool: PgPool = { connect: vi.fn(async () => { throw Object.assign(new Error(message), { code: "ECONNREFUSED" }); }) };
    const { result, lines, stdoutCalls, logCalls } = await run(pool);
    expect(result).toEqual({ ok: false, status: 0, error: "pool checkout failed while checking connection privileges (ECONNREFUSED)" });
    expectNoLeak(result.error, [message]);
    expect(lines).toEqual([`archstone: pool checkout failed while checking connection privileges for 'DATABASE_URL' (ECONNREFUSED): ${message}`]);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("site 2 — D-9 check query failure: SQLSTATE only to the caller; the DSN and its password are scrubbed from stderr", async () => {
    const message = `permission denied for table pg_roles (user "app_runtime", dsn ${DSN}, password ${PASSWORD_DECODED})\nDETAIL: line two`;
    const pool: PgPool = {
      connect: vi.fn(async () => clientOf(async () => { throw Object.assign(new Error(message), { code: "42501" }); })),
    };
    const { result, lines, stdoutCalls, logCalls } = await run(pool);
    expect(result).toEqual({ ok: false, status: 0, error: "over-privileged connection check failed (SQLSTATE 42501)" });
    expectNoLeak(result.error, ["permission denied"]);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "archstone: over-privileged connection check failed for 'DATABASE_URL' (SQLSTATE 42501): " +
        'permission denied for table pg_roles (user "app_runtime", dsn [dsn], password [redacted]) DETAIL: line two',
    );
    for (const secret of [DSN, "p%40ss%2Fw0rd", PASSWORD_DECODED, "\n"]) expect(lines[0]).not.toContain(secret);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("site 3 — a pool factory that throws: code only to the caller, the DSN scrubbed from stderr", async () => {
    const message = `invalid connection string ${DSN}`;
    const { result, lines, stdoutCalls, logCalls } = await run({ connect: vi.fn() }, {
      pgPoolFactory: () => { throw new Error(message); },
    });
    expect(result).toEqual({ ok: false, status: 0, error: "pool checkout failed (error code unknown)" });
    expectNoLeak(result.error, ["invalid connection string"]);
    expect(lines).toEqual(["archstone: pool checkout failed for 'DATABASE_URL' (error code unknown): invalid connection string [dsn]"]);
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("site 4 — per-call checkout failure: errno code only to the caller, host and role only on stderr", async () => {
    const message = 'password authentication failed for user "app_runtime" at db.internal';
    const connect = vi
      .fn<() => Promise<PgPoolClient>>()
      .mockResolvedValueOnce(clientOf(healthyCheck))
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
      .mockResolvedValueOnce(clientOf(healthyCheck))
      .mockResolvedValueOnce(
        clientOf(async (text) => {
          if (text.startsWith("SELECT id")) throw Object.assign(new Error(message), { code: "23505" });
          return { rows: [] };
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
      .mockResolvedValueOnce(clientOf(healthyCheck))
      .mockRejectedValueOnce(Object.assign(new Error("boom"), { code: "postgres://app_runtime@10.0.3.7" }));
    const { result, lines } = await run({ connect });
    expect(result.error).toBe("pool checkout failed (error code unknown)");
    expect(lines[0]).toContain("(error code unknown): boom");
    expectNoLeak(lines[0]);
  });

  it("a non-Error rejection, or one whose message is not a string, still yields the fixed caller string — logging never throws", async () => {
    const connect = vi
      .fn<() => Promise<PgPoolClient>>()
      .mockResolvedValueOnce(clientOf(healthyCheck))
      .mockRejectedValueOnce(Object.create(null))
      .mockRejectedValueOnce(Object.assign(new Error(), { message: { host: "10.0.3.7" } }));
    const pool: PgPool = { connect };
    const first = await run(pool);
    expect(first.result).toEqual({ ok: false, status: 0, error: "pool checkout failed (error code unknown)" });
    expect(first.lines).toEqual(["archstone: pool checkout failed for 'DATABASE_URL' (error code unknown): (non-string error)"]);
    // A fresh registry, so this rejection lands on the D-9 check's checkout (site 1).
    const second = await run(pool);
    expect(second.result).toEqual({ ok: false, status: 0, error: "pool checkout failed while checking connection privileges (error code unknown)" });
    expect(second.lines).toEqual([
      "archstone: pool checkout failed while checking connection privileges for 'DATABASE_URL' (error code unknown): (non-string error)",
    ]);
  });
});
