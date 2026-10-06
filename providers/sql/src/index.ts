// @archstone/provider-sql — SQL provider (ADR-0012)
//
// Binds a capability directly to Postgres. Read-only (`SELECT`), tenant-of-deployment
// isolation enforced by the DATABASE (RLS / security-barrier views + a runtime role that is
// not the table owner and does not hold BYPASSRLS) — never by binding-author discipline. This
// is a NODE-ONLY package: it opens a raw TCP socket and holds pooled, stateful connections,
// both incompatible with an edge isolate's per-request model (D-5). Never imported from
// `@archstone/runtime`'s `http` subpath or from the compiler/IR/emitter-support layers.

import { Pool, types, type PoolConfig } from "pg";
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
 *  (the static leading-keyword check) lives in `compiler/src/validate.ts`, offline, at `apply`.
 *
 *  `incomplete: true` marks a check that reached no verdict — pool creation, the checkout, the
 *  D-9 read or layer 4's query failed (#133). It still fails closed. Absent, a failed check's
 *  `error` is a refusal: a verdict that the connection is over-privileged. */
export type OverPrivilegeCheck = { ok: true } | { ok: false; error: string; incomplete?: true };

export interface ConnectionEntry {
  pool: PgPool;
  /** D-9's refusal for this DSN, once one is reached — at startup or mid-life, by layer 3 or 4.
   *  It holds for the life of the process: every later call against the DSN is refused before a
   *  connection is checked out (ADR-0012 D-9, "When layers 3 and 4 re-run", ruling 3). */
  refusal?: string;
  /** D-9 layer 4's verdict per (server, database) this DSN has reached, keyed by
   *  `serverKey` — settled once judged, pending while a transaction is judging it (ruling 2).
   *  Only a verdict stays: a check that failed to reach one is removed again (#127, per key). */
  ownership: Map<string, Promise<OverPrivilegeCheck>>;
}

/** Process-wide, keyed by the RESOLVED dsn string (D-5: "One pg.Pool per process… reused across
 *  invocations"). A test supplies its own `connectionRegistry` in `SqlInvokeOptions` instead of
 *  reaching into this module-level state. */
const defaultRegistry = new Map<string, ConnectionEntry>();

export interface SqlInvokeOptions extends BaseInvokeOptions {
  /** Constructs a pool for a resolved DSN. Defaults to a real `pg.Pool`; a test supplies a fake
   *  pool that never opens a socket. */
  pgPoolFactory?: PgPoolFactory;
  /** Overrides the process-wide connection cache (pool + cached D-9 verdicts),
   *  primarily for test isolation — each test gets its own registry rather than sharing the
   *  module-level `Map` across the whole vitest worker. */
  connectionRegistry?: Map<string, ConnectionEntry>;
  /** D-5: deployer-configured pool size, never a product surface. Defaults small (`pg`'s own
   *  default, 10) — connection pooling is explicitly not sold as a configurable feature beyond
   *  this one knob. */
  poolConfig?: Pick<PoolConfig, "max" | "connectionTimeoutMillis" | "idleTimeoutMillis">;
}

const ENV_RE = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

function defaultPoolFactory(dsn: string, poolConfig?: SqlInvokeOptions["poolConfig"]): PgPool {
  return new Pool({ connectionString: dsn, ...poolConfig, types: { getTypeParser: jsonSafeTypeParser } as PoolConfig["types"] }) as unknown as PgPool;
}

const PG_DATE = 1082;
const PG_TIMESTAMP = 1114;
const PG_TIMESTAMPTZ = 1184;
const PG_TEXT_ARRAY = 1009;
const PG_DATE_ARRAY = 1182;
const PG_TIMESTAMP_ARRAY = 1115;
const PG_TIMESTAMPTZ_ARRAY = 1185;

/** `pg`'s own parser for an OID. Its typings admit only the built-in scalar ids; array ids are real. */
const pgParser = (oid: number, format?: string): ((value: string) => unknown) =>
  format === "binary"
    ? types.getTypeParser(oid as Parameters<typeof types.getTypeParser>[0], "binary")
    : types.getTypeParser(oid as Parameters<typeof types.getTypeParser>[0]);

const parseDate = (v: string): string => v; // 'YYYY-MM-DD' as Postgres prints it — never a local-midnight Date
const parseTimestamp = (v: string): string => v.replace(" ", "T"); // wall-clock, no zone: never shifted into one
function parseTimestamptz(v: string): string {
  const d: unknown = pgParser(PG_TIMESTAMPTZ)(v);
  return d instanceof Date && !Number.isNaN(d.getTime()) ? d.toISOString() : v; // `infinity` stays text
}

/**
 * The pool's type parsers (#146): `pg`'s defaults turn date and timestamp columns into JS `Date`
 * objects, which are not JSON, so the response mapper treats them as absent. A DATE comes back as
 * Postgres's own `YYYY-MM-DD` text (pg's default would build a Date at LOCAL midnight and shift the
 * day in any zone west of UTC); a `timestamp` (no zone) as its wall-clock ISO text; a
 * `timestamptz` as an ISO instant in UTC. Their array types get the same treatment per element.
 * Every other type keeps `pg`'s parser; `jsonSafeRows` then covers what remains non-JSON.
 */
export function jsonSafeTypeParser(oid: number, format?: string): (value: string) => unknown {
  if (format === "binary") return pgParser(oid, "binary");
  const scalar = { [PG_DATE]: parseDate, [PG_TIMESTAMP]: parseTimestamp, [PG_TIMESTAMPTZ]: parseTimestamptz }[oid];
  if (scalar) return scalar;
  const element = { [PG_DATE_ARRAY]: parseDate, [PG_TIMESTAMP_ARRAY]: parseTimestamp, [PG_TIMESTAMPTZ_ARRAY]: parseTimestamptz }[oid];
  if (element) {
    const textArray = pgParser(PG_TEXT_ARRAY);
    const mapDeep = (x: unknown): unknown => (Array.isArray(x) ? x.map(mapDeep) : typeof x === "string" ? element(x) : x);
    return (v: string) => mapDeep(textArray(v));
  }
  return pgParser(oid);
}

/**
 * Make query rows JSON-safe before they leave the provider (#146): a provider returns JSON, and the
 * response mapper treats any non-JSON object as absent. A `Date` (from a custom parser or a fake
 * pool) becomes its ISO string; a `bigint` its decimal string; a non-finite number `null`. A value
 * with no JSON form — `bytea` (`Buffer`), an `interval` object, any other class instance — is
 * explicitly `null`, i.e. absent, never forwarded as an object. `json`/`jsonb` values (plain objects
 * and arrays) are walked the same way. `bigint`/`numeric` columns already arrive as strings.
 */
export function jsonSafeRows(rows: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return rows.map((row) => jsonSafe(row) as Record<string, unknown>);
}

function jsonSafe(v: unknown): unknown {
  if (v === null || v === undefined || typeof v === "string" || typeof v === "boolean") return v;
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  if (typeof v === "bigint") return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v.toISOString();
  if (Array.isArray(v)) return v.map(jsonSafe);
  if (typeof v === "object") {
    const proto: unknown = Object.getPrototypeOf(v);
    if (proto !== Object.prototype && proto !== null) return null; // Buffer, interval, any class instance
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v)) out[k] = jsonSafe(x);
    return out;
  }
  return null; // function, symbol
}

/** The DSN's env var name, or `(unnamed dsn)`. `invokeSql` refuses a dsn that is not
 *  `${VAR}`-shaped, but `ensureConnection` is exported and takes `dsnEnvVar` from its caller —
 *  a literal DSN passed there (it can carry a password) is never echoed. */
function safeDsnName(dsnEnvVar: string): string {
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(dsnEnvVar) ? dsnEnvVar : "(unnamed dsn)";
}

/** Classify a driver error's `code`. A SQLSTATE is five of [0-9A-Z]; Postgres has no class
 *  starting with "E", so a five-letter errno such as EPIPE is a socket code. Anything else not
 *  errno-shaped — absent, or a code carrying arbitrary text — is unknown. */
function classifyErrorCode(err: unknown): { sqlState?: string; errno?: string } {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code !== "string") return {};
  if (/^[0-9A-Z]{5}$/.test(code) && !/^E[A-Z]{4}$/.test(code)) return { sqlState: code };
  if (/^E[A-Z0-9_]{1,31}$/.test(code)) return { errno: code };
  return {};
}

/** Remove the DSN, and the password inside it (raw and URL-decoded), from a driver message, and
 *  keep it to one line. Defensive: `pg` does not normally echo either, but a parse error can. */
function scrubDriverMessage(message: string, resolvedDsn: string): string {
  let out = resolvedDsn ? message.split(resolvedDsn).join("[dsn]") : message;
  let password = "";
  try {
    password = new URL(resolvedDsn).password;
  } catch {
    // Not a URL-shaped DSN — no password to locate.
  }
  if (password) {
    const secrets = [password];
    try {
      secrets.push(decodeURIComponent(password));
    } catch {
      // Malformed percent-encoding — the raw form is still scrubbed.
    }
    for (const secret of secrets) if (secret) out = out.split(secret).join("[redacted]");
  }
  return out.replace(/[\r\n]+/g, " ");
}

/**
 * The caller-facing failure for a driver error, and one operator line on stderr — never stdout,
 * which stdio `serve` reserves for MCP.
 *
 * The CALLER (whose `InvokeResult.error` reaches the model) gets `<context> (<code>)` only — a
 * SQLSTATE, a socket code such as ECONNREFUSED, or `error code unknown` — never the driver's
 * message, which can carry the host, port, role and schema names. STDERR gets the DSN's env var
 * name, the same code, and the driver's message with the DSN and its password scrubbed out.
 */
function driverFailure(context: string, dsnEnvVar: string, resolvedDsn: string, err: unknown): string {
  const { sqlState, errno } = classifyErrorCode(err);
  const detail = sqlState ? `SQLSTATE ${sqlState}` : (errno ?? "error code unknown");
  // Never throws: inside the D-9 check a throw would turn its fail-closed result into a rejection.
  // `String(err)` throws on a null-prototype object, and a non-string `message` breaks the scrub.
  const raw = err instanceof Error ? err.message : err;
  const message = typeof raw === "string" ? raw : "(non-string error)";
  console.error(`archstone: ${context} for '${safeDsnName(dsnEnvVar)}' (${detail}): ${scrubDriverMessage(message, resolvedDsn)}`);
  return `${context} (${detail})`;
}

/** One line on stderr — never stdout, which stdio `serve` reserves for MCP. Names the DSN's env
 *  var and the error code only (a SQLSTATE, or a socket code such as ECONNRESET): never the DSN,
 *  and — unlike `driverFailure` — never the driver's message, even scrubbed: nobody asked for
 *  this connection, so there is no in-flight call whose diagnosis it serves. */
function logIdleClientError(dsnEnvVar: string, err: unknown): void {
  const { sqlState, errno } = classifyErrorCode(err);
  const detail = sqlState ? `SQLSTATE ${sqlState}` : errno ? `error code ${errno}` : "error code unknown";
  console.error(`archstone: an idle connection for '${safeDsnName(dsnEnvVar)}' failed (${detail}); discarded it, the pool keeps serving`);
}

/**
 * ADR-0012 D-9 ruling 1's read: layer 3's role attributes, and the (server, database) key layer
 * 4's verdict is cached under. Sent as a statement of its own inside a read-only transaction,
 * after `SET TRANSACTION READ ONLY` and before any `set_config` (D-4): a transaction is the one
 * unit that stays on one backend, on a direct connection and through a session- or
 * transaction-pooling proxy alike, so the answer is about the server that runs the declared query.
 *
 * `server_started` is rendered in UTC with a fixed format, not read as a `timestamptz` (which
 * `pg` parses into a millisecond `Date`) nor cast `::text` (which follows the session's TimeZone
 * and DateStyle, so one server could yield several keys): the key is the same from every session
 * and keeps the microseconds that tell two server processes apart (R-9).
 */
const SERVER_AND_ROLE_READ = `SELECT rolsuper, rolbypassrls,
       to_char(pg_postmaster_start_time() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US') AS server_started,
       (SELECT oid FROM pg_database WHERE datname = current_database()) AS database_oid
FROM pg_roles WHERE rolname = current_user`;

type ServerAndRole = { rolsuper?: unknown; rolbypassrls?: unknown; server_started?: unknown; database_oid?: unknown };

/** D-9 layer 3 — role-level: a refusal if the connecting role is superuser or holds BYPASSRLS. */
function roleRefusal(row: ServerAndRole | undefined, dsnEnvVar: string): string | undefined {
  if (row?.rolsuper === true) {
    return `connection for '${safeDsnName(dsnEnvVar)}' uses a role with rolsuper = true; the runtime role must not be a superuser — see the topology guide`;
  }
  if (row?.rolbypassrls === true) {
    return `connection for '${safeDsnName(dsnEnvVar)}' uses a role with rolbypassrls = true; the runtime role must not bypass row-level security — see the topology guide`;
  }
  return undefined;
}

/** The layer-4 cache key: the server process (`pg_postmaster_start_time()`) and the database
 *  (its oid) the transaction landed on (ruling 2). Kept internal — never put in a caller-facing
 *  string. A read that cannot name both is a failed read, never a verdict (ruling 4): it throws. */
function serverKey(row: ServerAndRole | undefined): string {
  const started = row?.server_started;
  const oid = row?.database_oid;
  if (started === null || started === undefined || oid === null || oid === undefined) {
    throw new Error("the D-9 read returned no server start time or database oid");
  }
  return `${started instanceof Date ? started.toISOString() : String(started)}|${String(oid)}`;
}

/**
 * D-9 layer 4 — relation-level: refuse if the connecting role both OWNS a relation and can
 * also REACH it through a grant (direct or PUBLIC) — the exact set a bound `sql` capability
 * could actually read, with no query-text parsing.
 */
async function checkOwnership(client: PgClient, dsnEnvVar: string): Promise<OverPrivilegeCheck> {
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
      error: `connection for '${safeDsnName(dsnEnvVar)}' owns ${owned.schema_name}.${owned.relation_name}, which it also holds a grant on — the runtime role must not own any relation it can query — see the topology guide`,
    };
  }
  return { ok: true };
}

/**
 * D-9 layers 3 and 4 inside the read-only transaction `client` has open (ADR-0012 D-9, "When
 * layers 3 and 4 re-run", rulings 1–4). Live, and therefore never reached from `apply`, which
 * stays fully offline. No flag exists anywhere in this module to bypass either check (ruling 5).
 *
 * Returns the refusal, if any, having cached it as the DSN's (ruling 3); `undefined` lets the
 * transaction go on to set claims and run its query. Layer 3 is judged on every call. Layer 4
 * runs only when this transaction's key has no verdict: an in-flight check for the same key is
 * awaited rather than repeated (ruling 2). Throws when the read or layer 4's query fails — no
 * verdict, nothing cached, and the next transaction on that key judges it again (ruling 4, #127).
 */
async function judgeTransaction(client: PgClient, entry: ConnectionEntry, dsnEnvVar: string): Promise<string | undefined> {
  const row = (await client.query(SERVER_AND_ROLE_READ)).rows[0] as ServerAndRole | undefined;
  let refusal = roleRefusal(row, dsnEnvVar);
  if (refusal === undefined) {
    const key = serverKey(row);
    let check = entry.ownership.get(key);
    if (!check) {
      const own = checkOwnership(client, dsnEnvVar);
      check = own;
      entry.ownership.set(key, own);
      // No verdict: clear it so the next transaction on this key retries — unless a newer check
      // has replaced it (#127's guard, per key). Every waiter on `own` fails with it.
      own.catch(() => {
        if (entry.ownership.get(key) === own) entry.ownership.delete(key);
      });
    }
    const verdict = await check;
    if (!verdict.ok) refusal = verdict.error;
  }
  // The first refusal reached stays the DSN's verdict; a later one never replaces it.
  if (refusal !== undefined) entry.refusal ??= refusal;
  return refusal;
}

/** Best-effort: the connection is about to be released regardless; a failed ROLLBACK (e.g. the
 *  connection itself died) is not a second error worth surfacing. */
async function rollbackQuietly(client: PgClient): Promise<void> {
  try {
    await client.query("ROLLBACK");
  } catch {
    // See above.
  }
}

/** What `ensureConnection` returns. `pool` is `undefined` exactly when no pool could be created
 *  for the DSN; `error` is then that failure, already scrubbed. Otherwise `refusal` is the DSN's
 *  cached D-9 refusal, if one has been reached. */
export type EnsuredConnection =
  | { pool: PgPool; entry: ConnectionEntry; refusal?: string }
  | { pool: undefined; entry?: undefined; error: string };

/**
 * Get (or lazily create) this DSN's pool, and return it with the DSN's cached D-9 refusal. Runs
 * no check (ADR-0012 D-9 ruling 2): every transaction judges its own backend, and the eager
 * startup check is `checkConnectionPrivileges`.
 *
 * Does not throw on a driver failure. A pool that cannot be created (the factory, or `pg`'s Pool constructor, threw —
 * its message can carry the DSN and its password) comes back as `error`, scrubbed through
 * `driverFailure` like every other driver failure, and is not cached: no registry entry is made,
 * so the next call retries (D-5).
 */
export function ensureConnection(dsnEnvVar: string, resolvedDsn: string, opts: SqlInvokeOptions): EnsuredConnection {
  const registry = opts.connectionRegistry ?? defaultRegistry;
  let entry = registry.get(resolvedDsn);
  if (!entry) {
    let pool: PgPool;
    try {
      pool = opts.pgPoolFactory ? opts.pgPoolFactory(resolvedDsn) : defaultPoolFactory(resolvedDsn, opts.poolConfig);
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
    } catch (err) {
      // Inside the try so a pool without its 'error' listener never enters the registry.
      return { pool: undefined, error: driverFailure("pool creation failed", dsnEnvVar, resolvedDsn, err) };
    }
    // Deliberately no eviction of the pool, nor of its verdicts (#119): replacing it would orphan
    // clients checked out of the old one and leak it, never `end()`ed.
    entry = { pool, ownership: new Map() };
    registry.set(resolvedDsn, entry);
  }
  return { pool: entry.pool, entry, refusal: entry.refusal };
}

/**
 * D-9's eager check, called only at `serve`/`serve --http`/`verify` startup, so `serve` refuses
 * before it accepts a connection and `verify` before it reports a result (ADR-0012 D-9 ruling 2).
 * On a checkout of its own, it reads ruling 1's row in a read-only transaction and runs layer 4
 * when the key it lands on has no verdict yet — recording both in the same cache entry every
 * later transaction consults, so a process that never fails over runs layer 4 once.
 *
 * Never throws. A failure to reach a verdict — pool creation, the checkout, the read (for example
 * `pg_postmaster_start_time()` not executable, R-9) or layer 4's query — fails closed, comes back
 * marked `incomplete: true` so a caller can tell it from a refusal (#133), and caches nothing, so
 * a later check or call reads again (#122). A refusal — cached, or reached here — carries no mark.
 */
export async function checkConnectionPrivileges(dsnEnvVar: string, resolvedDsn: string, opts: SqlInvokeOptions): Promise<OverPrivilegeCheck> {
  const connection = ensureConnection(dsnEnvVar, resolvedDsn, opts);
  if (connection.pool === undefined) return { ok: false, error: connection.error, incomplete: true };
  if (connection.refusal !== undefined) return { ok: false, error: connection.refusal };
  let client: PgPoolClient;
  try {
    client = await connection.pool.connect();
  } catch (err) {
    return { ok: false, error: driverFailure("pool checkout failed while checking connection privileges", dsnEnvVar, resolvedDsn, err), incomplete: true };
  }
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY"); // D-9 layer 2, D-4
    const refusal = await judgeTransaction(client, connection.entry, dsnEnvVar);
    if (refusal !== undefined) {
      await rollbackQuietly(client);
      return { ok: false, error: refusal };
    }
    await client.query("COMMIT");
    return { ok: true };
  } catch (err) {
    await rollbackQuietly(client);
    return { ok: false, error: driverFailure("connection privilege check failed", dsnEnvVar, resolvedDsn, err), incomplete: true };
  } finally {
    client.release();
  }
}

/** D-3: `${claim key} -> app.<claim key>` by default. Deployer-configured, never CDL content. */
function gucName(prefix: string, claim: string): string {
  return `${prefix}${claim}`;
}

/**
 * Invoke a compiled capability against its Postgres backend.
 *
 * One invocation = exactly one transaction: `BEGIN; SET TRANSACTION READ ONLY; <D-9 read>;
 * [<D-9 layer 4>]; set_config(...) per identity claim; <declared query>; COMMIT` (or `ROLLBACK`
 * on a refusal or any error, D-4). Performs NO AUTHORIZATION beyond the identity-adapter fail-closed gate below (D-3) —
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

  // Shape-validated at apply (BR-2); refused here too, naming none of it — a literal DSN can
  // carry a password, and this result reaches the model.
  const dsnMatch = ENV_RE.exec(sql.dsn);
  if (!dsnMatch) {
    return { ok: false, status: 0, error: `capability '${tool.id}': sql dsn is not a \${VAR} reference; refusing before any connection is used` };
  }
  const dsnEnvVar = dsnMatch[1];
  const resolvedDsn = env[dsnEnvVar];
  if (resolvedDsn === undefined) {
    return { ok: false, status: 0, error: `missing env var(s): ${dsnEnvVar}` };
  }
  if (!resolvedDsn) {
    return { ok: false, status: 0, error: `capability '${tool.id}': no dsn resolved` };
  }

  // Never throws: a pool that cannot be created comes back as `pool: undefined` with its
  // failure already scrubbed through `driverFailure`.
  const connection = ensureConnection(dsnEnvVar, resolvedDsn, opts);
  if (connection.pool === undefined) {
    return { ok: false, status: 0, error: connection.error };
  }
  // D-9 ruling 3: a refusal already reached for this DSN — at startup or by an earlier
  // transaction — refuses every later call before a connection is checked out, for the life of
  // the process. No flag exists anywhere in this module to bypass it.
  if (connection.refusal !== undefined) {
    return { ok: false, status: 0, error: connection.refusal };
  }

  let client: PgPoolClient;
  try {
    client = await connection.pool.connect();
  } catch (err) {
    // BR-24 / EC-9: the same fail-closed shape `invokeRest` returns on a fetch failure — no
    // unbounded queuing, no silent hang.
    return { ok: false, status: 0, error: driverFailure("pool checkout failed", dsnEnvVar, resolvedDsn, err) };
  }
  // D-9 ruling 3, again: a refusal cached while this call waited for a client (another
  // transaction reached it) refuses it before anything runs on that client.
  if (connection.entry.refusal !== undefined) {
    client.release();
    return { ok: false, status: 0, error: connection.entry.refusal };
  }

  const gucPrefix = opts.sqlSessionGucPrefix ?? "app.";
  try {
    await client.query("BEGIN");
    await client.query("SET TRANSACTION READ ONLY"); // D-9 layer 2, D-4
    // D-9 layers 3 and 4, in this transaction, on the backend about to run the query — before
    // any claim is set (rulings 1–2). A read that fails throws into the catch below.
    const refusal = await judgeTransaction(client, connection.entry, dsnEnvVar);
    if (refusal !== undefined) {
      await rollbackQuietly(client);
      return { ok: false, status: 0, error: refusal };
    }
    for (const [key, value] of Object.entries(claims)) {
      // set_config(..., true): transaction-scoped (`is_local`). Postgres resets it the instant
      // the transaction ends, whether COMMIT or ROLLBACK — no cleanup code to get wrong, and no
      // way for a pooled connection to leak a previous caller's identity into the next one.
      await client.query("SELECT set_config($1, $2, true)", [gucName(gucPrefix, key), value]);
    }
    const values = sql.params.map((name) => input[name]);
    const result = await client.query(sql.query, values);
    await client.query("COMMIT");
    return { ok: true, status: 200, data: jsonSafeRows(result.rows) };
  } catch (err) {
    // D-9 ruling 4: a failed D-9 read or layer-4 query lands here too — a failed call, never a
    // verdict, and nothing is cached.
    await rollbackQuietly(client);
    return { ok: false, status: 0, error: driverFailure("query failed", dsnEnvVar, resolvedDsn, err) };
  } finally {
    client.release();
  }
}
