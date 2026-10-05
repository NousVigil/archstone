- **A database that was unreachable when its first `sql` call arrived stayed refused until
  restart.** `@archstone/provider-sql` cached the ADR-0012 D-9 over-privileged check per DSN, and
  it cached a failure to run the check the same way as a verdict. If the check's own pool
  checkout failed (the database down, `ECONNREFUSED`, a timeout), or a catalog query failed
  mid-check, every later call on that DSN was refused even after the database recovered. Now
  only a verdict is cached: an acceptable role, or a refusal for `rolsuper`, `rolbypassrls` or an
  owned-and-granted relation, which still holds for the life of the process. A failure to reach
  a verdict still fails that call closed, with the same error as before, and the next call runs
  the check again.
