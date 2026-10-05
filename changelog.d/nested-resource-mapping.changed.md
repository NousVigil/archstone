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

  To find what a manifest relied on, run `archstone verify`. Under each capability it prints
  `nested keys not declared (dropped): host.phone, …`, with names only and never values. The
  line is informational and does not change the result. `--json` carries the same list as
  `undeclaredNested`. Declare the keys you need on the nested resource and re-run.
  `applyResponseMapping` takes an optional fourth argument, `{ collectUndeclared: true }`, which
  adds `undeclaredNested` to its result. Fingerprints are unaffected, so no fixture needs
  re-recording.
