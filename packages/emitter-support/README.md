# @archstone/emitter-support

Shared, IR-only substrate for Archstone emitters (ADD-0008 / RFC-0008): IR indexing
(`Registry`), semantic-type → JSON-Schema lowering, tool-name sanitization, the
response-mapping executor, and the extraction boundary (ADR-0011) — `extractionJsonSchema`
and `validateExtraction`, which lower a declared resource into a closed schema and judge a
model's answer against it. Depends only on `@archstone/compiler` — no MCP SDK, no
`node:fs`, no HTTP — so any emitter built on it (the MCP server in `@archstone/runtime`, the
embedded agent in `@archstone/agent`) can be tree-shaken cleanly.

Both directions of travel go through this package, and that is the point: a Resource
Definition is the schema for a provider's response *and* for what a model must produce, so
neither side can be mapped by a rule the other does not share.

Part of [Archstone](https://github.com/NousVigil/archstone), an open-source
Capability Platform — most users should install
[`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli) instead of depending on
this package directly.

## License

Apache-2.0
