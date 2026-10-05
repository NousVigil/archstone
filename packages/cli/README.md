# @archstone/cli

The `archstone` command — compiles a Capability Definition Language (CDL) manifest to a
target-agnostic IR and serves it as MCP tools an AI agent can call.

Part of [Archstone](https://github.com/NousVigil/archstone), an open-source
**Capability Platform**: a company describes what it can do in CDL (business only, no
integration code); Archstone compiles that to IR; an emitter turns the IR into tools an
agent can discover and call.

## Install

```bash
npm install -g @archstone/cli
```

## Usage

```bash
# Compile a manifest: parse -> validate -> lower to IR, print a human report
archstone apply path/to/manifest

# Serve the compiled tools to an AI agent as MCP over stdio
archstone serve path/to/manifest

# Replay a binding's golden fixture against the live backend; detect provider drift
archstone verify path/to/manifest

# Compile a manifest to a standalone IR artifact (archstone.ir.json by default)
archstone build path/to/manifest [--out path]
```

A manifest directory contains `capabilities.yaml`, `*.capability.yaml`, `*.resource.yaml`,
and `bindings/*.binding.yaml` — see the
[main repository README](https://github.com/NousVigil/archstone#readme) and
`examples/manifests/` for the full format and worked examples.

## License

Apache-2.0
