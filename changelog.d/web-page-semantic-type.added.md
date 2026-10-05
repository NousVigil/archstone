- **`web-page`, an Experimental output-only semantic type, checked against origins the binding
  declares.** A link field typed `string` can carry any URL, so a provider's data — or text a
  listing's owner typed in — could have an assistant show a person a link to anywhere. A field
  typed `web-page` means "the page where a person sees this resource on the provider's own
  site", and a binding declares where such pages live with a new `origins: { pages: [...] }`
  key (a sibling of `response:`/`extract:`; each entry a bare `https` origin). The shared
  response mapper in `@archstone/emitter-support` (`applyResponseMapping`) now checks every
  `web-page` value — top-level, inside nested resources, in every collection row, in `onError`
  rows and in `extract:` fields — and fails closed: a value must be an absolute `https` URL with
  no userinfo whose normalised origin equals a declared one. A passing value is emitted as its
  normalised href; a failing one is withheld (an optional field is omitted and the result is
  degraded; a required field is a contract violation carried in `_meta`, never in
  `structuredContent`). `MappingResult` and `@archstone/agent`'s `ExecuteResult` gain an
  optional `withheld: string[]` of field names — never values, and never added to `degraded`.
  `archstone verify` reports any withheld value red (`value outside declared origins in:
  <fields>`), and recording a contract keeps nothing when one is withheld. MCP lowers the type
  to `{ "type": "string", "format": "uri" }`; the `tools()` envelopes carry input schemas only
  and are unchanged; extraction refuses it; `archstone init` never infers it. `apply` adds six
  named rules: `web-page-in-input`, `web-page-no-origins`, `web-page-needs-mapping` and
  `origins-malformed` (errors), `origins-unused` and `web-page-required-in-collection`
  (warnings). Additive: an IR without `origins` is byte-identical and `IR.version` stays `"0"`.
  Only typed fields are checked (a URL inside a `text` field is untouched), relative links are
  withheld rather than resolved, and nothing fetches the page. See the CDL specification §4.7.
