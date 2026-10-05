- **`@archstone/provider-sql` could echo a literal DSN to the model.** When a binding's `dsn` was
  not a `${VAR}` reference, `invokeSql` used the DSN itself, password included, where the env var
  name belongs, and the over-privileged connection refusals (`rolsuper`, `rolbypassrls`, an owned
  relation) returned it to the caller. `apply` already refuses that shape, so this was reachable
  only past it. Now `invokeSql` refuses a non-`${VAR}` dsn before any connection is used, with an
  error that names no part of it, and the refusals from the exported `ensureConnection` name a
  DSN that is not an env var name as `(unnamed dsn)`.
