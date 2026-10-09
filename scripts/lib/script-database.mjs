// A throwaway Postgres database built from an example's own `fixture.sql` (ADR-0012 D-9 topology:
// an owner role that owns the data, a runtime role that logs in, owns nothing, and holds SELECT on
// a view). Shared by two consumers that cannot share TypeScript:
//
//   - scripts/release-gate.mjs, plain Node with no tsx and no dependencies of its own, which runs
//     `archstone verify` for every example that declares a `sql` binding (#162);
//   - providers/sql/test/support/postgres.ts, whose `createScriptDatabase` is a thin wrapper over
//     this, used by the real-Postgres CLI end-to-end test.
//
// Plain .mjs (typed by the sibling .d.mts) so both can import it: the gate cannot load .ts, and the
// test suite imports .mjs without ceremony. It never imports `pg` itself — the caller passes the
// module in. The gate resolves `pg` from the packed `@archstone/provider-sql` it installed (or from
// providers/sql in workspace mode); the test passes its own. That keeps the repo root free of
// dependencies, as the rest of scripts/ is.
//
// The admin url is used ONLY here, to create and drop the database and roles. What a caller hands
// to `archstone` is the runtime role's DSN, exactly as a deployment would.

import { randomBytes } from "node:crypto";
import { URL } from "node:url";

function quoteLiteral(s) {
  return `'${s.replace(/'/g, "''")}'`;
}

/** Pure — every role name a script creates, in order. */
export function rolesCreatedBy(sql) {
  return [...new Set([...sql.matchAll(/\bCREATE ROLE\s+(\w+)/gi)].map((m) => m[1]))];
}

/**
 * Pure — the script with every role it creates renamed through `rename`. Roles are cluster-global,
 * so a script's fixed names (`reporting_owner`, `reporting_runtime`) would collide between two runs
 * against the same server; every word-bounded occurrence is rewritten, so grants, `SET ROLE` and
 * `AUTHORIZATION` follow the rename.
 */
export function renameRoles(sql, rename) {
  const roles = rolesCreatedBy(sql);
  if (roles.length === 0) return sql;
  const re = new RegExp(`\\b(${roles.map((r) => r.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})\\b`, "g");
  return sql.replace(re, (name) => rename(name));
}

/**
 * The runtime role, read from the catalog rather than from a naming convention: among the roles the
 * script created, the one ADR-0012 D-9 describes — it can log in, is not a superuser, does not
 * bypass RLS, and owns no relation, schema or function. Exactly one must match; anything else is a
 * fixture this helper cannot connect as safely, and it says so.
 */
async function findRuntimeRole(client, createdNames) {
  const { rows } = await client.query(
    `SELECT r.rolname FROM pg_roles r
      WHERE r.rolname = ANY($1) AND r.rolcanlogin AND NOT r.rolsuper AND NOT r.rolbypassrls
        AND NOT EXISTS (SELECT 1 FROM pg_class c WHERE c.relowner = r.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_namespace n WHERE n.nspowner = r.oid)
        AND NOT EXISTS (SELECT 1 FROM pg_proc p WHERE p.proowner = r.oid)`,
    [createdNames],
  );
  if (rows.length !== 1) {
    throw new Error(
      `cannot tell which role the fixture means as its runtime role: expected exactly one created role that ` +
        `logs in, is NOSUPERUSER NOBYPASSRLS and owns nothing, found ${rows.length} (${rows.map((r) => r.rolname).join(", ") || "none"}).`,
    );
  }
  return rows[0].rolname;
}

/**
 * Create a fresh database, run `sql` in it as the admin (roles renamed run-unique), give the
 * runtime role a random password, and return its DSN.
 *
 * @param {object} opts
 * @param {*} opts.pg            the `pg` module (its default export)
 * @param {string} opts.adminUrl an admin url (superuser in CI and in the documented local container)
 * @param {string} opts.sql      the fixture script, with its own fixed role names
 * @param {string} [opts.runtimeRole] the script's name for the runtime role; derived from the catalog when omitted
 */
export async function createScriptDatabase({ pg, adminUrl, sql, runtimeRole }) {
  if (!adminUrl) throw new Error("createScriptDatabase called without an admin url");
  const suffix = randomBytes(4).toString("hex");
  const database = `archstone_it_${suffix}_script`;
  const prefix = `archstone_it_${suffix}_`;
  const rename = (role) => `${prefix}${role}`;
  const password = randomBytes(12).toString("hex");
  const urlFor = (user, pw) => {
    const u = new URL(adminUrl);
    if (user) u.username = encodeURIComponent(user);
    if (pw) u.password = encodeURIComponent(pw);
    u.pathname = `/${database}`;
    return u.toString();
  };
  const withDatabase = async (fn) => {
    const c = new pg.Client({ connectionString: urlFor() });
    c.on("error", () => undefined);
    await c.connect();
    try {
      return await fn(c);
    } finally {
      await c.end();
    }
  };
  const inDatabase = (text) => withDatabase((c) => c.query(text)).then(() => undefined);

  const script = renameRoles(sql, rename);
  const created = rolesCreatedBy(script);
  const server = new pg.Client({ connectionString: adminUrl });
  server.on("error", () => undefined);
  await server.connect();
  const teardown = async () => {
    for (let attempt = 0; ; attempt++) {
      try {
        await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
        break;
      } catch (err) {
        if (attempt >= 50) throw err;
        await new Promise((r) => setTimeout(r, 100));
      }
    }
    for (const role of created) await server.query(`DROP ROLE IF EXISTS ${role}`);
    await server.end();
  };

  let runtime;
  try {
    await server.query(`CREATE DATABASE ${database}`);
    await inDatabase(script);
    runtime = runtimeRole ? rename(runtimeRole) : await withDatabase((c) => findRuntimeRole(c, created));
    await inDatabase(`ALTER ROLE ${runtime} PASSWORD ${quoteLiteral(password)}`);
  } catch (err) {
    await teardown().catch(() => undefined);
    throw err;
  }
  return {
    dsn: urlFor(runtime, password),
    runtimeRole: runtime.slice(prefix.length),
    admin: inDatabase,
    teardown,
  };
}
