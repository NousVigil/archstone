- **`archstone init` can now propose a manifest from a Postgres database** (`@archstone/init`,
  `@archstone/cli`, `@archstone/provider-sql`). `archstone init --source postgres --dsn-env <VAR>
  --out <dir>` connects as the runtime role, reads the catalog, and proposes one candidate per table,
  view or materialized view the role can `SELECT` — only the columns it may select. You choose per
  relation whether it is a list bounded by `LIMIT 100` or a lookup by one column; `json`, `jsonb` and
  array columns are left out with a note. The connection string is read from the named environment
  variable and the manifest carries `${VAR}`; a superuser, `BYPASSRLS` or owning role is refused with
  the same message `serve` and `verify` give, and nothing is written. With `--probe --identity-map`, a
  lookup can record a contract that is replayed as a second principal and must return nothing; a list,
  an unresolvable second principal or an empty first leg records none. `@archstone/provider-sql`
  exports `introspectCatalog`, the catalog read behind it. `init <spec-file>` is unchanged.
