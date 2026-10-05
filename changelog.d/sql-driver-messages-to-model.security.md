- **`@archstone/provider-sql` passed Postgres driver messages to the model.** When a pool
  checkout, the over-privileged connection check, or a query failed, the error returned to the
  caller included node-postgres' own message, which can name the database host and port
  (`connect ECONNREFUSED 10.0.3.7:5432`), the role (`password authentication failed for user
  "app_runtime"`), and constraint or relation names. That result reaches the model. Now the
  caller gets a fixed message and the error code only: `query failed (SQLSTATE 25006)`,
  `pool checkout failed (ECONNREFUSED)`, or `(error code unknown)` when there is no code. The
  driver's message goes to one stderr line for the operator, named by the DSN's env var, with the
  DSN and its password removed. No SQLSTATE class passes driver detail through to the caller.
