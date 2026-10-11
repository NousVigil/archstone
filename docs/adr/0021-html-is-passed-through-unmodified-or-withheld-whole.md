# ADR-0021: Provider HTML Is Passed Through Unmodified or Withheld Whole

**Status:** ✅ Accepted (2026-10-11) — **design only; the build is held until a real provider needs it** (D-8)
**Date:** 2026-10-11 · D-1 binding since 2026-10-09 · ratified 2026-10-11
**Deciders:** Adrian Bratulescu
**Related:** [RFC-0010](../rfc/0010-html-output-type.md) (the full design; this ADR records its decisions) ·
[ADR-0008](0008-undeclared-provider-data-never-reaches-a-model.md) (the mapper is the boundary; no trusted-provider passthrough) ·
ADR-0007 (a minor, additive CDL bump) ·
RFC-0009 (`web-page`, `image`, `origins`; MCP Apps Part 2) ·
core [archstone#166](https://github.com/NousVigil/archstone/issues/166)
**Supersedes nothing. Reopens nothing.**

> **Public edition.** Reproduced from the ratified decision record. The decision, its reasoning,
> its rejected alternatives and its consequences are unabridged; references to internal
> architecture and planning documents have been removed or summarised in place. The guarantee
> stated here is the one in force.

---

## Context

Provider APIs often return a description as HTML, because a CMS or back-office editor produced it. An author
today has two bad options: leave the field out, so the assistant knows less than the provider's own website, or
map it as `string`, which carries any markup and any URL unchecked: a one-pixel image on a foreign host is a
silent beacon for the end user's address and timing.

`web-page` and `image` already closed this hole for single URLs: a binding declares `origins.pages` and
`origins.images`, and the shared response mapper withholds any value off those origins. HTML hides URLs inside a
document, so neither type can carry the guarantee for it.

The obvious remedy, a sanitiser, is the one this ADR refuses. A cleaned document is a document the provider did
not send. If Archstone edits it, Archstone becomes the author of what the model reads, and the promise ADR-0008
makes ("only what you declared, exactly as your system returned it") stops being true. Sanitisers are also the
classic source of mutation XSS, because they re-serialise.

RFC-0010 worked the design out in full: parser choice, allowlist, URL contexts, size caps, reporting, MCP
carriage, threat model. This ADR records what was decided. Where the two differ in detail, RFC-0010 governs the
mechanism and this ADR governs the commitment.

## Decision

### D-1 — Never altered: passed through unmodified, or withheld whole (RFC-0010 D-1, binding)

A field declared `html` is passed through **unmodified** when everything it points at satisfies the binding's
declared origins and it contains nothing the checker cannot classify. Otherwise it is **withheld whole**. It is
never rewritten, stripped, converted or sanitised, and no provider is trusted past the check: there is no key, flag
or default that expresses a trusted provider. Withdrawing this decision needs a superseding ADR.

"Unmodified" is testable: the UTF-8 bytes of the emitted string equal the UTF-8 bytes of the JSON-decoded string
the mapper received. The checker returns a verdict and never produces HTML. A value that cannot be encoded to
UTF-8 without change (an unpaired surrogate) or contains U+0000 is withheld.

### D-2 — One type, output-only, Experimental, scalar (RFC-0010 D-2, D-8; OQ-9, OQ-13)

`html` is a semantic type: HTML markup a provider produced for a person to read, a fragment, not a document.
Output-only (never input, never an extraction target), scalar only: **`list: html` is rejected in v1** and is
added later only when a provider returns a list of fragments (adding it is additive; removing it would not be).
Experimental, **with no feature flag**: a flag that turns the check off is the "default, not a guarantee" that
ADR-0008 refuses.

### D-3 — No new binding key; two existing lists govern one field (RFC-0010 D-3, D-4; OQ-1, OQ-7)

`origins` is reused. Image contexts (`img src`, `img srcset`, `picture > source srcset`) are checked against
`origins.images`; navigation contexts (`a href`) against `origins.pages`. **No `links` alias.** At least one of
the two lists must be declared; a list not declared is an empty allow-set for its contexts. Because one field is
governed by two lists, "is this type origin-bound" becomes one question with one answer in shared code, so no
call site can leave `html` unchecked.

### D-4 — Enforced once, in the shared mapper (RFC-0010 D-5)

The check runs in `applyResponseMapping`, at the scalar leaf, so MCP, the embedded `execute()`, `verify` and
contract recording behave identically from one implementation. The leaf emits the provider's original string,
never a derived one. A pass-through tool cannot carry `html` (compile error, plus the existing runtime floor).

### D-5 — Parse, never pattern-match; allowlist, never denylist (RFC-0010 D-6, D-7; OQ-2, OQ-3, OQ-5, OQ-11)

- One pinned, spec-tracking, pure-JavaScript HTML parser (parse5-class) in `emitter-support`, run in fragment
  mode with a fixed `div` context. The tree is read, never written back. It is the only new dependency and is
  validated by a differential corpus against a real browser before release.
- **Any parse error withholds.** A parse error is where parsers diverge.
- An **allowlist** of elements and attributes (RFC-0010 §6.3), kept in a versioned normative annex: widened only
  by a recorded decision, narrowed only for a security defect announced as one. v1 admits **no** `style`,
  `<style>`, `class`, `id`, `target`, `rel`, comments, scripts, forms, frames, SVG or MathML.
- URL attributes are checked after character-reference decoding, by the WHATWG URL parser with no base:
  `https` only, no userinfo, exact origin. **Relative, protocol-relative and fragment-only URLs withhold** in v1.
  Every `srcset` candidate is checked. Nothing is ever fetched.

### D-6 — Bounded: 64 KiB per value, 256 KiB per response, as constants (RFC-0010 D-8; OQ-4)

Over-cap values are withheld (`size`). Constants, not a per-binding knob: a knob would be a way to relax a
guarantee.

### D-7 — Withheld means omitted; the reason is a closed category (RFC-0010 D-9, D-10, D-11, D-12; OQ-6, OQ-8)

- Existing semantics, unchanged: the field is omitted; optional → `degraded`, required → `violation`; the path is
  in `withheld`; values never.
- The model and the embedder get the path and one of five categories (`origin`, `construct`, `markup`, `size`,
  `value`), never an element name, URL or origin. The author's tools (`verify`, lint) get the element, attribute
  and offending origin. Records keep path and category only. `verify` is red on any withheld `html` value. A
  passing value carries no note, because the check is about where the HTML points and what it can execute, not
  what it says.
- MCP carriage is an ordinary string field in `structuredContent` and the text block; `contentMediaType:
  text/html` is added only if a live strict-client test accepts it. An embedded `text/html` resource is rejected;
  MCP Apps rendering is deferred to RFC-0009 Part 2. The embedded SDK returns the identical string, with no
  rendering guarantee.

### D-8 — Ratified as a design; built only when a real provider needs it (RFC-0010 D-13; OQ-10, OQ-12)

The project's rule for new semantic types asks for two domains of real demand before one is built. Today the only demand is the synthetic Showcase. So the design is
ratified now and **nothing is built** (no CDL enum member, no parser dependency, no mapper change) until a real
provider's API returns HTML that an author needs to declare (RFC-0010 H-1). Then core#166 becomes an increment
with an ADD, against this ADR. The public editions of RFC-0010 and of this ADR are published on ratification, so
the public issue links to reasoning rather than to a promise.

## What the declaration does not promise

The check is about **where the HTML points and what it can execute**, not **what it says**. It does not promise
the text is true, safe, or free of instructions aimed at a model; that a declared origin does not log or redirect;
that a client renders the HTML, or renders it as intended; or that a renderer whose parser differs reads it
identically (mitigated by parse-error withholding and a small allowlist, not eliminated). ADR-0008 never promised
more for a declared field, and the public docs will say so.

## Alternatives considered

| Option | Why not |
|---|---|
| Sanitiser (strip bad tags and URLs) | Output is not what the provider sent (D-1); re-serialisation is the classic mXSS source |
| Convert to Markdown or plain text | A converted value is a rewritten value; `text` already exists for authors who want it |
| Trusted-provider flag | The guarantee becomes a default (ADR-0008) |
| Rewrite URLs through a proxy | Alters the document; makes Archstone a content-serving party |
| Withhold only the offending element | That is sanitising |
| Check, then emit a re-serialised tree | Changes the bytes |
| Denylist | Fails open on every new element |
| Regular expressions | Not how a browser reads HTML; the differential is the whole risk |
| Rely on the renderer's CSP | Covers neither a renderer without one nor the model's view; complements, does not replace |
| Allow `style` with a CSS parser | A second parser and a second differential surface; a separate decision after real-provider evidence |
| Embedded `text/html` resource over MCP | Triples the bytes and invents a URI for a rendering no host has been shown to do |

## Consequences

**Accepted:**

- Authors whose provider returns clean, structural HTML on declared origins get it verbatim, with its images and
  links, and a guarantee about where it points.
- Strict v1 allowlist: much real WYSIWYG output (inline `style`, `class`, relative URLs) will be withheld at first.
  The author sees why in `verify`; widening is per construct, on evidence.
- The first HTML parser dependency in core, pinned and differential-tested.
- One field governed by two origin lists: shared code must stop assuming one type, one list.

**Rejected, on the record:** sanitising in any form, a trusted-provider path, a feature flag, `list: html` in v1,
a `links` alias, relative URLs in v1, an embedded `text/html` resource.

**Risks:** a parser differential with some renderer (H-4 corpus); the allowlist withholding most of a real
provider's values (H-2: if under 90%, decide between widening the annex and asking for structural HTML, before
building).

**Follow-ups (not part of this ADR):** when a real provider pulls it, an ADD for core#166 and the Showcase S-22
unlock (a separate S-22 capability declares `description_html`; S-02 keeps it undeclared); RFC-0005 catalogue
entry; RFC-0009 Part 2 for rendering.
