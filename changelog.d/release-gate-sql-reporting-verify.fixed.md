- **The release gate now verifies the `sql-reporting` example instead of failing on it.** It ran
  `archstone verify` on every example with only a mock URL in the environment, so the 0.31.0
  release stopped at `isolation not verified: negative identity did not resolve to any claims`.
  The gate now passes `--identity-map` to any example that ships an `identity-map.json`. For an
  example with a `sql` binding, it builds a database from the example's `fixture.sql` in the
  job's Postgres and connects as the fixture's runtime role, through the variable the binding's
  `dsn` names. If no database is configured, that example's verify fails rather than being
  skipped. Pull requests now run the same per-example build and verify against the workspace
  build, so an example that needs input the gate does not supply fails on its PR, not at
  release time (#162).
