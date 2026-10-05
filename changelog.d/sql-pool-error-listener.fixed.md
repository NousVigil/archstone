- **A Postgres connection closed under `archstone serve` crashed the process.**
  `@archstone/provider-sql` attached no `'error'` listener to its `pg.Pool` or to the clients it
  checked out. When Postgres terminated a pooled connection (a restart, a failover,
  `pg_terminate_backend`, `idle_session_timeout`), Node threw an unhandled `'error'` event and the
  process exited. This happened whether the connection was idle or in the middle of a call. Now
  a dead idle connection is discarded, the next call opens a fresh one, and one line goes to
  stderr naming only the DSN's env var and the error code (never the DSN, host, user or driver
  message). A call whose connection dies in flight fails closed with `query failed`, and the
  dead connection is dropped on release. The listeners are attached to a pool from an injected
  `pgPoolFactory` too, when it implements `on`.
