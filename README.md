# Archstone — connect your business to every AI

**A compiler for AI capabilities.** You describe what your business can do, once, in
business terms. Archstone compiles that into tools an AI agent can discover and call —
MCP today, other protocols as they arrive. Nobody hand-writes integration code.

Open source, Apache-2.0.

[![Buy Me A Coffee](https://cdn.buymeacoffee.com/buttons/v2/default-yellow.png)](https://www.buymeacoffee.com/irutehe)

---

## See it work — 60 seconds, nothing to install

A capability compiled by Archstone is running live. Point Claude at it:

```
https://demo.archstone.dev/mcp
```

Open Claude (web, desktop or mobile) → **Settings** (or **Customize**) → **Connectors** →
**Add custom connector** → paste the URL. Then ask about a trip — a destination, dates, a
budget. Works on Free too (one custom connector is all this needs).

Prefer a terminal:

```bash
claude mcp add --transport http archstone-tourism https://demo.archstone.dev/mcp
```

The backend behind it is a plain HTTP service, and you can curl it directly — the same data
the agent sees, deterministic so the shape is obvious:

```bash
curl -s -X POST https://demo.archstone.dev/v1/search \
  -H "content-type: application/json" -d '{"destination":"Rome"}'
```

The entire integration that made this callable by an agent is
[12 lines of business YAML](examples/manifests/tourism/tourism.search.capability.yaml) — no
HTTP, no JSON Schema, no MCP SDK. Everything else was generated.

Want the same in front of your own systems? Write to
[hello@archstone.dev](mailto:hello@archstone.dev).

## Start from an API you already have

Point `archstone init` at an OpenAPI document. It reads the spec, asks you the questions no
document can answer, runs the real compiler over what it drafted, and writes nothing at all if
that does not compile.

![archstone init reading an OpenAPI document and writing a compiling CDL manifest](docs/init.gif)

```bash
archstone init openapi.yaml --out manifest --company acme --domain catalog
```

The one answer it never guesses is `effect` — `read`, `write` or `irreversible` is the
difference between looking up a price and charging a card, and no spec says which. Where a
response could honestly be read two ways, it asks rather than picking. With `--probe` it will
also make one read-only call to your real backend and record a genuine fixture, so
`archstone verify` has something true to replay later.

The spec in that recording is
[`examples/demo/stays-openapi.yaml`](examples/demo/stays-openapi.yaml), describing the demo
backend in this repository — you can run it yourself.

## Who is running it

**[ArtVinci](https://artvinci.ro)** — a custom-framing business — answers customer questions
today through a capability compiled by Archstone. Real catalog, real prices computed live by
their own backend. See the [case study](CASE-STUDY.md).

---

## Why a compiler, and not just an MCP server

Writing your first MCP server is not the hard part — it is a few hundred lines, and you can
do it in an afternoon.

The work is the fifth one. ChatGPT, Gemini and whatever ships next each want the same
capability shaped slightly differently, every one of them is a separate integration project,
and your API keeps changing underneath all of them at once.

> **Archstone is not an MCP server. It is a compiler that, in its first release, generates one.**

One capability definition (CDL) lowers to a target-agnostic **IR**; emitters consume the IR.
MCP today; REST · GraphQL · SDK tomorrow. Change the protocol and you regenerate — you do not
rewrite. Change the backend and the CDL and the generated tool do not move at all.

That is what *zero manual integration* means: not that the first server is easy, but that the
maintenance disappears instead of multiplying.

---

## How it works

```
capabilities.yaml   →   *.capability.yaml   →   bindings/*.binding.yaml
(what the company     (each capability:        (how one capability maps
 offers — the index)   business shape only)     to a real HTTP endpoint)

        └──────── archstone apply ────────┘        └── archstone serve ──┘
             parse → validate → compile → IR          emit MCP tools → agent
```

You describe capabilities in **CDL** (Capability Definition Language) — business only, no
integration code. Archstone compiles that to a target-agnostic **IR**, and an emitter turns
the IR into tools an AI agent can call. Swap the backend; the CDL and the generated tool do
not change.

Capability outputs reference named **resources** (`*.resource.yaml`); the compiler resolves
them into a typed, described `outputSchema`, and a binding's `response:` mapping enforces
that shape at every call — a required field missing from the provider's response fails
closed (a structured error, never a silent raw pass-through). `archstone verify` replays a
recorded fixture against the live backend on demand and reports a 🟢/🟡/🔴 health status per
binding, so contract drift shows up before an agent hits it — naming the fields the provider
gained, lost or retyped, not merely reporting that something moved. Bindings whose capability
`effect` is not `read` are skipped by default (replaying a fixture is a real invocation), and
re-included only with `--sandbox`, an assertion that the backend is a sandbox tenant.

**A field your manifest does not name never reaches a model.** That is deliberate: your
provider's payload very likely carries wholesale rates, commissions or internal ids beside the
fields you publish, and a backend deploy adding one must not be a decision about what an
assistant can say. `archstone apply <dir> --exposure` names both sides for each capability — the
fields a model is shown, and the ones your backend was recorded returning that it never sees
(`net`, `commission`, `boardType`, … for the tourism example). Declaring a new field is a
separate, deliberate act — `archstone adopt` offers each one, asks you to describe it, writes it
into your resource and binding, and recompiles before keeping anything. With stdin closed it
refuses and writes nothing: it needs a person, which is the point rather than a limitation.

**And a field the model invents never reaches your system.** The same resource declaration read
the other way round: when a model *produces* business data — extracting a booking from an email,
a line item from an invoice — `archstone.extractor("tourism.Stay", …)` hands it the closed schema
and judges what comes back. A missing required field is a violation and the document is withheld
whole; an undeclared key is dropped and named; nothing is coerced, defaulted or repaired. One
entity declared once, both directions of travel
([ADR-0011](docs/adr/0011-undeclared-model-output-never-reaches-a-business-system.md)).

---

## Quick start

**From source (this repository):**

```bash
pnpm install

# Scaffold a manifest from an API you already have (opt-in, read-only, no LLM)
pnpm exec tsx packages/cli/src/index.ts init path/to/openapi.yaml --out my-manifest --domain catalog

# Compile a manifest: validate + lower to IR (also warns about what an `irreversible` capability still lacks)
pnpm apply examples/manifests/booking

# Build a portable IR artifact (for embedding in your own app)
pnpm build examples/manifests/tourism

# Serve it to an AI agent as MCP tools over stdio
pnpm serve examples/manifests/tourism

# Serve it as MCP over HTTP (e.g. for Claude API mcp_servers)
pnpm serve --http examples/manifests/tourism --token my-bearer-token

# Replay a binding's golden fixture against the live backend; detect drift
pnpm verify examples/manifests/tourism

# Replay including write/irreversible capabilities (only for sandbox backends)
pnpm verify examples/manifests/tourism --sandbox

# Get structured JSON output for integration with CI pipelines and dashboards
pnpm verify examples/manifests/tourism --json
```

**From npm (standalone CLI):**

```bash
# Install globally or use npx
npm install -g @archstone/cli
# or
npx @archstone/cli apply <manifest-dir>

# Then run the same commands:
archstone init path/to/openapi.yaml --out my-manifest --domain catalog
archstone apply examples/manifests/booking
archstone build examples/manifests/tourism
archstone serve examples/manifests/tourism
archstone serve --http examples/manifests/tourism --token my-bearer-token
archstone verify examples/manifests/tourism
archstone verify examples/manifests/tourism --json

# Check a manifest against the pre-production checklist — offline, no backend contacted
archstone doctor examples/manifests/tourism

# Declare a field the backend started returning (asks before writing; needs a person)
archstone adopt examples/manifests/tourism
```

---

## Where your CDL lives

**Your business's CDL manifest** (`capabilities.yaml`, `*.capability.yaml`, `*.resource.yaml`,
and `bindings/*.binding.yaml`) is authored and version-controlled in **your own application
repository** — never inside this Archstone repository or any other Archstone-owned repository.

**`@archstone/cli` is a stateless compiler.** It runs locally on your machine or in your own CI
pipeline with zero checkout of any Archstone repository required — public or private. Install
`@archstone/cli` from npm; point it at your manifest directory; it compiles to IR and reports
the result. That's the entire integration: no cross-repo credentials, no monorepo dependency,
no fetch-at-runtime.

> **Distinguishing "From source" above:** the instructions above for exploring Archstone's
> source code are for **contributors building Archstone itself**. The real integration path
> for your business is to **install `@archstone/cli` from npm into your own repository** and
> wire `archstone apply`/`archstone build`/`archstone serve`/`archstone verify` into your own build system.
> See the [onboarding guide](docs/ONBOARDING.md) for the full walkthrough.

---

New here? Start with the **[onboarding guide](docs/ONBOARDING.md)** — one path for
**providers** (expose your business to agents) and one for **contributors** (build
Archstone).

---

## Embedding Archstone

Rather than running `archstone` as a separate CLI or MCP server, you can embed the compiled
IR directly in your own agent loop. After building a portable IR with `archstone build`,
consumers can use the **`@archstone/agent`** SDK (RFC-0008):

```typescript
import { fromIR, tools, execute } from "@archstone/agent";
const archstone = fromIR(compiledIR);

// Get typed tool definitions in your preferred format
const myTools = archstone.tools("anthropic");
// or "openai-chat" (Chat Completions) / "openai-responses" (Responses API) / "gemini" /
// "json-schema" — "openai" also works but is a deprecated alias of "openai-chat"

// Invoke capabilities directly — no MCP server process needed
// Accepts both raw dotted id and sanitized tool name (as returned by tools())
const result = await archstone.execute("tourism.search", { location: "Paris" });
// or: await archstone.execute("tourism_search", { location: "Paris" });
```

For those who want HTTP-based MCP (e.g., to expose an embedded instance via Claude API's
`mcp_servers`), the `/mcp` subpath provides a mountable Streamable-HTTP handler:

```typescript
import { mcpHandler } from "@archstone/agent/mcp";
const handler = mcpHandler(archstone, { bearerToken: "..." });
// Mount on your framework's HTTP router
```

See [`packages/agent`](packages/agent/) for full API docs and examples.

---

## Start here

| Read first | Path |
|---|---|
| **Onboarding** | [`docs/ONBOARDING.md`](docs/ONBOARDING.md) |
| **A business running on it** | [`CASE-STUDY.md`](CASE-STUDY.md) |
| **CDL by example** | [`examples/manifests/booking/`](examples/manifests/booking/) |
| **The schemas (wire format)** | [`packages/schema/schemas/`](packages/schema/schemas/) |
| **End-to-end demo (Claude)** | [`examples/demo/README.md`](examples/demo/README.md) |

---

## Repository layout

```
archstone/
├── packages/
│   ├── schema/
│   │   └── schemas/     # JSON Schema — cdl.schema.json validates the language
│   ├── compiler/        # compile → IR  (src/ir.ts = the moat: target-agnostic)
│   ├── emitter-support/ # IR indexing + semantic-type → JSON-Schema lowering (RFC-0008)
│   ├── agent/           # embedded SDK: fromIR(), tools(), execute() (RFC-0008)
│   ├── runtime/         # registry + MCP emitter (stdio + HTTP)
│   └── cli/             # `apply` / `build` / `serve` / `verify` / `doctor` / `adopt` — wires pipeline
├── providers/
│   └── rest/            # REST adapter (providers = adapters)
├── examples/            # manifests + the Claude demo
└── docs/                # rfc/ · adr/ · spec/ · glossary/ · ONBOARDING.md
```

The compiler never lets `apply` poke a target directly — it compiles to an **IR**, and
emitters (MCP now; REST · GraphQL · SDK later) consume the IR. That boundary is why the
product survives a protocol change.

---

## The iconic file

`capabilities.yaml` is to Archstone what `openapi.yaml` is to an API or `docker-compose.yaml`
is to a stack: the one file that declares what a company offers. See the
[booking example](examples/manifests/booking/).

---

## What is free, and what we sell

Everything needed to take a CDL manifest and turn it into something an agent can call is
Apache-2.0 and stays that way: the language, the compiler, the IR, every emitter, the embedded
SDK, and `init` / `apply` / `build` / `serve` / `verify`. **`archstone build` and `archstone
serve` never require a network call, an account or a key** — vendor a manifest, pin a version,
and you can keep compiling and serving it indefinitely with no relationship to us. ArtVinci
runs entirely inside this and owes us nothing.

**No feature that is free today becomes paid.** New commercial value is added alongside the
open core, or it is not added.

Both commitments are ratified decisions, not release notes — the reasoning, and the alternatives
that were considered and refused, are in [ADR-0005](docs/adr/0005-open-core-boundary-artifact-guarantee.md).
Ranking is covered separately and just as permanently: position in any selection Archstone
performs is not purchasable in any form ([ADR-0006](docs/adr/0006-marketplace-neutrality.md)).

What we sell, when it exists, is the *operation* of these artifacts over time on our machines:
hosted durable audit and retention, managed rate-limit counters, drift monitoring, and
multi-tenant hosting for teams who would rather not run a node. The governance mechanisms
themselves — policy evaluation, rate limiting, execution audit, model-output validation — ship
here, in the open, at every tier.

---

## The language

CDL is **1.0 and frozen**: every primitive is Canonical, so a manifest that compiles today
compiles against every later CDL 1.x. The normative grammar — what each primitive means, what a
processor MUST and MUST NOT do — is [`docs/cdl-specification.md`](docs/cdl-specification.md);
the machine contract is [`cdl.schema.json`](packages/schema/schemas/cdl.schema.json). Why the
grammar looks the way it does — every primitive's justification, and the ones that were rejected
— is the Rationale, [RFC-0002](docs/rfc/0002-cdl-v0.2.md). Terms are defined in the
[glossary](docs/glossary.md).

---

## Identity

Archstone never resolves identity — your host does, and hands over an opaque principal. What to
wire, what is guaranteed about it, and why there is no SSO/SCIM feature to look for:
[`docs/IDENTITY.md`](docs/IDENTITY.md).

---

## Support and versions

Which versions receive fixes, what gets backported, and what stays stable while the packages are
pre-1.0 (short answer: CDL and your compiled IR) — see [`SUPPORT.md`](SUPPORT.md). Security
reports go through [`SECURITY.md`](SECURITY.md), never a public issue.

---

## How this project uses generative AI

Archstone is written with substantial AI assistance. It says so here rather than leaving you to
infer it from the commit log. The model is Anthropic's Claude — `claude-opus-5` at the time of
writing — used through Claude Code.

**Where it is used:** implementation and refactoring across the compiler, emitters, runtime and
CLI; tests; documentation and changelog prose.

**What is not generated: the decisions.** Every structural choice — what enters CDL, what the
compiler guarantees, where a boundary sits — is written as an ADR before merge, with the
alternatives that were considered and refused, and ratified by a person who is accountable for
it. The decisions that constitute commitments to you are published in [`docs/adr/`](docs/adr/),
so you can read the reasoning instead of taking a claim on trust. A patch nobody can explain does
not merge, whatever wrote it.

**Provenance:** commits carrying generated code name the model in their co-authorship trailer.
Contributors are asked to do the same — see
[`CONTRIBUTING.md`](CONTRIBUTING.md#generative-ai).

This disclosure exists because the alternative is worse. A compiler asks you to trust its output
about things you cannot easily check by hand: that an `effect` is right, that a field you never
declared did not leave your backend. You are entitled to know how it was built before deciding
how much of that to trust.

---

## Contributing

See [`CONTRIBUTING.md`](CONTRIBUTING.md) and the
[contributor onboarding](docs/ONBOARDING.md#contributor-onboarding). Requires Node 22+ and
pnpm 11+; `pnpm typecheck && pnpm test` should be green before you open a PR.

---

## License

Copyright 2026 NousVigil LLC. Licensed under [Apache-2.0](LICENSE); see also [NOTICE](NOTICE).

*Archstone · schema-first · Capability Platform*
