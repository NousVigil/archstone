// @archstone/provider-rest — REST adapter (#6)
//
// The first adapter under providers/. Maps a capability's input → an HTTP request
// (from its IR connector) and the HTTP response → a result. REST only. baseUrl,
// headers and auth resolve from env via ${VAR} placeholders, and (ADD-32) from a
// per-invocation caller credential via ${caller.NAME} placeholders. HTTP lives HERE
// and nowhere else — the compiler/IR/emitter never touch it.

import type { IRTool } from "@archstone/compiler";
// #44: TYPE-ONLY. `invokeRest` never reads the audit sink — see `InvokeOptions.auditSink`
// below. The type is owned by the layer that acts on it (beside the policy evaluator and the
// record builder), and this package merely carries the field so a deployer keeps ONE options
// bag. Same shape of dependency as @archstone/agent type-importing `CallerContext` from here.
// ADR-0012 D-3: `CallerContext` and the connector-agnostic half of `InvokeOptions` moved to
// `@archstone/emitter-support` — the shared substrate every connector (`rest`, `sql`, and
// whatever comes next) extends. Re-exported here as a TYPE ALIAS, non-breaking: every existing
// `import type { CallerContext } from "@archstone/provider-rest"` call site keeps working
// unchanged (internal ADD-32 D-2 explicitly deferred this move to "the first non-REST
// connector" — this is that connector).
import type { CallerContext, FetchLike, InvokeOptions as BaseInvokeOptions } from "@archstone/emitter-support";

export type { CallerContext, FetchLike } from "@archstone/emitter-support";

export interface InvokeResult {
  ok: boolean;
  status: number;
  data?: unknown;
  /** Reaches the model. Never carries a transport's own message: a fetch failure is
   *  `request failed (<code>)`, with the detail on stderr for the operator. */
  error?: string;
}

export interface InvokeOptions extends BaseInvokeOptions {
  /**
   * Security-hardening follow-up to ADD-32: a **deployer-level policy**, static for the whole
   * process/deployment — set once at construction time, like `bearerToken` elsewhere in this
   * codebase (`runtime/src/http.ts`'s `CreateHttpHandlerOptions.bearerToken`), NOT per-request/
   * per-invocation like `caller` above. Only relevant when a binding's `rest.baseUrl` contains a
   * `${caller.NAME}` placeholder (per-tenant routing) — see the guard in `invokeRest` for why
   * that specific case, unlike headers/query/body, needs an allowlist at all.
   *
   * Each entry is either an exact hostname (`"api.example.com"`) or a `"*."`-prefixed wildcard
   * matching any subdomain (`"*.core.example.com"` matches `tenant-a.core.example.com` but NOT
   * `core.example.com` itself — list that separately if it must also be allowed).
   *
   * Undefined/empty is the secure default: a baseUrl whose *original template* referenced
   * `${caller.…}` fails closed unless the resolved host explicitly matches an entry here.
   */
  allowedHosts?: string[];
  /**
   * Issue #39 / ADD-31: a fire-and-forget observation hook for the RAW, unmapped backend
   * response of a completed HTTP round-trip (any status, 2xx or non-2xx). It exists so a
   * developer whose bound capability's own backend happens to bill per call/token (most
   * concretely, a capability whose connector calls a paid LLM completions API) can inspect
   * whatever usage/cost/audit fields that backend's response happens to contain — data a
   * `response:` mapping would otherwise silently discard before either caller (`callTool`,
   * `executeCapability`) ever sees it.
   *
   * Fires exactly once, synchronously, immediately after the response body is parsed —
   * BEFORE any response-mapping/OK-DEGRADED-VIOLATION classification runs in the caller
   * (BR-1/BR-3), including on a contract VIOLATION, where the caller's own D-6 rule withholds
   * this same raw body from the MCP client (BR-5 — a deliberate divergence: this hook runs
   * inside the binding author's own trusted process, not on the MCP boundary).
   *
   * It MUST NOT fire when `invokeRest` returns before any HTTP round-trip completes — no REST
   * connector, missing env/caller placeholder(s), a caller-influenced-baseUrl allowlist
   * rejection, a missing required path parameter, or a `doFetch` exception/timeout (BR-4) —
   * none of those ever produced a response to observe. The same guarantee holds for a policy
   * refusal (#43), which short-circuits in the CALLER before `invokeRest` is entered at all, so
   * this function is never reached and the hook cannot fire.
   *
   * `capabilityId` is `tool.id` — the unsanitized CDL id, never any MCP-sanitized advertised
   * tool name (BR-8). `data` is the exact same value that ends up in `InvokeResult.data`:
   * parsed JSON, the raw text if unparseable, or `undefined` for an empty body.
   *
   * BR-16 / ADD-31 Architectural Challenge: Archstone will NEVER parse or normalize a
   * provider-specific usage/token/cost shape out of this body. Three real LLM APIs already
   * disagree on the field name for the same concept — OpenAI `usage.prompt_tokens`, Anthropic
   * `usage.input_tokens`, Gemini `usageMetadata.promptTokenCount` — and baking any one of them
   * into this hook would tie this repo's release cycle to a third party's API changes on its
   * own timeline. The hook exists specifically so Archstone never has to pick one: the binding
   * author already knows their own backend's shape (they wrote the connector for it) and can
   * extract whatever fields matter themselves from the raw body.
   *
   * Fire-and-forget by design (OQ-1): `invokeRest` never awaits it, and a returned Promise's
   * rejection is swallowed — a slow or hanging hook can never add latency to, or affect the
   * result of, the business call it merely observes (BR-6/BR-7). A throwing or rejecting hook
   * is logged as a single line to stderr (this codebase's existing "stdout is the MCP channel,
   * human output goes to stderr" convention — see `serveStdio`) and never rethrown into
   * `InvokeResult`/`ExecuteResult`/the MCP `CallResult`.
   *
   * Deliberately NOT exposed as a CLI flag on any command, ever (BR-13/OQ-3) — a callback
   * function cannot be expressed as a CLI argument. This is a programmatic-API-only surface,
   * reachable only by code that imports `@archstone/provider-rest`/`@archstone/agent`/
   * `@archstone/runtime` directly and constructs its own options object — a deliberate,
   * structural boundary, not an oversight.
   */
  // Return type is `void | Promise<void>` (not just `void`) so a caller may supply an async
  // callback (OQ-1) — invokeRest never awaits either variant; see fireOnResponse below.
  onResponse?: (info: { capabilityId: string; status: number; data: unknown; durationMs: number }) => void | Promise<void>;
  // `auditSink`, `sessionId`, `workflowId`, `callerResolutionFailed`, `rateLimitCounter` moved
  // to the shared base (`@archstone/emitter-support`'s `InvokeOptions`, ADR-0012 D-3) — inherited
  // above, unchanged in meaning and doc comment, now shared verbatim with `providers/sql`.
}

// Issue #39 (OQ-1/OQ-2/BR-6): fire onResponse synchronously but never await it. A thrown
// exception or a rejected returned Promise is caught/swallowed here — logged once to stderr,
// never rethrown — so a misbehaving hook can never delay or break the invocation it observes.
function fireOnResponse(
  onResponse: InvokeOptions["onResponse"],
  info: { capabilityId: string; status: number; data: unknown; durationMs: number },
): void {
  if (!onResponse) return;
  try {
    const maybePromise = onResponse(info);
    if (maybePromise && typeof maybePromise.catch === "function") {
      maybePromise.catch((err: unknown) => {
        console.error(`archstone: onResponse hook rejected for capability '${info.capabilityId}':`, err);
      });
    }
  } catch (err) {
    console.error(`archstone: onResponse hook threw for capability '${info.capabilityId}':`, err);
  }
}

// Lowercased defensively on both sides — hostnames are case-insensitive (RFC 4343), and a
// caller-supplied tenantId used inside ${caller.NAME} could otherwise bypass an allowlist
// entry authored in a different case.
//
// Exported deliberately, not incidentally: a deployer wiring up `allowedHosts` may want to
// validate/lint their own list against expected hostnames before passing it to `InvokeOptions`,
// so this is kept as stable public surface rather than folded into an unexported helper.
export function hostMatchesPattern(host: string, pattern: string): boolean {
  const h = host.toLowerCase();
  const p = pattern.toLowerCase();
  if (h === p) return true;
  if (p.startsWith("*.")) {
    // `p.slice(1)` keeps the leading "." from "*." (so "*.example.com".slice(1) === ".example.com").
    // That leading dot is load-bearing: without it, "evilexample.com".endsWith("example.com")
    // would be a false-positive prefix match. With it, only a real subdomain boundary matches —
    // "tenant-a.example.com".endsWith(".example.com") is true, "evilexample.com" is false.
    return h.endsWith(p.slice(1));
  }
  return false;
}

const ENV_RE = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;
// ${caller.NAME} — a second placeholder namespace, resolved against opts.caller instead of
// env, parallel to ENV_RE/resolveEnv (ADD-32 D-2). Kept as a distinct regex/resolver (not a
// unified one) so a missing caller key is reported as "missing caller credential(s)", never
// conflated with "missing env var(s)" in the same error message.
const CALLER_RE = /\$\{caller\.([A-Za-z_][A-Za-z0-9_]*)\}/g;

// {field} placeholders in path and body templates. Restricted to identifier names
// so a JSON body template's own braces (e.g. {"city":"{city}"}) are not mistaken
// for placeholders — only {city} matches.
const PLACEHOLDER_RE = /\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

// An env var is "missing" only when it is unset (undefined). An empty string is a
// valid value: the placeholder resolves to "" and the call proceeds (BR-8/BR-9).
function resolveEnv(s: string, env: Record<string, string | undefined>, missing: Set<string>): string {
  return s.replace(ENV_RE, (_m, name: string) => {
    const v = env[name];
    if (v === undefined) {
      missing.add(name);
      return "";
    }
    return v;
  });
}

// ${caller.NAME} — resolved against opts.caller, parallel to resolveEnv. A missing key is
// "missing" only when the caller (or the whole caller object) is absent; an explicit ""
// (e.g. accessToken: "") is a valid, present value (ADD-32 §3/R-6 — same rule as resolveEnv).
// The cast below is only safe because every CallerContext field is `string | undefined` —
// an unmatched name still resolves to `undefined` at runtime. If CallerContext ever gains a
// non-string field, this needs a real `name in caller` narrow, not just a cast.
function resolveCaller(s: string, caller: CallerContext | undefined, missing: Set<string>): string {
  return s.replace(CALLER_RE, (_m, name: string) => {
    const v = caller?.[name as keyof CallerContext];
    if (v === undefined) {
      missing.add(name);
      return "";
    }
    return v;
  });
}

// Serialize a value destined for a query string or a body template placeholder.
// Objects/arrays are JSON-encoded; primitives use their String() form.
function serializeValue(v: unknown): string {
  return typeof v === "object" ? JSON.stringify(v) : String(v);
}

// Interpolate {param} placeholders in the path from input, URL-encoding each value.
// Tracks which fields were consumed (so the query can exclude them) and which
// required params were missing/empty (so the call can fail before any request).
function interpolatePath(
  path: string,
  input: Record<string, unknown>,
): { path: string; consumed: Set<string>; missing: string[] } {
  const consumed = new Set<string>();
  const missing: string[] = [];
  const out = path.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = input[key];
    if (v === undefined || v === null || v === "") {
      missing.push(key);
      return "";
    }
    consumed.add(key);
    return encodeURIComponent(String(v));
  });
  return { path: out, consumed, missing };
}

// Build a query string from input fields NOT consumed by a path placeholder. null/undefined
// fields are omitted; keys and values are URL-encoded. `queryMap` (from the connector's
// `rest.query`, #26/#63) renames a CDL input field to its wire query-param name, and its
// widened object form carries `explode` (list-field wire form) and `onQuery`; a field absent
// from the map is appended under its CDL name unchanged.
//
// `listFields` (#63) names every input field whose IRType is `list` — read from `tool.input`,
// never guessed from the runtime value's shape, so a field the manifest declares scalar is
// never reinterpreted as a list just because a caller happened to pass an array.
//
// `onlyFields`, when supplied, restricts the fields serialized here to that set (#63 Goal 2:
// when the operation also carries a body, ONLY the query-designated fields belong on the URL —
// the rest belong in the JSON body, built separately by the caller).
function buildQuery(
  input: Record<string, unknown>,
  consumed: Set<string>,
  queryMap: Record<string, string | { name?: string; explode?: boolean; onQuery?: true }> | undefined,
  listFields: ReadonlySet<string>,
  onlyFields?: ReadonlySet<string>,
): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(input)) {
    if (consumed.has(k) || v === undefined || v === null) continue;
    if (onlyFields && !onlyFields.has(k)) continue;
    const mapped = queryMap?.[k];
    const wireName = (typeof mapped === "object" ? mapped.name : undefined) ?? (typeof mapped === "string" ? mapped : undefined) ?? k;
    if (listFields.has(k)) {
      if (!Array.isArray(v)) continue; // schema validation upstream keeps this from happening
      if (v.length === 0) continue; // a required-but-empty list (founder ruling) omits the param entirely
      // OpenAPI's own default for `style: form` on `query` is `explode: true`.
      const explode = typeof mapped === "object" && mapped.explode !== undefined ? mapped.explode : true;
      if (explode) {
        for (const item of v) params.append(wireName, serializeValue(item));
      } else {
        params.append(wireName, v.map((item) => serializeValue(item)).join(","));
      }
      continue;
    }
    params.append(wireName, serializeValue(v));
  }
  return params.toString();
}

// Honour an authored body template: interpolate {field} placeholders from input.
// Absent/empty fields resolve to "" (defined, does not crash — EC-7).
function interpolateBody(template: string, input: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER_RE, (_m, key: string) => {
    const v = input[key];
    if (v === undefined || v === null) return "";
    return serializeValue(v);
  });
}

function joinUrl(base: string, path: string): string {
  return `${base.replace(/\/+$/, "")}${path.startsWith("/") ? path : `/${path}`}`;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** Read one property of a thrown value without throwing — a getter or a Proxy trap may. */
function readProp(value: unknown, key: string): unknown {
  if (value === null || (typeof value !== "object" && typeof value !== "function")) return undefined;
  try {
    return (value as Record<string, unknown>)[key];
  } catch {
    return undefined;
  }
}

/** The thrown value and up to two levels of `cause` — undici's `fetch failed` puts the socket
 *  error, and its code, on `cause`. Stops at a cycle or a primitive. */
function errorChain(err: unknown): unknown[] {
  const chain: unknown[] = [err];
  let current = err;
  for (let depth = 0; depth < 2; depth++) {
    const cause = readProp(current, "cause");
    if (cause === undefined || cause === null || chain.includes(cause)) break;
    chain.push(cause);
    current = cause;
  }
  return chain;
}

/** Classify a fetch failure's code: the first errno-shaped (`ECONNREFUSED`) or undici-shaped
 *  (`UND_ERR_CONNECT_TIMEOUT`) `code` along the cause chain, else an `AbortError` /
 *  `TimeoutError` name on the thrown value itself. Anything else — absent, non-string, or a
 *  code carrying arbitrary text — is unknown. */
function classifyFetchErrorCode(err: unknown): string | undefined {
  for (const link of errorChain(err)) {
    const code = readProp(link, "code");
    if (typeof code !== "string") continue;
    if (/^E[A-Z0-9_]{1,31}$/.test(code) || /^UND_ERR_[A-Z0-9_]{1,40}$/.test(code)) return code;
  }
  const name = readProp(err, "name");
  if (name === "AbortError" || name === "TimeoutError") return name;
  return undefined;
}

/** The thrown value's message, then each cause's (`fetch failed: getaddrinfo ENOTFOUND
 *  api.internal`) — `fetch failed` alone tells an operator nothing. A thrown string is its own
 *  message; anything else without a string message is `(non-string error)`. */
function fetchErrorMessage(err: unknown): string {
  const [head, ...causes] = errorChain(err);
  const headMessage = typeof head === "string" ? head : readProp(head, "message");
  const parts = [typeof headMessage === "string" ? headMessage : "(non-string error)"];
  for (const cause of causes) {
    const message = typeof cause === "string" ? cause : readProp(cause, "message");
    if (typeof message === "string" && message && message !== parts[parts.length - 1]) parts.push(message);
  }
  return parts.join(": ");
}

/** Every value of the request that can carry a credential, paired with what replaces it: the
 *  full URL, each resolved header value (and the credential after an auth scheme such as
 *  `Bearer`), the URL's userinfo and query-param values (raw and decoded), and the caller's
 *  access token. Short values such as `page=1` are scrubbed too — over-redacting an operator
 *  line is cheap, a leaked key is not. */
function requestSecrets(url: string, headers: Record<string, string>, caller: CallerContext | undefined): Map<string, string> {
  const secrets = new Map<string, string>();
  const redact = (value: string | undefined): void => {
    if (!value) return;
    if (!secrets.has(value)) secrets.set(value, "[redacted]");
    try {
      const decoded = decodeURIComponent(value);
      if (decoded && !secrets.has(decoded)) secrets.set(decoded, "[redacted]");
    } catch {
      // Malformed percent-encoding — the raw form is still scrubbed.
    }
  };
  for (const value of Object.values(headers)) {
    redact(value);
    const scheme = /^\S+\s+(\S+)$/.exec(value);
    if (scheme) redact(scheme[1]);
  }
  try {
    const parsed = new URL(url);
    redact(parsed.username);
    redact(parsed.password);
    for (const pair of parsed.search.slice(1).split("&")) redact(pair.slice(pair.indexOf("=") + 1 || pair.length));
    for (const value of parsed.searchParams.values()) redact(value);
  } catch {
    // Not URL-shaped — `fetch` would have refused it; nothing beyond the whole URL to locate.
  }
  redact(caller?.accessToken);
  // The URL last, so it is named `[url]` rather than `[redacted]` when it is also a secret.
  if (url) secrets.set(url, "[url]");
  return secrets;
}

/** Replace every secret in one pass, longest first, so a short secret never matches inside a
 *  longer one or inside a replacement already made; and keep the message to one line. */
function scrubFetchMessage(message: string, secrets: Map<string, string>): string {
  const keys = [...secrets.keys()].sort((a, b) => b.length - a.length);
  let out = message;
  if (keys.length > 0) {
    const pattern = new RegExp(keys.map((k) => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|"), "g");
    out = out.replace(pattern, (match) => secrets.get(match) ?? "[redacted]");
  }
  return out.replace(/[\r\n]+/g, " ");
}

/**
 * The caller-facing failure for a `doFetch` / `response.text()` throw, and one operator line on
 * stderr — never stdout, which stdio `serve` reserves for MCP.
 *
 * The CALLER (whose `InvokeResult.error` reaches the model) gets `request failed (<code>)` only —
 * a socket code such as ENOTFOUND, an undici code, AbortError/TimeoutError, or `error code
 * unknown` — never the error's message, which can name the backend's host, port and IP. STDERR
 * gets the capability id, the same code, and the message with its cause chain, the request URL,
 * header values, URL credentials, query values and the caller's access token scrubbed out.
 */
function fetchFailure(
  capabilityId: string,
  url: string,
  headers: Record<string, string>,
  caller: CallerContext | undefined,
  err: unknown,
): string {
  const detail = classifyFetchErrorCode(err) ?? "error code unknown";
  // Never throws: a custom `fetchImpl` may throw anything — `String(err)` throws on a
  // null-prototype object, and a getter or Proxy on the thrown value may throw too.
  let line: string;
  try {
    line = scrubFetchMessage(fetchErrorMessage(err), requestSecrets(url, headers, caller));
  } catch {
    line = "(message could not be scrubbed)";
  }
  console.error(`archstone: request failed for capability '${capabilityId}' (${detail}): ${line}`);
  return `request failed (${detail})`;
}

/**
 * Invoke a compiled capability against its REST backend.
 *
 * **This function performs NO AUTHORIZATION.** It is mechanical: connector presence → env/caller
 * placeholder resolution → caller-influenced-`baseUrl` allowlist → required path params → fetch.
 * It reads no `tool.policies`, branches on no `caller.principal`, and contains no allow/deny
 * logic of any kind.
 *
 * That is deliberate and was previously otherwise: the `policies: [authenticated]` gate used to
 * live here and was **moved** — not copied — to the one shared evaluation point in
 * `@archstone/emitter-support` (#43 / ADD-43 D-4, ADD-42 D-8). Two enforcement sites is exactly
 * the "one answer to where a policy is decided" this project set out to establish, and a check
 * inside an HTTP adapter is invisible to every non-REST connector added later. Callers
 * (`callTool`, `executeCapability`, `verifyTool`) evaluate policy BEFORE reaching this function.
 *
 * Consequence, named rather than hidden: a third party calling this exported function directly
 * against an `authenticated` capability with no caller now **proceeds** to the backend where it
 * previously failed closed. If you are re-adding a gate here because it looks missing — it is
 * not missing, it moved. Add your check at your own call site, or call one of the three
 * consumers above.
 */
export async function invokeRest(
  tool: IRTool,
  input: Record<string, unknown>,
  opts: InvokeOptions = {},
): Promise<InvokeResult> {
  const env = opts.env ?? process.env;
  const doFetch: FetchLike = opts.fetchImpl ?? fetch;

  const connector = tool.connector;
  if (!connector || connector.type !== "rest" || !connector.rest) {
    return { ok: false, status: 0, error: `capability '${tool.id}' has no REST connector` };
  }

  // (#43 / ADD-43 D-4) The ADD-32 `policies: [authenticated]` gate that used to sit here has
  // MOVED to `evaluatePolicy` in @archstone/emitter-support — see this function's doc comment.
  // Its predicate (`caller?.accessToken === undefined`, an explicit "" counting as present) and
  // its error text are preserved byte-for-byte there.

  const rest = connector.rest;

  const method = rest.method.toUpperCase();
  const hasBody = method !== "GET" && method !== "HEAD";

  const missingEnv = new Set<string>();
  const missingCaller = new Set<string>();
  const baseUrl = resolveCaller(resolveEnv(rest.baseUrl ?? "", env, missingEnv), opts.caller, missingCaller);
  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(rest.headers ?? {})) {
    headers[k] = resolveCaller(resolveEnv(v, env, missingEnv), opts.caller, missingCaller);
  }
  // NF-1: resolve the body template's env/caller only when a body will actually be sent.
  // GET/HEAD never send their (unused) body template, so an unset ${VAR}/${caller.NAME}
  // inside it must not block the call (BR-2 / EC-8: body is ignored on GET/HEAD).
  const bodyTemplate =
    hasBody && rest.body !== undefined
      ? resolveCaller(resolveEnv(rest.body, env, missingEnv), opts.caller, missingCaller)
      : undefined;

  if (missingEnv.size > 0) {
    return { ok: false, status: 0, error: `missing env var(s): ${[...missingEnv].join(", ")}` };
  }
  if (missingCaller.size > 0) {
    return { ok: false, status: 0, error: `missing caller credential(s): ${[...missingCaller].join(", ")}` };
  }
  if (!baseUrl) {
    return { ok: false, status: 0, error: `capability '${tool.id}': no baseUrl (set it in the binding or via env)` };
  }

  // Security hardening (follow-up to ADD-32, no shipped binding uses this yet — proactive, not
  // a fix for a live incident). `resolveCaller` substitutes caller-supplied values uniformly
  // across baseUrl/headers/query/body — the SAME mechanism as ${VAR}/env. That uniformity is
  // fine for headers/query/body: a caller-controlled value there can only change the CONTENT of
  // an outbound request, never where it goes. `baseUrl` is different — a caller-controlled value
  // there can redirect the ENTIRE request, including any attached credentials/headers, to an
  // arbitrary host of the caller's choosing. So: only when the ORIGINAL, pre-substitution
  // template (not the resolved `baseUrl`) contains `${caller.` do we require the resolved host to
  // match a deployer-configured allowlist — every other binding (the overwhelming majority) is
  // completely unaffected by this check.
  if ((rest.baseUrl ?? "").includes("${caller.")) {
    let resolvedHost: string;
    try {
      resolvedHost = new URL(baseUrl).hostname; // .hostname, not .host — excludes any port
    } catch {
      return {
        ok: false,
        status: 0,
        error: `capability '${tool.id}': baseUrl is not a valid URL after caller-placeholder substitution`,
      };
    }
    const allowedHosts = opts.allowedHosts ?? [];
    const allowed = allowedHosts.some((pattern) => hostMatchesPattern(resolvedHost, pattern));
    if (!allowed) {
      // Fails closed by default — an absent/empty allowedHosts is NOT "allow everything".
      return {
        ok: false,
        status: 0,
        error: `capability '${tool.id}': baseUrl resolves to host '${resolvedHost}', which is not in the caller-influenced-baseUrl allowlist — a binding whose baseUrl contains \${caller.*} requires InvokeOptions.allowedHosts to be configured, or every call fails closed`,
      };
    }
  }

  const { path: interpolatedPath, consumed, missing: missingParams } = interpolatePath(rest.path, input);
  if (missingParams.length > 0) {
    return {
      ok: false,
      status: 0,
      error: `capability '${tool.id}': missing required path parameter(s): ${missingParams.join(", ")}`,
    };
  }

  // #63: which input fields are LIST-typed (read from the IR, never guessed from the runtime
  // value), and which query-mapped fields are marked `onQuery` — belonging on the URL even
  // though this operation also carries a body (Goal 2).
  const listFields = new Set(tool.input.filter((f) => f.type.kind === "list").map((f) => f.name));
  const onQueryFields = new Set(
    Object.entries(rest.query ?? {})
      .filter((entry): entry is [string, { onQuery: true }] => typeof entry[1] === "object" && entry[1].onQuery === true)
      .map(([k]) => k),
  );

  let url = joinUrl(baseUrl, interpolatedPath);
  if (!hasBody) {
    const qs = buildQuery(input, consumed, rest.query, listFields);
    if (qs) url += `?${qs}`;
  } else if (onQueryFields.size > 0) {
    const qs = buildQuery(input, consumed, rest.query, listFields, onQueryFields);
    if (qs) url += `?${qs}`;
  }

  if (hasBody && headers["content-type"] === undefined && headers["Content-Type"] === undefined) {
    headers["content-type"] = "application/json";
  }

  // The JSON body excludes every `onQuery`-marked field (#63 Goal 2): it already went on the
  // URL above, and sending it twice would be a body that disagrees with the request it rode in
  // on. Every existing binding has an empty `onQueryFields`, so `bodyInput` is `input` unchanged.
  const bodyInput = onQueryFields.size > 0 ? Object.fromEntries(Object.entries(input).filter(([k]) => !onQueryFields.has(k))) : input;

  const body = hasBody
    ? bodyTemplate !== undefined
      ? interpolateBody(bodyTemplate, bodyInput)
      : JSON.stringify(bodyInput)
    : undefined;

  try {
    // BR-9: durationMs strictly bounds doFetch + the response-body read only — nothing
    // before it (env/caller resolution, path interpolation, the allowlist check above).
    const start = Date.now();
    const response = await doFetch(url, { method, headers, body });
    const text = await response.text();
    const durationMs = Date.now() - start;
    const data = text ? safeJson(text) : undefined;
    // BR-1/BR-3/BR-5: fires exactly once here — covering BOTH the ok and non-ok branches —
    // strictly before this function returns (and therefore before any response-mapping/
    // classification logic runs in the caller). Never reached from the catch branch below:
    // no response body exists there to observe (BR-4).
    fireOnResponse(opts.onResponse, { capabilityId: tool.id, status: response.status, data, durationMs });
    return {
      ok: response.ok,
      status: response.status,
      data,
      error: response.ok ? undefined : `backend returned ${response.status}`,
    };
  } catch (err) {
    // A fetch or body-read failure: the code only to the caller, the message to stderr — the
    // same rule `providers/sql`'s `driverFailure` follows. onResponse never fires here (BR-4).
    return { ok: false, status: 0, error: fetchFailure(tool.id, url, headers, opts.caller, err) };
  }
}
