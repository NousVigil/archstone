// @archstone/provider-sql — SQL provider (ADR-0012)
//
// Binds a capability directly to Postgres. Read-only (`SELECT`), tenant-of-deployment
// isolation enforced by the DATABASE (RLS / security-barrier views + a runtime role that is
// not the table owner and does not hold BYPASSRLS) — never by binding-author discipline. This
// is a NODE-ONLY package: it opens a raw TCP socket and holds pooled, stateful connections,
// both incompatible with an edge isolate's per-request model (D-5). Never imported from
// `@archstone/runtime`'s `http` subpath or from the compiler/IR/emitter-support layers.

import { Pool, type PoolConfig } from "pg";
import type { IRTool } from "@archstone/compiler";
import { hasIdentityClaims, type InvokeOptions as BaseInvokeOptions } from "@archstone/emitter-support";

export interface InvokeResult {
  ok: boolean;
  status: number;
  data?: unknown;
  error?: string;
}

/**
 * A minimal, structurally-`pg`-compatible pool shape — deliberately narrow so a test can inject
 * a fake pool with no real Postgres server. `pg.Pool` satisfies this interface as-is.
 */
export interface PgQueryResult {
  rows: Array<Record<string, unknown>>;
}
export interface PgClient {
  query(text: string, params?: unknown[]): Promise<PgQueryResult>;
}
export interface PgPoolClient extends PgClient {
  release(err?: unknown): void;
  /** A checked-out `pg.Client` emits its own 'error' when its backend dies mid-call. Optional,
   *  like `PgPool.on`, so a minimal fake need not implement it. */
  on?(event: "error", listener: (err: Error) => void): unknown;
}
export interface PgPool {
  connect(): Promise<PgPoolClient>;
  /** `pg.Pool` re-emits an IDLE client's error as 'error' (backend terminated by a restart,
   *  failover, `pg_terminate_backend`, `idle_session_timeout`) and announces every new client as
   *  'connect'. Optional so a minimal fake need not implement it; a pool without it gets no
   *  listeners. */
  on?(event: "error", listener: (err: Error) => void): unknown;
  on?(event: "connect", listener: (client: PgPoolClient) => void): unknown;
}

export type PgPoolFactory = (dsn: string) => PgPool;

/** D-9's four independent read-only/over-privileged enforcements — this module owns layers
 *  2 (transaction READ ONLY), 3 (role superuser/BYPASSRLS) and 4 (relation ownership). Layer 1
 *  (the static leading-keyword check) lives in `compiler/src/validate.ts`, offline, at `apply`. */
export type OverPrivilegeCheck = { ok: true } | { ok: false; error: string };

export interface ConnectionEntry {
  pool: PgPool;
  /** Cached across every invocation against this DSN for the life of the process — D-9's checks
   *  run "on first connection per DSN", not on every call. */
  check?: Promise<OverPrivilegeCheck>;
}

/** Process-wide, keyed by the RESOLVED dsn string (D-5: "One pg.Pool per process… reused across
 *  invocations"). A test supplies its own `connectionRegistry` in `SqlInvokeOptions` instead of
 *  reaching into this module-level state. */
const defaultRegistry = new Map<string, ConnectionEntry>();

export interface SqlInvokeOptions extends BaseInvokeOptions {
  /** Constructs a pool for a resolved DSN. Defaults to a real `pg.Pool`; a test supplies a fake
   *  pool that never opens a socket. */
  pgPoolFactory?: PgPoolFactory;
  /** Overrides the process-wide connection cache (pool + cached over-privileged check),
   *  primarily for test isolation — each test gets its own registry rather than sharing the
   *  module-level `Map` across the whole vitest worker. */
  connectionRegistry?: Map<string, ConnectionEntry>;
  /** D-5: deployer-configured pool size, never a product surface. Defaults small (`pg`'s own
   *  default, 10) — connection pooling is explicitly not sold as a configurable feature beyond
   *  this one knob. */
  poolConfig?: Pick<PoolConfig, "max" | "connectionTimeoutMillis" | "idleTimeoutMillis">;
}

const ENV_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function resolveDsn(dsn: string, env: Record<string, string | undefined>): { value?: string; missing?: string } {
  const m = ENV_RE.exec(dsn);
  if (!m) return { value: dsn }; // shape-validated at apply (BR-2) — defensive fallback only
  const name = m[1];
  const value = env[name];
  if (value === undefined) return { missing: name };
  return { value };
}

function defaultPoolFactory(dsn: string, poolConfig?: SqlInvokeOptions["poolConfig"]): PgPool {
  return new Pool({ connectionString: dsn, ...poolConfig }) as unknown as PgPool;
}

/** One line on stderr — never stdout, which stdio `serve` reserves for MCP. Names the DSN's env
 *  var and the error code only (a SQLSTATE, or a socket code such as ECONNRESET): never the DSN,
 *  and never the driver's message, which can carry the host and user. */
function logIdleClientError(dsnEnvVar: string, err: unknown): void {
  const code = (err as { code?: unknown } | null)?.code;
  // `invokeSql` falls back to the literal `dsn` when it is not `${VAR}`-shaped (apply refuses
  // that shape; defensive only) — never echo that value.
  const name = /^[A-Za-z_][A-Za-z0-9_]*$/.test(dsnEnvVar) ? dsnEnvVar : "(unnamed dsn)";
  // A SQLSTATE is five of [0-9A-Z]; Postgres has no class starting with "E", so a five-letter
  // errno such as EPIPE is a socket code. Anything else not errno-shaped is reported as unknown.
  const isSqlState = typeof code === "string" && /^[0-9A-Z]{5}$/.test(code) && !/^E[A-Z]{4}$/.test(code);
  const isSocketCode = typeof code === "string" && /^E[A-Z0-9_]{1,31}$/.test(code);
  const detail = isSqlState ? `SQLSTATE ${code}` : isSocketCode ? `error code ${code}` : "error code unknown";
  console.error(`archstone: an idle connection for '${name}' failed (${detail}); discarded it, the pool keeps serving`);
}

/**
 * D-9 layer 3 — role-level: refuse if the connecting role is superuser or holds BYPASSRLS.
 * D-9 layer 4 — relation-level: refuse if the connecting role both OWNS a relation and can
 * also REACH it through a grant (direct or PUBLIC) — the exact set a bound `sql` capability
 * could actually read, with no query-text parsing.
 *
 * Live, and therefore only ever called from `verify`/`serve` startup — NEVER from `apply`,
 * which stays fully offline. No flag exists anywhere in this module to bypass either check.
 */
async function checkOverPrivileged(client: PgClient, dsnEnvVar: string): Promise<OverPrivilegeCheck> {
  const roleResult = await client.query("SELECT rolsuper, rolbypassrls FROM pg_roles WHERE rolname = current_user");
  const role = roleResult.rows[0] as { rolsuper?: boolean; rolbypassrls?: boolean } | undefined;
  if (role?.rolsuper === true) {
    return {
      ok: false,
      error: `connection for '${dsnEnvVar}' uses a role with rolsuper = true; the runtime role must not be a superuser — see the topology guide`,
    };
  }
  if (role?.rolbypassrls === true) {
    return {
      ok: false,
      error: `connection for '${dsnEnvVar}' uses a role with rolbypassrls = true; the runtime role must not bypass row-level security — see the topology guide`,
    };
  }

  const ownershipResult = await client.query(
    `SELECT n.nspname AS schema_name, c.relname AS relation_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')
       AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
       AND EXISTS (
         SELECT 1 FROM information_schema.role_table_grants g
         WHERE g.grantee IN (current_user, 'PUBLIC')
           AND g.table_schema = n.nspname
           AND g.table_name = c.relname
       )
     LIMIT 1`,
  );
  const owned = ownershipResult.rows[0] as { schema_name?: string; relation_name?: string } | undefined;
  if (owned?.schema_name && owned.relation_name) {
    return {
      ok: false,
      error: `connection for '${dsnEnvVar}' owns ${owned.schema_name}.${owned.relation_name}, which it also holds a grant on — the runtime role must not own any relation it can query — see the topology guide`,
    };
  }
  return { ok: true };
}

/**
 * Get (or lazily create) this DSN's pool + cached over-privileged check. Exported so `verify`/
 * `serve` startup and `archstone init`'s introspection connection can all run the SAME check
 * against the SAME cache entry (D-9: "the same entry points... never `apply`").
 */
export async function ensureConnection(
  dsnEnvVar: string,
  resolvedDsn: string,
  opts: SqlInvokeOptions,
): Promise<{ pool: PgPool; check: OverPrivilegeCheck }> {
  const registry = opts.connectionRegistry ?? defaultRegistry;
  let entry = registry.get(resolvedDsn);
  if (!entry) {
    const pool = opts.pgPoolFactory ? opts.pgPoolFactory(resolvedDsn) : defaultPoolFactory(resolvedDsn, opts.poolConfig);
    // D-5: a connection whose backend dies (restart, failover, `pg_terminate_backend`,
    // `idle_session_timeout`) emits 'error', and an unlistened 'error' event takes the whole
    // `serve` process down. Attached once, here, so the default factory and an injected
    // `pgPoolFactory` are covered alike.
    // - IDLE: pg-pool re-emits on the pool and has already dropped the client; the next
    //   `connect()` opens a fresh one.
    pool.on?.("error", (err) => logIdleClientError(dsnEnvVar, err));
    // - CHECKED OUT (mid-call): pg-pool detaches its own idle listener on checkout, so the
    //   client needs a permanent one of its own. Silent on purpose: the in-flight query rejects
    //   and fails closed through `invokeSql`'s catch, `release()` drops the dead client, and an
    //   idle error already logs once through the pool listener above.
    pool.on?.("connect", (client) => client.on?.("error", () => undefined));
    // Deliberately no eviction of this entry (pool or D-9 `check`): the check is a property of
    // the role behind the DSN, which a dropped backend does not change, so re-running it buys
    // nothing; and replacing the pool would orphan clients checked out of the old one and leak
    // it, never `end()`ed.
    entry = { pool };
    registry.set(resolvedDsn, entry);
  }
  if (!entry.check) {
    entry.check = (async () => {
      let client: PgPoolClient;
      try {
        client = await entry!.pool.connect();
      } catch (err) {
        return { ok: false, error: `pool checkout failed while checking connection privileges: ${(err as Error).message}` };
      }
      try {
        return await checkOverPrivileged(client, dsnEnvVar);
      } catch (err) {
        return { ok: false, error: `over-privileged connection check failed: ${(err as Error).message}` };
      } finally {
        client.release();
      }
    })();
  }
  return { pool: entry.pool, check: await entry.check };
}

/** D-3: `${claim key} -> app.<claim key>` by default. Deployer-configured, never CDL content. */
function gucName(prefix: string, claim: string): string {
  return `${prefix}${claim}`;
}

/**
 * Invoke a compiled capability against its Postgres backend.
 *
 * One invocation = exactly one transaction: `BEGIN; SET TRANSACTION READ ONLY;
 * set_config(...) per identity claim; <declared query>; COMMIT` (or `ROLLBACK` on any error,
 * D-4). Performs NO AUTHORIZATION beyond the identity-adapter fail-closed gate below (D-3) —
 * `policies:[authenticated]`/rate-limiting/lifecycle gating all live upstream, exactly as they
 * do for `invokeRest`.
 */
export async function invokeSql(tool: IRTool, input: Record<string, unknown>, opts: SqlInvokeOptions = {}): Promise<InvokeResult> {
  const env = opts.env ?? process.env;

  const connector = tool.connector;
  if (!connector || connector.type !== "sql" || !connector.sql) {
    return { ok: false, status: 0, error: `capability '${tool.id}' has no SQL connector` };
  }
  const sql = connector.sql;

  // D-3: fail closed BEFORE any connection is used. No `identityAdapter` configured, or one
  // that cannot resolve THIS principal, refuses the call outright — there is no "run with no
  // session identity" path. An empty claims object `{}` is unresolved too: it would set no
  // session GUC, so it refuses with the same message as `undefined`.
  const claims = opts.identityAdapter?.(opts.caller?.principal);
  if (!hasIdentityClaims(claims)) {
    return {
      ok: false,
      status: 0,
      error: `capability '${tool.id}': no session identity resolved for this caller — identityAdapter is unset, or returned no claims for this principal; refusing before any connection is used`,
    };
  }

  const dsnMatch = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(sql.dsn);
  const dsnEnvVar = dsnMatch?.[1] ?? sql.dsn;
  const { value: resolvedDsn, missing } = resolveDsn(sql.dsn, env);
  if (missing) {
    return { ok: false, status: 0, error: `missing env var(s): ${missing}` };
  }
  if (!resolvedDsn) {
    return { ok: false, status: 0, error: `capability '${tool.id}': no dsn resolved` };
  }

  let connection: { pool: PgPool; check: OverPrivilegeCheck };
  try {
    connection = await ensureConnection(dsnEnvVar, resolvedDsn, opts);
  } catch (err) {
    return { ok: false, status: 0, error: `pool checkout failed: ${(err as Error).message}` };
  }
  // D-9 layers 3/4 — the check itself runs once, on first connection per DSN (cached above);
  // its RESULT then gates every subsequent invocation against that same DSN, for the life of
  // the process — a refusal holds for the connection's whole lifetime, not just its opening
  // moment, and no flag exists anywhere in this module to bypass either check.
  if (!connection.check.ok) {
    return { ok: false, status: 0, error: connection.check.error };
  }

  let client: PgPoolClient;
  try {
    client = await connection.pool.connect();
  } catch (err) {
    // BR-24 / EC-9: the same fail-closed shape `invokeRest` returns on a fetch failure — no
    // unbounded queuing, no silent hang.
    return { ok: false, status: 0, error: `pool checkout failed: ${(err as Error).message}` };
  }

  const gucPrefix = opts.sqlSessionGucPrefix ?? "app.";
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY"); // D-9 layer 2, D-4
    for (const [key, value] of Object.entries(claims)) {
      // set_config(..., true): transaction-scoped (`is_local`). Postgres resets it the instant
      // the transaction ends, whether COMMIT or ROLLBACK — no cleanup code to get wrong, and no
      // way for a pooled connection to leak a previous caller's identity into the next one.
      await client.query("SELECT set_config($1, $2, true)", [gucName(gucPrefix, key), value]);
    }
    const values = sql.params.map((name) => input[name]);
    const result = await client.query(sql.query, values);
    await client.query("COMMIT");
    return { ok: true, status: 200, data: result.rows };
  } catch (err) {
    try {
      await client.query("ROLLBACK");
    } catch {
      // Best-effort: the connection is about to be released regardless; a failed ROLLBACK
      // (e.g. the connection itself died) is not a second error worth surfacing.
    }
    return { ok: false, status: 0, error: `query failed: ${(err as Error).message}` };
  } finally {
    client.release();
  }
}
