- **`archstone serve`, `serve --http` and `verify` no longer call a sql connection over-privileged
  when the D-9 check could not reach a verdict.** An unreachable database, a failed catalog query
  or a `pg_postmaster_start_time()` the runtime role cannot execute is now reported under
  `sql connection privilege check(s) could not complete:`, apart from a genuine refusal, which
  keeps `over-privileged sql connection(s):`. Both still exit 1. `verify --json` adds `refused`
  and `incomplete` arrays beside the existing `errors` (`@archstone/cli`). A CI script that
  matches `verify --json`'s `error === "sql_over_privileged"` on an unreachable database now sees
  `sql_privilege_check_incomplete` instead; the exit code and `errors` are unchanged. In
  `@archstone/provider-sql`, `checkConnectionPrivileges` marks a result that reached no verdict
  with `incomplete: true` (additive), and its no-verdict error now reads
  `connection privilege check failed (…)` instead of `over-privileged connection check failed (…)`.
