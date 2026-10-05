- **`archstone adopt` records the replayed response against the manifest's own resources.** It
  used to map that response with an empty resource registry, so every mapped field counted as
  required and no field type was known. It now uses the manifest's resource definitions: an
  absent optional field degrades (yellow) instead of failing the adoption, and a `web-page`
  value outside the declared origins stops it (red, field names only).
- **A shape error on an enumerated value now names the value it refused.** `@archstone/schema`'s
  loader appends `(got '<value>')` to an `enum` failure in an authored manifest — e.g.
  `/capability/output/links/list must be equal to one of the allowed values (got 'web-page')`.
  Machine-emitted execution records are reported as before.
- **`contractViolationMessage` (`@archstone/emitter-support`) takes an optional third argument,
  the withheld field names.** Without it, or with an empty list, the text is unchanged.
