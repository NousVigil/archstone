// @archstone/cli — ADR-0012 D-9's eager over-privileged-connection check.
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

/**
 * ADR-0012 D-9 layers 3/4 — the over-privileged-connection checks run "at `archstone verify` and
 * at `serve`/`serve --http` startup," and again inside every transaction after that (amended
 * 2026-10-05); this is the eager one, so a refusal does not wait for a binding's first real
 * invocation. Called once per distinct DSN found across every `sql`-bound tool in the
 * compiled registry, BEFORE `serve`/`serve --http` accepts a connection and BEFORE `verify`
 * reports a single result — so a superuser/BYPASSRLS/owns-and-granted DSN is refused at startup
 * or at the top of a CI gate, not on whichever request happens to reach it first.
 *
 * A DSN whose env var is unset is skipped (not a startup failure here): that is a configuration
 * gap `invokeSql`'s own "missing env var(s)" fail-closed path already reports at invocation
 * time, and is not the D-9 privilege question this check exists to answer eagerly.
 */
export async function checkSqlOverPrivilege(tools: IRTool[], opts: SqlInvokeOptions | undefined): Promise<string[]> {
  const seen = new Set<string>();
  const errors: string[] = [];
  for (const tool of tools) {
    if (tool.connector?.type !== "sql" || !tool.connector.sql) continue;
    const dsnEnvVar = dsnEnvVarName(tool.connector.sql.dsn);
    if (!dsnEnvVar) continue;
    const resolvedDsn = (opts?.env ?? process.env)[dsnEnvVar];
    if (resolvedDsn === undefined || seen.has(resolvedDsn)) continue;
    seen.add(resolvedDsn);
    // No catch: `checkConnectionPrivileges` does not throw on a driver failure. A pool that cannot
    // be created, or a D-9 read that cannot complete, is a failed check like any other, its
    // message already scrubbed of the DSN and its password (`driverFailure`).
    const check = await checkConnectionPrivileges(dsnEnvVar, resolvedDsn, opts ?? {});
    if (!check.ok) errors.push(check.error);
  }
  return errors;
}
