# sql-reporting — a capability backed by Postgres, not an API

Harborline Capital lets each client's analyst ask about their **own** positions. The data is in a
Postgres database, there is no REST service in front of it, and the manifest is the same kind of
manifest as [`booking/`](../booking/) and [`bank/`](../bank/): a `capabilities.yaml`, one
capability, one resource, one binding. Only the binding's `connector.type` differs.

```
sql-reporting/
├── capabilities.yaml                       the company's contract — no mention of a database
├── reporting.get-position.capability.yaml  what an analyst can ask (CDL: business only)
├── reporting.Position.resource.yaml        what comes back
├── bindings/
│   └── reporting.get-position.binding.yaml connector.type: sql — the query, the row mapping, the contract
├── fixtures/
│   └── reporting.get-position.golden.json  the request `verify` replays, as whom, and as whom it must fail
├── identity-map.json                       caller principal → the tenant the database is told
└── fixture.sql                             the database side: roles, row-level security, the view
```

## The point: indistinguishable from `rest`

An agent cannot tell this from a REST-backed capability, and `archstone` can show it. The tests in
[`packages/cli/test/sql-postgres-e2e.integration.test.ts`](../../../packages/cli/test/sql-postgres-e2e.integration.test.ts)
swap this binding for a `rest` one and assert that the MCP tool — name, description, input schema,
output schema, annotations — is identical, and that a call returns byte-for-byte the same result
whether the rows came from Postgres or from an HTTP backend.

What differs is where isolation lives. For REST, the backend decides whose data a token may see.
For `sql`, **the database does**, and Archstone refuses to run against one that cannot:

- The binding names no tenant, and its grammar has no way to. The caller's identity reaches the
  database as a transaction-scoped setting (`app.tenant_id`) that a row-level-security policy reads.
- The runtime role (`reporting_runtime`) is not a superuser, does not bypass RLS, owns nothing and
  can `SELECT` one view. A connection that breaks any of that is refused before a query runs.
- Every statement runs in a `READ ONLY` transaction.
- `archstone verify` replays the recorded request as a **different** tenant and requires zero rows.
  Drop the policy and it goes red — see below.

## Run it

You need Docker, Node 22+ and pnpm (`pnpm install`). Postgres 16 or newer.

```bash
# 1. A throwaway database. The credentials are for this container only.
docker run -d --rm --name archstone-sql-demo -e POSTGRES_PASSWORD=admin-demo \
  -p 127.0.0.1:55432:5432 postgres:18
# (wait a few seconds for it to accept connections)

# 2. The fixture: roles, table, policy, view, seed rows.
docker exec archstone-sql-demo psql -U postgres -c 'CREATE DATABASE reporting'
docker exec -i archstone-sql-demo psql -U postgres -d reporting -v ON_ERROR_STOP=1 \
  < examples/manifests/sql-reporting/fixture.sql
docker exec archstone-sql-demo psql -U postgres -c "ALTER ROLE reporting_runtime PASSWORD 'runtime-demo'"

# 3. The binding's DSN is an env placeholder, never a literal. Connect as the RUNTIME role.
export REPORTING_DSN=postgres://reporting_runtime:runtime-demo@127.0.0.1:55432/reporting
```

```bash
# Validate and compile — offline, no database needed.
pnpm apply examples/manifests/sql-reporting

# Replay the recorded request as acme-analyst, then as globex-analyst (who must see nothing).
pnpm verify examples/manifests/sql-reporting --identity-map examples/manifests/sql-reporting/identity-map.json
#   🟢 reporting.get-position — fingerprint unchanged, mapping OK

# Serve it over MCP. Startup checks the connection's privileges first and refuses an over-privileged one.
pnpm serve examples/manifests/sql-reporting --identity-map examples/manifests/sql-reporting/identity-map.json
```

`serve` from the CLI starts and passes the same privilege check, but the CLI has no caller to
resolve — nobody is signed in on a stdio pipe — so a `sql` call made through it refuses: no
identity, no query. Per-caller calls come from a host that knows who is asking and passes a
`caller` into the runtime; the test above does exactly that, as `acme-analyst`.

### Break it, and watch `verify` say so

```bash
docker exec archstone-sql-demo psql -U postgres -d reporting -c 'ALTER TABLE app.positions DISABLE ROW LEVEL SECURITY'
pnpm verify examples/manifests/sql-reporting --identity-map examples/manifests/sql-reporting/identity-map.json
#   🔴 reporting.get-position — isolation test failed: 1 foreign row returned for capability 'reporting.get-position'
#   (exit code 1)
```

Replacing the policy with `USING (true)`, or dropping `FORCE ROW LEVEL SECURITY` (the view's owner is
then exempt), goes red the same way. Dropping the policy while RLS stays forced is default-deny, so it
leaks nothing; `verify` reports it yellow instead, because tenant A's own replay is empty too and no
longer matches the recorded contract.

Clean up with `docker stop archstone-sql-demo`.

## What the database side looks like

[`fixture.sql`](fixture.sql) is the topology the [ADR](../../../docs/adr/0012-sql-provider-database-as-first-class-backend.md)
asks for, in about sixty lines:

| | |
|---|---|
| `reporting_owner` | owns the table and the view. The role migrations run as; nothing connects as it. |
| `reporting_runtime` | what the DSN connects as. `NOSUPERUSER NOBYPASSRLS`, owns nothing, `SELECT` on `app.positions_v` only. |
| `app.positions` | has a `tenant_id`, `ENABLE` + `FORCE ROW LEVEL SECURITY`, and one policy: `tenant_id = app.current_tenant_id()`. |
| `app.current_tenant_id()` | reads `app.tenant_id` and **raises** when it is unset or empty — a session with no identity gets an error, not an empty result. |
| `app.positions_v` | the curated surface (a `security_barrier` view). Columns it leaves out, like `internal_cost`, are unreachable. |

The same shape is what the real-Postgres test suites build (they add a few extra roles to probe
the refusals); `fixture.sql` itself is run by the example's own test, so what this README tells you
to run is what is checked.
