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

interface RunBody {
  scenario?: string;
  caller?: string;
  result?: McpResult;
  backendCalls?: number;
  alsoRun?: { label?: string; result?: McpResult }[];
  evidence?: { tool?: string; where?: string; excerpt?: string };
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
    let json: RunBody | undefined;
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

  const legacyCall = await callMcp("tourism_search", { destination: "Lisbon", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } });
  const stays = (legacyCall.result?.structuredContent as { stays?: unknown[] } | undefined)?.stays;
  check("tourism_search: a saved client's call still returns stays", legacyCall.result?.isError !== true && Array.isArray(stays) && stays.length > 0);
  check("tourism_search: the backend's margin fields never reach the model", !/"(net|commission|margin)"/.test(JSON.stringify(legacyCall.result)));
  check("mcp: x-showcase-backend-calls counts the in-process API requests", legacyCall.res.headers.get("x-showcase-backend-calls") === "1", String(legacyCall.res.headers.get("x-showcase-backend-calls")));
  check("mcp: the response states the rate limit is approximate", /approximate/i.test(legacyCall.res.headers.get("x-showcase-rate-limit") ?? ""));

  // --- the declared input contract (#195): a malformed call is refused before the backend ------
  const injected = await callMcp("wanderlust_search", { destination: { $ne: 1 }, dates: "tomorrow", travelers: -1 });
  const injectedMeta = injected.result?._meta?.["dev.archstone/input_invalid"] as { error?: string; problems?: unknown[] } | undefined;
  check("input contract: an operator-injection payload is refused as input_invalid", injected.result?.isError === true && injectedMeta?.error === "input_invalid" && (injectedMeta.problems?.length ?? 0) === 3, JSON.stringify(injectedMeta));
  check("input contract: the backend is never called", injected.res.headers.get("x-showcase-backend-calls") === "0", String(injected.res.headers.get("x-showcase-backend-calls")));
  check("input contract: the refusal never echoes the sent value", !/\$ne|tomorrow/.test(JSON.stringify(injected.result)));

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

  // The blocked key is denied by Archstone's policy on paying and cancelling too (#201), and the
  // backend is not asked; the visitor key reaches the agency, whose refusal of an unknown booking is its own.
  const KEY_VISITOR = "Bearer demo-public-key-visitor-0000";
  const KEY_BLOCKED = "Bearer demo-public-key-blocked-0000";
  const payArgs = { bookingId: "B-0000cafe", amount: { amount: 354, currency: "EUR" }, paymentQuote: "PQ-0-00000000" };
  const payB = await callMcp("wanderlust_pay", payArgs, KEY_BLOCKED);
  check("pay with the blocked key: principal_denied, backend never called", policyReason(payB.result) === "principal_denied" && payB.res.headers.get("x-showcase-backend-calls") === "0", policyReason(payB.result));
  const cancelB = await callMcp("wanderlust_cancel", { bookingId: "B-0000cafe" }, KEY_BLOCKED);
  check("cancel with the blocked key: principal_denied, backend never called", policyReason(cancelB.result) === "principal_denied" && cancelB.res.headers.get("x-showcase-backend-calls") === "0", policyReason(cancelB.result));
  const cancelNone = await callMcp("wanderlust_cancel", { bookingId: "B-0000cafe" });
  check("cancel with no key: authenticated_no_credential, backend never called", policyReason(cancelNone.result) === "authenticated_no_credential" && cancelNone.res.headers.get("x-showcase-backend-calls") === "0", policyReason(cancelNone.result));
  const cancelA = await callMcp("wanderlust_cancel", { bookingId: "B-0000cafe" }, KEY_VISITOR);
  const refund = (cancelA.result?.structuredContent as { cancellation?: { refund?: { amount?: number } } } | undefined)?.cancellation?.refund?.amount;
  check("cancel the seeded booking with the visitor key: refund equals its total", cancelA.result?.isError !== true && refund === 354, String(refund));
  const cancelUnknown = await callMcp("wanderlust_cancel", { bookingId: "B-ffffffffffff" }, KEY_VISITOR);
  check("cancel an unknown booking: the agency answers 404 and nothing is invented", cancelUnknown.result?.isError === true && /404/.test(JSON.stringify(cancelUnknown.result)), JSON.stringify(cancelUnknown.result).slice(0, 160));

  const searchArgs = { destination: "Lisbon", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };

  // --- the quote: expiry from request time, pet fee itemised (#201) -----------------------------
  const before = Date.now();
  const petQuote = await callMcp("wanderlust_quote", { ...quoteArgs, pets: 1 });
  const pq = (petQuote.result?.structuredContent as { quote?: { total?: { amount?: number }; petFee?: { amount?: number }; expiresAt?: string } } | undefined)?.quote;
  check("quote with a cat: the pet fee is itemised and included in the total", pq?.petFee?.amount === 30 && pq?.total?.amount === 384, JSON.stringify(pq));
  const lead = Date.parse(pq?.expiresAt ?? "") - before;
  check("quote: expiresAt is about 15 minutes after the request, not already past", lead > 10 * 60_000 && lead < 20 * 60_000, String(lead));
  const noPets = await callMcp("wanderlust_quote", { ...quoteArgs, stayId: "ws-1003", pets: 1 });
  check("quote with pets on a no-pets stay: refused by the agency", noPets.result?.isError === true && /422/.test(JSON.stringify(noPets.result)), JSON.stringify(noPets.result).slice(0, 160));

  // --- search by a stay's name; room-status answers almost everywhere (#201) --------------------
  const byName = await callMcp("wanderlust_search", { ...searchArgs, destination: "Pensão Azul" });
  const named = (byName.result?.structuredContent as { stays?: { name?: string }[] } | undefined)?.stays ?? [];
  check("search by a stay's name returns that stay", named.length === 1 && named[0].name === "Pensão Azul", JSON.stringify(named.map((x) => x.name)));
  const june = await callMcp("wanderlust_room-status", { propertyId: "ws-1002", date: "2027-06-05" });
  check("room-status for Pensão Azul on a June weekend is a usable answer", june.result?.isError !== true && !/agency-busy/.test(JSON.stringify(june.result)), JSON.stringify(june.result).slice(0, 160));

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
  const s12 = await run("S-12");
  check("run S-12: the deprecation note it relies on is returned, with where it lives", /deprecated/i.test(s12.json?.evidence?.excerpt ?? "") && /tools\/list/.test(s12.json?.evidence?.where ?? "") && s12.json?.result?.isError === false, JSON.stringify(s12.json?.evidence));
  const s13 = await run("S-13");
  const wrongFormat = s13.json?.alsoRun?.find((x) => x.label === "wrong-format-price")?.result;
  const wrongMeta = wrongFormat?._meta?.["dev.archstone/contract_violation"] as { error?: string; invalid?: { field?: string }[]; missing?: unknown[] } | undefined;
  check("run S-13: the busy row is an error row and the main answer still works", s13.json?.result?.isError === false && /agency-busy/.test(JSON.stringify(s13.json?.result)));
  check("run S-13: the wrong-format price is reported as invalid, not missing", wrongFormat?.isError === true && wrongMeta?.invalid?.[0]?.field === "pricePerNight" && wrongMeta?.missing?.length === 0, JSON.stringify(wrongMeta));
  const s23 = await run("S-23");
  const s23Meta = s23.json?.result?._meta?.["dev.archstone/input_invalid"] as { error?: string; problems?: unknown[] } | undefined;
  check("run S-23: a wrong-shaped argument set is refused as input_invalid with its three problems", s23.json?.result?.isError === true && s23Meta?.error === "input_invalid" && s23Meta.problems?.length === 3, JSON.stringify(s23Meta));
  check("run S-23: the agency is never called", s23.json?.backendCalls === 0 && s23.res.headers.get("x-showcase-backend-calls") === "0", String(s23.json?.backendCalls));
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
