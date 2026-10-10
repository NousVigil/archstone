// The synthetic Wanderlust Agency API, called directly.
//
// Two jobs. First, the handler is one plain web-standard fetch handler: deterministic, stateless,
// runnable from Node and from a Workers runtime alike (AC-1.1, AC-1.9). Second, it OVER-EXPOSES
// ON PURPOSE (AC-1.2), and this file pins every over-exposure so a refactor cannot quietly make
// the backend "clean" and turn every later absence check into a vacuous pass.

import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { connect, type AddressInfo } from "node:net";
import { parse as parseYaml } from "yaml";
import {
  BOOKING_ID_RE,
  CATALOGUE,
  IMAGE_BASE,
  PAGES_BASE,
  QUOTE_WINDOW_MS,
  UNDECLARED_IMAGE_HOST,
  UNDECLARED_MARKUP_HOST,
  UNDECLARED_PAGE_HOST,
  BUSY_ON,
  SEEDED_BOOKING_ID,
  WRONG_PRICE_ON,
  handle,
  resolvePlace,
  normalizePreferences,
  resolveDestination,
} from "../api/wanderlust-api.mjs";
import { createApiServer } from "../api/serve.mjs";
import { ACCEPTED_KEYS, DEMO_KEY_A, DEMO_KEY_B } from "../credentials.mjs";
import { CLOCK_MS, SHOWCASE_DIR } from "./harness";

const ORIGIN = "http://api.showcase.example";
const auth = (key: string) => ({ authorization: `Bearer ${key}` });
const DATES = { from: "2027-05-12", to: "2027-05-15" };
const PARTY = { adults: 2 };

// The API answers many shapes and these tests probe their fields directly; a typed model of every
// response would only restate the handler. Contained here, to the one response-body type.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Body = any;

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; headers?: Record<string, string>; now?: number } = {},
): Promise<{ status: number; body: Body; text: string; res: Response }> {
  const res = await handle(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", ...opts.headers },
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    }),
    { now: opts.now ?? CLOCK_MS },
  );
  const text = await res.text();
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  return { status: res.status, body, text, res };
}

/** Every [key path, value] pair in a JSON value, with array indexes shown as []. */
function walk(value: unknown, path = "$"): [string, unknown][] {
  if (Array.isArray(value)) return value.flatMap((v) => walk(v, `${path}[]`));
  if (value && typeof value === "object") {
    return Object.entries(value).flatMap(([k, v]) => [[`${path}.${k}`, v] as [string, unknown], ...walk(v, `${path}.${k}`)]);
  }
  return [];
}
const keysOf = (value: unknown) => new Set(walk(value).map(([p]) => p));

describe("AC-1.1: one plain fetch handler", () => {
  it("answers liveness", async () => {
    const r = await call("GET", "/health");
    expect(r.status).toBe(200);
    expect(r.body).toEqual({ status: "ok", service: "wanderlust-agency-synthetic" });
    expect((await call("POST", "/health")).status).toBe(405);
  });

  it("uses only web-standard APIs: no Node import, no Node global, no Workers import", () => {
    for (const file of ["api/wanderlust-api.mjs", "credentials.mjs"]) {
      const src = readFileSync(resolve(SHOWCASE_DIR, file), "utf8");
      const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+["']([^"']+)["']/gm)].map((m) => m[1]);
      for (const spec of imports) {
        expect(spec, `${file} imports ${spec}`).toMatch(/^\.\.?\//); // relative only: no node:, no packages
      }
      expect(src, file).not.toMatch(/\bprocess\.|\brequire\(|\bBuffer\b|__dirname|__filename|node:|cloudflare:|\bfs\b/);
      expect(src, file).not.toMatch(/import\(/);
    }
  });

  it("serves the same responses from the Node http wrapper as from the handler", async () => {
    const server = createApiServer({ now: CLOCK_MS });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const live = await fetch(`${base}/health`);
      expect(live.status).toBe(200);
      expect(await live.json()).toEqual({ status: "ok", service: "wanderlust-agency-synthetic" });

      const probes: [string, string, unknown?, Record<string, string>?][] = [
        ["POST", "/v1/stays/search", { destination: "Lisbon", dates: DATES, travelers: PARTY }],
        ["GET", "/v1/stays/ws-1001"],
        ["GET", "/v1/stays/ws-1001/photos"],
        ["POST", "/v1/quotes", { stayId: "ws-1001", dates: DATES, travelers: PARTY }],
        ["GET", "/v1/room-status?propertyId=ws-1002&date=2027-05-12"],
        ["POST", "/v1/bookings/B-0000cafe/cancel", undefined, auth(DEMO_KEY_A)],
        ["POST", "/v1/bookings/B-0000cafe/cancel"],
        ["GET", "/img/ws-1001/1.svg"],
      ];
      for (const [method, path, body, headers] of probes) {
        const viaHttp = await fetch(`${base}${path}`, {
          method,
          headers: { "content-type": "application/json", ...headers },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
        const direct = await call(method, path, { body, headers });
        expect(viaHttp.status, `${method} ${path}`).toBe(direct.status);
        expect(await viaHttp.text(), `${method} ${path}`).toBe(direct.text);
      }
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("determinism and statelessness (AC-1.9)", () => {
  const requests: [string, string, unknown?, Record<string, string>?][] = [
    ["POST", "/v1/stays/search", { destination: "Lisbon", dates: DATES, travelers: PARTY }],
    ["POST", "/v1/stays/search", { destination: "Nowhere Fictional", dates: DATES, travelers: PARTY }],
    ["GET", "/v1/stays/ws-1003"],
    ["GET", "/v1/stays/ws-1003/pages"],
    ["POST", "/v1/quotes", { stayId: "ws-1002", dates: DATES, travelers: PARTY }],
    ["GET", "/v1/availability?propertyId=ws-1001&date=2027-06-05"],
    ["GET", "/v1/neighbourhoods?area=Alfama"],
  ];

  it("the same request at the same time gives byte-identical bytes, call after call", async () => {
    for (const [method, path, body, headers] of requests) {
      const first = await call(method, path, { body, headers });
      const second = await call(method, path, { body, headers });
      expect(second.text, `${method} ${path}`).toBe(first.text);
    }
  });

  it("derives ids from inputs: booking ids are deterministic and cancel/pay validate their shape", async () => {
    const quote = (await call("POST", "/v1/quotes", { body: { stayId: "ws-1001", dates: DATES, travelers: PARTY } })).body;
    const book = () =>
      call("POST", "/v1/bookings", {
        headers: auth(DEMO_KEY_A),
        body: { quoteId: quote.quoteId, stayId: "ws-1001", dates: DATES, travelers: PARTY, guestName: "Ana Pop" },
      });
    const a = await book();
    const b = await book();
    expect(a.status).toBe(201);
    expect(a.body.bookingId).toMatch(BOOKING_ID_RE);
    expect(b.body.bookingId).toBe(a.body.bookingId);
    const other = await call("POST", "/v1/bookings", {
      headers: auth(DEMO_KEY_A),
      body: { quoteId: quote.quoteId, stayId: "ws-1001", dates: DATES, travelers: PARTY, guestName: "Ion Exemplu" },
    });
    expect(other.body.bookingId).not.toBe(a.body.bookingId);

    // Self-verifying, not stored: the seeded booking and any id this agency issued cancel; an id it
    // never issued is a 404, whatever its shape.
    expect((await call("POST", "/v1/bookings/B-0000cafe/cancel", { headers: auth(DEMO_KEY_A) })).status).toBe(200);
    expect((await call("POST", `/v1/bookings/${a.body.bookingId}/cancel`, { headers: auth(DEMO_KEY_A) })).status).toBe(200);
    expect((await call("POST", "/v1/bookings/not-a-booking/cancel", { headers: auth(DEMO_KEY_A) })).status).toBe(404);
    const pay = await call("POST", "/v1/payments", {
      headers: auth(DEMO_KEY_A),
      body: { bookingId: "nope", amount: { amount: 10, currency: "EUR" }, paymentQuote: "PQ-0-00000000" },
    });
    expect(pay.status).toBe(404);
  });

  it("takes its clock from the caller: a quote expires 15 minutes after it is issued, not at a fixed boundary", async () => {
    const q = (now: number) => call("POST", "/v1/quotes", { body: { stayId: "ws-1001", dates: DATES, travelers: PARTY }, now });
    const first = await q(CLOCK_MS);
    const again = await q(CLOCK_MS);
    const later = await q(CLOCK_MS + 60_000);
    expect(again.body.quoteId).toBe(first.body.quoteId); // same instant, same request: deterministic
    expect(later.body.quoteId).not.toBe(first.body.quoteId); // a later request is a new quote
    expect(first.body.expiresAt).toBe("2027-05-01T10:22:00.000Z");
    expect(later.body.expiresAt).toBe("2027-05-01T10:23:00.000Z");
    // The expiry is always in the future of the request, whatever minute of the quarter hour it is.
    for (const offset of [0, 1, 60_000, 14 * 60_000, QUOTE_WINDOW_MS - 1, QUOTE_WINDOW_MS, 7 * QUOTE_WINDOW_MS + 12_345]) {
      const r = await q(CLOCK_MS + offset);
      expect(Date.parse(r.body.expiresAt) - (CLOCK_MS + offset), `offset ${offset}`).toBe(QUOTE_WINDOW_MS);
    }
  });

  it("keeps image URLs on a constant origin whatever address the request came to", async () => {
    const via = async (origin: string) =>
      (await (await handle(new Request(`${origin}/v1/stays/ws-1001/photos`), { now: CLOCK_MS })).json()) as { photos: string[] };
    expect(await via("http://localhost:8788")).toEqual(await via("https://elsewhere.showcase.example"));
    const injected = (await (await handle(new Request(`${ORIGIN}/v1/stays/ws-1001/photos`), { imageBase: "https://i.showcase.example" })).json()) as { photos: string[] };
    expect(injected.photos[0].startsWith("https://i.showcase.example/")).toBe(true);
  });

  it("contains no storage binding anywhere in the example", () => {
    const walkFiles = (dir: string): string[] =>
      readdirSync(dir).flatMap((f) => {
        const p = join(dir, f);
        return statSync(p).isDirectory() ? (f === "node_modules" ? [] : walkFiles(p)) : [p];
      });
    const src = readFileSync(resolve(SHOWCASE_DIR, "api/wanderlust-api.mjs"), "utf8");
    expect(src).not.toMatch(/\b(KV|D1|R2|localStorage|indexedDB|caches|Durable)\b|new Map\(|new Set\(/);
    const connectors = walkFiles(SHOWCASE_DIR)
      // `local/` holds the recorded-only scenarios (the sql reporting manifest of S-15): not part of the
      // deployed manifest or the Worker, which is what this test is about. Its own scenario asserts
      // that the live manifest has no sql capability.
      .filter((f) => f.endsWith(".binding.yaml") && !f.includes("/local/"))
      .map((f) => (parseYaml(readFileSync(f, "utf8")) as { binding: { connector: { type: string } } }).binding.connector.type);
    expect(connectors.length).toBeGreaterThan(10);
    expect(new Set(connectors)).toEqual(new Set(["rest"]));
  });
});

describe("AC-1.2: it over-exposes on purpose (each item pinned)", () => {
  it("stays carry the agency's private rate sheet and raw HTML on every search row", async () => {
    const { body } = await call("POST", "/v1/stays/search", { body: { destination: "Lisbon", dates: DATES, travelers: PARTY } });
    expect(body.stays.length).toBeGreaterThanOrEqual(4);
    for (const s of body.stays) {
      expect(typeof s.net).toBe("number");
      expect(typeof s.margin).toBe("number");
      expect(typeof s.commission).toBe("number");
      expect(s.margin).toBeGreaterThan(0);
      expect(typeof s.description_html).toBe("string");
      expect(s.hostContact.phone).toMatch(/^\+00 000 000 \d{3}$/);
    }
    // The agency's order, not price or rating order.
    const prices = body.stays.map((s: { pricePerNight: number }) => s.pricePerNight);
    expect(prices).not.toEqual([...prices].sort((a: number, b: number) => a - b));
    expect(prices).not.toEqual([...prices].sort((a: number, b: number) => b - a));
  });

  it("the HTML description points an <img> and an <a> at hosts nothing declares", async () => {
    const { body } = await call("GET", "/v1/stays/ws-1001");
    const html: string = body.description_html;
    expect(html).toMatch(/<img [^>]*src="/);
    expect(html).toMatch(/<a [^>]*href="/);
    const hosts = [...html.matchAll(/(?:src|href)="(https:\/\/[^/"]+)/g)].map((m) => m[1]);
    expect(hosts.length).toBeGreaterThanOrEqual(2);
    for (const host of hosts) {
      expect(host).toBe(UNDECLARED_MARKUP_HOST);
      expect([IMAGE_BASE, PAGES_BASE]).not.toContain(host);
    }
  });

  it("guest records carry passport and phone at every nesting level of a stay", async () => {
    const { body } = await call("GET", "/v1/stays/ws-1001");
    const guestPaths = new Set<string>();
    for (const [path, value] of walk(body)) {
      if (path.endsWith(".passport")) {
        expect(value).toMatch(/^DEMO-PASS-\d{6}$/);
        guestPaths.add(path.slice(0, -".passport".length));
      }
    }
    const depths = [...guestPaths].map((p) => p.split(".").length - 1);
    expect(guestPaths).toEqual(
      new Set([
        "$.guests[]",
        "$.rooms[].guests[]",
        "$.rooms[].amenities[].lastUsedBy",
        "$.rooms[].amenities[].history[].guests[]",
      ]),
    );
    expect(Math.max(...depths)).toBeGreaterThanOrEqual(4);
    for (const p of guestPaths) {
      const all = keysOf(body);
      expect(all.has(`${p}.phone`), `${p}.phone`).toBe(true);
      expect(all.has(`${p}.email`), `${p}.email`).toBe(true);
    }
    const phones = walk(body).filter(([p]) => p.endsWith(".phone")).map(([, v]) => v);
    for (const v of phones) expect(v).toMatch(/^\+00 000 000 \d{3}$/);
  });

  it("the rate sheet reappears nested inside rooms", async () => {
    const { body } = await call("GET", "/v1/stays/ws-1001");
    const keys = keysOf(body);
    for (const k of ["net", "margin", "commission"]) {
      expect(keys.has(`$.${k}`), `$.${k}`).toBe(true);
      expect(keys.has(`$.rooms[].${k}`), `$.rooms[].${k}`).toBe(true);
    }
    expect(keys.has("$.rooms[].amenities[].host.phone")).toBe(true);
  });

  it("five photos, exactly one (the fourth) on a host nothing declares", async () => {
    const { body } = await call("GET", "/v1/stays/ws-1001/photos");
    expect(body.photos).toHaveLength(5);
    const off = body.photos.map((u: string, i: number) => [i, u]).filter(([, u]: [number, string]) => !u.startsWith(`${IMAGE_BASE}/`));
    expect(off).toHaveLength(1);
    expect(off[0][0]).toBe(3);
    expect(off[0][1].startsWith(`${UNDECLARED_IMAGE_HOST}/`)).toBe(true);
  });

  it("two hotel page links, exactly one on an origin nothing declares", async () => {
    const { body } = await call("GET", "/v1/stays/ws-1001/pages");
    const urls: string[] = body.pages.map((p: { url: string }) => p.url);
    expect(urls.filter((u) => u.startsWith(`${PAGES_BASE}/`))).toHaveLength(1);
    expect(urls.filter((u) => u.startsWith(`${UNDECLARED_PAGE_HOST}/`))).toHaveLength(1);
  });

  it("confirmed bookings, cancellations and payments echo the guest's passport and phone", async () => {
    const quote = (await call("POST", "/v1/quotes", { body: { stayId: "ws-1001", dates: DATES, travelers: PARTY } })).body;
    const book = await call("POST", "/v1/bookings", {
      headers: auth(DEMO_KEY_A),
      body: { quoteId: quote.quoteId, stayId: "ws-1001", dates: DATES, travelers: PARTY, guestName: "Ana Pop" },
    });
    const cancel = await call("POST", `/v1/bookings/${book.body.bookingId}/cancel`, { headers: auth(DEMO_KEY_A) });
    const pay = await call("POST", "/v1/payments", {
      headers: auth(DEMO_KEY_A),
      body: { bookingId: book.body.bookingId, amount: book.body.total, paymentQuote: book.body.paymentQuote },
    });
    for (const r of [book, cancel, pay]) {
      expect(r.body.guests[0].passport).toMatch(/^DEMO-PASS-\d{6}$/);
      expect(r.body.guests[0].phone).toMatch(/^\+00 000 000 \d{3}$/);
    }
    expect(book.body.guests[0].name).toBe("Ana Pop");
    expect(typeof book.body.margin).toBe("number");
    expect(typeof pay.body.processorFee).toBe("number");
  });

  it("a DELETE-bookings endpoint exists and works, and the OpenAPI document lists it", async () => {
    const r = await call("DELETE", "/v1/guests/Ana%20Pop/bookings", { headers: auth(DEMO_KEY_A) });
    expect(r.status).toBe(200);
    expect(r.body.guest).toBe("Ana Pop");
    expect(r.body.deletedBookings).toBeGreaterThanOrEqual(1);
    const openapi = parseYaml(readFileSync(resolve(SHOWCASE_DIR, "api/wanderlust.openapi.yaml"), "utf8")) as { paths: Record<string, Record<string, unknown>> };
    expect(openapi.paths["/v1/guests/{name}/bookings"]).toHaveProperty("delete");
  });

  it("the room-status endpoint is unwell on purpose, on one property and date each: an error row, and a wrong-typed price", async () => {
    expect(BUSY_ON).toEqual({ propertyId: "ws-1002", date: "2027-05-12" });
    expect(WRONG_PRICE_ON).toEqual({ propertyId: "ws-1003", date: "2027-05-12" });
    const busy = (await call("GET", "/v1/room-status?propertyId=ws-1002&date=2027-05-12")).body;
    expect(busy.rows.some((r: { error?: unknown }) => r.error !== undefined)).toBe(true);
    expect(busy.rows.some((r: { error?: unknown }) => r.error === undefined)).toBe(true);
    const wrong = (await call("GET", "/v1/room-status?propertyId=ws-1003&date=2027-05-12")).body;
    for (const row of wrong.rows) expect(typeof row.pricePerNight).not.toBe("number");
    const fine = (await call("GET", "/v1/room-status?propertyId=ws-1001&date=2027-05-12")).body;
    for (const row of fine.rows) expect(typeof row.pricePerNight).toBe("number");
  });

  it("availability carries the rate sheet too", async () => {
    const { body } = await call("GET", "/v1/availability?propertyId=ws-1001&date=2027-06-05");
    expect(typeof body.margin).toBe("number");
  });
});

describe("the agency judges the credential and the quote; Archstone is not in this file", () => {
  it("accepts exactly the two public keys and refuses everything else with 401", async () => {
    expect(ACCEPTED_KEYS).toEqual([DEMO_KEY_A, DEMO_KEY_B]);
    for (const key of ACCEPTED_KEYS) {
      expect((await call("POST", "/v1/bookings/B-0000cafe/cancel", { headers: auth(key) })).status).toBe(200);
    }
    for (const headers of [{}, auth("not-a-key"), { authorization: DEMO_KEY_A }, { authorization: `Basic ${DEMO_KEY_A}` }, auth("")]) {
      const r = await call("POST", "/v1/bookings/B-0000cafe/cancel", { headers });
      expect(r.status, JSON.stringify(headers)).toBe(401);
      expect(r.res.headers.get("www-authenticate")).toBe("Bearer");
    }
    expect((await call("DELETE", "/v1/guests/Ana%20Pop/bookings")).status).toBe(401);
    expect((await call("POST", "/v1/payments", { body: {} })).status).toBe(401);
    expect((await call("POST", "/v1/bookings", { body: {} })).status).toBe(401);
  });

  it("books only on a quote this agency issued in this window for this stay, dates and party", async () => {
    const q = (await call("POST", "/v1/quotes", { body: { stayId: "ws-1001", dates: DATES, travelers: PARTY } })).body;
    const base = { stayId: "ws-1001", dates: DATES, travelers: PARTY, guestName: "Ana Pop" };
    const book = (extra: Record<string, unknown>, now?: number) =>
      call("POST", "/v1/bookings", { headers: auth(DEMO_KEY_A), body: { ...base, ...extra }, now });
    expect((await book({ quoteId: q.quoteId })).status).toBe(201);
    expect((await book({})).body.error).toBe("quote_required");
    expect((await book({ quoteId: "nonsense" })).body.error).toBe("quote_invalid");
    expect((await book({ quoteId: q.quoteId, stayId: "ws-1002" })).body.error).toBe("quote_mismatch");
    expect((await book({ quoteId: q.quoteId, travelers: { adults: 3 } })).body.error).toBe("quote_mismatch");
    expect((await book({ quoteId: q.quoteId }, CLOCK_MS + QUOTE_WINDOW_MS - 1)).status).toBe(201); // still inside its 15 minutes
    expect((await book({ quoteId: q.quoteId }, CLOCK_MS + QUOTE_WINDOW_MS)).body.error).toBe("quote_expired");
    expect((await book({ quoteId: q.quoteId }, CLOCK_MS - 1)).body.error).toBe("quote_invalid"); // not issued yet
  });

  it("pays only with a payment quote derived from booking, amount and window", async () => {
    const q = (await call("POST", "/v1/quotes", { body: { stayId: "ws-1001", dates: DATES, travelers: PARTY } })).body;
    const b = (
      await call("POST", "/v1/bookings", {
        headers: auth(DEMO_KEY_A),
        body: { quoteId: q.quoteId, stayId: "ws-1001", dates: DATES, travelers: PARTY, guestName: "Ana Pop" },
      })
    ).body;
    const pay = (extra: Record<string, unknown>, now?: number) =>
      call("POST", "/v1/payments", {
        headers: auth(DEMO_KEY_A),
        body: { bookingId: b.bookingId, amount: b.total, paymentQuote: b.paymentQuote, ...extra },
        now,
      });
    const ok = await pay({});
    expect(ok.status).toBe(201);
    expect(ok.body.status).toBe("paid");
    expect((await pay({ paymentQuote: undefined })).body.error).toBe("payment_quote_required");
    expect((await pay({ paymentQuote: "garbage" })).body.error).toBe("payment_quote_invalid");
    expect((await pay({ amount: { amount: 1, currency: "EUR" } })).body.error).toBe("payment_quote_mismatch");
    // A booking this agency issued, but not the one the payment quote was made for.
    expect((await pay({ bookingId: "B-0000cafe" })).body.error).toBe("payment_quote_mismatch");
    // A booking id this agency never issued.
    const unknown = await pay({ bookingId: "B-ffffffff" });
    expect([unknown.status, unknown.body.error]).toEqual([404, "booking_not_found"]);
    expect((await pay({}, CLOCK_MS + QUOTE_WINDOW_MS - 1)).status).toBe(201); // still inside its 15 minutes
    expect((await pay({}, CLOCK_MS + QUOTE_WINDOW_MS)).body.error).toBe("payment_quote_expired");
    expect((await pay({}, CLOCK_MS - 1)).body.error).toBe("payment_quote_invalid"); // not issued yet
  });
});

describe("malformed requests are refused, never fatal", () => {
  it("answers 400 JSON for a malformed % sequence in the path", async () => {
    for (const path of ["/v1/stays/%E0%A4%A", "/img/%zz/1.svg", "/v1/guests/%/bookings"]) {
      const r = await call("GET", path);
      expect(r.status, path).toBe(400);
      expect(r.body.error).toBe("bad_request");
    }
  });

  it("the Node wrapper answers 400 to a malformed Host header and keeps serving", async () => {
    const server = createApiServer({ now: CLOCK_MS });
    await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
    const port = (server.address() as AddressInfo).port;
    const raw = (text: string) =>
      new Promise<string>((done, fail) => {
        const sock = connect(port, "127.0.0.1", () => sock.write(text));
        let out = "";
        sock.on("data", (d) => (out += d));
        sock.on("end", () => done(out));
        sock.on("error", fail);
      });
    try {
      const bad = await raw("GET /health HTTP/1.1\r\nHost: a b\r\nConnection: close\r\n\r\n");
      expect(bad.startsWith("HTTP/1.1 400")).toBe(true);
      const after = await fetch(`http://127.0.0.1:${port}/health`);
      expect(after.status).toBe(200);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
  });
});

describe("the legacy search and the retired one", () => {
  it("POST /v1/search reads the same catalogue as the current search, in the legacy row shape, margin and all", async () => {
    const legacy = await call("POST", "/v1/search", { body: { destination: "Lisbon" } });
    const current = await call("POST", "/v1/stays/search", { body: { destination: "Lisbon" } });
    expect(legacy.status).toBe(200);
    expect(legacy.body.stays.map((s: Body) => s.id).sort()).toEqual(current.body.stays.map((s: Body) => s.id).sort());
    expect(legacy.body.totalMatches).toBe(current.body.totalMatches);
    for (const row of legacy.body.stays) {
      expect(typeof row.net).toBe("number");
      expect(typeof row.commission).toBe("number");
      expect(typeof row.boardType).toBe("string");
      expect(CATALOGUE.map((s) => s.name)).toContain(row.name);
    }
  });

  it("the classic search is gone", async () => {
    expect((await call("POST", "/v1/classic-search", { body: {} })).status).toBe(410);
  });
});

describe("every documented route is served", () => {
  const openapi = parseYaml(readFileSync(resolve(SHOWCASE_DIR, "api/wanderlust.openapi.yaml"), "utf8")) as {
    paths: Record<string, Record<string, { parameters?: { name: string; in: string; schema?: { examples?: string[] } }[] }>>;
  };

  it("each path and method in the OpenAPI document answers something other than 404 or 405", async () => {
    let n = 0;
    for (const [path, ops] of Object.entries(openapi.paths)) {
      for (const [method, op] of Object.entries(ops)) {
        const sample = (name: string) => op.parameters?.find((p) => p.name === name)?.schema?.examples?.[0] ?? "x";
        let url = path.replace(/\{(\w+)\}/g, (_, name: string) => encodeURIComponent(sample(name)));
        const query = (op.parameters ?? []).filter((p) => p.in === "query").map((p) => `${p.name}=${p.name === "date" ? "2027-05-12" : encodeURIComponent(sample(p.name))}`);
        if (query.length) url += `?${query.join("&")}`;
        const r = await call(method.toUpperCase(), url, {
          headers: auth(DEMO_KEY_A),
          body: ["post", "put", "patch"].includes(method) ? {} : undefined,
        });
        expect(r.body?.error, `${method.toUpperCase()} ${url}`).not.toBe("not_found"); // a route, not merely a domain 404
        expect(r.status, `${method.toUpperCase()} ${url}`).not.toBe(405);
        n += 1;
      }
    }
    expect(n).toBe(Object.values(openapi.paths).reduce((s, ops) => s + Object.keys(ops).length, 0));
    expect(n).toBeGreaterThanOrEqual(15);
  });

  it("unknown routes and methods are refused cleanly", async () => {
    expect((await call("GET", "/v2/anything")).status).toBe(404);
    expect((await call("GET", "/v1/nothing")).status).toBe(404);
    expect((await call("PUT", "/v1/quotes")).status).toBe(405);
    expect((await call("GET", "/img/ws-1001/x.png")).status).toBe(404);
    expect((await call("GET", "/img/ws-1001/1.svg")).res.headers.get("content-type")).toBe("image/svg+xml");
  });
});

// Reserved example domains, plus the demo Worker's own host: the agency's images are served from it.
const FAKE_HOST = /\.example$|^demo\.archstone\.dev$/;

describe("AC-1.11: every person, hotel and contact detail is visibly invented", () => {
  it("passports, phones, e-mails and URL hosts in every response are fakes", async () => {
    const responses: unknown[] = [];
    const get = async (method: string, path: string, body?: unknown) =>
      responses.push((await call(method, path, { body, headers: auth(DEMO_KEY_A) })).body);
    await get("POST", "/v1/stays/search", { destination: "Lisbon", dates: DATES, travelers: PARTY });
    for (const id of ["ws-1001", "ws-1002", "ws-1003", "ws-1004"]) {
      await get("GET", `/v1/stays/${id}`);
      await get("GET", `/v1/stays/${id}/photos`);
      await get("GET", `/v1/stays/${id}/pages`);
    }
    const q = (await call("POST", "/v1/quotes", { body: { stayId: "ws-1001", dates: DATES, travelers: PARTY } })).body;
    responses.push(q);
    const b = (
      await call("POST", "/v1/bookings", {
        headers: auth(DEMO_KEY_A),
        body: { quoteId: q.quoteId, stayId: "ws-1001", dates: DATES, travelers: PARTY, guestName: "Ana Pop" },
      })
    ).body;
    responses.push(b);
    await get("POST", `/v1/bookings/${b.bookingId}/cancel`);
    await get("POST", "/v1/payments", { bookingId: b.bookingId, amount: b.total, paymentQuote: b.paymentQuote });

    let seen = 0;
    for (const response of responses) {
      for (const [, value] of walk(response)) {
        if (typeof value !== "string") continue;
        if (value.includes("@")) {
          expect(value).toMatch(/^[a-z.]+@guest\.example$/);
          seen += 1;
        }
        if (/^\+/.test(value)) {
          expect(value).toMatch(/^\+00 000 000 \d{3}$/);
          seen += 1;
        }
        if (/^https?:\/\//.test(value)) {
          expect(new URL(value).hostname, value).toMatch(FAKE_HOST);
          seen += 1;
        }
      }
      for (const m of JSON.stringify(response).matchAll(/https?:\/\/[^"\\<>\s]+/g)) {
        expect(new URL(m[0]).hostname, m[0]).toMatch(FAKE_HOST);
      }
    }
    expect(seen).toBeGreaterThan(40);
  });
});

describe("one catalogue, one destination resolver", () => {
  const LISBON = ["ws-1001", "ws-1002", "ws-1003", "ws-1004"];
  const idsFor = async (path: string, destination: string, extra: Record<string, unknown> = {}) => {
    const r = await call("POST", path, { body: { destination, dates: DATES, travelers: PARTY, ...extra } });
    expect(r.status).toBe(200);
    return (r.body.stays as Body[]).map((s) => s.id as string).sort();
  };

  it.each([
    ["Lisbon", "Lisbon"], ["lisbon", "Lisbon"], ["LISBON", "Lisbon"], ["Lisboa", "Lisbon"], ["Lisabona", "Lisbon"],
    ["Lisbon, Portugal", "Lisbon"], ["Lisbon Portugal", "Lisbon"], ["  lisbon ,  portugal ", "Lisbon"],
    ["Bucuresti", "Bucharest"], ["București, Romania", "Bucharest"], ["Bucharest", "Bucharest"],
    ["Porto, Portugal", "Porto"], ["Barcelona, Spain", "Barcelona"], ["Nice", "Nice"],
    ["Lisbon, Spain", undefined], ["Atlantis", undefined], ["", undefined], ["Lisbon Porto", undefined],
  ])("resolveDestination(%j) -> %s", (text, city) => {
    expect(resolveDestination(text)).toBe(city);
  });

  it("an unknown destination is an honest empty result on both searches, never invented stays", async () => {
    for (const path of ["/v1/stays/search", "/v1/search"]) {
      const r = await call("POST", path, { body: { destination: "Atlantis", dates: DATES, travelers: PARTY } });
      expect(r.status).toBe(200);
      expect(r.body).toEqual({ stays: [], totalMatches: 0 });
    }
  });

  it("both searches answer a destination spelling with the same stays", async () => {
    for (const path of ["/v1/stays/search", "/v1/search"]) {
      for (const spelling of ["Lisbon, Portugal", "lisboa", "LISABONA"]) {
        expect(await idsFor(path, spelling), `${path} ${spelling}`).toEqual(LISBON);
      }
    }
  });

  it("every id either search returns resolves on details, photos, pages, quote and availability", async () => {
    const cities = [...new Set(CATALOGUE.map((s) => s.city))];
    const variants: Record<string, unknown>[] = [
      {},
      { budget: { amount: 120, currency: "EUR" } },
      { preferences: ["pets"] },
      { budget: { amount: 130, currency: "EUR" }, preferences: ["pet-friendly", "breakfast"] },
    ];
    let seen = 0;
    for (const path of ["/v1/stays/search", "/v1/search"]) {
      for (const city of cities) {
        for (const extra of variants) {
          for (const id of await idsFor(path, city, extra)) {
            seen++;
            expect((await call("GET", `/v1/stays/${id}`)).status, `details ${id}`).toBe(200);
            expect((await call("GET", `/v1/stays/${id}/photos`)).status, `photos ${id}`).toBe(200);
            expect((await call("GET", `/v1/stays/${id}/pages`)).status, `pages ${id}`).toBe(200);
            expect((await call("POST", "/v1/quotes", { body: { stayId: id, dates: DATES, travelers: PARTY } })).status, `quote ${id}`).toBe(200);
            expect((await call("GET", `/v1/availability?propertyId=${id}&date=2027-06-05`)).status, `availability ${id}`).toBe(200);
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(40);
  });

  it("the budget is a per-night EUR ceiling on both searches", async () => {
    for (const path of ["/v1/stays/search", "/v1/search"]) {
      const r = await call("POST", path, { body: { destination: "Lisbon", dates: DATES, travelers: PARTY, budget: { amount: 100, currency: "EUR" } } });
      expect((r.body.stays as Body[]).map((s) => s.id).sort()).toEqual(["ws-1002", "ws-1004"]);
      const usd = await call("POST", path, { body: { destination: "Lisbon", dates: DATES, travelers: PARTY, budget: { amount: 100, currency: "USD" } } });
      expect(usd.status).toBe(400);
      expect(usd.body.message).toContain("USD");
    }
  });

  it("search dates are validated: a prose date is a 400, not silently ignored", async () => {
    for (const path of ["/v1/stays/search", "/v1/search"]) {
      const r = await call("POST", path, { body: { destination: "Lisbon", dates: "next weekend" } });
      expect(r.status).toBe(400);
      expect(r.body.error).toBe("bad_dates");
    }
  });

  it("preference synonyms fold to the three declared tags; unknown tags are ignored", () => {
    expect(normalizePreferences(["pet-friendly", "Cat", "dogs", "pets", "BREAKFAST", "kids", "sea view"]).sort()).toEqual(["breakfast", "family", "pets"]);
    expect(normalizePreferences(["sea view", 7, null])).toEqual([]);
    expect(normalizePreferences(undefined)).toEqual([]);
  });
});

describe("R1-R6: a believable agency (#201)", () => {
  const quote = (extra: Record<string, unknown> = {}, now = CLOCK_MS, stayId = "ws-1001") =>
    call("POST", "/v1/quotes", { body: { stayId, dates: DATES, travelers: PARTY, ...extra }, now });
  const book = (q: { quoteId: string }, extra: Record<string, unknown> = {}, now = CLOCK_MS, stayId = "ws-1001") =>
    call("POST", "/v1/bookings", {
      headers: auth(DEMO_KEY_A),
      body: { quoteId: q.quoteId, stayId, dates: DATES, travelers: PARTY, guestName: "Ana Pop", ...extra },
      now,
    });

  describe("R2: the pet fee is itemised in the quote total", () => {
    it("a stay that charges per night adds pets x nights x fee, shown as petFee, and the booking honours it", async () => {
      const plain = await quote();
      expect(plain.body.total).toEqual({ amount: 354, currency: "EUR" }); // 3 nights at 118
      expect(plain.body.petFee).toEqual({ amount: 0, currency: "EUR" });
      expect(plain.body.pets).toBe(0);
      const withCat = await quote({ pets: 1 });
      expect(withCat.body.petFee).toEqual({ amount: 30, currency: "EUR" }); // EUR 10 x 3 nights
      expect(withCat.body.total).toEqual({ amount: 384, currency: "EUR" });
      expect(withCat.body.pets).toBe(1);
      expect((await quote({ pets: 2 })).body.petFee.amount).toBe(60);
      const booked = await book(withCat.body);
      expect(booked.status).toBe(201);
      expect(booked.body.total).toEqual({ amount: 384, currency: "EUR" });
      // ... and the party must be the one quoted: a quote for a cat does not book at the no-pet price.
      expect((await book(plain.body)).body.total).toEqual({ amount: 354, currency: "EUR" });
    });

    it("a stay that takes pets free of charge itemises a fee of 0", async () => {
      const free = await quote({ pets: 1 }, CLOCK_MS, "ws-1002");
      expect(free.status).toBe(200);
      expect(free.body.petFee).toEqual({ amount: 0, currency: "EUR" });
      expect(free.body.total.amount).toBe(74 * 3);
    });

    it("a stay with no pets refuses the quote and says why; a non-count is a 400", async () => {
      const refused = await quote({ pets: 1 }, CLOCK_MS, "ws-1003");
      expect([refused.status, refused.body.error]).toEqual([422, "pets_not_allowed"]);
      expect(refused.body.message).toContain("Miradouro Court");
      expect(refused.body.message).toContain("No pets");
      expect((await quote({ pets: 0 }, CLOCK_MS, "ws-1003")).status).toBe(200);
      for (const pets of [-1, 1.5, "1", 5, true]) expect((await quote({ pets })).body.error, JSON.stringify(pets)).toBe("bad_pets");
    });

    it("the fee is per pet per night from each stay's own policy", async () => {
      const per = (id: string) => CATALOGUE.find((s) => s.id === id)!.petPolicy;
      expect(per("ws-2001")).toContain("EUR 12 per night");
      const porto = await quote({ pets: 1 }, CLOCK_MS, "ws-2001");
      expect(porto.body.petFee.amount).toBe(36);
    });
  });

  describe("R4: a stay's name is a destination", () => {
    const search = (destination: string, extra: Record<string, unknown> = {}) =>
      call("POST", "/v1/stays/search", { body: { destination, dates: DATES, travelers: PARTY, ...extra } });
    it.each(["Pensão Azul", "Pensao Azul", "pensão azul", "PENSAO AZUL", "Pensão Azul, Lisbon", "Pensao Azul, Lisboa, Portugal", "pensao-azul"])(
      "%j returns that stay and no other",
      async (destination) => {
        const r = await search(destination);
        expect(r.body.stays.map((s: { id: string }) => s.id)).toEqual(["ws-1002"]);
        expect(r.body.totalMatches).toBe(1);
      },
    );
    it("the legacy search matches names the same way", async () => {
      const r = await call("POST", "/v1/search", { body: { destination: "Pensão Azul", dates: DATES, travelers: PARTY } });
      expect(r.body.stays.map((s: { id: string }) => s.id)).toEqual(["ws-1002"]);
    });
    it("the other filters still apply to a named stay", async () => {
      expect((await search("Pensão Azul", { budget: { amount: 50, currency: "EUR" } })).body.stays).toEqual([]);
      expect((await search("Miradouro Court", { preferences: ["pets"] })).body.stays).toEqual([]);
      expect((await search("Miradouro Court")).body.stays.map((s: { id: string }) => s.id)).toEqual(["ws-1003"]);
    });
    it("no fuzzy matching: a wrong city, a near miss or two stays is an honest empty result", async () => {
      for (const destination of ["Pensão Azul, Porto", "Pensao Azu", "Azul", "Pensão Azul, Casa Alfama", "Pensão Azul, Spain"]) {
        expect((await search(destination)).body.stays, destination).toEqual([]);
      }
    });
    it("a city still returns the whole city", () => {
      expect(resolvePlace("Lisbon")).toEqual({ city: "Lisbon" });
      expect(resolveDestination("Pensão Azul")).toBe("Lisbon");
    });
  });

  describe("R5: room-status is usable almost everywhere", () => {
    const status = async (propertyId: string, date: string) => (await call("GET", `/v1/room-status?propertyId=${propertyId}&date=${date}`)).body;
    it("every weekend of June 2027, for every stay, answers with usable rows", async () => {
      const weekends = ["2027-06-04", "2027-06-05", "2027-06-06", "2027-06-11", "2027-06-12", "2027-06-13", "2027-06-18", "2027-06-19", "2027-06-20", "2027-06-25", "2027-06-26", "2027-06-27"];
      for (const stay of CATALOGUE) {
        for (const date of weekends) {
          const body = await status(stay.id, date);
          expect(body.rows.length, `${stay.id} ${date}`).toBeGreaterThan(0);
          for (const row of body.rows) {
            expect(row.error, `${stay.id} ${date}`).toBeUndefined();
            expect(typeof row.pricePerNight, `${stay.id} ${date}`).toBe("number");
            expect(["free", "taken"]).toContain(row.status);
          }
        }
      }
    });
    it("agency-busy appears on exactly one property and date, the wrong-typed price on exactly one", async () => {
      const dates = ["2027-05-11", "2027-05-12", "2027-05-13", "2027-06-05"];
      const busy: string[] = [];
      const wrong: string[] = [];
      for (const stay of CATALOGUE) {
        for (const date of dates) {
          const body = await status(stay.id, date);
          if (body.rows.some((r: { error?: unknown }) => r.error !== undefined)) busy.push(`${stay.id} ${date}`);
          if (body.rows.some((r: { pricePerNight?: unknown; error?: unknown }) => r.error === undefined && typeof r.pricePerNight !== "number")) wrong.push(`${stay.id} ${date}`);
        }
      }
      expect(busy).toEqual(["ws-1002 2027-05-12"]);
      expect(wrong).toEqual(["ws-1003 2027-05-12"]);
    });
  });

  describe("R6: cancelling", () => {
    const cancel = (id: string, now = CLOCK_MS) => call("POST", `/v1/bookings/${id}/cancel`, { headers: auth(DEMO_KEY_A), now });
    it("an id the agency never issued is a 404 booking_not_found", async () => {
      for (const id of ["B-12345678", "B-0000cafd", "B-018017877847", "B-ffffffffffff", "nonsense", "B-"]) {
        const r = await cancel(id);
        expect([r.status, r.body.error], id).toEqual([404, "booking_not_found"]);
      }
    });
    it("the seeded booking is a real one and its refund equals its total", async () => {
      const r = await cancel(SEEDED_BOOKING_ID);
      expect(r.status).toBe(200);
      expect(r.body.refund).toEqual({ amount: 354, currency: "EUR" });
      expect(r.body.refund).toEqual((await quote()).body.total); // Casa Alfama, 12-15 May 2027
    });
    it("a booking made here cancels for exactly its own total, pet fee included", async () => {
      for (const pets of [0, 1, 2]) {
        const q = (await quote(pets ? { pets } : {})).body;
        const b = (await book(q)).body;
        const c = await cancel(b.bookingId);
        expect(c.status).toBe(200);
        expect(c.body.refund).toEqual(b.total);
      }
    });
    it("a tampered booking id is not one the agency issued", async () => {
      const b = (await book((await quote()).body)).body;
      const last = b.bookingId.slice(-1);
      const tampered = `${b.bookingId.slice(0, -1)}${last === "0" ? "1" : "0"}`;
      expect((await cancel(tampered)).status).toBe(404);
    });
  });

  describe("R3: the agency's own page is on the declared origin, the partner link is not", () => {
    it("the first page row is the agency's own site; the annex is the undeclared partner listing", async () => {
      const { body } = await call("GET", "/v1/stays/ws-1002/pages");
      expect(body.pages[0].url.startsWith(`${PAGES_BASE}/hotels/`)).toBe(true);
      expect(body.pages[0].name).toBe("Pensão Azul");
      expect(body.pages[1].url.startsWith(`${UNDECLARED_PAGE_HOST}/`)).toBe(true);
      expect(body.pages[1].name).toMatch(/partner listing/);
    });
  });
});
