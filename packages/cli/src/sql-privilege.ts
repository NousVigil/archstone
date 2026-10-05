// @archstone/cli — ADR-0012 D-9's eager over-privileged-connection check, and the startup
// message that tells its refusals apart from checks that could not complete (#133).
//
// Extracted into its own module (rather than living inline in index.ts) so it is directly
// testable without importing index.ts itself, which calls `main()` as a side effect of being
// loaded.

import type { IRTool } from "@archstone/compiler";
import { checkConnectionPrivileges, type SqlInvokeOptions } from "@archstone/provider-sql";

/** The env-var NAME inside a `${VAR}`-shaped dsn — `connector.schema.json`'s pattern already
 *  guarantees this shape at `apply` time; a non-matching string here is unreachable via a
 *  compiled manifest and is skipped defensively rather than crashing the startup check. */
export function dsnEnvVarName(dsn: string): string | undefined {
  return /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(dsn)?.[1];
}

/** What the eager check found, split by whether a verdict was reached (#133). `refused` holds
 *  refusals — the connection IS over-privileged. `incomplete` holds checks that reached no
 *  verdict (the database was unreachable, the D-9 read or layer 4's query failed). Either one
 *  refuses startup; only the message differs, so an operator is not told a connection is
 *  over-privileged when nothing was learned about it. */
export interface SqlPrivilegeFindings {
  refused: string[];
  incomplete: string[];
}

/**
 * ADR-0012 D-9 layers 3/4 — the over-privileged-connection checks run "at `archstone verify` and
 * at `serve`/`serve --http` startup," and again inside every transaction after that (amended
 * 2026-10-05); this is the eager one, so a refusal does not wait for a binding's first real
 * invocation. Called once per distinct DSN found across every `sql`-bound tool in the
 * compiled registry, BEFORE `serve`/`serve --http` accepts a connection and BEFORE `verify`
 * reports a single result — so a superuser/BYPASSRLS/owns-and-granted DSN is refused at startup
 * or at the top of a CI gate, not on whichever request happens to reach it first.
 *
 * A check that could not complete is reported apart from a refusal (`incomplete`), and fails
 * startup just the same: no verdict is not a pass.
 *
 * A DSN whose env var is unset is skipped (not a startup failure here): that is a configuration
 * gap `invokeSql`'s own "missing env var(s)" fail-closed path already reports at invocation
 * time, and is not the D-9 privilege question this check exists to answer eagerly.
 */
export async function checkSqlOverPrivilege(tools: IRTool[], opts: SqlInvokeOptions | undefined): Promise<SqlPrivilegeFindings> {
  const seen = new Set<string>();
  const findings: SqlPrivilegeFindings = { refused: [], incomplete: [] };
  for (const tool of tools) {
    if (tool.connector?.type !== "sql" || !tool.connector.sql) continue;
    const dsnEnvVar = dsnEnvVarName(tool.connector.sql.dsn);
    if (!dsnEnvVar) continue;
    const resolvedDsn = (opts?.env ?? process.env)[dsnEnvVar];
    if (resolvedDsn === undefined || seen.has(resolvedDsn)) continue;
    seen.add(resolvedDsn);
    // No catch: `checkConnectionPrivileges` does not throw on a driver failure. A pool that cannot
    // be created, or a D-9 read that cannot complete, comes back `incomplete`, its message
    // already scrubbed of the DSN and its password (`driverFailure`).
    const check = await checkConnectionPrivileges(dsnEnvVar, resolvedDsn, opts ?? {});
    if (!check.ok) (check.incomplete ? findings.incomplete : findings.refused).push(check.error);
  }
  return findings;
}

/** Whether the eager check found anything that must stop startup — a refusal or a check that
 *  could not complete. */
export function sqlPrivilegeBlocksStartup(findings: SqlPrivilegeFindings): boolean {
  return findings.refused.length > 0 || findings.incomplete.length > 0;
}

/**
 * The stderr lines for a startup the eager check stopped, each group under its own header so a
 * check that reached no verdict never reads as an over-privileged connection (#133). `prefix` is
 * the surface's own lead, e.g. `archstone serve: refusing to start`. Pure: the caller prints.
 */
export function formatSqlPrivilegeFindings(prefix: string, findings: SqlPrivilegeFindings): string[] {
  const lines: string[] = [];
  if (findings.refused.length > 0) {
    lines.push(`${prefix} — over-privileged sql connection(s):`);
    for (const e of findings.refused) lines.push(`  - ${e}`);
  }
  if (findings.incomplete.length > 0) {
    lines.push(`${prefix} — sql connection privilege check(s) could not complete:`);
    for (const e of findings.incomplete) lines.push(`  - ${e}`);
  }
  return lines;
}

/** `verify --json`'s payload for a run the eager check stopped. */
export interface SqlPrivilegeJson {
  error: "sql_over_privileged" | "sql_privilege_check_incomplete";
  errors: string[];
  refused: string[];
  incomplete: string[];
}

/**
 * `verify --json`'s payload for a run the eager check stopped. `error` names a refusal if there
 * is one, and `sql_privilege_check_incomplete` only when no verdict was reached anywhere (#133).
 * `errors` stays the flat list existing consumers read, refusals first. Pure: the caller prints.
 */
export function sqlPrivilegeJson(findings: SqlPrivilegeFindings): SqlPrivilegeJson {
  return {
    error: findings.refused.length > 0 ? "sql_over_privileged" : "sql_privilege_check_incomplete",
    errors: [...findings.refused, ...findings.incomplete],
    refused: [...findings.refused],
    incomplete: [...findings.incomplete],
  };
}
