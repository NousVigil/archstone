# @archstone/compiler

Compiler — validates a CDL Semantic Model (providers resolve, resources resolve) and lowers
it to the target-agnostic IR (`IR` — the physical form of the moat: no MCP SDK, no HTTP, no
JSON Schema, consumed by every emitter).

Part of [Archstone](https://github.com/NousVigil/archstone), an open-source
Capability Platform. This package is the second stage of the compiler pipeline
(`schema` → `compiler` → `runtime` → `cli`) — most users should install
[`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli) instead of depending on
this package directly.

## License

Apache-2.0
