# @archstone/provider-rest

REST provider — the only place HTTP appears in the Archstone pipeline. Maps a capability
call's typed input to an HTTP request per a binding's connector config, and maps the HTTP
response back to a result (or a fail-closed OK/DEGRADED/VIOLATION status) via the binding's
response mapping.

Part of [Archstone](https://github.com/NousVigil/archstone), an open-source
Capability Platform — most users should install
[`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli) instead of depending on
this package directly.

## License

Apache-2.0
