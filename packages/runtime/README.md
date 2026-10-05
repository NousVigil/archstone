# @archstone/runtime

Runtime — the capability `Registry` (list/resolve tools over the IR) and the MCP emitter:
lowers IR tools to MCP `tools/list` + typed `outputSchema`, dispatches `tools/call` through
a binding's connector and response mapping, and serves the result over stdio (or any
transport, e.g. Streamable HTTP on Cloudflare Workers).

Part of [Archstone](https://github.com/NousVigil/archstone), an open-source
Capability Platform. This package is the third stage of the compiler pipeline
(`schema` → `compiler` → `runtime` → `cli`) — most users should install
[`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli) instead of depending on
this package directly.

## License

Apache-2.0
