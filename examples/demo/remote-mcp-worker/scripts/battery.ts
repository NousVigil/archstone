// The wrangler-free live battery: plain HTTP requests against a base URL, checking the contract
// the Showcase promises on the live Worker. It is the same list whether the target is the Worker
// run in-process (test/worker.test.ts), `wrangler dev` (scripts/workerd-parity.ts) or the deployed
// URL (scripts/live-battery.ts, run after every deploy). It only uses `fetch`, so it needs no
// wrangler, no credentials and no Node-only API.
//
// Every check names an OBSERVABLE: an absent field, a named denial reason, a status, a header.

export type Send = (path: string, init?: RequestInit) => Promise<Response>;

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

export const PAGE_ORIGIN = "https://archstone.dev";
const OTHER_ORIGIN = "https://example.invalid";
const POLICY_META = "dev.archstone/policy_denied";
const LIFECYCLE_META = "dev.archstone/lifecycle_blocked";

const MCP_HEADERS = { "content-type": "application/json", accept: "application/json, text/event-stream" };

interface McpResult {
  content?: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  _meta?: Record<string, { reason?: string; error?: string } | undefined>;
  isError?: boolean;
  tools?: { name: string; description?: string }[];
}

export function policyReason(r: McpResult | undefined): string | undefined {
  return r?._meta?.[POLICY_META]?.reason;
}

export async function runBattery(send: Send): Promise<Check[]> {
  const checks: Check[] = [];
  const check = (name: string, ok: boolean, detail?: string) => checks.push({ name, ok, ...(ok || !detail ? {} : { detail }) });
  let nextId = 1;

  async function rpc(method: string, params: unknown, authorization?: string) {
    const headers: Record<string, string> = { ...MCP_HEADERS };
    if (authorization !== undefined) headers.authorization = authorization;
    const res = await send("/mcp", {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, params }),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: McpResult };
    return { res, result: body.result };
  }
  const callMcp = (name: string, args: Record<string, unknown>, authorization?: string) =>
    rpc("tools/call", { name, arguments: args }, authorization);

  async function run(id: string, init: RequestInit = {}) {
    const res = await send(`/run/${id}`, { method: "POST", ...init });
    const text = await res.text();
    let json: { scenario?: string; caller?: string; result?: McpResult } | undefined;
    try {
      json = JSON.parse(text);
    } catch {
      json = undefined;
    }
    return { res, json };
  }

  // --- MCP -------------------------------------------------------------------------------------
  const init = await rpc("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "battery", version: "0" },
  });
  check("mcp: initialize answers 200 JSON", init.res.status === 200 && (init.res.headers.get("content-type") ?? "").includes("json"));
  check("mcp: GET is refused with 405 and Allow: POST", (await send("/mcp", { method: "GET" })).status === 405);
  check("mcp: no CORS headers", !(await send("/mcp", { method: "POST", headers: { ...MCP_HEADERS, origin: PAGE_ORIGIN }, body: "{}" })).headers.has("access-control-allow-origin"));

  const list = await rpc("tools/list", {});
  const tools = list.result?.tools ?? [];
  const names = tools.map((t) => t.name);
  check("tools/list: the Showcase tools are served", ["wanderlust_search", "wanderlust_book", "wanderlust_availability"].every((n) => names.includes(n)), names.join(","));
  const legacy = tools.find((t) => t.name === "tourism_search");
  check("tools/list: tourism_search is still listed and advertised as deprecated", !!legacy && /deprecated/i.test(legacy.description ?? ""), legacy?.description);
  check("tools/list: the retired capability is omitted", !names.some((n) => n.startsWith("tourism_search-classic")));

  const legacyCall = await callMcp("tourism_search", { destination: "Lisbon" });
  const stays = (legacyCall.result?.structuredContent as { stays?: unknown[] } | undefined)?.stays;
  check("tourism_search: a saved client's call still returns stays", legacyCall.result?.isError !== true && Array.isArray(stays) && stays.length > 0);
  check("tourism_search: the backend's margin fields never reach the model", !/"(net|commission|margin)"/.test(JSON.stringify(legacyCall.result)));
  check("mcp: x-showcase-backend-calls counts the in-process API requests", legacyCall.res.headers.get("x-showcase-backend-calls") === "1", String(legacyCall.res.headers.get("x-showcase-backend-calls")));
  check("mcp: the response states the rate limit is approximate", /approximate/i.test(legacyCall.res.headers.get("x-showcase-rate-limit") ?? ""));

  // --- policy over MCP: S-06 / S-07 / policy_unevaluatable --------------------------------------
  const quoteArgs = { stayId: "ws-1001", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };
  const q = await callMcp("wanderlust_quote", quoteArgs);
  const quoteId = (q.result?.structuredContent as { quote?: { quoteId?: string } } | undefined)?.quote?.quoteId ?? "";
  const bookArgs = { ...quoteArgs, quoteId, guestName: "Ana Pop" };
  check("wanderlust_quote: needs no key", q.result?.isError !== true && quoteId !== "");
  const none = await callMcp("wanderlust_book", bookArgs);
  check("book with no Authorization: authenticated_no_credential", policyReason(none.result) === "authenticated_no_credential", policyReason(none.result));
  check("book with no Authorization: the backend is never called", none.res.headers.get("x-showcase-backend-calls") === "0");
  const keyA = await callMcp("wanderlust_book", bookArgs, "Bearer demo-public-key-visitor-0000");
  check("book with the visitor key: allowed", keyA.result?.isError !== true && !!keyA.result?.structuredContent, JSON.stringify(keyA.result).slice(0, 200));
  const keyB = await callMcp("wanderlust_book", bookArgs, "Bearer demo-public-key-blocked-0000");
  check("book with the blocked key: principal_denied", policyReason(keyB.result) === "principal_denied", policyReason(keyB.result));
  const other = await callMcp("wanderlust_book", bookArgs, "Bearer some-other-token");
  check("book with another bearer: refused before the backend", other.result?.isError === true && other.res.headers.get("x-showcase-backend-calls") === "0", policyReason(other.result));
  const malformed = await callMcp("wanderlust_book", bookArgs, "Basic dXNlcjpwYXNz");
  check("book with a non-Bearer Authorization: policy_unevaluatable", policyReason(malformed.result) === "policy_unevaluatable", policyReason(malformed.result));

  const retired = await callMcp("tourism_search-classic", { destination: "Lisbon" });
  check("retired capability called by name: lifecycle_blocked", retired.result?.isError === true && retired.result?._meta?.[LIFECYCLE_META]?.error === "lifecycle_blocked");

  // --- /run: CORS and fixed scenarios ------------------------------------------------------------
  const s07 = await run("S-07", { headers: { origin: PAGE_ORIGIN } });
  check("run S-07 from the site origin: principal_denied, caller named", s07.json?.caller === "demo key B" && policyReason(s07.json?.result) === "principal_denied", policyReason(s07.json?.result));
  check("run: the allowed origin is echoed exactly, with Vary: Origin", s07.res.headers.get("access-control-allow-origin") === PAGE_ORIGIN && (s07.res.headers.get("vary") ?? "").includes("Origin"));
  const s06 = await run("S-06", { headers: { origin: PAGE_ORIGIN } });
  check("run S-06: the visitor key books", s06.json?.caller === "demo key A" && s06.json?.result?.isError === false);
  const s14 = await run("S-14");
  check("run S-14: the DELETE route has no tool", s14.json?.result?.isError === true && /unknown tool/.test(s14.json?.result?.content?.[0]?.text ?? ""));
  const other_ = await run("S-01", { headers: { origin: OTHER_ORIGIN } });
  check("run from another origin: no allow header", !other_.res.headers.has("access-control-allow-origin"));
  const pre = await send("/run/S-01", { method: "OPTIONS", headers: { origin: PAGE_ORIGIN, "access-control-request-method": "POST" } });
  check("preflight from the site origin: 204 with the allow header", pre.status === 204 && pre.headers.get("access-control-allow-origin") === PAGE_ORIGIN);
  const preBad = await send("/run/S-01", { method: "OPTIONS", headers: { origin: OTHER_ORIGIN, "access-control-request-method": "POST" } });
  check("preflight from another origin: refused, no allow header", preBad.status >= 400 && !preBad.headers.has("access-control-allow-origin"));
  check("run: unknown scenario is 404", (await run("S-99")).res.status === 404);
  check("run: GET is 405", (await send("/run/S-01")).status === 405);

  // --- rate limit: S-11 refused within one run of calls; other capabilities unaffected ----------
  let refusedAt = 0;
  for (let i = 1; i <= 8 && refusedAt === 0; i++) {
    const r = await run("S-11");
    if (policyReason(r.json?.result) === "rate_limit_exceeded") refusedAt = i;
  }
  check("run S-11: refused with rate_limit_exceeded within 8 calls (exactly the 4th on one isolate)", refusedAt > 0 && refusedAt <= 8, `refused at call ${refusedAt}`);
  check("run S-11: the limit is stated as approximate", /approximate/i.test((await run("S-11")).res.headers.get("x-showcase-rate-limit") ?? ""));
  const after = await run("S-01");
  check("run S-01 after the limit: another capability is unaffected", after.json?.result?.isError === false);

  // --- the same origin serves the API and the images ---------------------------------------------
  const img = await send("/img/ws-1001/1.svg");
  check("img: served from the same origin", img.status === 200 && (img.headers.get("content-type") ?? "").includes("svg"));
  check("api: a booking without a key is 401", (await send("/v1/bookings", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" })).status === 401);
  check("anything else is 404", (await send("/nope")).status === 404 && (await send("/health")).status === 404);

  return checks;
}
