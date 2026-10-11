---
rfc: 0010
title: A declared `html` output type — passed through unmodified, or withheld whole
status: Accepted — ratified 2026-10-11 (design only; build held until a real provider needs it)
kind: Type B — Platform RFC, carrying one Type A type candidate for RFC-0005
version: 0.2
authors:
  - Adrian Bratulescu
created: 2026-10-11
updated: 2026-10-11
promoted: ADR-0021
requires: RFC-0001, RFC-0005, RFC-0009, ADR-0008
related:
  - ../adr/0021-html-is-passed-through-unmodified-or-withheld-whole.md
---

# RFC-0010 — A declared `html` output type

> **Names referenced but not linked** — `Rule #N` is Archstone's internal constitution; RFC-0001, RFC-0005, RFC-0009, ADR-0007, the Charter and the `ADD-NN` series are its language, architecture and decision records. They are cited so a claim here can be traced to where it was decided; those documents are not published. Nothing here depends on reading them.

> This document describes the current understanding of the problem. It is expected to evolve as new evidence becomes available.

**Status:** Accepted — **ratified 2026-10-11** by Adrian Bratulescu: every open question is resolved to its recommendation (§14) and every `D-` is Ratified. Promoted to [ADR-0021](../adr/0021-html-is-passed-through-unmodified-or-withheld-whole.md). **Ratified as a design only: nothing is built until a real provider's API returns HTML (OQ-12, D-13).** · **Kind:** Type B — Platform RFC (Charter §3). It adopts one semantic type candidate for RFC-0005; the CDL change lands with the build, not before.
**Tracking:** core [archstone#166](https://github.com/NousVigil/archstone/issues/166).
**Verified against:** core `origin/main` at `6ff4bac` (release 0.33.0), 2026-10-11. Nothing newer is assumed.
**What is ratified:** D-1 (binding since 2026-10-09) and, since 2026-10-11, D-2…D-13.

---

## 1. Summary

A provider's API often returns a description as HTML, because the system that produced it was a CMS or a
back-office editor. Today an author has two options, both bad: leave the field out (the assistant knows less
than the provider's own website), or map it as `string`, which carries any markup and any URL with no check.

This RFC proposes a third: a field typed `html`, output-only, with one rule taken from the founder's binding
decision (D-1):

> The value is passed through **unmodified** if everything it points at satisfies the binding's declared
> origins and it contains nothing the processor cannot classify. Otherwise it is **withheld whole**. It is never
> rewritten, stripped, converted or sanitised, and no provider is trusted past the check.

The mechanism reuses what `web-page` and `image` already established: the same `origins` binding key, the same
response mapper as the single enforcement point, the same `withheld` semantics, the same `verify` rule. What is
new is one **checker** that reads the HTML with a standards-compliant parser, **verifies without ever
re-serialising**, and either returns the provider's original string or nothing.

The open questions in §14 are resolved (2026-10-11), each to its recommendation: the §6.3 allowlist (OQ-2), parse
errors withhold (OQ-3), and MCP carriage (a) (OQ-6), among the rest.

## 2. Problem

- **Affected:** authors of bindings whose provider returns HTML (the job: *"show my description
  the way my team wrote it, with my photos and my links, and nothing else"*), and embedders who render a result
  in their own UI.
- **Why `string` is not an answer:** an HTML `string` can load a pixel from any host (a silent beacon for the
  end user's address and timing), link anywhere, and carry active content. `web-page` and `image` closed the
  same hole for single URLs; HTML hides URLs inside a document.
- **Why a cleaner is not an answer:** a cleaned document is a document the provider did not send. If Archstone
  edits it, Archstone becomes the author of what the model reads, and the guarantee "only what you declared,
  exactly as your system returned it" stops being true (D-1, ADR-0008).
- **Rule #10 floor:** a new type needs two domains. At this revision the only demand evidence is the synthetic
  Showcase; real providers are unverified (H-1). The founder ruled on OQ-12 (2026-10-11): the design is ratified,
  and nothing is built until a real provider's API needs it (D-13).

## 3. Current understanding

### 3.1 Observations (verified against the code; registry in §12)

| ID | Observation | Source |
|---|---|---|
| O-1 | `web-page` and `image` are registered, **Experimental, output-only** semantic types. Neither may be an input or an extraction target; both need `response:` or `extract:`. | CDL spec §4.7; `packages/compiler/src/ir.ts` |
| O-2 | A binding's origin lists are `origins.pages` and `origins.images`: each non-empty, bare `https` origins only, no wildcards, no path. The IR table that binds a type to its list is **one type to one list**. | CDL spec §5.4; `ORIGIN_BOUND_TYPES`, `binding.schema.json` |
| O-3 | The origin predicate (`checkOrigin`) parses with WHATWG `URL`, requires `https` and no userinfo, compares the normalised origin exactly, and returns the **normalised href** — which is what the mapper then emits instead of the provider's string. | `packages/emitter-support/src/origins.ts`, `mapping.ts` |
| O-4 | The response mapper is the one enforcement point: an off-origin value is *absent*; optional → omitted and the result is `degraded`; required → contract `violation` carried in `_meta`, never `structuredContent`. Withheld paths go in a separate `withheld` list (names only, never values). | `mapping.ts`; `server.ts`; `execute.ts` |
| O-5 | The model sees a `note: withheld …` text block naming the output paths; `verify` reports any withheld value **red**; the embedded `ExecuteResult` carries `withheld` field names. The note's last sentence says every other **link and image** returned passed. | `withheldNote`, `verify.ts`, `execute.ts` |
| O-6 | `list: image` withholds per item (names capped at 25 per list); `list: web-page` is refused. | CDL spec §4.7 |
| O-7 | The MCP server returns the mapped data **twice**: serialised into a text block and as `structuredContent`. It advertises tools only; tool definitions carry no `_meta` and there is no `resources` capability (re-check before relying on it). | `server.ts`; RFC-0009 O-1 (2026-10-05, not re-verified today) |
| O-8 | `outputSchema` is validated by the reference client unconditionally; a value or keyword a strict client rejects crashes it (the reason `format: uri` is safe only because the mapper emits a normalised href). | `server.ts` ADD-19 comments; `lowering.ts` |
| O-9 | A tool whose binding has neither `response:` nor `extract:` is raw pass-through; the mapper never runs. The compiler refuses the combination for origin-bound types and `passThroughRefusal` is a runtime floor. | `validate.ts`; `mapping.ts` |
| O-10 | No HTML (or CSS) parser is a dependency of any core package today. | `package.json` of `compiler`, `emitter-support`, `runtime`, `agent` |
| O-11 | The synthetic Showcase API returns a raw `description_html` containing `<img>` and `<a>` to undeclared hosts; it is deliberately undeclared (N-02), asserted absent by the Showcase's acceptance criteria, and S-22 is a locked card. | `examples/showcase/` |
| O-12 | CDL states the limits of an origin-bound type: only typed fields are checked; nothing is fetched; a deployer's `onResponse` hook sees the raw body before the check. | CDL spec §4.7 |

### 3.2 What the declaration promises, and does not (be explicit; ADR-0008)

ADR-0008 says undeclared provider data never reaches a model. `html` does **not** weaken it, because the
*declaration* is the field's name, type and origins: everything in the value is part of one **declared field**,
returned as the provider wrote it. The ADR forbids forwarding what the manifest did not name; it never promised
that the text of a declared field is benign, any more than it does for a declared `text` field.

| The declaration promises | The declaration does **not** promise |
|---|---|
| The value is exactly what the provider returned (byte-equal after JSON decoding). | That the text is safe, true, or free of instructions aimed at a model. The check is about **where the HTML points and what it can execute**, not **what it says**. |
| Every image and link in it is on a declared origin, or the value is absent. | That the declared origin is trustworthy, does not redirect, or logs requests. |
| It contains no construct the processor cannot classify (scripts, forms, frames, styles, unknown elements). | That any client renders it, or renders it the way the provider intended. |
| It was parsed, not pattern-matched. | That a renderer whose parser differs from the checker's reads it identically (mitigated in §10, not eliminated). |

## 4. Proposal

### 4.1 The type (D-2, Ratified)

`html` is a semantic type candidate for RFC-0005: *HTML markup a provider produced for a person to read,
returned unmodified or not at all.* Experimental, output-only, scalar only.

| Section | Content |
|---|---|
| **Definition** | A string of HTML, as a fragment (not a document), that a person is meant to read. Its images and links point only at origins the binding declares, and it contains only constructs on the supported list (§6.3). |
| **Motivation** | Without it, rich provider text is either dropped (the assistant knows less than the site) or carried as an unchecked `string`. Tourism (offer and hotel descriptions) and retail/CMS (product body) are the two intended domains; **unverified on real APIs** (H-1). |
| **Examples** | A hotel description with a paragraph, a list and a photo; a product body with a heading, a table of sizes and a link to the size guide. |
| **Counterexamples** | A full HTML document, a page to be fetched, an email template with inline styles, a widget with scripts, a Markdown body (that is `text`). |
| **Rejected alternatives** | §11. |
| **Evidence** | Minimality: `string` cannot carry the guarantee; `web-page`/`image` cannot, because URLs are inside markup. Falsification record: none yet — not yet falsified by any real provider. |
| **Known limitations** | Rendering is the client's. Content is not checked. The supported list is deliberately small and will fail real-world CMS output routinely at first. |

### 4.2 Declaration (D-3 and D-4, Ratified)

CDL gains one enum member in the scalar field form, **not** in the list form. Minor, additive CDL bump
(ADR-0007); older tooling rejects the unknown value, which is the intended fail-closed behaviour. The
binding gains **no new key**: `origins` is reused.

| URL context in the HTML | Governing list |
|---|---|
| Image contexts: `img src`, `img srcset`, `picture > source srcset` | `origins.images` |
| Navigation contexts: `a href` | `origins.pages` |

The names are the core's: `pages` and `images`. Adrian's wording was `{ images, links }`; the core has no
`links`. Decided (OQ-1, as recommended): keep `pages` and add no alias — a second name for one list is a permanent
cost (Rule #11) for no capability. Both lists are separate, as for `web-page` and `image`: a URL valid for one
is checked only against that one.

Because an `html` value can contain both kinds of URL, **one `html` field is governed by two lists**. This
breaks the table in O-2 (one type, one list) and is the main ripple on shared code (§7).

**Which lists must be declared.** Decided (OQ-7, as recommended): at least one of the two. A list that is not declared
is an *empty* allow-set for its contexts: any image (or any link) in the value withholds it. An author whose
provider's descriptions contain only links, or only photos, declares one list; one whose descriptions are
formatting only still declares one (the statement "I considered where this may point" is the point of the
rule). The alternative — require both — is simpler to state and forces a made-up origin on an author who will
never use it.

**Compile rules** (derived names follow the existing `<type>-<rule>` pattern; severities as for siblings):

| Code | Condition | Severity |
|---|---|---|
| `html-in-input` | `html` (or a Resource containing it) reachable from `input:` | error |
| `html-no-origins` | output reaches an `html` field and the binding declares neither `origins.pages` nor `origins.images` | error |
| `html-needs-mapping` | output reaches `html` but the binding has neither `response:` nor `extract:` | error |
| `origins-malformed` | an entry breaks the §5.4 syntax (existing rule) | error |
| `origins-unused` | a declared list is reached by no origin-bound field; `html` counts as reaching **both** lists (extends the existing rule) | warning |
| `html-required` | an `html` field is `required` (routine withholding would fail the whole response) | warning |
| `html-required-in-collection` | required `html` in a `collection:` without `onError` (the existing derived rule) | warning |
| *(schema)* | `list: html` is not in the list-field enum → a schema error, as `list: web-page` is | error |

An extraction target containing `html` is refused by the existing extraction mechanism. `init` must not infer
`html` from an OpenAPI `format: html` or a field name: it cannot know the origins (RFC-0009 §14 point 5).

### 4.3 Where it is enforced (D-5, Ratified)

In `applyResponseMapping`, at the scalar leaf, beside the existing origin check, so MCP, the embedded
`execute()`, `verify` and contract recording behave identically from one implementation (O-4). The mapper
already walks nested Resources and collection rows; `html` inherits that walk. The one difference from
`web-page`: **the leaf emits the provider's original string, never a derived one.**

## 5. "Unmodified", defined

D-1 makes this the contract, so it must be testable.

1. The checker receives the **JSON-decoded string value** (UTF-16 code units, as the runtime holds it).
2. It returns a verdict and nothing else. It **never produces HTML**: no serialisation, no re-encoding, no
   trimming, no entity or whitespace normalisation, no case change, no BOM handling. The mapper emits the very
   string it received.
3. **Byte equality** is defined on the UTF-8 encoding of that string: the UTF-8 bytes of the output equal the
   UTF-8 bytes of the input. The guarantee is therefore about the decoded value, not the provider's HTTP body
   (which may use `\u` escapes or different JSON whitespace); the decoding itself is the provider layer's, before
   the mapper.
4. A string that **cannot be encoded to UTF-8 without change** (an unpaired surrogate, e.g. from a `"\ud800"`
   escape) would not survive step 3. It is withheld (category `value`). U+0000 is withheld for the same reason
   (it is a tokeniser error and a renderer differential).
5. The test that proves it (a Showcase acceptance test): hash the input string's UTF-8 bytes; hash the output's; they are
   equal, over a corpus that includes uppercase tags, unquoted attributes, `&amp;` in a query string, CRLF line
   endings, a leading BOM and non-BMP characters.

The guarantee does not extend to the deployer's `onResponse` hook (it runs first, on the raw body — O-12) or to
anything downstream of the result (a client may reformat what it shows).

## 6. Verification algorithm (parse-only)

### 6.1 Why a parser, and which

A regular expression cannot read HTML the way a browser does, and the whole risk of this feature is the checker
reading less than the renderer. The checker therefore uses a **WHATWG-compliant tokeniser and tree
constructor** (D-6, Ratified): the same algorithm a browser runs, applied in fragment mode with a fixed
context element (`div`), so the checker's tree and a renderer's tree agree wherever the renderer uses the same
context. The tree is **read, never written back**.

The candidate is an established, spec-tracking parser (parse5 is the obvious one, H-4). It would be the first HTML
dependency in core (O-10), so it must be pinned, lock-filed, pure JavaScript (the Showcase Worker runs on
workerd), and the only addition. A hand-written parser is rejected: writing a browser-grade tokeniser is a
larger risk than depending on one. OQ-11 asks.

### 6.2 Steps, in order, first failure decides the category

| # | Step | Failure → category |
|---|---|---|
| 1 | The value is a string, well-formed Unicode (no unpaired surrogate), no U+0000. | `value` |
| 2 | UTF-8 length ≤ the size cap (§8). | `size` |
| 3 | Parse as a fragment. **Any parse error reported by the tokeniser or the tree constructor withholds** (OQ-3). Element nesting depth ≤ 32 (the mapper's existing nesting cap). Doctype, `<html>`/`<head>`/`<body>`, CDATA, processing instructions all produce parse errors in this mode. | `markup` |
| 4 | Every element is on the **allowlist** (§6.3). Comments are not allowed. | `construct` |
| 5 | Every attribute of every element is on that element's allowlist; no attribute appears twice on one tag (duplicate-attribute is a parse error, so step 3 already catches it). | `construct` |
| 6 | Every URL-bearing attribute passes the origin predicate (§6.4). | `origin` |

Steps 4–6 report **all** findings to the author's diagnostics (capped at 20); the runtime needs only the first.

### 6.3 Allowlist, not denylist (D-7, Ratified)

**Fail closed on anything not named.** A denylist ("no script, no iframe, …") fails the moment the web adds an
element or attribute, and the web does so regularly; it also invites the question "why was `<frame>` not on the
list". An allowlist fails in the safe direction — and every widening is a recorded decision.

The v1 list (ratified). It is deliberately smaller than what CMS output uses, because each addition needs its own
argument:

| Group | Elements |
|---|---|
| Text | `p`, `br`, `hr`, `span`, `div`, `strong`, `b`, `em`, `i`, `u`, `s`, `small`, `sub`, `sup`, `mark`, `abbr`, `q`, `blockquote`, `pre`, `code`, `kbd`, `samp`, `var`, `time`, `address`, `wbr` |
| Structure | `h1`–`h6`, `ul`, `ol`, `li`, `dl`, `dt`, `dd`, `section`, `article`, `aside`, `header`, `footer`, `nav` |
| Table | `table`, `caption`, `thead`, `tbody`, `tfoot`, `tr`, `th`, `td`, `colgroup`, `col` |
| Media | `img`, `picture` (with `source` only as its child), `figure`, `figcaption` |
| Link | `a` |

| Element | Allowed attributes |
|---|---|
| any allowed element | `title`, `lang`, `dir` |
| `a` | `href` (→ `pages`) |
| `img` | `src`, `srcset` (→ `images`), `alt`, `width`, `height`, `sizes` |
| `source` | `srcset` (→ `images`), `sizes`, `media`, `type`, `width`, `height` |
| `td`, `th` | `colspan`, `rowspan`, `scope` |
| `ol` | `start`, `reversed`, `type` |
| `time` | `datetime` |
| `col`, `colgroup` | `span` |

**Not on the list, and why it matters (a `construct` finding names the element or attribute to the author):**

- **Active content:** `script`, `style`, `link`, `meta` (so `meta http-equiv=refresh`), `base`, `iframe`,
  `frame`, `frameset`, `object`, `embed`, `applet`, `form` and every form control, `template`, `noscript`,
  `canvas`, `svg`, `math` (foreign content has its own parsing rules and its own `href`, `xlink:href`, `use`
  and `foreignObject` surfaces), `video`, `audio`, `track`, `map` and `area` (image maps; `area href` would be a
  `pages` context if ever admitted).
- **Attributes that carry a URL elsewhere:** `poster`, `action`, `formaction`, `background`, `data`, `codebase`,
  `longdesc`, `cite`, `ping`, `usemap`, `xlink:href`, and the `src` of anything but `img`. These are recognised by
  name so the diagnostic says "an unsupported URL-bearing attribute" rather than a generic "unsupported".
- **Attributes that smuggle behaviour or styling:** every `on*` handler, `style`, `class`, `id`, `name`,
  `hidden`, `data-*`, `target`, `rel`, `download`. `style` and `<style>` can carry `url()`, `@import`,
  `image-set()` and font loads, and can hide or overlay text. `class` and `id` can address the **host page's**
  own styles and scripts (UI redress, DOM clobbering). Inline `style` is the single most common CMS construct
  and its refusal is the largest cost of this design (OQ-2).
- **Comments** (including conditional comments): they are invisible to a person and visible to a model, a
  hidden-instruction channel.

`area`/`map`, `target`, `rel`, `class` and `style` are the candidates for widening once H-2 shows how often they
fail real providers. Each is its own decision.

**Rule #11.** The type's *meaning* in the spec stays short (the definition above). The element and attribute
list lives in a **versioned normative annex** that may be widened by decision and narrowed only for a security
defect, announced as one — otherwise an author's value that passes today fails after an upgrade.

### 6.4 URL attributes: checked on the decoded value, emitted as the original

The one place this differs from `web-page` (O-3): `checkOrigin` returns a normalised href, which for `html`
would be a modification. The origin predicate is therefore split in two, **one implementation, two outputs**:
the same decision (`https`, no userinfo, exact normalised origin, absolute only), then either "emit the
normalised href" (`web-page`, `image`) or "emit nothing; the caller keeps the original" (`html`). Behaviour for
`web-page` and `image` must not change.

- The tokeniser **decodes character references** in attribute values before the check, so `&#x6a;avascript:alert(1)`
  is read as `javascript:alert(1)` and fails the scheme test, exactly as a browser reads it.
- The decoded value is parsed by the WHATWG URL parser with **no base**. A relative reference (`/img/1.jpg`,
  `photo.jpg`), a fragment-only reference (`#top`), a protocol-relative one (`//host/x`), an empty `href`, and
  every non-`https` scheme (`javascript:`, `data:`, `vbscript:`, `http:`) fail. This is the `web-page` rule and
  for the same reason: there is no declared base to resolve against (OQ-5 revisits it only if real providers
  need it).
- `srcset` is read with the **HTML "parse a srcset attribute" algorithm**, not a string split, and **every**
  candidate URL must pass. A srcset the algorithm cannot parse withholds. The candidate count is capped (100).
- An `img` with both `src` and `srcset` has all of its URLs checked.
- Whitespace around or inside the URL (tabs, newlines) is handled by the URL parser exactly as the browser does;
  the original string, with that whitespace, is what is emitted.
- Nothing is fetched. Whether an image or page exists is not checked (RFC-0009 Q-6, unchanged).

## 7. Layer boundaries and ripple on shared code

| Layer | Change | Out of scope |
|---|---|---|
| CDL schema | `html` in the scalar enum only | list form; input; extraction |
| IR | `SemanticType` gains `html`. The type→list table needs to say **one type may be bound to several lists**. No HTML syntax in the IR. | the allowlist, any URL parsing |
| Compiler | the §4.2 rules; they derive from the same table | fetching, parsing HTML at compile time (the compiler stays syntactic; it does not parse values) |
| `emitter-support` | the checker (parser dependency lives here); the split origin predicate; the `html` leaf in the mapper; lowering; "origin-bound" predicate used by extraction refusal, `passThroughRefusal` and reachability must include `html`; the `withheld` reason category | any MCP type |
| Runtime / MCP emitter | the model-facing note text (§9) | `resources`, `ui://`, `_meta` (deferred, §10) |
| `@archstone/agent` | `ExecuteResult` gains the additive reason (§9) | rendering |
| CLI | `verify` diagnostics (§9) | a standalone fragment-checking command (possible follow-up) |

The ripple to name for the ADD: the existing single-list helper (`originListOf`) is consulted in four places
(mapper, lowering, extraction refusal, validation). A naive second type-to-list entry would silently leave `html`
unchecked in whichever call site is missed; the ADD should make "is origin-bound" one question with one answer.

**Lowering.** MCP `outputSchema`: `type: string`. `contentMediaType: text/html` is a valid JSON Schema 2020-12
annotation and would tell a capable client what the string is; it is added only if a live reference-client test
shows no strict validator rejects it (O-8, H-6). Otherwise the field `description` carries the meaning, with a
fallback sentence when the author wrote none ("HTML for a person to read; do not fetch the URLs in it"), as
`image` has. No `pattern`, no `format`. The four tool formats carry an input schema only, so the type does not
appear there (a D3(c) lossiness row, as for `web-page`).

## 8. Size, lists and nesting (D-8, Ratified)

**Size.** A value larger than **64 KiB** (UTF-8 bytes) is withheld (`size`). The sum of `html` values counted in
one response is capped at **256 KiB**, in the provider's order: once exhausted, later values are withheld
(`size`). The cap protects the parser and the model's context; it is not a content judgement. The mapped data
reaches the client twice (O-7), so wire size is roughly double. The cap is a constant in v1 — a per-binding knob
is a new primitive, and it would be a way to relax a guarantee. OQ-4 asks for the number; H-8 tests it.

**Lists.** Two options:

| | `list: html` rejected in v1 (recommended) | per-item withholding, like `list: image` |
|---|---|---|
| Consistent with | `web-page` | `image` |
| Evidence of need | none (no provider returns a list of HTML fragments, H-1) | none |
| Cost | a provider returning `[html, html]` models a Resource with an `html` field | parallel-list misalignment (CDL spec §4.7); the response budget makes *which* item is dropped depend on order; the 25-name cap applies |
| Reversible | adding it later is additive | removing it later is not (Rule #11) |

**Nesting.** `html` is allowed in a Resource at any depth and in `collection:` rows; the existing walk and the
existing nesting cap (32) apply. A required `html` inside a collection without `onError` fails the whole
response when one row is withheld — the existing `web-page` behaviour — and the `html-required*` warnings say
so. An optional `html` is the recommended shape.

## 9. How withholding is reported (D-9, Ratified)

Existing semantics apply unchanged (O-4): the field is **omitted** (not null); optional → `degraded`; required →
`violation` with the `_meta` carrier and the path in `withheld`. The result names **paths, never values**.

What is new is a **reason category**, a closed vocabulary that is never provider text:

| Category | Meaning | Examples |
|---|---|---|
| `origin` | a URL points outside the declared origins, or is not checkable (relative, non-`https`) | tracking pixel, `javascript:` link |
| `construct` | an element, attribute or comment outside the supported list | `<script>`, `onclick`, `style` |
| `markup` | the parser reported an error, or nesting is too deep | unclosed tag, duplicate attribute, bare `<` |
| `size` | over the per-value or per-response cap | |
| `value` | not a string, or not well-formed text | lone surrogate, NUL |

| Audience | Gets | Why |
|---|---|---|
| **Model** (MCP note; `ExecuteResult` for an embedder) | the path and the **category**; the note's fixed sentence is adjusted so it does not claim more than it checked | the model can tell the user "the description was withheld because it contained an unsupported construct" instead of guessing; the category is not provider-controlled (RFC-0009 §4.3). A URL, host or element name would be (OQ-8). |
| **Author** (`verify`, `verify --record`, the lint) | path, category, and **element, attribute, and the offending origin**, each truncated and control-character-escaped | this is what an author needs to act; it is printed to their terminal, not returned to a model |
| **Records** (audit, `contract:`) | the path and category only | ADR-0008: the contract records shapes, never values |

`verify` marks any withheld `html` value **red**, as for `web-page`: the provider's own data already breaks a
guarantee production enforces by silently dropping the field. The existing sentence "Every other link and image
returned passed the origin check" stays true for typed `web-page`/`image` fields; for a withheld `html` field the
note says the value was not checked past the first failure, and does not claim anything about its contents.
A **passing** value carries no note (a note would read as an assurance about content, which the check does not
give).

## 10. MCP carriage, honestly compared

The question is how an `html` value reaches a client. What follows is what is known; **no claim below that
depends on a client's behaviour has been verified by hand** (H-5).

| | (a) string in `structuredContent` + the existing text block | (b) embedded resource with `mimeType: text/html` | (c) MCP Apps `ui://` resource |
|---|---|---|---|
| What the client gets | the same string it gets for any text field | an extra content block carrying the HTML, plus a URI the server must invent | a `ui://` template the host renders in a sandboxed iframe |
| Works in every client today | **yes** (it is the status quo for strings) | clients differ on what they do with an embedded resource; many hand it to the model as text or drop it (H-5) | only hosts that implement the extension (see below) |
| Bytes | 2× (O-7) | 3× | template once, data as today |
| Preserves "unmodified" | yes | yes | yes, if the card inserts the string as markup — which RFC-0009 D-3's *text-nodes-only* card does not do; it would need a new, audited path |
| Rendering | the client's choice; raw tags are likely in many (H-5) | no evidence any mainstream host renders `text/html` that is not a `ui://` app (H-5) | host-enforced sandbox and CSP; the **images** list could feed the CSP, so a checker bug still cannot load a foreign picture (RFC-0009 Q-4) |
| Cost to build | a lowering line (§7) | a URI scheme, a per-field mapping, a third copy of the bytes | RFC-0009 Part 2 (the card, `resources`, per-provider CSP) — not built |
| Presentation primitive risk | none | a server-side decision about how a field is shown | the generated card (RFC-0009 D-2…D-7) |

*On MCP Apps.* RFC-0009 O-5 records the extension (SEP-1865) as live since 2026-01-26. A third-party client matrix
searched on 2026-10-11 lists Claude, Claude Desktop, VS Code GitHub Copilot, Goose, Postman and MCPJam; guides
disagree on ChatGPT. That is secondary evidence only (H-5, H-7). Host support, and whether a stdio server learns
the client advertises `io.modelcontextprotocol/ui`, are still open in RFC-0009 Q-4.

**Decision (D-10, Ratified): (a) for v1.** The HTML travels as an ordinary string field, with
`contentMediaType: text/html` if the live test allows (§7). (b) is rejected for v1: it triples the bytes and invents
a URI to buy a rendering no one has shown to exist. (c) is deferred to RFC-0009 Part 2, where `html` is the first
field that needs the card to insert markup rather than text, and where the declared image origins become the
CSP — a real gain, and one that must not be bought before the card exists. Nothing in (a) forecloses (c): the
IR and the result are the same either way (Rule #12: the surface is an emitter output).

## 11. Alternatives considered

| Option | Pros | Cons | Why not |
|---|---|---|---|
| **Sanitiser** (strip bad tags, URLs) | most real HTML would "pass" | the output is not what the provider sent (D-1); sanitisers are the classic source of mXSS because they re-serialise; Archstone becomes the author | refused by D-1 |
| **Convert to Markdown / plain text** | small, readable by a model | a converted value is a rewritten value; loses structure | refused by D-1; `text` already exists for authors who want it |
| **Trusted-provider flag** | removes the failures | the guarantee becomes a default (ADR-0008); a flag that disables it is the thing the ADR refuses | refused by ADR-0008 |
| **Rewrite URLs through a proxy** | the model never sees the origin | alters the document; makes Archstone a content-serving party that logs end users | refused by D-1 and RFC-0009 §4.3 |
| **Withhold only the offending element** | fewer failures | that *is* sanitising | refused by D-1 |
| **Check, then emit a re-serialised tree** | one canonical form | changes the bytes | refused by §5 |
| **Denylist** | passes more | fails open on every new element | §6.3 |
| **Regex over the string** | no dependency | not how a browser reads HTML; the differential is the whole risk | §6.1 |
| **Rely on the renderer's CSP only** | zero checking | does not cover a renderer without one, or the model's view; no guarantee before the result leaves | complements, does not replace |
| **Allow `style` with a CSS parser** | covers the commonest CMS construct | a second parser, a second differential surface | deferred to a decision after H-2 |
| **Render via MCP Apps first** | best presentation | nothing to render until the type exists; host-dependent | RFC-0009 §9 sequencing |

## 12. Registries

### Observation registry

O-1 … O-12 are in §3.1, all dated 2026-10-11 against core `6ff4bac`, except O-7's `_meta`/`resources` clause, last
verified 2026-10-05 in RFC-0009 O-1.

### Hypothesis registry

| ID | Statement | Validation method | Status |
|---|---|---|---|
| H-1 | At least two domains (tourism, retail/CMS) return HTML descriptions from a production API | Inspect real provider responses; Rule #10 gate (a). The Showcase is synthetic and does not count | Pending |
| H-2 | On the first real provider's recorded fixtures, at least 90% of HTML values pass once origins are declared, with no change to the provider's content | Run the checker over recorded fixtures; report the failure histogram by category and by construct (`style`, `class`, `target`, relative URL …) | Pending |
| H-3 | An author whose value is withheld can fix it from the diagnostic alone | Hand test with two authors | Pending |
| H-4 | A spec-tracking parser in fragment mode with a `div` context, plus this allowlist, leaves no case where a current evergreen browser reads a URL or element the checker did not | A differential corpus (the §6 conformance list plus public mXSS/parser-differential examples) run in a headless browser and in the checker, a bounded serial run in CI | Pending |
| H-5 | Most MCP hosts show an HTML string in a tool result as text; none renders embedded `text/html` that is not a `ui://` app | Check by hand in each target host | Pending (unverified) |
| H-6 | The reference client's validator accepts `contentMediaType` in an `outputSchema` | Live-client test, ADD-19 pattern | Pending |
| H-7 | Hosts that support MCP Apps honour a declared image-origin CSP | RFC-0009 H-4 / Q-4 host check | Pending |
| H-8 | 64 KiB / 256 KiB is above 99% of real descriptions | Measure on H-2's fixtures | Pending |

### Decision registry

| ID | Decision | Status | Rationale | Revisit when |
|---|---|---|---|---|
| **D-1** | HTML from a provider API is never altered: passed through unmodified when it satisfies the binding's declared origins, withheld whole otherwise; never rewritten, stripped or sanitised; no trusted-provider passthrough | **Binding** (founder, 2026-10-09) | ADR-0008; a cleaned document is a document the provider did not send | Never without an ADR |
| D-2 | `html` is a scalar, output-only, Experimental semantic type candidate | Ratified 2026-10-11 | §4.1; RFC-0009 D-8 | H-1 |
| D-3 | No new binding key; reuse `origins` with image contexts on `images` and link contexts on `pages` | Ratified 2026-10-11 | Rule #10 | Real providers need a third kind |
| D-4 | At least one of the two lists is required; an undeclared list is an empty allow-set | Ratified 2026-10-11 | §4.2 | OQ-7 |
| D-5 | Enforced in the shared mapper; the leaf emits the original string | Ratified 2026-10-11 | ADR-0008 (the mapper is the boundary); §5 | — |
| D-6 | Spec-compliant parser, fragment mode with a fixed context; never serialise; any parse error withholds | Ratified 2026-10-11 | §6.1; OQ-3 | H-4 fails |
| D-7 | Element and attribute **allowlist**, in a versioned annex; widen by decision, narrow only for security | Ratified 2026-10-11 | §6.3; Rule #11 | H-2 shows a construct that must widen |
| D-8 | 64 KiB per value, 256 KiB per response, constants; `list: html` rejected in v1 | Ratified 2026-10-11 | §8 | H-8; a list-of-HTML provider appears |
| D-9 | Withheld = omitted; closed reason category to model and embedder; element/attribute/origin to the author only | Ratified 2026-10-11 | §9 | OQ-8 |
| D-10 | MCP carriage (a) in v1; (b) rejected; (c) deferred to RFC-0009 Part 2 | Ratified 2026-10-11 | §10 | H-5, H-7 |
| D-11 | The embedded SDK returns the string untouched; no rendering guarantee | Ratified 2026-10-11 | §13 | — |
| D-12 | Compile rules per §4.2; `verify` red on withheld | Ratified 2026-10-11 | §4.2, §9 | — |
| D-13 | Ratified as a design only: no core build, no CDL enum member, no parser dependency until a real provider's API returns HTML that an author needs to declare (H-1); the Showcase alone does not pull it. The public edition is published on ratification | Ratified 2026-10-11 | OQ-12, OQ-10; Rule #10 | A real provider needs it → core#166 becomes an increment with an ADD |

## 13. Embedded SDK, Showcase, threat model

### 13.1 Embedded SDK path (D-11)

`execute()` returns the mapped `data` with the `html` field holding **the identical string**. The embedder holds
the IR (the output field's type is `html`; the tool's `origins` are in the IR), so it knows what the field is and
what the declared origins are. The four tool formats do not carry output types (RFC-0009 §4.4), so no type
information is added there; whether `fromIR` should expose a field-type accessor is a question for the ADD, not
this RFC (not verified). `ExecuteResult.withheld` is unchanged; the category is additive (§9).

*Non-normative guidance for the embedder:* render the string in a sandboxed `iframe` (`sandbox` with no
permissions) via `srcdoc`, with a Content-Security-Policy whose `img-src` is the declared `origins.images`, and
open links from `origins.pages` only. Archstone guarantees what the string contains, not what a renderer does with
it.

### 13.2 Showcase negative scenario (S-22)

Hosts below are illustrative; the Showcase's real ones come from `examples/showcase/`.

*Declared:* a field `description_html: html` (optional) on a stays Resource; `origins.pages:
[https://www.wanderlust.example]`, `origins.images: [https://img.wanderlust.example]`.

| Case | Provider value (abridged) | Result |
|---|---|---|
| Clean | `<p>Casa Alfama, a <strong>restored</strong> townhouse. <a href="https://www.wanderlust.example/stays/casa-alfama">Details</a></p><img src="https://img.wanderlust.example/casa-alfama/1.jpg" alt="Facade" width=640 height=480>` | Field present, **byte-identical** (a test asserts hash equality of input and output). No note. |
| Tracking pixel | the clean value plus `<img src="https://tracker.example/p.gif" width=1 height=1>` | **Whole value withheld**: field omitted; `degraded`; `withheld: [stays[0].description_html]`; the note names that path and the category `origin`. The rest of the result is unaffected; nothing is fetched. `verify` is red and names the element, the attribute and `tracker.example`. |

Unquoted attribute values such as `width=1` are valid HTML and are **not** a parse error, so the pair differs only
in the pixel.

Showcase acceptance mapping:

| Showcase requirement | How this RFC meets it |
|---|---|
| The value is byte-for-byte what the provider sent | §5; the clean case |
| A value that fails the check is withheld whole, named in `withheld`, never cleaned | §9; the pixel case |
| A trusted provider gets no exception | no key exists to express one; a binding with an unknown key is a schema error; a test adds a "trusted"-style key and expects refusal |
| The check never fetches anything | the checker is pure; a request spy records zero outbound calls |
| S-22 unlocks with a clean-pass and a withheld pair | §13.2 table; the Showcase unlock and its companion change land together |
| Form, script and inline-style URLs are decided, not left open | **Decided here (D-7 and D-9, Ratified):** none is a "link" — each is an unsupported construct (`construct`) that withholds whole. The model-facing report gives the category, not the origin; the author's tools give the origin (§9, OQ-8) |

**Coordination, not a question** *(done 2026-10-11: the Showcase's absence assertions are scoped to S-02)*. The Showcase's assertions that `description_html` is absent from the result, the output schema and the exposure list (S-02's N-02 among them) are scoped to the S-02 capability. Declaring it anywhere in the Showcase manifests would break those assertions as written, so only a separate S-22 capability (for example a stay "describe" tool) declares it, and S-02's claim stays literally true.

### 13.3 Threat model

| Threat | Mitigation | Residual |
|---|---|---|
| **Exfiltration by image/beacon** (pixel to a foreign host) | every `img src`/`srcset`/`picture source` checked against `images`; unsupported URL-bearing attributes (`background`, `poster`, `data`) are not on the list | a **declared** origin that logs or redirects; the provider's own server sees the end user's IP and timing, as for `image` |
| **Exfiltration by link** | `a href` against `pages`; scheme `https` only | an open redirect on a declared origin (out of scope, as for `web-page`) |
| **Exfiltration by CSS** (`url()`, `@import`, fonts, `image-set`) | `style`, `<style>`, `<link>` not allowed; no `class`/`id` to address the host's CSS | none in v1; widening `style` needs a CSS parser and its own decision |
| **Active content** (script, `on*`, `javascript:`, frames, SVG/MathML) | allowlist; `on*` not named; foreign content not allowed | a renderer bug |
| **Parser differential / mXSS** | the string is never re-serialised, so no round-trip mutation; any parse error withholds; a fixed fragment context; a strict allowlist leaves little for parsers to disagree about; H-4 tests it | a renderer that inserts the string in a different context (`table`, `select`, foreign content) or runs an older parser — mitigated by the §13.1 guidance, not eliminated |
| **Prompt injection in text** (instructions in a paragraph, `alt`, `title`) | comments are withheld; `style`, `class`, `hidden`, `data-*` are not allowed, so text a person cannot see is limited to `alt`/`title` and invisible Unicode | **full**: the check does not read what the text says. ADR-0008 never promised otherwise for a declared field; the public docs say so |
| **Invisible or bidirectional Unicode** (tag characters, RTL overrides) | lone surrogates and U+0000 withheld | other code points pass, as in any `text` field |
| **DoS** (huge value, deep nesting, srcset bombs) | 64 KiB / 256 KiB caps before parsing; depth ≤ 32; srcset ≤ 100 candidates; tokenisation is linear | a hostile response consumes the budget and withholds legitimate later values (deterministic, in order) |
| **Homograph / punycode** | the same WHATWG normalisation as `checkOrigin`; a trailing-dot host is a different origin | an author who declares a lookalike origin |
| **Redirects on allowed origins** | none (nothing is fetched) | out of scope, as for `web-page` |
| **Checker bypass** (pass-through tool, `onResponse` hook) | `html-needs-mapping` compile error; runtime `passThroughRefusal` floor; the `onResponse` caveat is stated | the hook sees the raw body before the check (O-12) |
| **Downgrade to trusted** | no flag, no key | none |
| **Supply chain** (the parser dependency) | one dependency, pinned, lock-filed; releases already go through OIDC trusted publishing | an upstream compromise between pins |
| **Checker and `verify` disagree** | one implementation, reached through the same mapper | none |

## 14. Open questions — resolved 2026-10-11

Each was resolved to its recommendation by the founder on 2026-10-11. The text of each question is kept as asked; the **Resolved** line is the decision.

- **OQ-1 `pages` or `links`?** Your wording was `{ images, links }`; the core's lists are `origins.pages` and `origins.images`. *Recommend: keep `pages`, add no alias.* An alias is a permanent second name (Rule #11); `pages` is already the list for "where a person goes".
  **Resolved (2026-10-11):** keep `pages`, no alias (D-3).
- **OQ-2 How strict is the v1 allowlist, including `style` and `class`?** *Recommend: the §6.3 list — no `style`, `<style>`, `class`, `id`, `target`, `rel`.* They are the cost-bearing choices: they will fail many CMS values, and each is where an exfiltration or redress channel lives. Widen individually after H-2's histogram.
  **Resolved (2026-10-11):** the §6.3 list, with no `style`, `<style>`, `class`, `id`, `target`, `rel`; widen individually after H-2 (D-7).
- **OQ-3 Do parse errors withhold?** *Recommend: yes.* An error is where parsers diverge; one more failure category is cheaper than one differential. Real CMS output will fail on bare `<`, `&nbsp` without a semicolon and unclosed tags; H-2 will say how often.
  **Resolved (2026-10-11):** yes, any parse error withholds (D-6).
- **OQ-4 Size cap.** *Recommend: 64 KiB per value, 256 KiB per response, constants.* Typical descriptions are far smaller; the cap is for the parser and the context window.
  **Resolved (2026-10-11):** 64 KiB per value, 256 KiB per response, constants (D-8).
- **OQ-5 Relative URLs.** *Recommend: withheld in v1, as `web-page`.* Revisit only when a real provider returns them and a declared-base rule can be argued.
  **Resolved (2026-10-11):** withheld in v1, as `web-page` (§6.4).
- **OQ-6 MCP carriage.** *Recommend: (a) string in `structuredContent` + the text block, with `contentMediaType: text/html` if the live test passes; (b) rejected; (c) MCP Apps deferred to RFC-0009 Part 2.*
  **Resolved (2026-10-11):** (a) string in `structuredContent` + the text block, `contentMediaType: text/html` only if H-6 passes; (b) rejected; (c) deferred to RFC-0009 Part 2 (D-10).
- **OQ-7 Both origin lists, or at least one, or zero?** *Recommend: at least one; the other is an empty allow-set.* A formatting-only description still declares one list, as the author's statement. Alternative: zero allowed with a warning — more convenient, but removes the author's explicit statement.
  **Resolved (2026-10-11):** at least one list; an undeclared list is an empty allow-set (D-4).
- **OQ-8 Does the model-facing report carry the reason category?** *Recommend: yes — the closed five-value category; never an element name, URL or origin.* A model can then explain the absence truthfully. Alternative: field name only, as `web-page` does today.
  **Resolved (2026-10-11):** yes, the closed five-value category; never an element name, URL or origin (D-9).
- **OQ-9 Maturity and gating.** *Recommend: Experimental, no flag.* A type nobody authors costs nothing, and a flag that turns the check off is the "default, not a guarantee" ADR-0008 refuses.
  **Resolved (2026-10-11):** Experimental, no flag (D-2).
- **OQ-10 Public edition timing.** *Recommend: publish the public edition when the RFC is ratified and before the core PR opens,* so the public issue #166 can link to the reasoning rather than to a promise.
  **Resolved (2026-10-11):** publish the public edition on ratification, before any core PR (D-13).
- **OQ-11 Parser dependency.** *Recommend: one pinned, spec-tracking, pure-JS parser (parse5-class) in `emitter-support`, validated by H-4's differential corpus before release.* Alternative: a hand-written strict-subset recogniser — no dependency, but it is a parser we would own.
  **Resolved (2026-10-11):** one pinned, spec-tracking, pure-JS parser (parse5-class) in `emitter-support`, validated by H-4 before release (D-6).
- **OQ-12 Rule #10's two-domain floor.** *Recommend: do not build until H-1 is answered on a real API;* ratify the RFC only as a design. The Showcase is synthetic.
  **Resolved (2026-10-11):** ratified as a design only; not built until H-1 is answered on a real API (D-13).
- **OQ-13 `list: html`.** *Recommend: rejected in v1 (§8).* Add when a provider returns a list of fragments.
  **Resolved (2026-10-11):** `list: html` rejected in v1 (D-8).

## 15. Success criteria

Promotion to an ADR: done 2026-10-11 ([ADR-0021](../adr/0021-html-is-passed-through-unmodified-or-withheld-whole.md)),
on the founder's ruling on OQ-12 and the other open questions. **Before the build starts** (D-13): H-1 has a real
provider; H-4's corpus design is agreed; and the live-client test plan for H-6 exists. Build success: every §6 conformance case (lookalike host, userinfo trick, entity-encoded `javascript:`, relative,
protocol-relative, `data:`, foreign `srcset` candidate, `<base>`, `<meta refresh>`, `<iframe>`, `<form>`, `<svg>`,
`<script>`, `on*`, `style`, a comment, a duplicate attribute, an unclosed tag, a lone surrogate, oversize, over-deep)
withholds with the right category, from one mapper, in MCP, `execute()` and `verify`; the clean corpus is
byte-identical; zero outbound requests.

## 16. Revision history

| Rev | Date | Change |
|---|---|---|
| 0.1 | 2026-10-11 | First draft. D-1 binding; D-2…D-12 proposed; OQ-1…OQ-13 |
| 0.2 | 2026-10-11 | Ratified by the founder: OQ-1…OQ-13 resolved to their recommendations; D-2…D-12 Ratified; D-13 added (design only, build held until a real provider needs it; public edition on ratification); promoted to ADR-0021 |
