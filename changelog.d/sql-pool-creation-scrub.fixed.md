- **A connection pool that could not be created no longer prints its raw error at `serve`/`verify`
  startup.** The ADR-0012 D-9 startup check echoed the pool factory's (or the `pg` Pool
  constructor's) own message unscrubbed, and that message can carry the DSN and its password.
  `ensureConnection` in `@archstone/provider-sql` no longer throws: a pool that cannot be created
  is a failed check, reported through the same path as every other driver failure — the error
  code only, with the DSN and its password scrubbed from the one stderr line — and is not cached,
  so the next call retries. The string for this case is now `pool creation failed (…)` at startup
  and at invocation; invocation previously said `pool checkout failed (…)`.
  Terminal hygiene: the unscrubbed message never reached the model.
