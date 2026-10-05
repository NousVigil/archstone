- **A `sql` DSN re-pointed at another server kept the over-privileged verdict of the first one.**
  `@archstone/provider-sql` ran the ADR-0012 D-9 role and ownership checks once per DSN and
  cached the result for the life of the process, so a long-lived `serve --http` or embedded
  `execute()` kept serving after a logical-replication failover, a blue/green cut-over or a proxy
  re-pointed behind the same DSN, onto a server where the role could be a superuser, hold
  `BYPASSRLS` or own what it reads. Now every transaction reads the role's `rolsuper` and
  `rolbypassrls`, the server's `pg_postmaster_start_time()` and the database oid before any claim
  is set. The ownership check runs again the first time a transaction lands on a server and
  database it has not judged. A refusal reached mid-life refuses every later call on that DSN
  until restart, as one at startup does. A read that fails, for example because the runtime role
  cannot execute `pg_postmaster_start_time()`, fails the call with `query failed (…)` and caches
  nothing; at `serve` and `verify` startup it stops the process. Not covered: an
  `ALTER … OWNER TO` or a new `GRANT` on the same server and database while the process runs
  (ADR-0012 R-8); restart long-lived processes after one.
