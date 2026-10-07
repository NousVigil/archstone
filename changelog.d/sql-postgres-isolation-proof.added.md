- **The `sql` provider's isolation guarantee is now proven against a real Postgres, in CI, on
  every pull request.** Tenant isolation through a curated view and a forced row-level-security
  policy, no leakage across a pool of one connection, a call with no identity refused before any
  connection is used, a policy that fails closed on an unset setting, read-only enforcement, the
  D-9 over-privilege refusals (including a role reached only through a group membership) and
  `archstone verify` going red when the policy is removed all run against Postgres 18 and 16, and
  CI fails rather than skips when no database is available. New example
  `examples/manifests/sql-reporting` runs a `sql`-bound capability against the same database shape,
  with the SQL to build it and a check that it is indistinguishable from a `rest` one to an agent.
  ADR-0012 is amended where Postgres behaves differently from what it assumed: a transaction-local
  setting reads back as `''`, not `NULL`, once the transaction ends; a refused write carries
  `25006` or `42501` depending on the object; and a group membership, active or not, is invisible
  to the ownership check.
