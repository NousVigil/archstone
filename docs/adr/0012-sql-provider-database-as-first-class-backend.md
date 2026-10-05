# ADR-0012: A Database Is a First-Class Backend — the `sql` Provider

**Status:** 🚧 Draft — not accepted. Circulated for review. The decision is still a draft, but
D-1–D-9 have partly shipped ahead of acceptance (`providers/sql`, `IRSqlConnector`,
`invokeConnector`); where shipped code and this text disagreed, the amendments below say which
one moved.

**Amended (2026-10-02),** from the design for #87 (`archstone init` from a Postgres catalog).
Decision text is edited in place; this list is what moved:

1. **D-10, introspection path.** `init` reads the catalog through `providers/sql`'s
   `introspectCatalog`, which shares `ensureConnection` (D-9 layers 3–4) and D-4's read-only
   transaction — not through `invokeConnector` over a synthetic `IRTool`. "D-9 runs for `init`
   for free" is unchanged.
2. **D-10, effect.** The effect *hint* is always `read`; the confirmed effect is recorded as the
   human gave it.
3. **D-3/D-8, identity.** `GoldenFixture` gains `identity?: { principal }`, the positive leg's
   principal when no caller principal is supplied. D-3 now defines "resolved claims" exactly
   (a plain object with at least one key, every value a non-empty string); D-8 points at it.
4. **D-10, scoping.** Catalog scoping is by `has_table_privilege`/`has_column_privilege`
   (`SELECT`), not by catalog visibility; partitions fold into their parent; foreign tables are
   deferred.
5. **D-6, location.** `invokeConnector` ships from `@archstone/runtime/connector`, not an
   `@archstone/emitter-support/connector` subpath — correcting drift, no behaviour change.

**Amended (2026-10-05),** deciding #123 (should D-9 re-run after a failover onto a server where
the role may differ?). This amendment is ratified (2026-10-05); ADR-0012 as a whole stays Draft.
Implemented for `invokeSql` and the CLI startup check (#132); `introspectCatalog` (D-10) and the
topology guide are not yet. Decision text is edited in place; this list is what moved:

1. **D-9 layer 3, when it runs.** The role-attribute check (`rolsuper`, `rolbypassrls`) runs
   inside **every** transaction `providers/sql` opens, on the backend that is about to run the
   query — no longer "on first connection per DSN" and cached.
2. **D-9 layer 4, what a verdict is about.** The ownership verdict is cached per DSN **and per
   server and database**, keyed by `pg_postmaster_start_time()` and the current database's oid,
   read in that same per-transaction statement. A transaction that lands on a key with no
   verdict yet runs layer 4 in that transaction, before the declared query. `invokeSql`'s lazy
   pre-check on a separate checkout goes; the eager startup/`verify` check stays.
3. **D-9, a refusal reached mid-life is the DSN's verdict.** It is cached and refuses every later
   call against that DSN until the process restarts, exactly as a refusal at startup does. A
   per-transaction read that fails is a failed call, never a verdict (#127, unchanged).
4. **D-4, the transaction.** Gains the read above as its own statement, after
   `SET TRANSACTION READ ONLY` and before any claim is set, plus layer 4's query when the key has
   no verdict yet.
5. **D-10, introspection.** `introspectCatalog`'s transaction makes the same read and, when
   needed, runs layer 4, like any other transaction.
6. **Risks.** R-8 names what this does not cover: ownership or grants changed on the *same*
   server (`ALTER … OWNER TO`, a new `GRANT`) while a process is running. R-9 names the new
   dependency on `pg_postmaster_start_time()` and the database oid being readable by the runtime
   role, memory-snapshot clones, and a same-microsecond start.

**Note:** two independent architect drafts of this decision existed. This one — with connector
dispatch centralized once in a new subpath (D-6) — was chosen by Adrian on 2026-09-24 over the
alternative, which kept dispatch per-consumer. The superseded draft is kept for reference at
`0012-sql-connector-database-as-first-class-backend.md.rejected`.
**Date:** 2026-09-23
**Deciders:** Adrian Bratulescu (pending)
**Related:** [ADR-0005](0005-open-core-boundary-artifact-guarantee.md) ·
[ADR-0008](0008-undeclared-provider-data-never-reaches-a-model.md) ·
[ADR-0011](0011-undeclared-model-output-never-reaches-a-business-system.md) ·
`providers/rest` (the `rest` connector this design is symmetric with) ·
internal ADD-18 (contract probe/health), ADD-30 (tool-name/registry centralization),
ADD-32 (caller credential propagation), ADD-37 (`archstone init` inference loop),
ADD-42 (caller principal) — cited throughout for precedent; their numbering is internal
and does not correspond to this repo's ADR sequence.

---

## Context

A capability's binding today maps to exactly one implemented connector: `rest`. Everything
`archstone` knows how to *do* with a backend — resolve `${VAR}`/`${caller.NAME}` placeholders,
build a request, map a declared response shape onto a resource, probe and diff a contract,
gate on a policy — is expressed once, in `providers/rest`, and read generically by the compiler
and by every invocation path through `IRTool.connector`.

A large class of capabilities are `SELECT ... WHERE` over a company's own database with no
business logic in between. Exposing them today requires standing up a REST endpoint whose only
job is to be reachable from `archstone` — a controller, a serializer, an auth check and a
deployment that exist to satisfy the transport, not the business. `connector.schema.json`
already reserves `"sql"` in its `type` enum (alongside `"graphql"`, `"grpc"`, `"soap"`), but
nothing implements it: `IRConnector["type"]` accepts the string, `compile.ts`'s
`lowerConnector` lowers it to a bare `{ type: "sql" }` with no body, and no `invokeX` function
exists to act on it. A capability bound this way today compiles, is listed as invocable (`.connector`
is truthy), and fails at the first call with no useful error.

This ADR designs the `sql` provider: a second, first-class connector, symmetric with `rest`,
binding a capability directly to a Postgres database. It is scoped narrowly and deliberately —
see the constraints below, drawn from the approved product brief
(`internal/docs/product/brainstorming/sql-provider-database-as-first-class-backend-pm.md`) and
**treated here as fixed, not re-opened**:

- Postgres and the Postgres wire family only (self-hosted, RDS/Aurora, Supabase, Neon) — no
  Snowflake, BigQuery, MySQL, SQL Server, Mongo in v1.
- Read-only (`SELECT`) — no writes, no mutations, in v1.
- No agent-authored SQL, ever. No table name, column name, engine, or connection string may
  appear in a `*.capability.yaml` — only in the binding, exactly as CDL already requires for
  every implementation detail (RFC-0001).
- Isolation — "a caller sees only their own rows" — is enforced by the database (Postgres RLS,
  typically via a curated schema of security-barrier views as the documented default topology,
  with RLS on base tables as a supported alternative) and by a runtime role that is not the
  table owner and does not hold `BYPASSRLS`. A binding that omits a tenant predicate must still
  return zero foreign rows. The YAML author is not part of the security boundary.
- v1 ships tenant-of-deployment isolation (one deployment, one tenant, resolved once per
  invocation). Per-end-user isolation is a later increment and must not require a rewrite of
  this one — it is designed for by using a per-invocation *session-identity* mechanism now
  rather than "one connection string per tenant."
- Identity arrives as the already-ratified opaque caller **principal** (internal ADD-42), mapped
  to identity claims by a deployer-supplied adapter. `tenantId`/`userId` are never read from
  model/capability input.
- Free core, Apache-2.0, no paywall on `serve` or on running a compiled artifact (ADR-0005). No
  console dependency, no `if (isSaaS)` anywhere in this design.
- `archstone init` proposes capabilities from `information_schema`, the way the OpenAPI adapter
  proposes them from a spec, and `archstone verify` proves isolation — a negative test, foreign
  identity → zero rows — that can fail a build.

What follows is this ADR's own decision: the binding grammar, the identity seam, the
transaction/session mechanics, the connection lifecycle, the contract/fixture shape, where the
isolation test lives mechanically, how an over-privileged connection is detected, and how
`init`'s Postgres adapter fits the existing compile-and-probe loop precedent.

---

## Decision

### D-1. Binding grammar — a declared, parameterized query; no query-text templating, ever

A binding's `connector.sql` block, symmetric with `connector.rest`:

```yaml
# bindings/portfolio.summary.binding.yaml
binding:
  capabilityId: portfolio.summary
  connector:
    type: sql
    sql:
      engine: postgres
      dsn: "${DATABASE_URL}"
      statementKind: select
      query: |
        SELECT id, week_ending, headline, delta_pct
        FROM reporting.portfolio_summary_v
        WHERE id = $1
      params:
        - id
  response:
    resource: reporting.PortfolioSummary
    collection: "$[*]"
    map:
      id: id
      weekEnding: week_ending
      headline: headline
      deltaPct: delta_pct
```

- **`dsn`** resolves via the existing `${VAR}` env-placeholder mechanism, unchanged — the same
  `resolveEnv` REST's `baseUrl` already uses. A literal connection string in a binding is
  refused at `apply` the same way a literal secret in a header would be flagged today (same
  discipline, no new mechanism).
- **`query`** is the entire declared SQL text, author-controlled, static, and — this is the
  load-bearing property — **never templated with a caller-influenced value**. There is no
  `{field}`/`${caller.NAME}` substitution inside `query` at all; the grammar does not offer one.
  Only the fixed **positional parameter list** (`params`, an ordered array of declared CDL input
  field names) is bound, through the driver's native parameterized-query API (`pg`'s
  `client.query(text, values)`), to the query's `$1, $2, …` placeholders. This is what "declared,
  parameterized query" means concretely: the shape of the query is fixed at authoring time; only
  values move at invocation time, and they move through the driver's own escaping, never through
  string concatenation. A `query` referencing a name not in `params`, or a `params` entry naming
  an undeclared CDL input field, is an `apply`-time error — the same "ambiguous is a refusal, not
  a guess" discipline `compiler/src/resolve.ts` already applies to resource names.
- **`statementKind: select`** is required and, in v1, only `"select"` validates
  (`connector.schema.json` closes the enum to one value now; `"insert"`/`"update"`/`"call"` are
  reserved names for a later, narrower write increment — not built here). This is the first of
  three independent read-only enforcements (D-9).
- **No identity placeholder exists in this grammar, on purpose.** `${caller.principal}` /
  `${caller.tenantId}` are a REST-only construct (ADD-32/42) and are deliberately **not**
  offered on `sql.query`/`sql.params`. Identity never flows through binding-authored text — see
  D-3/D-4. This is the concrete mechanism behind the product constraint "the YAML author is not
  part of the security boundary, and cannot widen it": there is no field in this grammar an
  author could use to *reference* identity even if they wanted to.
- **Response mapping is unchanged, reused verbatim (D-7).** `binding.response`/`response.schema.json`
  already express "a JSONPath into a list of items, mapped field-by-field onto a resource" — a
  SQL provider that returns its row array as the tool's raw response body needs nothing new here.

### D-2. `connector.type: "sql"` carries an engine discriminator now; the other stubs are named, not silently carried forward

`connector.schema.json`'s `type` enum already reserves `graphql`/`grpc`/`soap`/`sql`. This ADR:

- Adds a required `sql.engine` field, closed to `"postgres"` in v1 (Challenge 2 of the product
  brief: the Postgres wire family shares one isolation mechanism; a portable "SQL" abstraction
  across engines would silently degrade to the weakest one's guarantee — refused, not built).
  `engine` exists so a later Snowflake/BigQuery increment is additive (`"snowflake"` joins the
  enum) rather than a `type` fork, while making it schema-legible today that `"sql"` is not yet
  portable.
- Leaves `graphql`/`grpc`/`soap` exactly as reserved, unimplemented enum members — **but adds one
  small, in-scope fix**: today a capability bound to any of those types compiles, is treated as
  invocable (`IRTool.connector` is truthy), and fails only at the moment of invocation with an
  opaque error, because nothing checks connector *implementedness* before that point. This ADR's
  new `invokeConnector` dispatch (D-6) is the one place that already has to know the closed set
  of implemented types, so it is also the one place a `compiler/src/validate.ts` diagnostic
  should fire: `connector.type` is `graphql`/`grpc`/`soap` → an `apply`-time **error**
  (`connector-type-not-implemented`), not a runtime surprise. This is a pre-existing gap this
  ADR's work makes visible, not new scope for the `sql` provider itself; it is included because
  the alternative — leaving it — means `sql` becomes the second connector type silently exempt
  from a check the codebase never had.

### D-3. The identity-adapter seam, and why `CallerContext` moves out of `providers/rest` now

Internal ADD-32 D-2 declined to move `CallerContext` out of `providers/rest` into the shared
substrate, explicitly deferring the move to "the trigger ADD-32 R-1 already named: the first
non-REST connector." This is that connector.

**Move.** `CallerContext` and the connector-agnostic half of `InvokeOptions`
(`env`, `fetchImpl`, `caller`, `auditSink`, `sessionId`, `workflowId`,
`callerResolutionFailed`, `rateLimitCounter`) relocate to `@archstone/emitter-support` as the
shared, connector-agnostic invoke-context shape. `providers/rest`'s `InvokeOptions` becomes an
extension of that base adding only what is genuinely REST-specific (`allowedHosts`,
`onResponse`) — the pattern REST's own `${caller.NAME}` interpolation already establishes for
what stays local to a connector. `providers/rest` re-exports `CallerContext` as a type alias so
no existing `import type { CallerContext } from "@archstone/provider-rest"` call site breaks —
a non-breaking, type-only migration. `providers/sql`'s `InvokeOptions` extends the same base.

**The new seam.** A capability bound to `sql` needs one further mapping the REST world never
needed: **principal → identity claims** (`{ tenantId }` in v1; `{ tenantId, userId }` later,
per the product brief's phase-coherence argument). This is a deployer-supplied pure function,
carried as one new field on the shared base `InvokeOptions`:

```ts
identityAdapter?: (principal: string | undefined) => Record<string, string> | undefined;
```

- It is **not** a per-request extraction hook like `resolveCaller` (ADD-32/42). `resolveCaller`
  had to be per-request because it reads the raw inbound `Request`; `identityAdapter` takes the
  *already-resolved* `caller.principal` (resolved once per invocation, identically on every
  entry point, by the existing ADD-42 machinery) and returns a pure derived value. It can
  therefore be set **once, statically, at construction time** — on `ExecuteOptions`,
  `serveStdio`'s `invoke`, and `createHttpHandler`'s options — with **zero** risk of the
  ADD-42 G-1/D-13 class of bug (a per-request clobbering seam that silently falls back to a
  static default). There is exactly one thing to configure and exactly one place it is read.
- **It is read in exactly one place: `invokeSql` (D-4).** No allow/deny decision is made from
  it — it only produces the values the runtime sets as session state before running the
  declared query. This mirrors ADD-42 D-8's placement rule ("identity-based decisions never
  live in a specific provider") generalized to: *identity resolution* is shared/generic
  (`identityAdapter` lives on the shared invoke-context type), but *acting on resolved identity*
  is connector-specific mechanics, exactly as `${caller.principal}` interpolation is REST-only
  mechanics over the same shared `CallerContext.principal`.
- **Absence fails closed.** A `sql`-bound capability whose `identityAdapter` returns no claims
  (unset adapter, or an adapter that cannot resolve this principal) refuses the call before any
  connection is used — `invokeSql`'s equivalent of ADD-32's "no caller credential" gate. There is
  no silent "run with no session identity" path; a `SELECT` executed with no GUC set would rely
  entirely on the DBA's RLS policy defaulting to deny-on-absent, which this design does not want
  to depend on as its only safety net.
- **"Returned no claims" is defined by shape, not truthiness.** Claims count as resolved only
  when the result is a plain object with at least one key and every value a non-empty string.
  Anything else — `undefined`, `{}`, `{ tenantId: "" }`, a `null` or non-string value, a string,
  an array, a function — is unresolved and refuses identically, because each would set no GUC,
  an empty one, or a meaningless one, and RLS would then return zero rows: the unresolved case in
  disguise. One predicate (`hasIdentityClaims`, in `@archstone/emitter-support`) decides this for
  both `invokeSql` and D-8's negative replay, so the two cannot drift.
- **This closes the ADD-30/ADD-42-class drift risk by construction, not by discipline**: because
  `identityAdapter` needs no new per-surface wiring (it rides the same shared `InvokeOptions` bag
  every entry point already forwards, and is invoked from the one dispatch function in D-6),
  there is no second copy of "how do we get identity into this call" for a future third connector
  to duplicate.

### D-4. Transaction/session mechanics — the correctness core

One invocation of a `sql`-bound capability is exactly one Postgres transaction:

```
BEGIN;
SET TRANSACTION READ ONLY;                          -- D-9, structural read-only enforcement
SELECT rolsuper, rolbypassrls, pg_postmaster_start_time(),   -- D-9 layer 3, every transaction,
       (SELECT oid FROM pg_database                           -- and the (server, database) key
        WHERE datname = current_database())                   -- for layer 4's cached verdict
FROM pg_roles WHERE rolname = current_user;
<D-9 layer 4 ownership query>;                       -- only when that key has no verdict yet
SELECT set_config('app.tenant_id', $1, true);        -- one call per resolved identity claim
                                                      -- ... (one per key identityAdapter returned)
<the declared, parameterized SELECT>;
COMMIT;                                              -- or ROLLBACK on any error
```

- **`set_config(name, value, is_local := true)` is the mechanism the entire isolation guarantee
  rests on, and it is a Postgres guarantee, not an application discipline.** The third argument,
  `true`, scopes the setting to the *current transaction only*: Postgres itself resets it the
  instant the transaction ends, whether by `COMMIT` or `ROLLBACK`, unconditionally, including on
  an unexpected error inside the request handler. This is what makes "a pooled connection cannot
  leak a previous caller's session state" true by construction rather than by careful cleanup
  code: there is no cleanup code to get wrong, because there is nothing left to clean up once the
  transaction boundary closes. A connection is returned to the pool only after `COMMIT`/`ROLLBACK`
  has already run, so the next caller to check it out starts with no residual GUC state from any
  previous tenant — enforced by the database, not by `archstone`.
- **GUC naming is deployer configuration, never CDL/binding content.** `identityAdapter` returns
  claim keys the deployer chooses to match their own RLS policies (e.g. `{ tenant_id: "acme" }`);
  a small `sqlSessionGucPrefix` option on `InvokeOptions` (default `"app."`) determines the
  literal GUC name (`app.tenant_id`). This lives entirely in deployer-supplied `InvokeOptions`,
  exactly like `bearerToken`/`allowedHosts` — a manifest author cannot see it, let alone change
  it, from any CDL or binding file. This is D-1's "no identity placeholder in the grammar"
  restated from the runtime side.
- **`SET TRANSACTION READ ONLY`** (or `BEGIN READ ONLY`, the same enforcement in one statement;
  either form satisfies D-9 layer 2) is a second, independent read-only enforcement (D-9): even a
  query that somehow slipped past the compile-time `statementKind`/leading-keyword check (a
  comment-obfuscated statement, say) fails at the database with a read-only-transaction error,
  because Postgres enforces this per-transaction unconditionally, not by trusting the query text.
- **The role and the server are read inside the transaction (D-9, amended 2026-10-05).** One
  statement of its own, before any claim is set, reads the connecting role's
  `rolsuper`/`rolbypassrls`, the server's `pg_postmaster_start_time()` and the current
  database's oid. It runs inside the transaction because a transaction is the one
  unit guaranteed to stay on one backend — through a proxy in session or transaction pooling
  mode as much as on a direct connection — so the answer is about the server that runs the
  declared query, not about one the pool or a proxy happened to reach earlier. A refusal rolls the
  transaction back before any claim is set or any declared query runs.
- **Exclusivity.** A connection is checked out of the pool for the duration of exactly one
  transaction and is never shared concurrently across two invocations; standard pool
  checkout/release semantics already guarantee this — no new locking is introduced.
- **Error paths roll back.** Any failure inside the transaction (a bad parameter, a backend
  error, a policy evaluator error before the connector is even reached) results in `ROLLBACK`,
  never a bare connection return with an open transaction — the pool wrapper's `try { … } finally
  { release() }` pattern, with rollback in the `catch`, matches the existing "fail closed, name
  the property" style `invokeRest` already uses for its own error paths.

### D-5. Connection lifecycle: embedded, stdio, HTTP — and exclusion from the stateless edge build

- **Embedded (`execute()`) and `serve --http`.** One `pg.Pool` per process, constructed once
  (at `fromIR`/handler-construction time) and reused across invocations; each invocation checks
  out one connection for its one transaction (D-4) and releases it. Standard, long-lived Node
  process behavior — no change to the "long-running process" assumption `serve --http` already
  makes.
- **`serve` (stdio).** One child process per conversation (the same model ADD-32 already
  established for stdio caller identity) — a pool sized for a single conversation's concurrency
  is architecturally correct here, same as the rest of that surface.
- **Exhaustion / timeout.** A pool-checkout timeout returns the same fail-closed
  `{ ok: false, status: 0, error: … }` shape `invokeRest` already returns for a fetch failure —
  no silent unbounded queuing. Pool sizing defaults small and is a deployer-configured
  `InvokeOptions` field, never a product surface (per the brief: "connection management as a
  product feature... it is not sold").
- **Excluded, by construction, from any stateless/edge (Cloudflare Workers) build.** `pg`
  (the Postgres wire driver) opens a raw TCP socket and holds pooled, stateful connections — both
  incompatible with an edge isolate's per-request, no-persistent-process model, and with the
  "pure mapper + `fetch` + injectable env only" edge-safe surface internal RFC-0008 already
  established. `providers/sql` is therefore a **Node-only package**: it is never imported from
  `@archstone/runtime`'s `http` subpath (the edge-safe entry ADD-0008 built specifically to stay
  fs/TCP-free), and the compiler/IR/`emitter-support` layers stay unaware of it — a manifest
  containing a `sql`-bound capability compiles fine, but is not a candidate for a future edge
  deployment target until a data-proxy decision (Hyperdrive or equivalent) is made on a real
  customer's demand, per the product brief's own phase-coherence framing. No mechanism is built
  for that here; only the exclusion boundary is drawn, deliberately, now.

### D-6. Provider dispatch is generalized, once, in a new subpath — not re-implemented at each call site

Today four call sites — `executeCapability` (`agent`), `callTool` (`runtime/server.ts`),
`verifyTool` and `recordContract` (`runtime/verify.ts`) — import `invokeRest` directly and call
it unconditionally. Adding a second connector type without centralizing dispatch would mean
teaching four places, independently, to branch on `tool.connector?.type` — precisely the
duplicated-mechanism defect class internal ADD-30 already found and fixed once for tool-name
resolution.

**Decision:** add `invokeSql` to a new `providers/sql` package with the same `InvokeResult`
shape `invokeRest` returns, and add one new function, `invokeConnector(tool, input, opts)`, that
switches on `tool.connector?.type` and calls the right adapter (or returns a clean
"connector type not implemented" result for `graphql`/`grpc`/`soap`, and today's existing
"no REST connector" for a mismatched/absent connector). All four call sites switch to
`invokeConnector`; none imports `invokeRest`/`invokeSql` directly any more except
`invokeConnector` itself.

**Where it lives, and why not `@archstone/emitter-support`.** `emitter-support`'s own header
states its purity contract: "IR-only: no MCP SDK, no fs, no HTTP." `invokeConnector`
necessarily depends on both an HTTP-capable package (`providers/rest`) and a TCP-capable one
(`providers/sql`) — putting it in the pure root would break that contract for every existing
consumer of `emitter-support`'s neutral pieces (Registry, the mapper, the policy evaluator). A
subpath of `emitter-support` does not work either: both providers depend on `emitter-support`
for the shared `CallerContext`/`InvokeOptions` base (D-3), so a subpath there importing them back
would be a circular *workspace* dependency, and `pnpm -r build` would have no topological order.
The fix reuses a precedent this codebase already applied once, for exactly this shape of
problem: internal ADD-37 R-2 kept `@archstone/runtime`'s root pure while adding an I/O-touching
`recordContract` behind a dedicated `@archstone/runtime/verify` subpath — "a bundler can
tree-shake an import, not a method," so a separate subpath keeps the pure root pure for anyone
who never imports the new one. `@archstone/runtime` already sits above both providers, so
`invokeConnector` ships from the `@archstone/runtime/connector` subpath, in its own source file.
Beside it, `@archstone/runtime/connector-rest` is the edge-safe half (`rest` plus the
not-implemented and no-connector results, never `pg`), and is the default dispatcher for
`callTool` and `agent`'s `execute()`, so neither gains a static edge to `pg` (D-5). Node-only
callers — `verify`, and the CLI's stdio `serve` — use or inject the full `./connector`. Nobody
who imports only a root pulls in `pg`.

### D-7. Contract/fixture shape — reused verbatim, no IR/schema change

ADD-18's `fingerprintShape`/`ShapeMap`/`ShapeDiff` and `contract.schema.json`/`IRContract`
already operate on `unknown` JSON data by structural shape (sorted key paths + JS value types),
with no assumption about where the data came from. A SQL result set, once row objects are
returned as `InvokeResult.data` (an array, exactly as a REST list endpoint returns a JSON array
body) and passed through the **same, unmodified** `applyResponseMapping`, is indistinguishable
from a REST body at every layer above the connector. Concretely:

- `invokeSql` returns `{ ok, status, data: rows, error? }` — `rows` is the driver's row-object
  array, with native Postgres types coerced to the same JSON-safe representation the driver
  already produces by default (numeric/bigint/timestamp as strings unless a deployer overrides
  type parsers) — so `fingerprintShape` sees the same `string`/`number`/`boolean`/`object`/`array`
  vocabulary it already sees for REST.
- A SQL binding's `response.collection: "$[*]"` + `response.map` are the **existing**
  `response.schema.json` grammar, unchanged. No new binding block, no new IR type for "a SQL
  response."
- `archstone verify`'s probe-and-diff loop (`runVerify`/`recordContract`) needs no change beyond
  routing its one `invokeRest` call through `invokeConnector` (D-6) — the fingerprinting,
  diffing, and health derivation are already connector-agnostic.

**The one additive IR change this ADR requires:** `IRConnector` gains an optional `sql` field
mirroring `rest`:

```ts
export interface IRSqlConnector {
  engine: "postgres";
  dsn?: string;         // ${VAR}-templated, as-authored — resolved at invoke time, never at compile time
  statementKind: "select";
  query: string;
  params: string[];     // ordered CDL input field names bound positionally to $1..$n
}

export interface IRConnector {
  type: "rest" | "graphql" | "grpc" | "sql" | "soap";
  rest?: IRRestConnector;
  sql?: IRSqlConnector;  // NEW — additive, IR.version stays "0" (Rule #11)
}
```

No other IR shape changes. `IRContract`, `IRResponseMapping`, `IRTool`, and the resource
registry are all untouched — the SQL provider is a new leaf under `IRConnector`, nothing more.

### D-8. The negative isolation test — where it lives mechanically

Golden fixtures are already an unschema'd, TypeScript-only artifact (`GoldenFixture` in
`runtime/src/verify.ts`, per internal ADD-37 O-11) — a `verify`-time artifact, not a manifest
input, and explicitly not subject to the "no new schema surface" constraint the same way CDL is.
This ADR extends that interface, not `contract.schema.json`, with one new optional field, present
only for `sql`-connector bindings:

```ts
interface GoldenFixture {
  // ...existing fields unchanged...
  identity?: { principal: string };         // the positive leg's principal, sql bindings only
  negativeIdentity?: { principal: string }; // a DIFFERENT tenant's principal, sql bindings only
}
```

`identity` exists because the claims half of a verify-time identity is configurable from the CLI
(an identity map behind `identityAdapter`) but the principal half is not: `archstone verify`
supplies no caller principal, so without it `identityAdapter(undefined)` resolves nothing and
every contract-bearing `sql` binding is red before isolation is considered. The fixture records
the positive principal next to the negative one, and the replay uses it only when no caller
principal was supplied. No new `verify` flag.

**Mechanics, inside `runVerify`'s existing per-binding loop, for `sql` connectors only:**

1. Replay the fixture's `request` under the caller principal if one was supplied, otherwise
   under the fixture's `identity` (either resolved through the same `identityAdapter`) — the
   existing green/yellow/red path, unchanged.
2. If `negativeIdentity` is present, replay the **identical** request under that principal
   (resolved through the same `identityAdapter`, but the different principal produces different
   claims) and assert the result set is **empty**. A non-empty result here is a hard `🔴`, with a
   detail message distinct from every other red cause ("isolation test failed: N foreign rows
   returned for capability '<id>'").
3. If `negativeIdentity` is **absent** for a `contract`-bearing `sql` binding, the binding is
   `🔴` — "isolation not verified: no negative identity recorded" — mirroring success criterion 4
   verbatim ("a binding without a recorded negative result is not verified").
4. **Confirmed behavior, not left implicit:** if `negativeIdentity` **is** present but the
   configured `identityAdapter` cannot resolve it — returns anything D-3 does not count as
   resolved claims (`undefined`, `{}`, an empty-string value, a non-object), the same "cannot
   resolve" outcome D-3 already treats as a fail-closed refusal for a real invocation — the
   binding is `🔴`, with its own distinct detail
   ("isolation not verified: negative identity did not resolve to any claims"). This is
   deliberately **the same outcome as case 3 (absent)**, not a separate, softer status and never
   a silent skip or an automatic green: an isolation test that cannot be run is exactly as
   unverified as one that was never recorded, regardless of which of the two reasons produced
   that state. `runVerify` must not distinguish "no negative identity was declared" from
   "a negative identity was declared but could not be resolved" in anything other than the
   detail string — both gate the build identically.

**No new `HealthStatus` value, no new CLI flag, no new exit-code mechanism.** This folds into the
existing red-fails-the-build behavior `archstone verify` already has (ADD-18) — a manifest with a
failing isolation test already fails CI the moment any binding is red. `archstone verify`'s
`--json` output (internal ADD-20's shape) gains this as one more possible `detail`/status
combination on an existing field, not a new top-level key.

### D-9. Detecting an over-privileged connection — mechanism and entry points

**Correction (2026-09-24).** The role-level layer below originally checked only
`pg_roles.rolsuper`/`rolbypassrls` and claimed to cover "superuser, table owner, or
`BYPASSRLS`." That claim was wrong: table ownership in Postgres is **not** a per-role attribute
— there is no `pg_roles` column meaning "this role owns something." Ownership is per-relation
(`pg_class.relowner`), so the original check silently let the owner case pass through
uninspected. Fixed below by adding a fourth, genuinely relation-aware check (3b) rather than
widening the role-level query, which cannot express it.

Four independent enforcements, layered rather than relying on any single one:

1. **Compile-time (static, no network — `apply`).** `compiler/src/validate.ts` parses the
   declared `query` text (after stripping leading whitespace/comments) and refuses to compile
   unless it begins with `SELECT` or `WITH … SELECT` (a read-only CTE). This is the
   `statementKind` declaration checked against the query's own shape — an author cannot declare
   `statementKind: select` and write an `UPDATE`.
2. **Transaction-level (structural, every invocation — D-4).** `SET TRANSACTION READ ONLY` makes
   Postgres itself reject any write statement that reaches the database regardless of what the
   query text says, defeating comment obfuscation or multi-statement smuggling the static check
   might miss.
3. **Role-level, superuser/BYPASSRLS (live, at `archstone verify` and at `serve`/`serve --http`
   startup, and inside every transaction after that — never at `apply`, which is offline).** At
   startup, and again inside every transaction `providers/sql` opens (D-4; amended 2026-10-05),
   read the connecting role's `rolsuper` and `rolbypassrls` from `pg_roles` — the query is
   ruling 1's in "When layers 3 and 4 re-run" below. If either is
   `true`, refuse — fail closed, loudly, naming the exact violated property
   ("connection for '<dsn-env-var>' uses a role with `rolbypassrls = true`; the runtime role must
   not bypass row-level security — see the topology guide") and refuse to serve or to verify any
   `sql`-bound capability on that connection. This is a live check and therefore cannot run at
   `apply` — `apply` never dials any backend today (REST or SQL) and stays offline, consistent
   with ADR-0005's "the compile-and-run path never requires a network call *to Archstone*,"
   which is a different claim from "a deployed server never calls the customer's own backend"
   and is not in tension with it: `serve` already calls the customer's REST backend on every
   real invocation; a role check against the customer's own database, at that surface's startup
   and inside its transactions, is the same category of call, not a new dependency on Archstone.
4. **Relation-level, ownership (live, at `archstone verify` and `serve`/`serve --http` startup, and
   again on the first transaction that lands on a server and database with no verdict yet — never
   `apply`).** The verdict is cached per DSN and per (server, database) (amended 2026-10-05, see
   below), not re-run on every transaction: it is the expensive one of the two. Ownership cannot be
   checked against `pg_roles`; it has to be checked against `pg_class` for specific relations, and
   the question this design needs answered is not "does this role own anything in the database"
   (true of almost every real Postgres instance, for objects the runtime role never touches) but
   "does this role own anything **it can also read**" — which is exactly the set of relations a
   bound `sql` capability could actually reach, without parsing any query text to find out. That set
   is already recorded by Postgres itself, as the connecting role's own grants:

   ```sql
   SELECT n.nspname AS schema_name, c.relname AS relation_name
   FROM pg_class c
   JOIN pg_namespace n ON n.oid = c.relnamespace
   WHERE c.relkind IN ('r', 'v', 'm', 'p', 'f')  -- table, view, matview, partitioned table, foreign table
     AND c.relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
     AND EXISTS (
       SELECT 1 FROM information_schema.role_table_grants g
       WHERE g.grantee IN (current_user, 'PUBLIC')
         AND g.table_schema = n.nspname
         AND g.table_name = c.relname
     );
   ```

   Any row returned is a refusal, naming the exact relation
   ("connection for '<dsn-env-var>' owns `<schema>.<relation>`, which it also holds a grant on —
   the runtime role must not own any relation it can query — see the topology guide"). This is
   **fully general with respect to what the connection can do**, not merely to what `init`
   introspected or to a schema an author happened to declare: a role can only ever reach a
   relation through a grant, so "every relation this role owns AND has a grant on" is exactly
   the reachable-and-owned set, with no dependency on reading, parsing, or trusting any specific
   binding's `query` text. It requires no new binding field and no author input.

   **What this does not catch, stated plainly:** `information_schema.role_table_grants` reports
   grants visible to the connecting role's own session — direct grants, `PUBLIC` grants, and
   grants reachable through role membership the connecting role has at query time — the same
   visibility Postgres itself uses to decide what the role can do. It does not, and cannot,
   catch a grant that exists but is not yet visible in this session (e.g. `NOINHERIT` role
   membership the connection has not `SET ROLE`'d into) or ownership of a relation the role could
   reach only through a mechanism outside ordinary `SELECT` grants (e.g. a `SECURITY DEFINER`
   function chain). Those are named residual gaps, not silently assumed away — see R-7.

There is no flag to bypass any of the four. All four are named explicitly so a future
contributor does not "simplify" the design down to whichever ones they find first — in
particular, checks 3 and 4 answer two different questions ("is this role inherently too
powerful" vs. "does this specific role/grant combination let it read something it owns") and
neither one is a substitute for the other.

#### When layers 3 and 4 re-run — amended 2026-10-05 (#123)

**The question.** Layers 3 and 4 were written to run "on first connection per DSN" and to be
cached for the life of the process. That rests on an assumption the text never stated: that a DSN
identifies one role on one server for as long as the process lives. Until #119, a dropped
connection usually crashed `serve`, and a supervisor's restart re-ran D-9 as a side effect. #119
made the pool survive a dropped connection, rightly, and deliberately did not evict the cached
verdict; #127 then fixed the rule to "cache a verdict, never the absence of one." After both, a
long-lived process (`serve --http`, embedded `execute()`, D-5) keeps the verdict it reached at
startup through any failover or re-point behind its DSN. Nothing re-runs D-9.

**When the server behind a DSN can actually differ.**

- **Physical (streaming) replication.** A standby is a block-level copy of the whole cluster,
  shared catalogs included: `pg_authid` (role attributes) and every database's `pg_class`
  (ownership) are the primary's, up to the last change replayed. A promoted standby cannot carry
  different attributes or ownership. Managed high-availability failovers that replicate at the
  physical or storage level are this case; this ruling does not depend on any given service
  being one of them.
- **Logical replication.** Replicates row changes of published tables only. Roles are global
  objects and are not replicated, and neither are DDL, ownership or grants. A subscriber's runtime
  role, its attributes and who owns each relation are whatever was set up on the subscriber, and
  can differ from the publisher in every respect D-9 checks.
- **Blue/green cut-overs.** Inherit whichever of the two they are built on. One built on logical
  replication is the logical case. One whose green side was cloned from a snapshot starts with
  identical roles and ownership and can diverge before the switch.
- **A re-pointed name.** A DNS name, a proxy's target (PgBouncer, a managed proxy) or a load
  balancer moved to another cluster can land anywhere: a different role with the same name, a
  different owner, a different cluster altogether. Behind a proxy this happens **without a new
  client connection**: the process's connection to the proxy outlives the server behind it, so
  pg-pool opens nothing and emits nothing.

So the assumption holds for physical failover and fails for the rest, and the rest are ordinary
operations, not exotic ones.

**The ruling.**

1. **Layer 3 runs inside every transaction.** Every transaction `providers/sql` opens — an
   invocation's (D-4) and `introspectCatalog`'s (D-10) — reads the row below as a statement of
   its own, after `SET TRANSACTION READ ONLY` and before any claim is set; the startup and
   `verify` check reads the same row:

   ```sql
   SELECT rolsuper, rolbypassrls,
          pg_postmaster_start_time() AS server_started,
          (SELECT oid FROM pg_database WHERE datname = current_database()) AS database_oid
   FROM pg_roles WHERE rolname = current_user;
   ```

   `rolsuper` or `rolbypassrls` true is a refusal, with layer 3's existing text. The read runs
   *inside* the transaction because a transaction is the one unit that stays on one backend, on
   a direct connection and through a proxy in session or transaction pooling mode alike (a proxy
   in statement mode cannot carry D-4's transaction at all). So the answer is about the server
   that is about to run the declared query.
2. **Layer 4's verdict is about a server and a database, not only a DSN.** `server_started`
   identifies the server process the transaction landed on; `pg_class` is per database, so the
   key also carries `database_oid`, which changes when a proxy alias is re-pointed at another
   database on the same server or a database is dropped and recreated. Each DSN keeps one layer-4
   verdict per key it has reached. A transaction whose key has no verdict runs layer 4's query in
   that same read-only transaction; every transaction awaits a verdict for its key — its own, or
   one already in flight for that key — before any claim is set or the declared query runs. A key
   already judged is not judged again. The startup and `verify` check records its verdict against
   the key it reached, so a process that never fails over runs layer 4 once, as today.
   `invokeSql`'s lazy pre-check — `ensureConnection` checking out a separate client on the first
   call when no startup check ran (embedded `execute()`) — is dropped: it judges whichever backend
   that checkout reached, and the first transaction now judges its own. `ensureConnection` keeps
   one job, returning the pool and the DSN's cached refusal. The eager check becomes a separate
   entry point, on a separate checkout, called only at `serve`/`serve --http`/`verify` startup,
   so `serve` still refuses before accepting a connection.
3. **A refusal, wherever it is reached, is the DSN's verdict.** A layer-3 or layer-4 refusal
   mid-life rolls back its transaction, fails that call closed with the existing refusal text,
   and is cached for the DSN for the life of the process: every later call against that DSN is
   refused before a connection is checked out, exactly as a refusal at startup is. It does not
   lift when routing moves back to a server that would pass. The unit a deployer configures is
   the DSN, and D-9 refuses "to serve or to verify any `sql`-bound capability on that
   connection"; a refusal that held on some servers and not others would make a misconfigured
   fleet flap instead of stopping. Recovery is the same as from a startup refusal: fix the role,
   restart the process — for embedded `execute()`, the deployer's own application.
4. **A read that fails is not a verdict (#127, unchanged).** If the per-transaction read or a
   layer-4 query errors — the backend died mid-transaction, the function is not executable — the
   transaction rolls back and that call fails closed through the existing
   `query failed (<detail>)` path. Nothing is cached; the next call reads again.
5. **No flag, no mode.** The read is unconditional on every surface. There is no setting to turn
   it off, to fall back to per-DSN caching, or to mark a deployment as having a fixed topology.

**What a mid-life refusal does to work already in flight.** The transaction that observed it is
rolled back; its call is refused. Every other transaction makes its own read on its own backend,
so a call holding another client is refused by its own read if its backend is over-privileged,
and by the cached DSN refusal if it had not yet checked out. A transaction already past its read
when the refusal is cached runs to completion; it ran on a backend whose own read passed. Nothing
is cancelled, and the window is at most one transaction per client.

**Evidence.**

- *No pg-pool hook gates the right thing.* In the `pg-pool` resolved here (3.14.0), the
  `'connect'` (new client) and `'acquire'` (every checkout) events are emitted synchronously and
  their listeners are not awaited, so a check started there races the caller's first query. The
  `onConnect` and `verify` constructor options do gate the checkout, but only of a new physical
  connection, and as constructor options an injected `pgPoolFactory` never runs them. Every hook
  is either unable to gate or blind to a re-point behind a proxy.
- *The per-transaction read is cheap, but it is one more statement.* One row from `pg_roles` by
  the unique index on `rolname`, one from `pg_database` by `datname`, and a value fixed at server
  start: one more round trip per invocation. It must stay a statement of its own, ahead of every
  `set_config`, so that no claim is set before the verdict and layer 4 can run in between. An
  implementation may send `BEGIN READ ONLY; <the read>` as one unparameterised simple-protocol
  message in place of `BEGIN` + `SET TRANSACTION READ ONLY` + the read, keeping the round-trip
  count flat; checked with `pg` 8.23 against Postgres 16, which returns both results and leaves
  the transaction read-only. It is permitted, not required, and cannot carry a bound parameter.
- *`pg_postmaster_start_time()` and `pg_control_system()` are executable by an unprivileged role
  on stock Postgres.* Checked on 16.15 and 17.11: both have the default `PUBLIC` `EXECUTE`
  (`proacl` null), and a `LOGIN NOSUPERUSER NOBYPASSRLS` role read both. Not checked on any
  managed service, which may revoke it; that dependency is R-9.
- *Why the start time and not the cluster identity.* `system_identifier` (from
  `pg_control_system()`) is fixed at `initdb` and carried by every physical copy: a standby, a
  base backup, a snapshot restore. A cluster cloned from a snapshot and since diverged — the green
  side of a snapshot-built blue/green — reports the same value as the original. The start time
  differs for a different server process, including a server started from a copied data
  directory — but not for a memory-snapshot clone (CRIU, a VM instant clone) that resumes the
  running postmaster, which keeps both values (R-9). It also changes on a plain restart
  and on a physical failover, which re-runs layer 4 once against an unchanged catalog: a wasted
  query, accepted, and cheaper than a rule that tries to tell the cases apart.

**Rejected alternatives.**

| Alternative | Why rejected |
|---|---|
| Document the assumption (a DSN is one role on one server) and change no code | The assumption is false for logical replication, logical blue/green and any re-pointed name, which are routine operations. It would turn a checked guarantee into a runbook instruction, the opposite of this ADR's "provable, not merely documented" |
| Re-validate on a schedule | An interval has no correct value: long enough to be cheap leaves a window of that length, short enough to close it is a per-call check by another name. It adds a timer to a library that runs inside a caller's process, and a configurable interval is a setting someone will make "never" |
| Re-validate after N reconnects | Reconnects track load (`idleTimeoutMillis`, churn), not topology. Blind to a re-point behind a proxy, which reconnects nothing |
| Layer 3 on every new physical connection (pg-pool `'connect'`/`onConnect`), layer 4 cached per DSN (#123's option 3) | `'connect'` cannot gate the checkout; `onConnect` misses an injected pool; both miss a proxy re-point; layer 4 would stay unchecked on the new server in every case where ownership, not attributes, differs |
| Re-run layers 3 and 4 when `system_identifier` changes | Readable, but misses a snapshot or base-backup clone, which keeps the original's identifier: precisely the blue/green case |
| Re-run on `inet_server_addr()` changing | Null over a Unix socket; behind NAT, containers or a proxy it names an address, not a server |
| Run layer 4 in every transaction too | Its query joins `information_schema.role_table_grants`, whose cost grows with the catalog. Not measured: this is a judgment that per-call cost for a fact that changes with the server, the database or DDL is not proportionate. It is also the only way to close R-8, and is the one to revisit if R-8 proves likely |
| Evict the pool, or its verdict, on a pool error | Re-argues #119 (eviction orphans checked-out clients and leaks the old pool) |
| A refusal that holds only for the server that produced it | A fleet with one over-privileged server would serve some calls and refuse others depending on routing. The DSN is the configured unit; a refusal stops it, as at startup |

**What this does not cover, stated plainly.** Layer 4 is re-run when the *server or database*
changes, not when the *catalog* does. An `ALTER TABLE … OWNER TO` the runtime role, or a new
`GRANT` to it on a relation it already owns, in the same database on the same running server, is
not seen by a process that has already judged that key. That is R-8, and it is a residual, not
something this ruling claims to close.
Layer 3, by running in every transaction, does see an `ALTER ROLE … SUPERUSER` or `BYPASSRLS` on
the same server; that is a consequence of where the read runs, not the reason for it.

**Interactions.**

- **D-5.** One rule on every surface. Long-lived processes (`serve --http`, embedded `execute()`)
  are where it matters; a stdio `serve` process lives for one conversation and gets the same
  read, with no special case for being short.
- **#127.** "Cache a verdict, never the absence of one" is unchanged and now applies per key:
  a verdict (ok or refused) is cached, a failed read or failed layer-4 query is not.
- **#119.** Unchanged: no pool eviction on error.
- **The CLI startup check** (`serve`, `serve --http`, `verify`) reads the same row, so it now also
  fails — fail closed, exit 1 — when `pg_postmaster_start_time()` is not executable, or the
  database oid cannot be read (R-9).
- **#120/#125, #121.** No new caller-facing text. Refusals reuse layer 3's and layer 4's existing
  strings, so a fix for #121's unfiltered `dsnEnvVar` covers them. A failed read goes through the
  existing scrubbed `query failed (<detail>)`. The server start time and database oid are never
  put in a caller-facing error.

### D-10. `archstone init`'s Postgres adapter — compile-and-probe loop, not a one-shot generator

Follows the precedent internal ADD-37 already established for the OpenAPI adapter, and reuses
its machinery rather than duplicating it:

- **A new `SourceAdapter` under `packages/init/src/adapters/postgres/`.** Unlike the OpenAPI
  adapter (a pure, static document parse), this adapter's input is *live*: the catalog, read
  over a real, read-only connection using the runtime role. Scoping is by the role's effective
  privileges — `has_table_privilege(…, 'SELECT')` and `has_column_privilege(…, 'SELECT')`,
  which count `PUBLIC` and inherited membership, the same visibility D-9 layer 4 relies on — not
  by what the catalog merely lets the role *see*. Tables, partitioned tables, views and
  materialized views are proposed; partitions fold into their parent; foreign tables are
  reported and deferred (RLS cannot be enabled on them, and reading one reaches a third host).
  So `init` can only ever propose what the runtime role can already `SELECT`, which is
  precisely what makes the curated-view topology the path of least resistance rather than a
  lecture (the product brief's journey 5.1).
- **Reads the catalog through `providers/sql`, not a bespoke ad-hoc `pg` client inside
  `packages/init`.** The host issues its catalog queries through `providers/sql`'s
  `introspectCatalog`, which shares `ensureConnection` (the same pool and the DSN's cached refusal)
  and D-4's read-only transaction, so it gets D-9's per-transaction read (layer 3, and layer 4 when
  its key has no verdict yet) with the same messages (amended 2026-10-05). The adapter itself stays
  a pure function of the snapshot it is handed. It sets no session identity because it runs no
  declared query: D-3's gate protects tenant rows read by a declared query, and the catalog has no
  tenant rows, is not subject to RLS, and is read with constant query text no author or caller can
  influence. It does **not** go through `invokeConnector` over a synthetic `IRTool` — that would
  need a fabricated `identityAdapter` to pass D-3's gate (a hole in the very gate it exists for),
  would move SQL authoring out of the one package that owns `pg`, and would push a meaningless tool
  through the policy evaluator and response mapper. An "introspection" flag on the invocation path
  was refused for the same reason: a flag on the invocation path is a flag someone will set on a
  real invocation. Either way there is never a second, parallel connection/role-check
  implementation, so D-9's over-privileged check runs for `init`'s own introspection connection for
  free: pointing `init` at a superuser DSN refuses immediately, consistently with everywhere else.
- **Column → CDL semantic type**, from `information_schema.columns` ground truth (`is_nullable`,
  `data_type`) rather than a spec's possibly-stale declaration — actually *more* reliable than
  the OpenAPI adapter's declared/observed distinction, since this is the catalog itself. Required
  vs. optional is `is_nullable = 'NO'` directly, no probing needed. **Named gap, not built
  around:** Postgres `boolean`/`json`/`jsonb`/array column types have no faithful `SemanticType`
  in `cdl.schema.json`'s closed set (`location`, `date-range`, `party`, `preference-set`,
  `money`, `identifier`, `string`, `text`, `time-slot`, `quantity`, `enum`, `date`, `datetime` —
  no boolean, no raw JSON). Per-column skip-and-report with a new reason code
  (`column-type-not-expressible`), mirroring ADD-37's own precedent for an unmappable OpenAPI
  construct (`field-path-not-expressible`) — a tool limitation, not a CDL gap, and not proposed
  as a new semantic type here.
- **The effect hint is always `read`** (v1 is read-only by construction), routed through the
  same human-confirmed Decision Record ADD-37 D-3/D-4 established, for one-mental-model
  consistency across adapters rather than a special case. **The confirmed effect is recorded as
  the human gave it.** `effect` is human-confirmed, never inferred; an `init` that rewrote a
  confirmed `write` to `read` would be inferring it. Over-declaration is the safe direction —
  more confirmation, no probe — and refusing it would make `init` reject an answer the compiler
  accepts.
- **The probe leg extends `recordContract`, and a SQL capability is never proposed with a
  contract but no isolation test.** When `init` offers to record a fixture for a proposed SQL
  capability, it also prompts for (or, non-interactively, requires) a second identity to record
  as `negativeIdentity` (D-8) in the same step, and records the positive principal as the
  fixture's `identity` so a later `verify` can replay both legs. If the negative probe cannot
  be attempted — no second identity available, non-interactive mode with none supplied —
  `init` records **no** `contract:` for that capability at all (extending the existing
  "contract is all-or-nothing," ADD-37 Challenge 2 item 3, rather than emitting a
  testable-looking contract with no isolation proof).
- **Loop structure is identical to the OpenAPI adapter's**: temp-dir materialize → `load` →
  `validateSemantics` → `compile` → `new Registry()` (tool-name collision refusal, ADD-30) →
  record-and-verify-green-before-commit → write only on success. "Adding an adapter must touch no
  file outside `adapters/`" (ADD-37 D-1) holds here more cleanly than it did for OpenAPI — there
  is no multi-document `$ref`-closure problem — **provided `providers/sql` (with
  `introspectCatalog`) and `invokeConnector` (D-1–D-6 of this ADR) land first**; this adapter
  is a downstream consumer of this ADR's core work, not a parallel effort.

---

## IR & Schema Impact — summary

| Artifact | Change | Additive? |
|---|---|---|
| `connector.schema.json` | `sql` object (`engine`, `dsn`, `statementKind`, `query`, `params`); `graphql`/`grpc`/`soap` untouched | Yes |
| `compiler/src/ir.ts` | `IRSqlConnector`; `IRConnector.sql?` | Yes — `IR.version` stays `"0"` |
| `compiler/src/validate.ts` | New error `connector-type-not-implemented` for `graphql`/`grpc`/`soap`; new checks for `sql.query`/`params` consistency and `statementKind` vs. leading keyword | Yes (new diagnostics only) |
| `response.schema.json`, `contract.schema.json`, `IRContract`, `IRResponseMapping` | **Unchanged** | n/a |
| `GoldenFixture` (TS interface, unschema'd) | `identity?: { principal: string }`, `negativeIdentity?: { principal: string }` | Yes |
| `@archstone/emitter-support` root (`CallerContext`, base `InvokeOptions`) | Relocated from `providers/rest`; `identityAdapter?` added to the base | Additive; `providers/rest` re-exports the type for compatibility |
| `@archstone/runtime/connector` (new subpath) | `invokeConnector(tool, input, opts)`; edge-safe `rest`-only half at `@archstone/runtime/connector-rest` | New surface, pure root untouched |
| `providers/sql` (new package) | `invokeSql`, mirroring `invokeRest`'s `InvokeResult` shape; `ensureConnection`; `introspectCatalog` for `init` (D-10) | New package |
| `packages/init/src/adapters/postgres/` (new) | Postgres `SourceAdapter` | New, downstream of the above |

No change to `cdl.schema.json` — capabilities remain implementation-blind by construction; every
change above is binding/provider/IR-side.

---

## Consequences

**Accepted:**

- A capability bound to `sql` is, from the model's side, indistinguishable from one bound to
  `rest` — same tool listing, same input/output schema, same violation semantics — because both
  terminate in the same `applyResponseMapping`/`IRResponseMapping` machinery, and both are
  reached through the same `invokeConnector` dispatch.
- The isolation guarantee is enforced four times independently (compile-time statement check,
  transaction-level `READ ONLY`, live superuser/`BYPASSRLS` role check, live relation-ownership
  check) and is *provable*, not merely documented — `archstone verify`'s negative test is a build
  gate, not a runbook instruction.
- `CallerContext` moving to `@archstone/emitter-support` pays down debt internal ADD-32 R-1
  explicitly deferred rather than adding a second copy of caller-context plumbing beside it.
- The SQL provider adds exactly one new IR field (`IRConnector.sql`) and reuses every other IR
  concept (`IRResponseMapping`, `IRContract`, `IRField`) unmodified — the compiler's target
  neutrality is undisturbed.
- D-9 re-runs after a server change (2026-10-05), at a cost. Every invocation runs one more
  statement, unless folded into `BEGIN` (D-9). Layer 4 re-runs after every server restart, not
  only after a failover, which is frequent where a service scales to zero. A refusal reached
  mid-life holds until the host process restarts — for embedded `execute()`, the deployer's own
  application.

**Rejected alternatives:**

| Alternative | Why rejected |
|---|---|
| A portable multi-engine `sql` connector (Postgres + Snowflake + BigQuery) in v1 | Each engine's isolation mechanism is structurally different (RLS+GUC vs. row-access-policies vs. authorized views with no per-request session concept); a shared abstraction degrades to the weakest engine's guarantee while presenting one promise (product brief Challenge 2) |
| Identity carried as a query parameter (`WHERE tenant_id = $1` bound from `caller.tenantId`) | Puts the isolation boundary back in binding-authored text — exactly what "the YAML author is not part of the security boundary" forbids. A forgotten predicate would leak; the session-GUC/RLS design makes the predicate irrelevant to correctness |
| `${caller.NAME}`-style templating inside `sql.query`, symmetric with REST's header/body templating | Reintroduces string-built SQL text at the one place it must never exist; REST's templating is safe because it only ever changes *where a request goes or what it carries*, never *what a database executes* |
| Dispatch logic duplicated in each of the four invocation call sites | The exact defect class internal ADD-30 already found and fixed once (two independently-buggy hand-rolled indexes); centralizing in one new subpath costs one file |
| Putting `invokeConnector` in `@archstone/emitter-support` (root or subpath) | The root breaks that package's own "IR-only: no MCP SDK, no fs, no HTTP" contract for every existing pure consumer; a subpath makes a circular workspace dependency, since both providers depend on `emitter-support`. A `@archstone/runtime` subpath (precedent: ADD-37 R-2) solves both |
| `init` introspection through `invokeConnector` over a synthetic `IRTool`, or an "introspection" flag on `invokeSql` | The first needs a fabricated `identityAdapter` to pass D-3's gate and authors SQL outside `providers/sql`; the second is a flag on the invocation path that someone will set on a real invocation. `introspectCatalog` shares `ensureConnection` and D-4's read-only transaction instead (D-10) |
| RLS/GUC session state as an explicit binding-authored `SET LOCAL` statement, symmetric with the declared query | Reopens exactly the "manifest author is part of the security boundary" problem this design exists to close — a binding author could omit or mis-author the `SET`, and nothing would catch it |
| D-9 layers 3–4 cached once per DSN for the life of the process, with the topology assumption documented (#123) | The server behind a DSN can change under a running process — logical replication, logical blue/green, a re-pointed name or proxy — and a cached verdict then describes a server the process no longer talks to. Layer 3 runs per transaction and layer 4 per (server, database) instead (D-9, "When layers 3 and 4 re-run"), where the other alternatives considered are also listed |

---

## Risks

| ID | Risk | Likelihood | Impact | Mitigation direction |
|---|---|---|---|---|
| R-1 | A future contributor "simplifies" read-only enforcement down to one layer (e.g. drops `SET TRANSACTION READ ONLY` as "redundant" with the static check) | M | H | D-9 names all three explicitly and independently; code review treats removing any one as a Challenge trigger, same discipline ADD-42 R-11 uses for its own load-bearing line |
| R-2 | A DBA-authored RLS policy defaults to permissive when the session GUC is unset, silently widening the boundary if `identityAdapter` is ever accidentally left unconfigured | M | H | D-3's fail-closed-on-absent-identity gate means an unconfigured adapter refuses every `sql` invocation rather than running with no GUC set — the two failure modes must both hold, and are documented together in the topology guide (a docs follow-up, not code) |
| R-3 | The negative-isolation fixture format (`negativeIdentity`, unschema'd) drifts from what `verify` expects, the same class of risk ADD-37 already named for the golden-fixture format generally | M | M | Pin with a round-trip test (record → `runVerify` → red-without/green-with, per D-8); schema question deferred exactly as ADD-37 O-11 deferred it for the base fixture |
| R-4 | Postgres native-type → JSON coercion (bigint, numeric, timestamp, uuid) disagrees between what `init` observes at probe time and what a later driver version produces, causing a false drift signal | M | M | Pin the driver's type-parser configuration explicitly (no reliance on ambient defaults) as part of `providers/sql`'s own test suite, not left to each deployer's `pg` version |
| R-5 | `init`'s Postgres adapter ships before `providers/sql` (`ensureConnection`, `introspectCatalog`) (D-1–D-6, D-10), forcing it to open its own ad-hoc connection and duplicating the exact mechanism this ADR centralizes | L (sequencing is stated) | H | D-10 states the dependency order explicitly; implementation guidance below sequences accordingly |
| R-6 | Premature Phase-2 (edge/Hyperdrive) complexity creeps into v1 because "it would be nice to also run this on Workers" | L | M | D-5 draws the exclusion boundary now and builds no accommodation for it; a data-proxy decision is explicitly deferred to a real customer demand, per the product brief |
| R-7 | The ownership check (D-9, layer 4) misses a grant the connecting role holds but that is not visible in the checking session — most plausibly a `NOINHERIT` role membership the connection has not `SET ROLE`'d into, or a path to data reached through a `SECURITY DEFINER` function rather than a direct table/view grant | L | H | Named explicitly in D-9 rather than folded into a general "best effort" disclaimer, so the topology guide can say precisely what is and is not covered. The mitigation is operational, not code: the documented default topology (a runtime role granted directly on a curated view schema, no role-membership indirection, no `SECURITY DEFINER` in the exposed surface) is exactly the shape under which this check is complete, and `archstone init`'s own output never produces the shape that would evade it |
| R-8 | Ownership or grants change in the *same* database on the *same* running server — `ALTER TABLE … OWNER TO` the runtime role, or a new `GRANT` to it on a relation it already owns — after a long-lived process (`serve --http`, embedded `execute()`) has judged that (server, database); layer 4 is not re-run, so the process keeps serving a role that now owns a relation it can read. Layer 3's attributes are not affected: they are read in every transaction | L | H | Named in D-9 rather than implied away. Operational: the topology guide states that layer 4 is judged once per server and database per process, that ownership of exposed relations belongs to a separate owner role, and that an ownership or grant change touching the runtime role is followed by a restart of long-lived processes. `archstone verify` re-runs layer 4, which helps only where it reaches the production server and database, which CI usually does not. A per-transaction layer 4 would close it and was rejected as a judgment on cost, not a measurement (D-9) |
| R-9 | A managed Postgres service revokes `EXECUTE` on `pg_postmaster_start_time()` from ordinary roles, or returns something other than the server process's start time; or a server is a memory-snapshot clone (CRIU, a VM instant clone) of a running one, which keeps the same start time (and `system_identifier`) while it diverges; or two servers start in the same microsecond (theoretical). Verified only on stock Postgres 16 and 17, where it is `PUBLIC` | L | M if revoked (every call fails closed — an outage, never a bypass); H if the key does not change across a server change (layer 4 would not re-run on a re-point) | Revoked: fails closed by D-9 ruling 4, loudly (the startup error reports it as a check that could not complete, not as "over-privileged", #133) — at `serve`/`serve --http`/`verify` startup before any call is served; under embedded `execute()`, which has no startup check, on every call from the first. The Postgres integration suite pins the stock behaviour; the topology guide lists the function among what the runtime role needs. A service whose value does not track the server is not detectable from inside the session; if one is found, the fix is a different server identity in the same place, not a fallback to per-DSN caching |

---

## Open Questions

1. **Verify-time identity source.** *Partly answered (2026-10-02).* D-8's positive replay needs
   claims and a principal. The claims half is the CLI's identity map behind `identityAdapter`;
   the principal half is now the fixture's own `identity` (D-8), used when no caller principal
   is supplied — no `--verify-caller` flag. Still open: whether `verify` should also accept a
   caller principal from the environment for hand-written fixtures that record none — left for
   the implementation issue, since it does not affect the IR/schema/dispatch design above.
   Whichever wiring is chosen, D-8's
   fourth case (negative identity present but unresolved ⇒ 🔴, same as absent) already fixes the
   *behavior* independent of *how* the identity is supplied, so the BA's acceptance criteria can
   be written against that behavior now without waiting on this question.
2. **`archstone init`'s scaffolded RLS/view SQL.** The product brief's journey 5.1 has `init`
   "refusing to propose anything the runtime role cannot select," which this ADR covers, but does
   not propose `init` *generating* the curated-view/RLS migration SQL itself — that remains a
   human/DBA authoring step. Worth a follow-up product decision once v1 ships and real DBAs have
   used it.
3. **Pool-sizing defaults and observability.** D-5 defers connection-pool sizing to deployer
   configuration with no product surface; whether `archstone verify --json`/a future console
   evidence pack should also report pool-exhaustion incidents is out of scope here and flagged
   for the console-side follow-up the product brief already names as explicitly deferred.

---

## Implementation Guidance (ordered)

1. **`@archstone/emitter-support`**: relocate `CallerContext` and the connector-agnostic half of
   `InvokeOptions`; add `identityAdapter?`; `providers/rest` re-exports the type. New
   `@archstone/runtime/connector` subpath housing `invokeConnector` (D-6) — stubbed to call
   `invokeRest` only, for now, so this step is independently shippable and non-breaking.
2. **`connector.schema.json` + `compiler/src/ir.ts`/`compile.ts`/`validate.ts`**: add the `sql`
   object, `IRSqlConnector`, the query/params/statementKind static checks, and the
   `connector-type-not-implemented` diagnostic for `graphql`/`grpc`/`soap`.
3. **`providers/sql`** (new package): `invokeSql`, the transaction/session mechanics (D-4), the
   role-privilege check (D-9 layer 3), pool lifecycle (D-5). Wire into `invokeConnector`.
4. **`runtime/src/verify.ts`**: route `verifyTool`/`recordContract` through `invokeConnector`;
   implement the negative-isolation replay (D-8) for `sql` connectors.
5. **`agent/src/execute.ts`, `runtime/src/server.ts`**: route `executeCapability`/`callTool`
   through the edge-safe `@archstone/runtime/connector-rest` by default, accepting the full
   `invokeConnector` only as a caller-supplied override (D-5/D-6).
6. **`packages/init/src/adapters/postgres/`**: build only after steps 1–4 land, per D-10/R-5,
   with `introspectCatalog` added to `providers/sql` and `GoldenFixture.identity` to
   `runtime/src/verify.ts` in the same series.
7. **Docs**: the topology guide (curated-view default, RLS-on-base-tables alternative, the
   fail-closed role check's exact error text) — a tech-writer follow-up once the mechanism above
   is implemented, not before.
8. **D-9 re-run after a server change (#123, amended 2026-10-05).** Ratified 2026-10-05.
   Steps 1–4 shipped for `invokeSql` (#132); step 2's `introspectCatalog` half waits on that
   function (#87), step 5 on the topology guide (step 7). In order:
   1. *`providers/sql`*: `checkOverPrivileged` reads ruling 1's row, returning the
      (`server_started`, `database_oid`) key. `ConnectionEntry` keeps a DSN-level refusal and, per
      key, a layer-4 verdict (or an in-flight check); #127's verdict-versus-absence handling and
      its "never clobber a newer check" guard carry over per key. `ensureConnection` returns the
      pool and the DSN's cached refusal, and runs no check. A separate eager-check entry point,
      on a separate checkout, is called only by `serve`/`serve --http`/`verify` startup.
   2. *`invokeSql` and `introspectCatalog`*: after `SET TRANSACTION READ ONLY`, the
      per-transaction read as its own statement (D-4), or folded into `BEGIN READ ONLY` as D-9
      permits; refuse on `rolsuper`/`rolbypassrls`; await the key's layer-4 verdict, running
      layer 4 in this transaction when none exists or is in flight, before any `set_config`;
      cache any refusal as the DSN's; on a failed read, roll back through the existing
      `query failed (<detail>)` path and cache nothing. Remove `invokeSql`'s lazy pre-check on a
      separate checkout; keep the eager CLI startup check. No option on `SqlInvokeOptions`
      controls any of it.
   3. *Unit tests* (`providers/sql/test/invoke.test.ts`, fake pool): a server change (new start
      time) re-runs layer 4 once and not again; a database change on the same server (new oid,
      same start time) re-runs it too; no `set_config` is sent before the verdict; a role turning
      `rolbypassrls` mid-life refuses the next transaction and every later call without a
      checkout; a mid-life layer-4 refusal is cached for the DSN and survives routing back to a
      passing server; a failed read fails the call and caches nothing; two servers alternating
      behind one DSN run layer 4 once each; refusal strings carry no start time, host or driver
      text.
   4. *Postgres integration suite* (`providers/sql/test/postgres.integration.test.ts`): an
      unprivileged runtime role can execute the read, and the CLI startup check fails closed if it
      cannot; `ALTER ROLE … BYPASSRLS` on the runtime role while a pool is live refuses the next
      call and every later one. If the suite's harness allows it: restarting the server under a live
      pool re-runs layer 4 once (new start time), and a second container standing in for a
      re-pointed name is judged on its own.
   5. *Docs*: the topology guide gains the assumption that is now checked, what is not (R-8), the
      restart after an ownership change, and `pg_postmaster_start_time()` among the runtime role's
      requirements (R-9).

   Separately, the CLI's startup error reports a check that could not complete — a revoked
   `pg_postmaster_start_time()` among them — as such, not as "over-privileged" (#133).
