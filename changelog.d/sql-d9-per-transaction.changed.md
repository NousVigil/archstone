- **`ensureConnection` in `@archstone/provider-sql` no longer runs the D-9 check.** It is now
  synchronous and returns the pool with the DSN's cached refusal, if any (`{ pool, entry,
  refusal? }`, or `{ pool: undefined, error }` when no pool could be created). The eager check
  that `serve`, `serve --http` and `verify` run at startup is the new `checkConnectionPrivileges`.
  `ConnectionEntry.check` is replaced by `refusal` and a per-server-and-database `ownership` map.
  `invokeSql` no longer checks out a separate connection for the check on its first call.
