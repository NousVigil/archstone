- **`image`, an Experimental output-only semantic type, checked against origins the binding
  declares, with per-item withholding in lists.** A URL field typed `string` can carry any
  link, so a provider's data could show an assistant any image at all. A field typed `image`
  means "a picture or visual asset for the client to display", and a binding declares where such
  images live with a new `origins: { images: [...] }` key (a sibling of `response:`/`extract:`;
  each entry a bare `https` origin). Unlike `web-page`, `image` **may be a list** (`list:
  image`). The shared response mapper in `@archstone/emitter-support` (`applyResponseMapping`)
  now checks every `image` value — top-level, inside nested resources, in every collection row,
  in `onError` rows and in `extract:` fields — and fails closed: a value must be an absolute
  `https` URL with no userinfo whose normalised origin equals a declared one. For scalar fields,
  a passing value is emitted as its normalised href; a failing one is withheld (an optional
  field is omitted and the result is degraded; a required field is a contract violation). For
  list fields, items are checked individually: off-origin items are dropped, valid ones kept in
  order with their 0-based positions from the provider named in `withheld` (e.g. `photos[2]`),
  and an empty list (all items withheld) is present and degraded. Item names appear in
  `withheld` only, never in `degraded`. A `list: image` with any withheld items causes the
  result to be DEGRADED, whether the list is optional or required. `MappingResult` and
  `@archstone/agent`'s `ExecuteResult` gain an optional `withheld: string[]` (same as for
  `web-page`, shared implementation). `archstone verify` reports any withheld value red (`value
  outside declared origins in: <fields>`), and recording a contract keeps nothing when one is
  withheld. MCP lowers scalar `image` to `{ "type": "string", "format": "uri" }` and list
  `image` to `{ "type": "array", "items": { "type": "string", "format": "uri" } }` with no
  `minItems`; the `tools()` envelopes carry input schemas only and are unchanged; extraction
  refuses it; `archstone init` never infers it. `apply` adds six named rules: `image-in-input`,
  `image-no-origins`, `image-needs-mapping` and `origins-malformed` (errors), `origins-unused`
  and `image-required-in-collection` (warnings; scalar only, since lists drop items per-item).
  Additive: an IR without `origins.images` is byte-identical and `IR.version` stays `"0"`. Only
  typed fields are checked (a URL inside a `text` field is untouched), relative links are
  withheld rather than resolved, nothing fetches the image or checks safety, and signed URLs are
  not special-cased. Parallel lists (`photos` and `captions` with matching indices) misalign
  when items are withheld; the type's documentation recommends a `collection:` of a Resource
  with both fields instead. See the CDL specification §4.7–§5.4.
