# @archstone/init

Capability inference from an existing API — reads an OpenAPI document, asks the questions no
spec can answer, and drafts a Capability Definition Language (CDL) manifest that the real
compiler has already compiled. It writes nothing at all if that manifest does not compile.

Part of [Archstone](https://github.com/NousVigil/archstone), an open-source
**Capability Platform**: a company describes what it can do in CDL (business only, no
integration code); Archstone compiles that to a target-agnostic IR; an emitter turns the IR
into tools an AI agent can discover and call. This package is the onboarding path into that
pipeline — most users should install [`@archstone/cli`](https://www.npmjs.com/package/@archstone/cli)
and run `archstone init`, rather than depending on this package directly.

## Usage

```bash
npm install -g @archstone/cli
archstone init path/to/openapi.yaml --out manifest --company acme --domain catalog
```

The one answer it never guesses is `effect` — `read`, `write` or `irreversible` is the
difference between looking up a price and charging a card, and no spec says which. Where a
response could honestly be read two ways (which array in a payload is the actual result, and
which is diagnostics?), it asks rather than picking. With `--probe` it will also make one
read-only call to your real backend and record a genuine fixture, so `archstone verify` has
something true to replay later.

See the [main repository README](https://github.com/NousVigil/archstone#readme) for
the full CDL format, worked examples, and a GIF of `init` running end to end against a demo
spec.

## Package structure

The root export (`@archstone/init`) is pure — no `node:fs`, no HTTP, no terminal, no clock. It
carries the draft model and the OpenAPI adapter, and derives every fact mechanically from the
source or a human answer, never from an LLM: the same input produces the same output on every
run. `@archstone/init/loop` is the only entry point that touches the filesystem — it owns the
closed compile loop that validates a draft before anything is written.

## License

Apache-2.0
