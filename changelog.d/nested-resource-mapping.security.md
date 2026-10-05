- **`@archstone/emitter-support`: undeclared keys inside a nested value no longer reach the model
  (#146).** The response mapper projected only the top level of each row. A field whose type is a
  resource (`host: Host`) was copied as the provider sent it, so every key inside it reached
  `structuredContent`, the model-facing text, the embedded `execute()` result and `verify`'s
  replay, whether `Host` declared it or not. The same was true of a `collection:` inside a
  resource, of an object sent in a `ref:` slot, of extra keys inside a `money`, `party` or
  `date-range` object, and of an object or array sent where a plain scalar (`text`, `quantity`, …)
  is declared. Every value is now projected against its declared type at every level, so
  ADR-0008's guarantee, that an undeclared provider field never reaches a model, holds at any
  depth. Every earlier release is affected for an output resource that nests a `type:` resource,
  a `collection:` field or a composite semantic type.
