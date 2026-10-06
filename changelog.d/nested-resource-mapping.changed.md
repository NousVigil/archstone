- **Breaking: what a manifest that under-declares a nested resource now returns.** A mapped
  value contains only what its declared type names:
  - a nested resource value holds only the resource's declared fields, read by name, at every
    level and in every `collection:` row; other keys are dropped;
  - `money`, `party` and `date-range` objects keep only their declared keys. A primitive in their
    place (`price: 120`) passes as before;
  - a `ref:` slot takes a primitive id only. An object or array there is treated as absent,
    never reduced to an id;
  - an object or array where a scalar is declared is treated as absent, top level included;
  - nested values are capped at 32 resource levels; anything deeper is absent.

  Absent values follow the required/optional rules at each level. When a nested value is missing
  a required field, the nearest **optional** field above it is dropped and named in `degraded`
  (`host`, or `host.agency` deeper down). With no optional field on the way up, the response is
  a contract violation naming the deepest field (`host.name`; collection rows share a path, with
  no index). A `collection:` inside a resource is dropped as a whole when any row fails, never
  shortened. This also applies to a required `web-page` withheld inside a nested value. Until
  this release that failed the whole response even under an optional parent.

  `archstone verify` prints, under each capability,
  `nested keys not declared (dropped): host.phone, …`, with names only and never values. The
  line is informational and does not change the result. `--json` carries the same list as
  `undeclaredNested`. `applyResponseMapping` takes an optional fourth argument,
  `{ collectUndeclared: true }`, which adds `undeclaredNested` to its result.

  **Upgrading:**
  1. Run `archstone verify`, declare on the nested resource each key it lists that you need, and
     re-run.
  2. If a binding uses `@archstone/provider-sql` and reads a `date` or `timestamp` column,
     re-record its fixture: those columns' contract fingerprints change from `object` to
     `string` (see below). Fingerprints of every other binding are unaffected.
  3. If you pass your own `pgPoolFactory` to `@archstone/provider-sql`, install its exported
     `jsonSafeTypeParser` on that pool (`types: { getTypeParser: jsonSafeTypeParser }`).
     Without it, `date` columns arrive as local-midnight `Date`s and shift by the host's
     time zone.
- **`@archstone/provider-sql` returns JSON-safe rows.** `pg` returned `date` and `timestamp`
  columns as JS `Date` objects. The stricter mapper treats a non-JSON object as absent, so a
  required date field would fail the response. The default pool now parses a `date` as
  Postgres's own `YYYY-MM-DD` text, which also removes the one-day shift pg's local-midnight
  `Date` caused east or west of UTC. A `timestamp` (no time zone) is read as UTC and sent as an
  ISO instant (`2026-10-03T12:34:56.789Z`); a `timestamptz` is an ISO instant in UTC. Their array
  types are parsed the same way, and `infinity` or a BC value stays as Postgres prints it. Any
  value left with no JSON form is `null`, which the mapper treats as absent: `bytea`,
  `interval`, and other class instances. A required field read from such a column therefore
  reports missing. A `bigint` becomes its decimal string and a non-finite number becomes `null`.
  `numeric` and `int8` already arrived as strings and are unchanged. A `jsonb` key named
  `__proto__` is kept as ordinary data. The parser is exported as `jsonSafeTypeParser`.
