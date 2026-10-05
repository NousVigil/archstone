# Archstone — connect your business to every AI

**A compiler for AI capabilities.** Describe what your business can do once, in business terms.
Archstone compiles it into tools an AI agent can discover and call — MCP today, other protocols
as they arrive. Nobody hand-writes integration code.

Open source, Apache-2.0.

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://www.buymeacoffee.com/irutehe)

## Find what you need

| I want to… | Go to |
|---|---|
| See it working in 60 seconds | [Try it](#try-it--60-seconds-nothing-to-install) |
| Generate a manifest from my OpenAPI spec | [Start from an API you already have](#start-from-an-api-you-already-have) |
| Install the CLI and know what each command does | [Install](#install) · [Commands](#commands) |
| Understand the model (CDL → IR → tools) | [How it works](#how-it-works) |
| Call capabilities from my own agent loop | [Embed it](#embed-it-in-your-own-agent) |
| Know what Archstone guarantees | [Guarantees](#guarantees) |
| Learn the language | [CDL specification](docs/cdl-specification.md) · [glossary](docs/glossary.md) |
| Walk through it end to end | [Onboarding guide](docs/ONBOARDING.md) |
| Know what is free and what is sold | [Open source and commercial](#open-source-and-commercial) |
| Contribute | [Contributing](#contributing) |

---

## Try it — 60 seconds, nothing to install

A capability compiled by Archstone is running live:

```
https://demo.archstone.dev/mcp
```

- **Claude app** (web, desktop or mobile): **Settings** → **Connectors** → **Add custom
  connector** → paste the URL, then ask about a trip. Works on the Free plan.
- **Claude Code:**

  ```bash
  claude mcp add --transport http archstone-tourism https://demo.archstone.dev/mcp
  ```

The whole integration behind it is
[12 lines of business YAML](examples/manifests/tourism/tourism.search.capability.yaml) — no HTTP,
no JSON Schema, no MCP SDK. Everything else was generated.

Want this in front of your own systems? [hello@archstone.dev](mailto:hello@archstone.dev).

## Start from an API you already have

```bash
archstone init openapi.yaml --out manifest --company acme --domain catalog
```

`init` drafts a manifest from an OpenAPI document, asks you what no spec can answer, and writes
nothing unless the result compiles.

![archstone init reading an OpenAPI document and writing a compiling CDL manifest](docs/init.gif)

Details: [onboarding → `archstone init`](docs/ONBOARDING.md#already-have-an-openapi-document-start-with-archstone-init).
The spec in the recording is [`examples/demo/stays-openapi.yaml`](examples/demo/stays-openapi.yaml).

---

## Install

```bash
npm install -g @archstone/cli     # or: npx @archstone/cli <command>
```

Node 22+. Your manifest lives in **your own repository**; the CLI is a stateless compiler that
needs no checkout of this one
([why](docs/ONBOARDING.md#repository-ownership--the-stateless-compiler)).

## Commands

| Command | What it does |
|---|---|
| `archstone init <openapi>` | Draft a manifest from an OpenAPI document |
| `archstone apply <dir>` | Validate and compile to IR; `--exposure` lists what a model sees and what it never sees |
| `archstone build <dir>` | Write a portable IR artifact for embedding |
| `archstone serve <dir>` | Serve MCP tools over stdio; `--http --token <t>` for HTTP |
| `archstone verify <dir>` | Replay recorded fixtures against the live backend and report drift; `--json` for CI |
| `archstone doctor <dir>` | Offline pre-production checklist |
| `archstone adopt <dir>` | Declare a field the backend started returning (interactive) |
| `archstone audit <log>` | Read back the execution audit trail |

Each command is covered in the [onboarding guide](docs/ONBOARDING.md#provider-onboarding).
Working from a checkout of this repository instead? Use `pnpm apply`, `pnpm serve`, … — see
[contributor onboarding](docs/ONBOARDING.md#contributor-onboarding).

---

## How it works

```
capabilities.yaml   →   *.capability.yaml   →   bindings/*.binding.yaml
(what the company      (each capability:        (how a capability maps
 offers — the index)    business shape only)     to a real backend)

        └──────── archstone apply ────────┘        └── archstone serve ──┘
             parse → validate → compile → IR          emit MCP tools → agent
```

- **CDL** (Capability Definition Language) describes *what* you offer — business terms only.
- **Bindings** say *how* each capability reaches a backend (REST or SQL).
- The **compiler** lowers both to a target-agnostic **IR**; **emitters** turn the IR into tools.

Change the protocol and you regenerate instead of rewriting. Change the backend and the CDL does
not move. A worked example: [`examples/manifests/booking/`](examples/manifests/booking/).

## Embed it in your own agent

No MCP server process needed — load a built IR with
[`@archstone/agent`](packages/agent/):

```typescript
import { fromIR } from "@archstone/agent";

const archstone = fromIR(compiledIR);
const tools = archstone.tools("anthropic"); // or "openai-chat", "openai-responses", "gemini", "json-schema"
const result = await archstone.execute("tourism.search", { location: "Paris" });
```

A mountable Streamable-HTTP MCP handler is available at `@archstone/agent/mcp`. Full API:
[`packages/agent`](packages/agent/).

## Guarantees

These are ratified decisions, not implementation details — each links to its reasoning.

| Guarantee | Decision |
|---|---|
| A provider field your manifest does not declare never reaches a model | [ADR-0008](docs/adr/0008-undeclared-provider-data-never-reaches-a-model.md) |
| A field a model invents never reaches your system | [ADR-0011](docs/adr/0011-undeclared-model-output-never-reaches-a-business-system.md) |
| `build` and `serve` never need a network call, an account or a key | [ADR-0005](docs/adr/0005-open-core-boundary-artifact-guarantee.md) |
| No feature that is free today becomes paid | [ADR-0005](docs/adr/0005-open-core-boundary-artifact-guarantee.md) |
| Ranking in any selection Archstone performs is not for sale | [ADR-0006](docs/adr/0006-marketplace-neutrality.md) |
| `effect` (`read` / `write` / `irreversible`) is confirmed by a person, never inferred | [Onboarding](docs/ONBOARDING.md#what-apply-warns-about-on-an-irreversible-capability) |

All decision records: [`docs/adr/`](docs/adr/).

---

## Who is running it

**[ArtVinci](https://artvinci.ro)**, a custom-framing business, answers customer questions
through a capability compiled by Archstone — real catalog, prices computed live by their own
backend. [Case study](CASE-STUDY.md).

## Why a compiler, and not an MCP server

The first MCP server is an afternoon's work. The fifth — ChatGPT, Gemini and whatever ships
next, each shaped slightly differently, all on top of an API that keeps changing — is the real
cost. Archstone is a compiler that, in its first release, generates an MCP server, so that
maintenance does not multiply with every new protocol.

## Open source and commercial

Everything needed to turn a manifest into something an agent can call — language, compiler, IR,
emitters, embedded SDK and CLI — is Apache-2.0 and stays that way. What we will sell is
*operating* it for you: hosted audit retention, managed rate limits, drift monitoring and
multi-tenant hosting. See [ADR-0005](docs/adr/0005-open-core-boundary-artifact-guarantee.md).

---

## Documentation

| Topic | Where |
|---|---|
| Onboarding (providers, embedders, contributors) | [`docs/ONBOARDING.md`](docs/ONBOARDING.md) |
| CDL specification (normative, 1.0, frozen) | [`docs/cdl-specification.md`](docs/cdl-specification.md) |
| Why CDL looks the way it does | [RFC-0002](docs/rfc/0002-cdl-v0.2.md) |
| Machine schema | [`cdl.schema.json`](packages/schema/schemas/cdl.schema.json) |
| Glossary | [`docs/glossary.md`](docs/glossary.md) |
| Identity and principals | [`docs/IDENTITY.md`](docs/IDENTITY.md) |
| Architecture decisions | [`docs/adr/`](docs/adr/) |
| End-to-end demo with Claude | [`examples/demo/README.md`](examples/demo/README.md) |
| Supported versions | [`SUPPORT.md`](SUPPORT.md) |
| Reporting a vulnerability | [`SECURITY.md`](SECURITY.md) — never a public issue |
| Changes | [`CHANGELOG.md`](CHANGELOG.md) |

## Repository layout

```
packages/
  schema/           load and shape-validate manifests (cdl.schema.json)
  compiler/         semantic validation, lowering to IR
  emitter-support/  shared substrate for every emitter
  runtime/          registry, MCP emitter and transport, verify
  agent/            embedded SDK
  init/             OpenAPI → manifest drafting
  cli/              the archstone command
providers/
  rest/  sql/       backend adapters
examples/           manifests and the Claude demo
docs/               spec, ADRs, RFCs, onboarding
```

---

## How this project uses generative AI

Archstone is written with substantial AI assistance — Anthropic's Claude, through Claude Code —
for implementation, tests and documentation. **The decisions are not generated:** every
structural choice is an ADR, argued and ratified by an accountable person before the code, and
a patch nobody can explain does not merge. Commits with generated code name the model in their
co-authorship trailer. What we ask of contributors:
[`CONTRIBUTING.md`](CONTRIBUTING.md#generative-ai).

## Contributing

[`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[contributor onboarding](docs/ONBOARDING.md#contributor-onboarding). Node 22+, pnpm 11+;
`pnpm typecheck && pnpm test` green before you open a PR.

## License

Copyright 2026 NousVigil LLC. Licensed under [Apache-2.0](LICENSE); see also [NOTICE](NOTICE).
