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
- **Who enforces what.** For `book`, `pay` and `cancel`, Archstone's *policy* runs first: a missing
  credential, a caller the manifest denies (key B's principal) and a caller nobody listed (an unknown
  key carries no principal) are refused before the agency is asked. Archstone never verifies a key
  itself; it matches the principal the host asserted. Only a call the policy lets through reaches
  the synthetic agency, which then judges the credential (401) and the quote. A payment needs a
  quote the agency issued within the last 15 minutes; the agency checks that, not Archstone. `archstone apply` warns about a payment declared without
  safeguards, it does not block one (see [`manifest-variants/`](manifest-variants/)).

## The two demo keys are public

The synthetic API accepts exactly two bearer values, defined in [`credentials.mjs`](credentials.mjs)
and published here on purpose:

| Key | Principal (asserted by whoever hosts the server) | Meaning |
|---|---|---|
| `demo-public-key-visitor-0000` | `demo:visitor` | accepted by the agency, allowed to book, pay and cancel |
| `demo-public-key-blocked-0000` | `demo:blocked` | accepted by the agency, denied by Archstone's policy on book, pay and cancel alike |

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
| [`manifest/`](manifest/) | The live manifest: 13 capabilities, resources, four policies (principals for book, pay and cancel; the availability rate limit), bindings, golden fixtures for `verify`. |
| [`manifest-variants/`](manifest-variants/) | Authoring fixtures that are never deployed. Today: the mis-declared payment. |
| [`scenarios.json`](scenarios.json) | The scenario table, S-01 to S-23. |
| [`test/`](test/) | `api.test.ts`, `manifests.test.ts`, `scenario-json.test.ts`, the negative-scenario suite (`negatives.test.ts`, `denial-reasons.test.ts`, `tool-list.test.ts`), the shared `harness.ts` and `negatives-support.ts`, and for the recorded scenarios `recorded-s15.test.ts` to `recorded-s21.test.ts`, `recorded-determinism.test.ts` and `recorded.ts`. |
| [`record/`](record/) | The recorder for S-15 to S-21 (`record.mjs`), one module per scenario, and the person's answers for S-20. |
| [`conversations/`](conversations/) | The local conversation check (`pnpm showcase:conversations`): a real model drives the MCP endpoint. Not part of CI. |
| [`transcripts/`](transcripts/) | Its output: `s-15.json` to `s-21.json`. Generated; do not edit by hand. |
| [`local/reporting/`](local/reporting/) | The SQL reporting manifest of S-15, its `fixture.sql` and identity map. Local only: not part of the manifest the Worker serves. |
| [`sdk/embedded.mjs`](sdk/embedded.mjs) | The runnable embedded-SDK script of S-21. |

## The capabilities

| Capability | Effect | Lifecycle | Notes |
|---|---|---|---|
| `wanderlust.search` | read | stable | collection; the agency's own order; optional `budget` (max nightly rate, EUR) and `preferences` (`pets`, `breakfast`, `family`) |
| `wanderlust.stay-details` | read | stable | nested projection: stay, rooms, amenities |
| `wanderlust.stay-photos` | read | stable | `image` list checked against `origins.images` |
| `wanderlust.stay-page` | read | stable | `web-page` checked against `origins.pages` |
| `wanderlust.quote` | write | stable | valid 15 minutes from when it is issued; optional `pets` (a count) itemises the stay's pet fee in the total; a stay with no pets refuses it; books nothing |
| `wanderlust.book` | write | stable | `authenticated`, forwards `${caller.accessToken}`; policy allows `demo:visitor`, denies `demo:blocked`; books at the quoted total |
| `wanderlust.cancel` | irreversible | stable | `authenticated`, the same principal policy as book, `human-approval` declared, failures declared; the refund is the booking's total |
| `wanderlust.pay` | irreversible | stable | as cancel (the same principal policy), plus a payment quote the agency checks |
| `wanderlust.availability` | read | beta | the only `rateLimit`: 3 calls per 60 seconds |
| `wanderlust.room-status` | read | stable | `onError` rows; a wrong-typed price is a contract violation (reported as `invalid`) |
| `wanderlust.neighbourhood` | read | experimental | unlisted, still callable by name |
| `tourism.search` | read | deprecated | the original `tourism_search` tool; same input and filters as `wanderlust.search`, the old output shape (no ids) |
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
- Room status that is unwell on **one property and date each**, so it is usable everywhere else: an
  error row for `ws-1002` on 2027-05-12 (`agency-busy`), and a wrong-typed price for `ws-1003` on
  the same date. Pensão Azul's June weekends, for example, answer normally.

  Follow-up (#176): a `money` output value that is not `{amount: number, currency: "EUR"-shaped}`
  is now a shape mismatch, so a bare string such as `"129.00"` is rejected like any other wrong type
  (`test/negatives.test.ts`, on `wanderlust.quote`'s `total`). S-13 keeps its present trigger because
  `room-status.pricePerNight` is a `quantity`, which still accepts a bare string; moving S-13 to the
  string-price trigger means declaring that field `money` and changing the `ws-1003` body, which is a
  separate change to the scenario, its copy and its recordings.
- The legacy `POST /v1/search`, which still carries `net` and `commission`, over the same catalogue, destination resolver and filters as the current search.

## One catalogue, one resolver

Both searches, details, photos, pages, quote and availability read the same `CATALOGUE` in
`api/wanderlust-api.mjs`: Lisbon (`ws-1001` to `ws-1004`, the rows the scenarios depend on), Porto,
Barcelona, Nice and Bucharest. A destination goes through one resolver, tolerant of case, diacritics
and a country (`Lisbon`, `lisboa`, `Lisabona`, `Lisbon, Portugal`, `Bucuresti`); a country that
contradicts the city (`Lisbon, Spain`) or an unknown place returns an empty list, never invented
stays. So every id a search returns resolves on every follow-up tool (`test/api.test.ts`).

- `budget` is a **per-night** ceiling in EUR on both searches. Another currency is a `400`.
- `preferences` are `pets`, `breakfast` and `family`, combined with AND. Synonyms are folded
  (`pet-friendly`, `cat`, `dog` mean `pets`); any other tag is ignored.
- `petPolicy` is a declared field on the search rows and on stay details: e.g. "Cats welcome, EUR 10
  per night", or "No pets".
- `dates` that are not an ISO range are a `400`, not silently ignored.
- A destination may also be **a stay's exact name** ("Pensão Azul", "pensao azul", "Pensão Azul,
  Lisbon"): the search then returns that stay only (the budget and preferences still apply). It is
  exact after folding case and diacritics, never fuzzy: a wrong city or a near miss is an empty list.
- A **quote** takes an optional `pets` count (0 to 4). The stay's `petPolicy` is where the fee comes
  from ("EUR 10 per night" is per pet per night; "free of charge" is a fee of 0); the quote shows
  `pets`, `petFee` and a `total` that includes it, and a booking from that quote is at that total. A
  stay with "No pets" refuses a quote that declares pets (the agency's `422 pets_not_allowed`).
- The agency's own page (`stay-page`) is the first link and sits on the origin the binding declares,
  so it is returned; the "partner listing" is on an origin nothing declares, so it is withheld.

`test/conversations.test.ts` runs the arguments a model sends for these phrasings, deterministically.
`conversations/run.mjs` does the same with a real model against a live endpoint.

## Stateless and deterministic

Nothing is stored. A quote id, and the payment quote returned with a booking, carry the instant they
were issued (base 36) and a hash of their inputs: each is valid for 15 minutes **from that instant**,
so it expires relative to the request, not on a fixed boundary, and `book` and `pay` refuse it once
expired. A booking id carries its own total and a check over it, so `cancel` and `pay` recognise an id
this agency issued without a record: an id it never issued is `404 booking_not_found`, and a
cancellation refunds the booking's total (the seeded booking `B-0000cafe`, always known, is Casa
Alfama for 12-15 May, EUR 354). "Time" is injected (`now`), so a fixed clock gives byte-identical output, and image URLs are built from a
constant origin (`https://demo.archstone.dev`, the public demo Worker, which serves `/img/...`)
rather than the request's address. The
binding for `wanderlust.stay-photos` declares that origin; a host that serves the pictures elsewhere
changes the constant and the declaration together.

## The scenario table

`scenarios.json` has one row per scenario, `S-01` to `S-23`, each exactly once. Fields: `id`, `negative`
(the `N-xx` id and any overrides the negative call needs), `group`, `mode` (`live`, `recorded`, `locked`),
`tool`, `capability`, `arguments`, `key` (`none`, `A`, `B`), optional `setup` steps (a call whose
result a later argument needs, referenced as `"{{name}}"`), `outcome`, optional `refusal` (`input_invalid` on S-23: refused by the input contract, not by a
policy), optional `alsoRun` (more fixed calls the live run makes and reports separately: S-13's
wrong-format price), optional `evidence` (a fact the card relies on that lives in the tool list:
S-12's deprecation note, with where it lives), `anchor`, `test`, `issue` and `issueUrl` (only the two
locked rows), and `copy` with English and Romanian slots (`ask`, `happens`,
`refused`). The Romanian slots exist and are empty. Live rows are run by `test/manifests.test.ts`;
recorded rows get their tests with the recorder; the two locked rows run nothing.

## Recorded scenarios (S-15 to S-21)

Some things cannot or should not run on the public Worker: the SQL provider is Node-only, and the CLI
verbs are local by nature. Those seven rows of `scenarios.json` (`mode: "recorded"`) are shown as
**transcripts**: the real workspace CLI (and, for S-21, the embedded SDK) run against the synthetic API,
with their output written to [`transcripts/`](transcripts/) and checked in.

| Row | What it runs | What it must show, and its negative |
|---|---|---|
| S-15 | `verify` and a tool call over [`local/reporting`](local/reporting/) against a local Postgres | a table of bookings per city; another tenant gets no rows; the live manifest has no sql capability |
| S-16 | `apply --exposure` | the exposed list names no margin, passport, phone, `description_html` or delete tool, while the backend is observed returning them |
| S-17 | `verify`, `adopt` against a wrapped backend | `verify` names the new `guestEmail` field; it is absent from the exposure until a person declares it |
| S-18 | `diff` on two declarations | one added field and one added action, with the backend stopped |
| S-19 | `audit`, `doctor` and `apply --exposure` | irreversible actions listed (by `audit` over a trail, and by `doctor`); exposed fields listed by `apply --exposure`, not by `audit`; zero outbound requests |
| S-20 | `init` from the OpenAPI document | no delete action (the delete is declined in the person's decisions file, `record/s20-decisions.json`), no passport or phone, nothing published; without a decisions file `init --non-interactive` refuses and writes nothing |
| S-21 | [`sdk/embedded.mjs`](sdk/embedded.mjs) | the same tools in three vendor shapes; S-02 and S-14 still hold |

```bash
pnpm build                                  # the recorder drives the built workspace CLI
export ARCHSTONE_TEST_PG_URL=postgres://postgres:<password>@127.0.0.1:5432/postgres   # an admin URL, S-15 only
pnpm showcase:record                        # rewrite examples/showcase/transcripts/
pnpm showcase:record:check                  # regenerate to a temp directory; fail on any difference
```

`ARCHSTONE_TEST_PG_URL` is the variable the repository's other real-Postgres suites use. The recorder
builds a throwaway database from [`local/reporting/fixture.sql`](local/reporting/fixture.sql) with it and
drops it afterwards; the CLI and the runtime only ever see the runtime role's DSN. Without it, S-15 is
skipped locally with a message and its committed transcript is left alone. Under CI (`CI=true`) a
missing URL is a failure, never a skip. `--out <dir>` writes elsewhere and `--only S-17,S-18` runs a
subset.

Every scenario states what it expects **and** its negative as claims. A claim that does not hold stops
the scenario, names it, and the recorder exits non-zero without writing anything. A scenario that says
"offline" runs its commands under [`record/no-network.mjs`](record/no-network.mjs), which makes any
attempt to open a socket, resolve a name or call `fetch` fail and be logged, so "zero outbound requests"
is checked on the process and not only on the backend's counter. S-17 does not add a switch to the API:
the recorder wraps the handler in the recorder's own server to add the field. Archstone does not make
the backend safe in any of these; they show what the manifest declines to forward and where a person
decides.

### Transcript format

Each `transcripts/s-NN.json` is two-space JSON in this key order, with one trailing newline:

```jsonc
{
  "scenario": "S-17",
  "title": "The agency added a guest email field (verify, adopt)",
  "kind": "cli",                    // "cli" | "sdk" | "mcp": the surface the scenario is mainly about
  "recorded": {
    "date": "2027-05-01",           // the fixed clock's date (scenarios.json "clock"), never wall time
    "cli": "0.31.0"                 // the workspace CLI's version when the content last changed
  },
  "steps": [
    {                               // a command
      "command": "archstone adopt <manifest>",
      "typed": ["y", "..."],        // only when a person's answers were scripted, in order; [] = nobody there
      "exit": 0,
      "stdout": "...",              // omitted when empty
      "stderr": "..."               // omitted when empty
    },
    {                               // an in-process tool call
      "call": { "tool": "wanderlust_bookings-by-city", "arguments": { "month": "2027-05" } },
      "result": { "as": "demo:analyst", "isError": false, "structuredContent": { } }   // keys sorted
    }
  ],
  "asserts": [ { "claim": "...", "negative": true } ],   // every claim the recorder checked; negative = must NOT happen
  "normalisation": [ { "what": "...", "as": "<manifest>" } ]   // only the rewrites that were applied
}
```

Machine-specific text is rewritten to placeholders before it is written: the checkout path to `<repo>`,
temporary directories to `<manifest>`, `<work>`, `<before>` or `<draft>`, the API's ephemeral address to
`<api>`, and the CLI's own version string inside output to `{cli}`. No timestamps or durations are
recorded; the one audit trail in S-19 has its random ids and wall-clock times replaced by fixed ones,
and nothing else in its records is touched.

**The version stamp and releases.** `recorded.cli` says which CLI recorded the content. A release stamps
a new version into the package files, which would turn every transcript stale on the release commit
without any output changing. So `--check` treats `recorded.cli` as the one field that may differ: it
fails on any other byte, and when only the stamp differs it passes and prints a note. The stamp moves the
next time the content does (`pnpm showcase:record`). Read it as "recorded with", not "current as of".

**Consuming the files.** A documentation site reads them as plain JSON; there is no build step. Pin a
tag or a commit, not `main`, so the rendered text and the CLI version it names stay together:

```
raw.githubusercontent.com/NousVigil/archstone/<tag-or-commit>/examples/showcase/transcripts/s-17.json
```

Render `steps` in order, show `recorded.date` and `recorded.cli` beside them, and keep `typed` visible,
because it is where the person's decision lives.

The tests for these rows are `test/recorded-s15.test.ts` to `test/recorded-s21.test.ts`; they assert each
scenario's outcome and negative from the committed transcript. `recorded-determinism.test.ts` records
twice and requires identical bytes that equal the committed files. CI also runs
`node examples/showcase/record/record.mjs --check` in the job that has the Postgres service.

One reading note on S-17: in this version a gained field is a yellow reading in `verify`, which names it
and exits 0; only a lost field, a changed type or a missing required value are red and exit 1. A strict
`verify` that exits non-zero on a gained field is not available in this version and is tracked in
[#178](https://github.com/NousVigil/archstone/issues/178); the transcript says so in a claim. S-17 runs
`adopt` on `wanderlust.stay-details` because `adopt` resolves a resource by bare name and this manifest
has two resources called `Stay`, a known bug tracked in
[#177](https://github.com/NousVigil/archstone/issues/177).

A note on S-19: `audit` reads Execution-record trails, so it lists what ran (including the irreversible
`cancel` and `pay`). The exposed fields in that transcript come from `apply --exposure`, not from `audit`.

## Test

```bash
pnpm test                                              # the whole repository, including this example
pnpm exec vitest run examples/showcase                 # just this example
```

The tests run the real pipeline (`buildRegistry`, `callTool`, `createMcpServer`, `verify`) against the
handler in-process, with no network.
