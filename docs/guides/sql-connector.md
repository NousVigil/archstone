# The `sql` connector: a Postgres database as a backend

This guide shows how to put a read-only Postgres query behind a capability, how the database
keeps one tenant's rows away from another, and how to prove that with `archstone verify`. It
follows the worked example in [`examples/manifests/sql-reporting/`](../../examples/manifests/sql-reporting/)
from the database side to a running tool.

The design is recorded in [ADR-0012](../adr/0012-sql-provider-database-as-first-class-backend.md),
which is still a draft. This guide describes what the code does today; where the ADR and the code
differ, the code is what runs, and the differences are called out in the sections below.

## Before you start

- **Node 22 or newer**, and **pnpm 11 or newer**.
- **Postgres 16 or newer.** The example's README asks for 16 or newer. The provider's integration
  suites run against 16 and 18. The commands in this guide were run against Postgres 18.6.
- **From a checkout** of this repository: `pnpm install && pnpm build`. The root scripts are
  `pnpm apply`, `pnpm verify` and `pnpm serve`. There is no root script for `build` (the root
  `build` script builds every package), so run `pnpm exec tsx packages/cli/src/index.ts build <dir>`
  in its place.
- **From npm**, the same commands are `archstone apply`, `archstone verify` and so on, from
  [`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli).
- `archstone init --source postgres` is **not in 0.34.0**. It is unreleased. Until the next
  release, run it from a checkout.

Commands that start with `pnpm` run from the repository root.

---

## 1. What it is, and the one rule

A `sql` binding is a file in `bindings/` that says how one capability reads a Postgres database.
The capability itself does not change. An agent sees the same tool whether a REST API or a
database sits behind it.

The one rule: **SQL text appears only in binding files** (`bindings/*.binding.yaml`). A
`*.capability.yaml` names no table, no query and no tenant. The compiler checks this, as far as
it can, when you run `apply`:

- The query must begin with `SELECT`, or with `WITH` and a `SELECT`. Anything else is refused.
- Every `$n` in the query needs an entry in `params`, and every `params` entry needs a `$n`.
- Each `params` entry must name a declared input of the capability.
- `dsn` must be a single environment variable reference, `${VAR}`. A literal connection string is
  refused.

### Tenant identity is never in the query

The binding has no field for identity, and the query text is never templated with a caller's
value. The query binds only its declared parameters, through the driver's parameter list.

Identity reaches the database another way. Each call runs in one transaction. Inside it, the
provider sets one session variable per identity claim, with `set_config(..., true)`. The third
argument makes the setting local to the transaction, so Postgres clears it at `COMMIT` or
`ROLLBACK`. A pooled connection cannot carry one caller's identity into the next call.

The sequence, as `invokeSql` runs it in `providers/sql/src/index.ts`:

```
BEGIN;
SET TRANSACTION READ ONLY;                              -- every call is read-only
<the role and server checks, see section 6>;
SELECT set_config('app.tenant_id', $1, true);           -- one per claim the host resolved
<the declared query, with its $n parameters>;
COMMIT;                                                 -- or ROLLBACK on any error
```

The claim key `tenant_id` becomes the variable `app.tenant_id`. The `app.` prefix is the default.
It can be changed with `--sql-guc-prefix` on the CLI, or `sqlSessionGucPrefix` in code. The
claims come from an identity adapter that the host supplies. The binding cannot set them.

A row-level security policy in the database reads that variable. The example's policy is in
section 2.

---

## 2. The database side: what to ask the DBA

The example's [`fixture.sql`](../../examples/manifests/sql-reporting/fixture.sql) is the reference.
It creates the roles, the table, the policy and the view in about sixty lines. The statements below
are copied from it. The comments are shortened.

The excerpts below are not a runnable script on their own (they leave out the table and the
`SET ROLE`). To build the example database, load the whole of `fixture.sql` as a superuser, as the
example's [README](../../examples/manifests/sql-reporting/README.md#run-it) shows.

Ask for this topology:

1. **A runtime role that is not privileged.** The DSN connects as this role. It is `NOSUPERUSER`
   and `NOBYPASSRLS`, owns nothing, and has no membership in other roles.
2. **An owner role, separate from the runtime role.** It owns the table and the view. Migrations
   run as this role. Nothing connects as it at runtime.
3. **Row-level security on the base table, forced.** Forced means the table owner is subject to
   the policy too.
4. **A policy that reads the variable through a helper that refuses to run without one.**
5. **A curated view** with `security_barrier`. The runtime role gets `SELECT` on the view and on
   nothing else, and the view leaves out columns the agent must not see.

The excerpts:

```sql
-- Roles and schema. The runtime role may reach one view, granted below. Give the runtime role a
-- password before the DSN can connect (the example's README does this with ALTER ROLE).
CREATE ROLE reporting_owner   LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE ROLE reporting_runtime LOGIN NOSUPERUSER NOBYPASSRLS;
CREATE SCHEMA app AUTHORIZATION reporting_owner;
GRANT USAGE ON SCHEMA app TO reporting_runtime;
```

```sql
-- The base table. Forced row-level security: the owner is subject to the policy as well.
ALTER TABLE app.positions ENABLE ROW LEVEL SECURITY;
ALTER TABLE app.positions FORCE ROW LEVEL SECURITY;

-- The caller's tenant, as the provider sets it for one transaction. It RAISES when there is
-- none, so a session without an identity gets an error, not an empty answer.
CREATE FUNCTION app.current_tenant_id() RETURNS text LANGUAGE plpgsql STABLE AS $fn$
DECLARE
  tenant text := current_setting('app.tenant_id', true);
BEGIN
  IF tenant IS NULL OR tenant = '' THEN
    RAISE EXCEPTION 'app.tenant_id is not set: no tenant identity for this session' USING ERRCODE = '28000';
  END IF;
  RETURN tenant;
END
$fn$;

CREATE POLICY tenant_isolation ON app.positions USING (tenant_id = app.current_tenant_id());
```

```sql
-- The only surface the runtime role can see. The view is owned by the owner role, so it reads the
-- table as that role, and the forced policy still applies.
CREATE VIEW app.positions_v WITH (security_barrier = true) AS
  SELECT tenant_id, id, label, qty FROM app.positions;

GRANT SELECT ON app.positions_v TO reporting_runtime;
```

Three things to tell the DBA:

- **Read the view's column list as a contract.** `internal_cost` is not in the view, so no
  binding can select it. `archstone init` proposes every column the runtime role can `SELECT`, and
  maps each one into the output, so a column left in the view reaches the agent unless you remove
  it. In the example's own `init` run, `tenant_id` was in the view, and the generated binding and
  resource both carried it.
- **Keep the runtime role out of role memberships.** A role the runtime role belongs to can own
  or hold a grant on a table, and the ownership check in section 6 cannot see that. Grant the
  runtime role directly, as above. The ADR records this residual gap as R-7.
- **Avoid `SECURITY DEFINER` functions in anything the runtime role can reach.** The same residual
  gap applies. The ownership check reads only the grants the runtime role holds directly or
  through `PUBLIC`.

### Read replicas

Only what the code and the ADR support is stated here.

- **A physical standby** is a block-level copy of the whole cluster. Roles, role attributes and
  ownership are the primary's, so the checks on the primary describe it.
- **A logical replica** does not carry roles, ownership, grants or DDL. Your policies, grants and
  owner/runtime split must be created on the subscriber. Archstone checks whatever the DSN reaches.
  Role attributes are checked in every transaction. Ownership is checked once for each combination
  of server start time and database the DSN reaches. A change to ownership or grants on the same
  server, while the process runs, is not seen (ADR-0012, risk R-8).
- **A DSN re-pointed behind a proxy** reaches a different server without a new client connection.
  The checks are keyed by server and database, so they run again when the key changes.

A refusal is cached for the DSN for the life of the process. Fix the role, then restart.

---

## 3. Produce the manifest

There are two ways to get a `sql` binding. Both produce the same file layout.

### 3a. Generate it with `init`

```bash
export REPORTING_DSN='postgres://reporting_runtime:<password>@db.internal:5432/app'
```

`--dsn-env` takes the **name** of an environment variable, never the connection string. A literal
string is refused. The manifest it writes carries `dsn: "${REPORTING_DSN}"`, so the connection
string is not written to a file and is not on the command line.

```bash
archstone init --source postgres --dsn-env REPORTING_DSN --out my-manifest
```

`init` connects as the runtime role, reads the catalog, and asks about each relation. The answers
are the ones the Decision Record below holds: whether it is a capability at all, its id, its
`effect`, whether it is a **list** (bounded by `LIMIT 100`) or a **lookup** by one column, and its
resource name. It reads the catalog through the same role checks as `serve` (section 6). It writes
the manifest only if the compiler accepts it.

To answer without a terminal, write the answers down in a Decision Record and pass it with
`--decisions`. This is the file the verification for this guide used:

```json
{
  "version": "0",
  "company": { "id": "harborline" },
  "identities": { "principal": "acme-analyst", "negativePrincipal": "globex-analyst" },
  "decisions": [
    {
      "operation": "SELECT app.positions_v",
      "keep": true,
      "capabilityId": "reporting.get-position",
      "effect": "read",
      "lookupColumn": "id",
      "resourceName": "Position",
      "probe": true,
      "sampleInput": { "id": 1 }
    },
    {
      "operation": "SELECT app.events",
      "keep": true,
      "capabilityId": "reporting.list-events",
      "effect": "read",
      "resourceName": "Event"
    }
  ]
}
```

```bash
archstone init --source postgres --dsn-env REPORTING_DSN --out my-manifest --decisions decisions.json --non-interactive
```

`--non-interactive` needs `--decisions`. `init` never picks an `effect` for you. The `identities`
block is needed only for a contract, which section 4 explains. The `app.events` relation in this
Decision Record is not in `fixture.sql`: it is a table you create yourself (the verification used one
with `jsonb`, `text[]`, `interval` and `bytea` columns), so skip that entry if you only have the example database. Without `--probe` no tenant row is
read.

What `init` writes:

```
my-manifest/
├── INIT-REPORT.md                       what was skipped, and why
├── capabilities.yaml
├── reporting.get-position.capability.yaml
├── reporting.Position.resource.yaml
├── reporting.list-events.capability.yaml
├── reporting.Event.resource.yaml
└── bindings/
    ├── reporting.get-position.binding.yaml
    └── reporting.list-events.binding.yaml
```

With `--probe --identity-map` it also writes `fixtures/<capability>.golden.json` and a `contract:`
block in the binding. The identity map is read and never copied into the output.

**Lookup or list.** A lookup binds one parameter, `WHERE "id" = $1`, and its input is that column.
A list is `LIMIT 100`, and it has no input. Only a lookup can carry a contract (section 4).

**Column types.** Each column is typed from what the driver returns:

| Postgres type | CDL type |
|---|---|
| `timestamp`, `timestamp with time zone` | `datetime` |
| `date` | `date` |
| `integer`, `smallint`, `real`, `double precision` | `quantity` |
| `uuid` | `identifier` |
| `boolean` | `boolean` |
| `text`, `character varying`, `bigint`, `numeric`, and every other type not listed here or below | `string` |

`bigint` and `numeric` arrive as strings, so they are `string`. The lookup key takes the type of its
column. An `integer` key is a `quantity`, which is a JSON number. The example's hand-written
`identifier` is a string. The two are not interchangeable.

**What is left out.** A column whose type has no CDL form is left out of the `SELECT` and named in
the report. The codes come from `packages/init/src/adapters/postgres/columns.ts`:
`json`, `jsonb`, arrays, `interval`, `bytea`, the geometric types (`point`, `line`, `lseg`, `box`,
`path`, `polygon`, `circle`) and `oid`. A foreign table is reported and not proposed. A view's
columns all come out `required: false`, because Postgres records no `NOT NULL` on a view's columns.

An excerpt from the console and report of that run:

```
  ✓ reporting.get-position  [read]  SELECT app.positions_v → reporting.Position
  ✓ reporting.list-events  [read]  SELECT app.events → reporting.Event
  list-has-no-isolation-test [operation] (1) — a list cannot carry a contract: its isolation replay returns the other identity's own rows
  column-type-not-expressible [field] (4) — a column has no expressible CDL type — left out of the select
    - SELECT app.events#payload: column 'payload' has Postgres type 'jsonb', which has no expressible CDL semantic type — skipped, not guessed
    - SELECT app.events#tags: column 'tags' has Postgres type 'ARRAY', which has no expressible CDL semantic type — skipped, not guessed
    - SELECT app.events#span: column 'span' has Postgres type 'interval', which has no expressible CDL semantic type — skipped, not guessed
    - SELECT app.events#blob: column 'blob' has Postgres type 'bytea', which has no expressible CDL semantic type — skipped, not guessed
```

Then check what you got. Read `INIT-REPORT.md` and the generated files before you commit them. The
capability description is generated from the object name (for example, `Read rows of the view
app.positions_v.`), and an agent reads it to decide whether to call the tool. Rewrite it.

### 3b. Write the binding by hand

Start from the example's binding. This is
[`bindings/reporting.get-position.binding.yaml`](../../examples/manifests/sql-reporting/bindings/reporting.get-position.binding.yaml),
without its comments:

```yaml
binding:
  capabilityId: reporting.get-position
  connector:
    type: sql
    sql:
      engine: postgres
      dsn: "${REPORTING_DSN}"
      statementKind: select
      query: |
        SELECT id, label, qty
        FROM app.positions_v
        WHERE id = $1
      params:
        - id

  response:
    collection: "$[*]"
    resource: Position
    map:
      id: "$.id"
      label: "$.label"
      quantity: "$.qty"

  contract:
    source: recorded
    fingerprint: "sha256:dd003cbce8591a29c0dafe2b01361e0a9666f23afcff5a01c2c5563e8b1769d8"
    shape:
      "$": array
      "$[]": object
      "$[].id": number
      "$[].label": string
      "$[].qty": number
    verifiedAt: "2026-10-07T00:00:00Z"
    probe:
      fixture: fixtures/reporting.get-position.golden.json
```

The schema requires all five `sql` fields: `engine`, `dsn`, `statementKind`, `query` and `params`.
`engine` is `postgres`, and `statementKind` is `select`, the only values accepted. `params` lists
the capability's declared inputs in the order of `$1`, `$2` and so on. The `response` map is the
same as a REST binding's.

**The `contract:` block and its fixture come from a recording.** Take the fingerprint from a
recording, not from your own hand. The supported way to record one is `archstone init --probe`,
which section 3a shows. A binding with no `contract:` is never replayed by `verify`, so no isolation
test runs for it. Do not put a lookup into production without one.

The values in the example's `contract:` block were recorded against the example's fixture data. Your
own data gives a different fingerprint, so take the block from your own recording.

---

## 4. Identity, and the negative isolation test

### The identity map

`verify`, `serve` and `init` take a JSON file that maps a principal to its session claims:

```json
{
  "acme-analyst": { "tenant_id": "acme" },
  "globex-analyst": { "tenant_id": "globex" }
}
```

Every claim value must be a non-empty string. An empty object, or a value that is not a string,
counts as no identity. A principal that the map does not resolve gets no identity, and the call is
refused before any connection is opened (section 7).

The file can be passed as `--identity-map <file>`, or through the `ARCHSTONE_IDENTITY_MAP`
environment variable.

### The isolation test

A `contract:` with a `negativeIdentity` in its fixture tells `verify` to run two replays of the
same request:

1. As the **positive** principal, `acme-analyst`. The request must return rows that match the
   contract.
2. As the **negative** principal, `globex-analyst`. The same request must return **zero** rows.

The fixture is the recorded request and the two principals:
[`fixtures/reporting.get-position.golden.json`](../../examples/manifests/sql-reporting/fixtures/reporting.get-position.golden.json).

```json
{
  "capabilityId": "reporting.get-position",
  "recordedAt": "2026-10-07T00:00:00Z",
  "request": { "id": 1 },
  "identity": { "principal": "acme-analyst" },
  "negativeIdentity": { "principal": "globex-analyst" },
  "expects": { "collectionNonEmpty": true }
}
```

### Run it

This needs the example database from the example's [README](../../examples/manifests/sql-reporting/README.md#run-it):
the Postgres container, `fixture.sql`, and the runtime role's password. In that README's commands the
password is `runtime-demo` and the port is `55432`.

```bash
export REPORTING_DSN='postgres://reporting_runtime:<password>@127.0.0.1:55432/reporting'
pnpm verify examples/manifests/sql-reporting --identity-map examples/manifests/sql-reporting/identity-map.json
```

Expected output, with exit code 0:

```
archstone verify examples/manifests/sql-reporting

  🟢 reporting.get-position — fingerprint unchanged, mapping OK
```

`verify` exits 1 when anything is red, so it can gate CI.

### Break it

Turn off row-level security on the table, and run it again:

```bash
docker exec archstone-sql-demo psql -U postgres -d reporting -c 'ALTER TABLE app.positions DISABLE ROW LEVEL SECURITY'
pnpm verify examples/manifests/sql-reporting --identity-map examples/manifests/sql-reporting/identity-map.json
```

The container and database are the ones the example's README creates.

```
  🔴 reporting.get-position — isolation test failed: 1 foreign row returned for capability 'reporting.get-position'
```

The same request, as `globex-analyst`, now returns acme's row. The test caught it. Put the policy
back with `ALTER TABLE app.positions ENABLE ROW LEVEL SECURITY`, and run `verify` again.

Two other ways to break it, both checked:

- **Drop the policy and keep `FORCE` on.** The database returns no rows to either tenant. `verify`
  reports the positive replay as empty, which fails the `collectionNonEmpty` expectation:
  `🔴 reporting.get-position — expected a non-empty 'positions' collection; got none`.
- **Remove `FORCE` and keep `ENABLE`.** The view's owner is exempt from the policy and reads every
  row. The result is the same as disabling the policy: `isolation test failed: 1 foreign row
  returned for capability 'reporting.get-position'`.

### What `verify` refuses to pass

Each of these is red, and each one fails CI:

| Situation | Result |
|---|---|
| No `negativeIdentity` in the fixture | `isolation not verified: no negative identity recorded` |
| The negative principal resolves to no claims | `isolation not verified: negative identity did not resolve to any claims` |
| No identity map, and the fixture names `acme-analyst` | the same message as above, because the negative leg runs first |

---

## 5. Running it: what works in v1

| How it is run | Works? | What happens |
|---|---|---|
| `archstone verify` with `--identity-map` | Yes | Replays the contract, runs the isolation test, exits non-zero on red. |
| Embedded SDK (`@archstone/agent`), with a host-supplied caller and identity adapter | Yes | `execute()` returns the rows. The host must inject the Node-only dispatcher, see below. |
| Host-supplied stdio server (`serveStdio`, from `@archstone/runtime`) | Yes | One process per conversation, with a fixed caller and identity adapter. |
| `archstone serve` (CLI, stdio) with `--identity-map` | Starts. Sql calls refuse. | The privilege check passes at startup. Each call refuses: no caller is known on stdio. |
| `archstone serve` (CLI, stdio) without `--identity-map` | Starts. Sql calls refuse. | The refusal text is misleading here. See section 7. |
| `archstone serve --http` | Starts. Sql calls refuse. | The HTTP surface never dispatches `sql` (checked with `--identity-map`). |

### Embedded SDK

Build an IR artifact from the manifest, then load it and call it. The sample below was run against
the example database. `invokeConnector` is the Node-only dispatcher. It comes from
`@archstone/runtime/connector`, and the SDK never imports it, so your host must supply it.

Install the packages in your host project, then build the artifact:

```bash
npm install @archstone/agent @archstone/runtime @archstone/provider-sql
```

```bash
archstone build examples/manifests/sql-reporting --out archstone.ir.json
```

(From a checkout, run the CLI through the repo's scripts instead of `archstone`, as in "Before you
start".)

```ts
import { readFileSync } from "node:fs";
import { fromIR } from "@archstone/agent";
import { invokeConnector } from "@archstone/runtime/connector";

const sdk = fromIR(JSON.parse(readFileSync("archstone.ir.json", "utf8")));

// Your own mapping from the principal your auth layer resolved to the claims the database sees.
// `tenant_id` becomes the session variable `app.tenant_id`.
const claims: Record<string, Record<string, string>> = {
  "acme-analyst": { tenant_id: "acme" },
};

const result = await sdk.execute(
  "reporting.get-position",
  { id: "1" },
  {
    env: process.env,
    caller: { principal: "acme-analyst" },
    identityAdapter: (principal) => (principal === undefined ? undefined : claims[principal]),
    connector: invokeConnector,
  },
);

console.log(JSON.stringify(result));
// {"status":"ok","data":{"positions":[{"id":1,"label":"ACME-BOND-2031","quantity":120}]}}
```

The input `id` is a string here, because the example declares it as `identifier`. A binding from
`init` may declare a number instead, so send the type its capability declares.

The tool name in MCP is `reporting_get-position`. The SDK takes the capability id,
`reporting.get-position`.

`execute()` returns `status: "error"` with the same message as section 7 when the connector is
not supplied. It never falls back to a REST dispatcher.

### Host-supplied stdio

A host that spawns the server itself can pass the same options to `serveStdio`:

```ts
import { serveStdio } from "@archstone/runtime";
import { invokeConnector } from "@archstone/runtime/connector";

await serveStdio("examples/manifests/sql-reporting", {
  env: process.env,
  caller: { principal: "acme-analyst" },
  identityAdapter: (principal) => (principal === "acme-analyst" ? { tenant_id: "acme" } : undefined),
  connector: invokeConnector,
});
```

A strict MCP client will reject a successful call to this example. The example's resource declares
`id` as `identifier` (a string), but `app.positions.id` is an `int4`, so the row carries the number
`1` and the client's output-schema validation fails with `id must be string`. The SDK's `execute()`
does not validate, which is why the sample above passes. For your own manifests, declare the type the
column really has (`init` does this for you).

This path runs no startup privilege check. (The CLI's `serve` runs one on stdio only when you pass
`--identity-map` or `--sql-guc-prefix`; `serve --http` and `verify` always run it.) The check at each transaction still applies, so a
superuser DSN is refused on the first call, with this message:

```
connection for 'REPORTING_DSN' uses a role with rolsuper = true; the runtime role must not be a superuser — see the topology guide
```

### The CLI cannot serve per-caller sql in v1

`archstone serve` on stdio, with `--identity-map`, passes the startup check and then refuses every
sql call. A stdio server has no caller. The CLI's identity adapter is the map lookup, and with no
principal it returns nothing:

```
capability 'reporting.get-position': no session identity resolved for this caller — identityAdapter is unset, or returned no claims for this principal; refusing before any connection is used
```

`serve --http` refuses every sql call as well. Its handler uses the edge-safe connector, which
refuses sql by design:

```
capability 'reporting.get-position': connector type 'sql' is not available on this edge-safe surface — sql-bound capabilities require a Node-only dispatcher (archstone serve, archstone verify, or an explicit connector override)
```

The Node-only dispatcher is reached from `verify`, from `init`, from the CLI's stdio server when
`--identity-map` or `--sql-guc-prefix` is given, and from embedders who inject it. None of those gives an MCP client a
caller, so an MCP client cannot get rows from a sql capability through the CLI.

---

## 6. The privilege checks

The ADR calls these four layers. The first two are checks on the manifest and on each call. The
last two are checks on the connection, and they are the ones that refuse a dangerous role.

| Layer | What it checks | When it runs |
|---|---|---|
| 1. Query shape | The query begins with `SELECT`, or `WITH` and `SELECT`. Parameters match placeholders. | `apply`, offline. |
| 2. Read-only transaction | `SET TRANSACTION READ ONLY` on every call. Postgres refuses a write inside it. | Every call. |
| 3. Role attributes | The connecting role is not `rolsuper` and not `rolbypassrls`. | `serve` and `verify` startup, `init`, and inside **every** transaction. |
| 4. Ownership | The role does not own a table, view or other relation that it also holds a grant on, directly or through `PUBLIC`. | `serve` and `verify` startup, `init`, and the first transaction that reaches each server and database. |

The read-only property has no separate check at startup. Layer 2 enforces it on each call.
Layer 1 checks the text at `apply`.

**Nothing is checked at `apply`** for the live layers. `apply` ran against a superuser DSN and
against an unreachable one, and both exited 0. The live checks start at `serve`, `verify` and `init`.

**A refusal stops startup.** `serve` prints the refusals and exits 1 before it accepts a connection.
`verify` prints them, or with `--json` a `sql_over_privileged` error, and exits 1. A check that
reached no verdict, because the server was down or the password was wrong, stops startup too, under
its own heading: `sql connection privilege check(s) could not complete`.

**The first refusal stays.** A refusal reached at any point is cached for the DSN for the life of the
process, so every later call is refused without opening a connection.

### The residual gap (ADR-0012, R-7)

Layer 4 checks one thing: the runtime role owns a relation and also holds a grant on it, directly or
through `PUBLIC`. The check cannot see:

- an ownership or a grant reached through a **role membership**, whether or not the membership is
  inherited;
- a path to rows through a **`SECURITY DEFINER`** function.

The mitigation is operational. Grant the runtime role directly on a view, with no membership and
no `SECURITY DEFINER` in what it can reach. The ADR says `init`'s output never produces the shape
that would evade the check. The check reads the query in `providers/sql/src/index.ts`, and the gap
follows from that query. It was not tested with a membership in this guide.

---

## 7. Errors, and what to do

The messages say "see the topology guide". This page is that guide. Each message is copied from the
source. Most were also produced by running the commands in this guide.

### Wrong role

| Check | The message, verbatim | Fix |
|---|---|---|
| Superuser | `connection for 'REPORTING_DSN' uses a role with rolsuper = true; the runtime role must not be a superuser — see the topology guide` | Connect as the runtime role, created `NOSUPERUSER`. |
| BYPASSRLS | `connection for 'REPORTING_DSN' uses a role with rolbypassrls = true; the runtime role must not bypass row-level security — see the topology guide` | `ALTER ROLE <runtime> NOBYPASSRLS`. |
| Ownership | `connection for 'REPORTING_DSN' owns app.positions_v, which it also holds a grant on — the runtime role must not own any relation it can query — see the topology guide` | `ALTER VIEW app.positions_v OWNER TO <owner>`, then re-grant `SELECT` to the runtime role. |
| Write, or a missing grant | The caller sees `query failed (SQLSTATE 42501)`. The operator's stderr line adds `permission denied for view positions_v`. | The runtime role holds no write grant, and every call is read-only. Grant only what the view needs. |
| No verdict | `pool checkout failed while checking connection privileges (ECONNREFUSED)` or `(SQLSTATE 28P01)` | Check the DSN and the server. The driver's own text goes to stderr, and the caller sees only the code. |

The ownership case was run by making the runtime role own the view. The refusal text was the same
at `verify` and at `init`, and the owner was restored afterwards.

### Missing identity

| Situation | The message, verbatim |
|---|---|
| The map does not resolve the principal, or there is no adapter | `capability 'reporting.get-position': no session identity resolved for this caller — identityAdapter is unset, or returned no claims for this principal; refusing before any connection is used` |
| The CLI serves stdio without `--identity-map` | `capability 'reporting.get-position': connector type 'sql' is not available on this edge-safe surface — sql-bound capabilities require a Node-only dispatcher (archstone serve, archstone verify, or an explicit connector override)` |
| `verify`, with no identity map | `isolation not verified: negative identity did not resolve to any claims` |

Fix the first by adding the principal to the map, or by making your host resolve the caller.

The second message is the one `serve` gives without `--identity-map`. It lists `archstone serve`
among the Node-only dispatchers, which is misleading: without the map, the stdio server does not use
one. Pass `--identity-map`, and the call then fails with the first message, which is the real
reason. Passing the map does not make a call succeed on stdio, because no caller is known.

### Unresolvable negative identity

| Situation | The message, verbatim | Fix |
|---|---|---|
| The fixture names no negative principal | `isolation not verified: no negative identity recorded` | Record the contract with a second principal, or add `negativeIdentity` to the fixture. |
| The named negative principal has no claims | `isolation not verified: negative identity did not resolve to any claims` | Add it to `identity-map.json`. |
| `init --probe` finds the same problem | `negative principal 'globex-analyst' resolves to no claims in the identity map (D-8 case 4)` | As above. Without it, `init` writes no contract. |
| `init` on a list | `list-has-no-isolation-test [operation] (1) — a list cannot carry a contract: its isolation replay returns the other identity's own rows` (report) | Make it a lookup, with a `lookupColumn`. |

### Column not expressible

`init` reports these and emits the rest of the capability. They are not errors:

| Postgres type | Report line |
|---|---|
| `jsonb` | `column 'payload' has Postgres type 'jsonb', which has no expressible CDL semantic type — skipped, not guessed` |
| `text[]` | `column 'tags' has Postgres type 'ARRAY', which has no expressible CDL semantic type — skipped, not guessed` |
| `interval` | `column 'span' has Postgres type 'interval', which has no expressible CDL semantic type — skipped, not guessed` |
| `bytea` | `column 'blob' has Postgres type 'bytea', which has no expressible CDL semantic type — skipped, not guessed` |

To expose such a value, cast it in a view to a type CDL has, such as `text`, and point the
binding at the view. Do not expect `init` to do that for you.

### Missing environment variable

| Where | The message, verbatim | Fix |
|---|---|---|
| `init` | `archstone init: the environment variable REPORTING_DSN is not set` (exit 2) | `export REPORTING_DSN=…` |
| `verify` | `isolation not verified: negative replay failed — missing env var(s): REPORTING_DSN` | As above. |
| A call through the SDK or `serve` | `missing env var(s): REPORTING_DSN` | As above. |

`verify` and `serve` do not stop on an unset variable at startup. They skip the privilege check for
that DSN, and each call then fails with the message above.

### `init` refusals

| Situation | The message, verbatim |
|---|---|
| A literal DSN passed as `--dsn-env` | `archstone init: --dsn-env takes the NAME of an environment variable, never a connection string` (exit 2) |
| `--identity-map` without `--probe` | `archstone init: --identity-map is used only with --probe: it names the identities a recorded contract is replayed as` (exit 2) |
| `--source postgres` with a spec file | `archstone init: --source postgres reads a database and takes no <spec-file>` (exit 2) |

### Apply-time refusals

These come from `archstone apply`, before any database is touched:

| Situation | The message, verbatim |
|---|---|
| A literal connection string | `/binding/connector/sql/dsn must match pattern "^\$\{[A-Za-z_][A-Za-z0-9_]*\}$"` |
| A write statement | `connector.sql.query must begin with SELECT or WITH … SELECT (after stripping leading whitespace/comments) — statementKind: select does not match the query's own leading keyword` |
| A placeholder past the end of `params` | `connector.sql.query references $2, but params has only 1 entry` |
| A `params` entry with no placeholder | `connector.sql.params[0] ('id') has no corresponding $1 placeholder in the query` |
| A `params` name that is not a declared input | `connector.sql.params references '<name>', which is not a declared input field of capability '<id>'` (from `packages/compiler/src/validate.ts`) |

---

## 8. Scope

| Topic | Status |
|---|---|
| Engines | **Postgres only.** `sql.engine` accepts `postgres` and nothing else. |
| Statements | **`SELECT` and `WITH … SELECT`.** Writes are out of scope. |
| Writes, `CALL`, `INSERT`, `UPDATE`, `DELETE` | **Out of scope.** Refused at `apply`. |
| Other databases (MySQL, Snowflake, BigQuery and the rest) | **Out of scope for v1.** The `engine` field is there for later engines. Nothing here commits to one. |
| Isolation between tenants | **The tenant of the deployment.** The database enforces it with the claims the host resolves. |
| Isolation between users inside one tenant | **Out of scope.** The example's claims carry one key, `tenant_id`. This guide does not describe a per-user mechanism. |
| sql in `serve` (CLI stdio, with an identity map) | **Refused per call.** No caller is known on stdio. |
| sql in `serve --http` | **Refused per call.** The HTTP surface never dispatches sql. |
| sql in the edge build (`@archstone/agent` and `@archstone/runtime` roots, `/http`) | **Refused unless a Node-only connector is injected.** |
| `archstone init --source postgres` | **Not in 0.34.0.** Unreleased. |
| Read replicas | As stated in section 2. |

### What was verified

| Claim | How it was verified |
|---|---|
| The sql-reporting example applies, verifies green, and goes red with RLS disabled | Ran `apply`, `verify` and the break-it step against a Postgres 18.6 database loaded from `fixture.sql`. |
| The superuser, BYPASSRLS and ownership refusals, and their wording | Ran `verify`, `serve`, `init` against roles created for the check, then removed. |
| The missing-identity, edge-safe and `serve --http` refusals | Drove `serve` over stdio and HTTP, and called the SDK. |
| `init` output, skips, types and the probe report | Ran `init` with a Decision Record, with and without `--probe`. |
| The apply-time refusals | Ran `apply` against copies of the example with a bad binding. |
| The embedded SDK and host-supplied stdio calls | Ran both, and type-checked the SDK sample with `tsc --strict`. |
| The DBA topology | The statements were run as part of `fixture.sql`. |
| A write as the runtime role | Refused with `permission denied` (42501). This was a missing write grant. The read-only transaction's own refusal was not isolated. |
| R-7 and the read-replica behaviour | Read in ADR-0012 and in `providers/sql/src/index.ts`. Not run against a membership or a replica. |
