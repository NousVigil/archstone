# The Showcase: a synthetic travel agency

One coherent, **synthetic** agency, "Wanderlust Agency", that exercises every Archstone feature, from a
simple read to irreversible actions: search, details with images and pages, quote, book, cancel, pay,
reporting.

Everything here is **invented**: the agency, the hotels, the guests, the passport numbers
(`DEMO-PASS-nnnnnn`), the phone numbers (`+00 000 000 nnn`), the e-mail addresses (reserved `.example`
domain) and the payments. No value is, or should be mistaken for, a real business, person, booking or
card. Any resemblance is accidental.

## What it is for, and what it is not

The synthetic backend **deliberately over-exposes**. It returns more than a contract should allow:
guest passports and phones at every nesting level, the agency's private margin, raw HTML, images and
links on hosts nobody declared, and a DELETE endpoint no capability exposes. That is the point: the
manifests in [`manifest/`](manifest/) name what a model may see, and everything the backend returns
beyond it is left unnamed, so it never reaches a model. Later increments assert that, scenario by
scenario.

Read the example for what it is:

- **Archstone does not make a real backend safe.** It stops fields the manifest does not name from
  being forwarded, and it refuses calls the manifest says to refuse. It does not fix what the backend
  stores, returns elsewhere, or does when asked directly. This backend is unsafe on purpose.
- **Effects are MCP annotations.** `read`, `write` and `irreversible` become hints that a client may use
  to decide whether to ask a person first. Archstone does not enforce them and does not take credit for
  a confirmation the client chose to ask for.
- **`human-approval` is declared, not enforced.** The cancel and pay capabilities declare it; this
  version of Archstone has no approval mechanism, and `archstone apply` says so in a warning. Runtime
  enforcement is tracked in
  [#165](https://github.com/NousVigil/archstone/issues/165). HTML output is tracked in
  [#166](https://github.com/NousVigil/archstone/issues/166); until then the raw description is not
  sent at all.
- **The agency checks the credential and the quote.** Archstone forwards the caller's token and cannot
  judge it; the synthetic agency answers 401. A payment needs a quote the agency issued a moment ago;
  the agency checks that, not Archstone. `archstone apply` warns about a payment declared without
  safeguards, it does not block one (see [`manifest-variants/`](manifest-variants/)).

## The two demo keys are public

The synthetic API accepts exactly two bearer values, defined in [`credentials.mjs`](credentials.mjs)
and published here on purpose:

| Key | Principal (asserted by whoever hosts the server) | Meaning |
|---|---|---|
| `demo-public-key-visitor-0000` | `demo:visitor` | accepted by the agency, allowed to book |
| `demo-public-key-blocked-0000` | `demo:blocked` | accepted by the agency, denied by the booking policy |

Anyone may use them. They unlock nothing but invented data. Never copy this pattern for a real
credential.

## Run it

```bash
# The manifest compiles (exit 0). Two warnings are expected: cancel and pay declare an approval step
# this version does not enforce.
pnpm apply examples/showcase/manifest

# The synthetic backend, on http://localhost:8788 (PORT to change it).
pnpm --filter archstone-showcase api

# The tools, over stdio, against that backend.
SHOWCASE_API_URL=http://localhost:8788 pnpm serve examples/showcase/manifest

# Replay the recorded contracts against the running backend.
SHOWCASE_API_URL=http://localhost:8788 pnpm verify examples/showcase/manifest

# The mis-declared payment: exits 0 with three warnings naming wanderlust.pay.
pnpm apply examples/showcase/manifest-variants/misdeclared-pay
```

The manifest directory is `examples/showcase/manifest`, not `examples/showcase`: `archstone apply`
reads `capabilities.yaml` from the directory it is given, and the other folders here are not manifests.

## Layout

| Path | What |
|---|---|
| [`api/wanderlust-api.mjs`](api/wanderlust-api.mjs) | The synthetic API: one plain `handle(request, { now, imageBase }) -> Response`. Web-standard APIs only; no Node and no Workers imports; deterministic and stateless. |
| [`api/serve.mjs`](api/serve.mjs) | A Node `http` wrapper serving that same handler. |
| [`api/wanderlust.openapi.yaml`](api/wanderlust.openapi.yaml) | A synthetic OpenAPI document describing every route, over-exposed fields included. |
| [`credentials.mjs`](credentials.mjs) | The two public demo keys and their principals. |
| [`manifest/`](manifest/) | The live manifest: 13 capabilities, resources, two policies, bindings, golden fixtures for `verify`. |
| [`manifest-variants/`](manifest-variants/) | Authoring fixtures that are never deployed. Today: the mis-declared payment. |
| [`scenarios.json`](scenarios.json) | The scenario table, S-01 to S-22. |
| [`test/`](test/) | `api.test.ts`, `manifests.test.ts`, `scenario-json.test.ts`, the negative-scenario suite (`negatives.test.ts`, `denial-reasons.test.ts`, `tool-list.test.ts`), and the shared `harness.ts` and `negatives-support.ts`. |

## The capabilities

| Capability | Effect | Lifecycle | Notes |
|---|---|---|---|
| `wanderlust.search` | read | stable | collection; the agency's own order |
| `wanderlust.stay-details` | read | stable | nested projection: stay, rooms, amenities |
| `wanderlust.stay-photos` | read | stable | `image` list checked against `origins.images` |
| `wanderlust.stay-page` | read | stable | `web-page` checked against `origins.pages` |
| `wanderlust.quote` | write | stable | a price that expires; books nothing |
| `wanderlust.book` | write | stable | `authenticated`, forwards `${caller.accessToken}`; policy allows `demo:visitor`, denies `demo:blocked` |
| `wanderlust.cancel` | irreversible | stable | `authenticated`, `human-approval` declared, failures declared |
| `wanderlust.pay` | irreversible | stable | as cancel, plus a payment quote the agency checks |
| `wanderlust.availability` | read | beta | the only `rateLimit`: 3 calls per 60 seconds |
| `wanderlust.room-status` | read | stable | `onError` rows; a wrong-typed price is a contract violation |
| `wanderlust.neighbourhood` | read | experimental | unlisted, still callable by name |
| `tourism.search` | read | deprecated | the original `tourism_search` tool, same input, output and binding shape |
| `tourism.search-classic` | read | retired | listed nowhere, refused when called |

There is **no capability** for the DELETE endpoint, for `description_html`, for the margin, or for
passport and phone. Those are the things the backend returns that the manifest never names. The booking
resource declares no guest field at all.

Tool names are the capability ids with dots replaced by underscores (`wanderlust.stay-details` is
`wanderlust_stay-details`). Retired and experimental capabilities are not in the tool list.

## What the backend over-exposes (each item is pinned by `test/api.test.ts`)

- `net`, `margin` and `commission` on every stay, again nested in rooms, quotes, bookings, availability.
- `guests[]` with `passport`, `phone` and `email` at stay, room, amenity and amenity-history level
  (four levels deep), and on every booking, cancellation and payment.
- A raw HTML `description_html` whose `<img>` and `<a>` point at hosts no manifest declares.
- Five photos, one (the fourth) on an undeclared host; two hotel page links, one on an undeclared origin.
- `DELETE /v1/guests/{name}/bookings`, which works (with either key) and is bound by no capability.
- A token check in the API itself (the two keys are accepted, anything else gets 401), and a quote or
  payment-quote check in the API (missing, expired or foreign quotes get 422).
- One property whose room status contains an error row (`ws-1002`) and one whose price is the wrong
  type (`ws-1003`).
- The legacy `POST /v1/search`, byte-compatible with the demo's mock backend, margin and all.

## Stateless and deterministic

Nothing is stored. Quote ids, booking ids and payment quotes are hashes of their inputs plus the
current 15-minute window; cancel and pay validate the *shape* of an id, not a record. "Time" is
injected (`now`), so a fixed clock gives byte-identical output, and image URLs are built from a
constant origin (`https://images.wanderlust-agency.example`) rather than the request's address. The
binding for `wanderlust.stay-photos` declares that origin; a host that serves the pictures elsewhere
changes the constant and the declaration together.

## The scenario table

`scenarios.json` has one row per scenario, `S-01` to `S-22`, each exactly once. Fields: `id`, `negative`
(the `N-xx` id and any overrides the negative call needs), `group`, `mode` (`live`, `recorded`, `locked`),
`tool`, `capability`, `arguments`, `key` (`none`, `A`, `B`), optional `setup` steps (a call whose
result a later argument needs, referenced as `"{{name}}"`), `outcome`, `anchor`, `test`, `issue` and
`issueUrl` (only the two locked rows), and `copy` with English and Romanian slots (`ask`, `happens`,
`refused`). The Romanian slots exist and are empty. Live rows are run by `test/manifests.test.ts`;
recorded rows get their tests with the recorder; the two locked rows run nothing.

## Test

```bash
pnpm test                                              # the whole repository, including this example
pnpm exec vitest run examples/showcase                 # just this example
```

The tests run the real pipeline (`buildRegistry`, `callTool`, `createMcpServer`, `verify`) against the
handler in-process, with no network.
