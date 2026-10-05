// @archstone/emitter-support — origin checks for origin-bound output types (`web-page`).
//
// A `web-page` value is a link a person will be shown, and a provider's data (or text a listing's
// owner typed into it) decides what that link says. The binding declares the origins such a page
// may live on (`origins.pages`); this file decides whether one value is on one of them.
//
// WHATWG URL parsing (the global `URL`) lives here, in emitter-support, not in the compiler or the
// IR: the IR carries the origin list as plain strings, and the compiler checks only their syntax.
// Pure — no network, no fs; nothing is fetched to see whether a page exists.
//
// The rule, deliberately strict, and the same for every caller (MCP, embedded `execute()`,
// `verify`, contract recording), because they all reach it through `applyResponseMapping`:
//
//   - the value is a string that parses as an ABSOLUTE URL — a relative reference (`/stays/1`) or
//     a protocol-relative one (`//host/x`) has no base to resolve against and is withheld;
//   - its scheme is `https` — `http:`, `javascript:`, `data:` and every other scheme are withheld;
//   - it carries no userinfo (`https://expected.example@elsewhere.example/` is withheld);
//   - its origin (scheme, host, port after normalisation: lower-cased host, punycode, default port
//     elided) equals a declared origin EXACTLY — no suffix match, no wildcard. A trailing-dot host
//     (`example.com.`) is a different origin to the parser and so is withheld.
//
// A passing value leaves as its normalised `href`, never as the provider's raw string: that is
// what makes `format: uri` in the MCP `outputSchema` safe to advertise (a raw string with a space
// in its path would fail a strict client's `uri` check).

import type { IROrigins } from "@archstone/compiler";

/** The normalised origin of a declared entry, or `undefined` when the entry is not a bare https
 *  origin. An entry that fails here simply matches nothing — fail closed — though the compiler's
 *  `origins-malformed` rule refuses such an entry before it can reach an IR. */
export function normaliseOrigin(entry: string): string | undefined {
  let url: URL;
  try {
    url = new URL(entry);
  } catch {
    return undefined;
  }
  if (url.protocol !== "https:" || url.username !== "" || url.password !== "") return undefined;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return undefined;
  if (url.origin === "null") return undefined;
  return url.origin;
}

/** Normalise one declared origin list once, ahead of checking many values against it. */
export function allowedOrigins(origins: IROrigins | undefined, list: keyof IROrigins): ReadonlySet<string> {
  const out = new Set<string>();
  for (const entry of origins?.[list] ?? []) {
    const origin = normaliseOrigin(entry);
    if (origin) out.add(origin);
  }
  return out;
}

export type OriginCheck = { ok: true; href: string } | { ok: false };

/**
 * Check one provider value against a normalised origin set. Returns the normalised href to emit,
 * or `{ok: false}` — never a reason that quotes the value: the value is provider-controlled text,
 * and echoing it into an error is a way to put it in front of a model anyway.
 */
export function checkOrigin(value: unknown, allowed: ReadonlySet<string>): OriginCheck {
  if (typeof value !== "string" || value === "") return { ok: false };
  let url: URL;
  try {
    url = new URL(value); // no base: a relative or protocol-relative reference throws
  } catch {
    return { ok: false };
  }
  if (url.protocol !== "https:") return { ok: false };
  if (url.username !== "" || url.password !== "") return { ok: false };
  if (!allowed.has(url.origin)) return { ok: false };
  return { ok: true, href: url.href };
}
