# @archstone/schema

Schema Loader — loads and shape-validates a deployable Capability Definition Language (CDL)
manifest from disk (`capabilities.yaml`, `*.capability.yaml`, `*.resource.yaml`,
`bindings/*.binding.yaml`) against the canonical JSON Schema.

Part of [Archstone](https://github.com/NousVigil/archstone), an open-source
Capability Platform. This package is the first stage of the compiler pipeline
(`schema` → `compiler` → `runtime` → `cli`) — most users should install
[`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli) instead of depending on
this package directly.

## License

Apache-2.0
