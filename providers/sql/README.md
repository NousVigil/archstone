# @archstone/provider-sql

The `sql` connector for [Archstone](https://github.com/NousVigil/archstone). It binds a capability
to a read-only Postgres query. The database decides which tenant's rows a call can see: the
caller's identity reaches it as a transaction-scoped session setting, and a row-level security
policy reads that setting. The binding never names a tenant.

- Postgres only, `SELECT` only. Writes are out of scope.
- Node only. It opens TCP connections to Postgres, so it is not for edge runtimes.
- Most users want [`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli), which uses this
  package for `sql` bindings, instead of depending on it directly.

**Guide:** [The `sql` connector: a Postgres database as a backend](https://github.com/NousVigil/archstone/blob/main/docs/guides/sql-connector.md)
covers the database side (roles, row-level security, the view), the binding, the isolation test
with `archstone verify`, the privilege checks, and the error messages.

**Design record:** [ADR-0012](https://github.com/NousVigil/archstone/blob/main/docs/adr/0012-sql-provider-database-as-first-class-backend.md).
It is still a draft.

## License

Apache-2.0
