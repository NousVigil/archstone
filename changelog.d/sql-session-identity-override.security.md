- **A `sql` binding's query could set the caller's identity itself and read another tenant's rows
  (#218).** `@archstone/provider-sql` sets each identity claim with `set_config(…, true)` and then
  runs the declared query in the same transaction, so a query such as
  `WITH s AS MATERIALIZED (SELECT set_config('app.tenant_id', $1, true)) SELECT … FROM some_view`
  replaced the claim before row-level security read it. `apply` only checked that the query began
  with `SELECT` or `WITH`. Now `apply` refuses a query that calls `set_config` (in any case,
  schema-qualified, or as a quoted identifier) or contains a `SET`, `SET LOCAL`, `SET SESSION` or
  `RESET` statement, judged with comments and string literals blanked out, so `current_setting`
  and the word in a string or comment still pass. Independently, `invokeSql` reads every claim back
  after the query and before `COMMIT`; one that no longer holds the value it set rolls the
  transaction back and returns no rows, with an error that names the capability and no claim
  value. The limit: a query that changes a setting and restores it before it ends leaves nothing
  to read back, so only the `apply` check stands against it, and that check sees only the query
  text — not a database function the query calls that does the same on its behalf.
