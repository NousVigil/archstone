# CDL Specification

**The normative reference for the Capability Definition Language.**

**Project:** Archstone (Capability Platform)
**Language version:** CDL 1.0 (Canonical)
**Status:** ✅ Normative — frozen by ADR-0007
**Date:** 2026-07-14 · CDL 1.0 as of 2026-08-23
**Machine contract:** [`cdl.schema.json`](../packages/schema/schemas/cdl.schema.json)

> This is the **Reference**: strict grammar and conformance, no argument. It says
> *what CDL is*. It does **not** justify itself — the justification, the evidence and the
> rejected alternatives live in the Rationale, [RFC-0002](rfc/0002-cdl-v0.2.md). The split
> mirrors Rust's *Reference* vs *RFCs*.

> **Names referenced but not linked** — `Rule #N` and `Axiom A-N` are Archstone's internal
> constitution; `ADR-NNNN` and `RQ-NNN` are its decision and research series (the CDL
> rationale, RFC-0002, *is* published — see above). They are cited so a claim here can be traced
> to where it was decided; the rest are not published. Nothing in this specification depends on reading them: what is
> normative is here, and the compiler enforces exactly this.

---

## 1. Notational conventions

The key words **MUST**, **MUST NOT**, **SHALL**, **SHOULD**, **SHOULD NOT**, and
**MAY** in this document are to be interpreted as described in RFC 2119. They appear
**only in normative statements** — surrounding prose is descriptive.

A **processor** is any tool that reads CDL: a validator, the compiler, or the
runtime registry.

---

## 2. Formal definition

> **A Capability Definition is a declarative description of a business capability,
> independent of implementation, execution, protocol, and consumer.**

From this, four independence properties follow. A Capability Definition:

- **MUST NOT** contain implementation detail (no REST paths, SQL, HTTP verbs, wire formats). Implementation lives in bindings.
- **MUST NOT** contain execution detail (no retries, timeouts, transactions, locks, scheduling). Execution is the runtime's concern.
- **MUST NOT** name an ingress protocol (no MCP, Function Calling). Protocols are generated targets.
- **MUST NOT** name or assume a specific consumer. A capability is complete without knowing who invokes it.

CDL is a **synchronous, request/response** language: a capability describes one
bounded invocation with declared inputs and outputs. Asynchronous interaction —
initiation and streaming — is out of scope for the grammar (see RQ-001, the Model-Breakers study).

---

## 3. The two categories

CDL has exactly two kinds of thing. Conflating them is an error; the distinction is
load-bearing for the compiler.

| Category | What it is | Examples |
|---|---|---|
| **Language primitives** (§4) | the vocabulary that *composes* a capability | `effect`, `failures`, field forms `type`/`ref`/`collection`, `lifecycle`, `policies` |
| **Manifests** (§5) | deployable *files* that carry declarations | `*.capability.yaml`, `capabilities.yaml`, `*.resource.yaml`, `*.binding.yaml` |

> **Resource splits across the two.** A **Resource Reference** (`ref`) is a *language
> primitive* (§4.3). A **Resource Definition** (`*.resource.yaml`) is a *manifest*
> (§5.3) — **not** a grammar primitive. The compiler treats them differently: `ref`
> is resolved during capability compilation; a Resource Definition is loaded as a
> named type.

---

## 4. Language primitives

### 4.1 Capability

A Capability Definition **MUST** declare:

- `id` — **MUST** match `^[a-z][a-z0-9-]*(\.[a-z][a-z0-9-]*)+$` (`domain.action`, kebab-case).
- `description` — **MUST** be a non-empty string.
- `effect` — **MUST** be one of `read | write | irreversible` (§4.2).

A Capability Definition **MAY** declare `input`, `output`, `failures`, `lifecycle`,
`policies`, `provider`. It **MUST NOT** declare any other top-level key.

### 4.2 `effect`

`effect` **MUST** be exactly one of:

| Value | Meaning | Processor consequence |
|---|---|---|
| `read` | observes; changes no business state | freely repeatable |
| `write` | changes state; a compensating capability exists in the domain | confirm; retry with care |
| `irreversible` | changes state with no business-level undo | explicit confirm; **MUST NOT** auto-retry |

Per Axiom A-1, `effect` **MUST** describe the
reversibility of **invoking** the capability, not of its downstream consequences. A
processor **MUST NOT** define a fourth value.

### 4.3 Fields and field forms

`input` and `output` are maps of field name → field descriptor. Each field
descriptor **MUST** use exactly **one** of three forms:

| Form | Syntax | Meaning | Position |
|---|---|---|---|
| **Type** | `{ type: <t> }` | a value of semantic type `<t>` (§4.7) or a Resource by representation | input or output |
| **Reference** | `{ ref: <Resource> }` | a **Resource Reference** — points at a Resource **by identity** | input |
| **Collection** | `{ collection: <Resource> }` | an ordered set of a Resource | input or output |
| **List** | `{ list: <t> }` | an ordered set of a **semantic type** `<t>` (§4.7) — distinct from **Collection**, which is a set of a **Resource** | input or output |

Normative:

- A **Resource Reference** (`ref`) **MUST** name a Resource (§5.3) and **MUST NOT**
  carry any identifier scheme, URL, or backend key — those are binding concerns.
- `ref` **SHOULD** appear only in `input`; `output` **SHOULD** use `type` or
  `collection` (a returned representation, not a pointer).
- A `type` field **MAY** be a semantic type (lowercase, §4.7) or a Resource name
  (PascalCase). A field descriptor **MUST NOT** combine forms.
- A **List** (`list`) field **MUST** name a semantic type (§4.7), never a Resource
  name — a list of Resources **MUST** use `collection` instead. A field descriptor
  **MUST NOT** combine `list` with `type`, `ref`, or `collection`.
- `required: true` on a **List** field means the field **MUST** be present; it does
  **NOT** constrain the list's length — an empty list is a valid value of a
  `required: true` List field unless a future primitive adds a minimum-length
  constraint.
- A field **MAY** declare `required: false`; absent, it defaults to `required: true`.
- A **List** `output` field **MAY** be populated from a provider response by a binding's
  `extract:` block (ADD-12 §8.2) — every JSONPath match becomes an array item, not just the
  first, and an empty match set is a valid value (OK, not DEGRADED). That mapping is a
  binding concern, out of CDL's own grammar, same as `response:`/`extract:` generally
  (§4.3's opening rule) — see [`docs/ONBOARDING.md`](ONBOARDING.md) for the binding-side
  walkthrough, including the row-level error discriminator (`response.onError`, ADD-12
  §8.1) a `collection:` mapping may declare — `onError` may carry its own optional `map:`
  (errorResource field → item-relative JSONPath, same shape as the success `map:`); a field
  with no entry there falls back to a same-named key on the item.

### 4.4 `failures`

`failures`, if present, **MUST** be a map of kebab-case token → one-line description
of a **business** failure state.

- Tokens are capability-scoped and **MUST** describe business outcomes (e.g.
  `insufficient-funds`), **NOT** transport status codes.
- A processor **MUST NOT** attach severities, numeric codes, or retry hints to a
  failure token; those are Execution-model concerns.
- Per-item outcomes of a batch **MUST** be modeled as `output` data, not `failures`.

> *Non-normative.* `archstone apply` warns when an `irreversible` capability declares no
> `failures`. The warning checks the declaration; it does not change what a processor accepts.

### 4.5 `lifecycle`

`lifecycle`, if present, **MUST** be one of
`experimental | beta | stable | deprecated | retired`.

- If absent, a processor **MUST** treat the capability as `stable`.
- Agent-facing ingress **SHOULD** hide `experimental` and `retired`; **MAY** hide
  `deprecated` per Policy.
- `lifecycle` is a business fact. Audience/visibility ("who may call it") **MUST NOT**
  be expressed here — that is Policy.

### 4.6 `policies` and `provider`

- `policies`, if present, **MUST** be a list of reserved intent tokens
  (`authenticated`, `rate-limited`, `tenant-scoped`, `human-approval`,
  `consent-required`). Tokens declare intent; a processor **MUST NOT** read
  enforcement configuration (thresholds, JWT, IAM) from CDL.
- `provider`, if present, **MUST** name a backend system whose id appears in the
  tenant's [`capabilities.yaml`](§5.2) `providers` list.

### 4.7 Semantic types

The set of semantic types (`location`, `date-range`, `money`, `enum`, `date`, …) is
defined by the **Semantic Type System**, RFC-0005,
which versions independently of this grammar. A processor **MUST** reject a `type`
whose name is neither a registered semantic type nor a defined Resource.

The registered set is `location`, `date-range`, `party`, `preference-set`, `money`,
`identifier`, `string`, `text`, `time-slot`, `quantity`, `enum`, `date`, `datetime`,
`web-page` and `image`.

#### `web-page` — *Experimental*, output-only

**Definition.** The page where a person can see this resource on the provider's own site:
meant to be opened by a person, never fetched by the assistant. Examples: a listing page
(`https://www.example.com/stays/1234`), a product page in a catalogue
(`https://www.example.com/products/sku-0042`). Not a `web-page`: an API endpoint (a binding
concern), an image, or a deep link such as `tel:` or `mailto:`.

It is a meaning, not a format. A `string` field can carry any URL at all — including one a
provider's data, or text typed into a listing by its owner, points anywhere it likes. A
`web-page` field carries one more fact: the link points at an origin the provider declared.

Normative:

- `web-page` is **output-only**. A processor **MUST** reject it in a capability's `input`,
  directly or inside a Resource carried there by representation (`type:` / `collection:`).
  It **MUST NOT** be used as an extraction target.
- `web-page` **MUST NOT** be a **List** item type (`list: web-page`) in this version.
- A binding whose capability output reaches a `web-page` field — directly, or through a
  Resource or Collection at any depth — **MUST** declare `origins.pages` (§5.4) and **MUST**
  declare `response:` or `extract:`. A pass-through binding is never checked, so it cannot
  carry the guarantee.
- A conforming runtime **MUST** check every `web-page` value it emits against the binding's
  `origins.pages` and **MUST** fail closed. A value passes only if it parses as an
  **absolute** URL, its scheme is `https`, it carries no userinfo, and its origin (scheme,
  host, port — after normalisation: lower-cased host, punycode, default port elided) equals a
  declared origin exactly. No suffix match, no wildcard.
- A passing value **MUST** be emitted as its normalised form, not the provider's raw string.
- A failing value **MUST** be treated as absent: an optional field is omitted (the result is
  degraded), a required field is a contract violation. A processor **MUST** report which
  fields were withheld, and **MUST NOT** echo a withheld value into any message, result or
  record — the value is provider-controlled text.

Limits — what the type does *not* guarantee:

- **Only typed fields are checked.** A URL inside a `text` or `string` field is passed
  through untouched.
- **Relative references are withheld**, not resolved: `/stays/1234` and `//host/x` have no
  declared base to resolve against.
- **Nothing is fetched.** Neither the runtime nor `archstone verify` checks that the page
  exists or what it says; the origin is the guarantee, not the path or the content.
- A trailing-dot host (`www.example.com.`) is a different origin and is withheld.
- A declared origin the runtime cannot normalise (e.g. a host label that is not valid IDNA)
  matches nothing.
- The check applies to what the model is shown. A deployer's own response hook (`onResponse`
  in the reference runtime) runs before it and sees the raw provider body.

`web-page` is Experimental: its meaning may still change before it is frozen with the rest of
the semantic type system.

#### `image` — *Experimental*, output-only

**Definition.** The content for a person to view: a picture, photo, or visual asset meant to be
displayed by the client, never fetched by the assistant. Examples: a hotel's photo
(`https://cdn.example.com/hotels/1234/photo-01.jpg`), a product image in a catalogue
(`https://cdn.example-img.net/products/sku-0042/main.jpg`). Not an `image`: an API endpoint (a
binding concern), a link a person opens (`web-page`), or an embedded asset that requires
Javascript (`data:` URI with content security implications).

It is a meaning, not a format. A `string` field can carry any URL at all — including one a
provider's data, or text typed into a listing by its owner, points anywhere it likes. An
`image` field carries one more fact: the link points at an origin the provider declared, and
when used in a `list:`, items are checked individually.

Normative:

- `image` is **output-only**. A processor **MUST** reject it in a capability's `input`,
  directly or inside a Resource carried there by representation (`type:` / `collection:`).
  It **MUST NOT** be used as an extraction target.
- `image` **MAY** be a **List** item type (`list: image`), unlike `web-page`. In a list,
  items that fail the origin check are **withheld per item** rather than all-or-nothing: a
  list containing mix of off-origin and valid URLs emits only the valid ones, items are
  reordered to remove the withheld ones, and item names in the `withheld` list use 0-based
  positions from the provider's original array (e.g. `photos[2]`). An empty list means all
  items were withheld. A list where every item is withheld is present and empty (not
  omitted), whether optional or required, and the result is **DEGRADED**.
- A binding whose capability output reaches an `image` field — directly, or through a
  Resource or Collection at any depth — **MUST** declare `origins.images` (§5.4) and **MUST**
  declare `response:` or `extract:`. A pass-through binding is never checked, so it cannot
  carry the guarantee.
- A conforming runtime **MUST** check every `image` value it emits against the binding's
  `origins.images` and **MUST** fail closed. A value passes only if it parses as an
  **absolute** URL, its scheme is `https`, it carries no userinfo, and its origin (scheme,
  host, port — after normalisation: lower-cased host, punycode, default port elided) equals a
  declared origin exactly. No suffix match, no wildcard.
- A passing value **MUST** be emitted as its normalised form, not the provider's raw string.
- A failing scalar value **MUST** be treated as absent: an optional field is omitted (the
  result is degraded), a required field is a contract violation. A failing list item **MUST**
  be dropped (per item 0-based position kept in `withheld`). A processor **MUST** report which
  fields were withheld, and **MUST NOT** echo a withheld value into any message, result or
  record — the value is provider-controlled text.

Limits — what the type does *not* guarantee:

- **Only typed fields are checked.** A URL inside a `text` or `string` field is passed
  through untouched.
- **Relative references are withheld**, not resolved: `/hotels/1234/photo.jpg` and
  `//cdn.example.com/photo.jpg` have no declared base to resolve against.
- **Nothing is fetched.** Neither the runtime nor `archstone verify` checks that the image
  exists, what it contains, or whether it is safe to display inline; the origin is the
  guarantee, not the content. An SVG served from the declared origin, for example, may carry
  embedded script and run it when the client renders it.
- Signed or time-limited URLs are not special-cased; if one expires, it is still withheld. A
  provider must issue URLs with validity periods that outlast the response lifetime.
- A trailing-dot host (`cdn.example.com.`) is a different origin and is withheld.
- A declared origin the runtime cannot normalise (e.g. a host label that is not valid IDNA)
  matches nothing.
- The check applies to what the model is shown. A deployer's own response hook (`onResponse`
  in the reference runtime) runs before it and sees the raw provider body.
- **Withheld item names are capped.** A hostile response can carry thousands of off-origin
  items. The `withheld` list names at most 25 items per list by position (e.g. `photos[0]`,
  `photos[1]`, …, `photos[24]`); beyond 25, one overflow entry `photos[…]` closes the list.
  Item values are never named, only field names and integer positions, so existing input
  sanitisation applies.
- **Parallel lists misalign when items are withheld.** A `list: image` named `photos` and a
  `list: string` named `captions` with matching indices — e.g. `photos[3]` describes
  `captions[3]` — do not track together if one image is withheld; `captions[3]` no longer
  describes `photos[3]` if it has been dropped. Do not model alt text as a parallel list; use
  a `collection:` of a Resource with an `image` field and a `text` field instead (though note
  that a required `image` in a collection fails the entire response on one withheld item, per
  ADR-0009 and S-A8).

`image` is Experimental: its meaning may still change before it is frozen with the rest of
the semantic type system.

---

## 5. Manifests

Manifests are deployable files. They are **not** language primitives.

### 5.1 `*.capability.yaml`

Carries exactly one Capability Definition (§4.1) under a `capability:` root. It
**MUST NOT** contain binding or connector detail.

### 5.2 `capabilities.yaml`

The tenant's iconic catalog. It **MUST** declare `company`, `capabilities` (a list of
`id`s), and `providers`. Every `id` listed **MUST** resolve to a `*.capability.yaml`
in the same manifest set.

### 5.3 `*.resource.yaml` — Resource Definition

A **Resource Definition** is a manifest, **not** a language primitive. It **MUST**
declare:

- `name` — domain-qualified (`domain.Name`, PascalCase name part); the bare name
  **MAY** be used as shorthand within files of the same domain.
- `fields` — a field map using the §4.3 grammar.

A Resource Definition **MUST NOT** declare `states` or `transitions`. Resource state
is modeled as a `fields` entry (a status field of an `enum` type, timestamps of
`date` type); the state machine is **derived** from capabilities, never authored
(see RQ-002).

### 5.4 `*.binding.yaml`

Carries connector/implementation detail for one capability. Bindings are **outside
CDL**; a CDL processor **MUST** validate a capability without reference to any
binding.

A binding **MAY** declare `origins`, a sibling of `response:` and `extract:`: the origins where
the provider's pages and images live, against which every `web-page` and `image` output value
(§4.7) is checked.

```yaml
binding:
  capabilityId: stays.search
  connector: { ... }
  response: { ... }
  origins:
    pages:
      - https://www.example.com
    images:
      - https://cdn.example-img.net
      - https://www.example.com
```

- `origins.pages` and `origins.images`, if present, **MUST** each be a non-empty list. Each
  entry **MUST** be a bare `https` origin: `https://`, a host, an optional `:port`, and
  nothing else — no path (not even a trailing `/`), query, fragment, userinfo, wildcard or
  `${VAR}` placeholder. `https://www.example.com` and `https://cdn.example-img.net:8443` are
  valid; `https://www.example.com/stays`, `https://www.example.com/`, `http://www.example.com`,
  `https://*.example.com` and `${IMAGES_ORIGIN}` are refused.
- Entries are compared after normalisation (lower-cased host, default port elided); two
  entries naming the same origin within the same key are an error. `pages` and `images` are
  separate: a URL valid for `pages` is checked only against `pages`, and a URL in an `image`
  field is checked only against `images`. They do not share or fall back to one another.
- The lists are per binding, and are repeated in each binding of a provider by design: there is
  no provider-level document for it. A `web-page` field with no `origins.pages` or an `image`
  field with no `origins.images` is a compile error (`web-page-no-origins` / `image-no-origins`).

---

## 6. Conformance

- A **conforming CDL document** satisfies every **MUST** in §4–§5 and validates
  against [`cdl.schema.json`](../packages/schema/schemas/cdl.schema.json).
- A **conforming processor**:
  - **MUST** reject any document violating a **MUST**.
  - **MUST** preserve `id` as a stable contract across compilations.
  - **SHALL** generate ingress and developer targets (MCP, JSON Schema, …) from the
    document alone, without human-authored per-target files.
  - **MUST NOT** require any information a Capability Definition is forbidden to carry
    (§2) in order to validate it.

---

## 7. Status of primitives

**Every primitive in this document is Canonical** (Rule 11,
ADR-0007, 2026-08-23): frozen in
meaning, and neither removable nor redefinable. A manifest that compiles against CDL 1.0
compiles against every later 1.x.

They were held at Experimental until the compiler and real manifests exercised them. The
compiler enforces all of them and a production deployment exercises most; the remainder are
exercised by the compiler's own suite and the example manifests. ADR-0007 records why those
graduate too — what freezes is *meaning*, not *usage*, and a two-tier grammar would leave a
reader unable to tell which half of a normative document they may rely on.

**Additions remain possible and are not breaking.** A new primitive earns its place under
Rule 10 or it does not enter; either way an existing manifest is
unaffected, which is why RQ-001 and
RQ-002 can stay open across a 1.0.

The **List** field form (§4.3, issue #63) is exactly such an addition: a new sibling of
`type`/`ref`/`collection` inside the field-form union, added because no existing form could
express "a list of one scalar semantic type" (only `collection`, a list of a *Resource*,
existed). Every manifest authored before this addition continues to compile unchanged — the
field-form union grew a member, and no existing member's meaning moved.

The **semantic type system versions independently** of this grammar (§4.7) and is not frozen by
1.0. This document tracks the **normative** grammar at each version; the
the Rationale RFC tracks *why* each primitive exists.

---

*CDL Specification · v1.0 · normative reference · the grammar, without the argument*
