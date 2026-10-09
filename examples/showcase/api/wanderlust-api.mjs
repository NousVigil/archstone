// The synthetic Wanderlust Agency API.
//
// One plain fetch handler: `handle(request, options) -> Promise<Response>`. It uses only the
// web-standard Request/Response/URL/Headers, no Node API and no Workers API, so the same file
// serves from a Node `http` wrapper (./serve.mjs), from Vitest through a `fetch` stand-in, and
// from a Workers runtime. It is deterministic and stateless: every id, every price and every
// "time" is a pure function of the request and of the injected clock. There is no storage of any
// kind; a booking "exists" only in the sense that its id has the right shape and was derived from
// a quote the agency would have issued.
//
// IT OVER-EXPOSES ON PURPOSE. Everything marked OVER-EXPOSED below is a field, a link, a host or
// an endpoint that a well-run contract must keep away from a model, and each one is pinned by
// test/api.test.ts so that a refactor cannot quietly make this backend "clean" and turn every
// later absence check into a vacuous pass. Nothing here makes a real backend safe; this file is
// the opposite of safe by design.
//
// Everything is invented: the agency, the hotels, the guests, the passport numbers (all of the
// form DEMO-PASS-nnnnnn), the phone numbers (all +00 000 000 nnn) and the e-mail addresses (all
// on the reserved ".example" domain). Any resemblance to a real business or person is accidental.

/* global Response, URL */
import { ACCEPTED_KEYS } from "../credentials.mjs";

/** The origin the agency's own image host answers on. Constant on purpose: not derived from the
 *  request, so the output is identical under any runtime and any local address. */
export const IMAGE_BASE = "https://images.wanderlust-agency.example";
/** The origin of the agency's own hotel pages. */
export const PAGES_BASE = "https://www.wanderlust-agency.example";
/** OVER-EXPOSED: hosts the manifest does not declare (images, links, markup). */
export const UNDECLARED_IMAGE_HOST = "https://cdn.partner-photos.example";
export const UNDECLARED_PAGE_HOST = "https://book.partner-hotels.example";
export const UNDECLARED_MARKUP_HOST = "https://deals.unknown-host.example";

/** A quote is valid until the end of its 15-minute window. */
export const QUOTE_WINDOW_MS = 15 * 60 * 1000;

/**
 * @typedef {object} HandleOptions
 * @property {number | (() => number)} [now]  The clock, in epoch milliseconds, or a function
 *   returning it. Injected so a fixed clock gives byte-identical output.
 * @property {string} [imageBase]  Origin used in image URLs. Defaults to IMAGE_BASE.
 */

// ---------------------------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------------------------

/** Sync string hash (the demo mock's, kept so ids need no crypto.subtle). */
function hash(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
  return h;
}
const hex8 = (s) => hash(s).toString(16).padStart(8, "0");
const round2 = (n) => Math.round(n * 100) / 100;

/** @param {unknown} body @param {number} [status] @param {Record<string, string>} [headers] */
function json(body, status = 200, headers = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}
const problem = (status, error, message) => json({ error, message }, status);

async function readJson(request) {
  try {
    const text = await request.text();
    if (!text) return {};
    const parsed = JSON.parse(text);
    return parsed !== null && typeof parsed === "object" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
/** @returns {{ from: string, to: string, nights: number } | undefined} */
function parseDates(d) {
  if (!d || typeof d !== "object" || !DATE_RE.test(d.from) || !DATE_RE.test(d.to)) return undefined;
  const nights = Math.round((Date.parse(d.to) - Date.parse(d.from)) / 86_400_000);
  if (!Number.isFinite(nights) || nights < 1 || nights > 30) return undefined;
  return { from: d.from, to: d.to, nights };
}

function money(amount, currency = "EUR") {
  return { amount: round2(amount), currency };
}

// ---------------------------------------------------------------------------------------------
// Invented people (OVER-EXPOSED: the guest record carries passport and phone)
// ---------------------------------------------------------------------------------------------

export const GUEST_NAMES = [
  "Ana Pop", "Ion Exemplu", "Maria Demo", "Test Guest", "Nina Fictiva", "Paul Inventat",
  "Rita Sample", "Dan Placeholder",
];

/** A guest record. Passport and phone are visibly fake and present at every nesting level. */
function guestRecord(seed, name) {
  const n = hash(`guest|${seed}`) % 900_000 + 100_000;
  const who = name ?? GUEST_NAMES[hash(`name|${seed}`) % GUEST_NAMES.length];
  const slug = who.toLowerCase().replace(/[^a-z]+/g, ".").replace(/^\.|\.$/g, "");
  return {
    name: who,
    passport: `DEMO-PASS-${n}`,
    phone: `+00 000 000 ${String(n % 1000).padStart(3, "0")}`,
    email: `${slug}@guest.example`,
  };
}

// ---------------------------------------------------------------------------------------------
// Stays
// ---------------------------------------------------------------------------------------------

// Fictional Lisbon properties, listed in the AGENCY's own order: not by price, not by rating.
// Archstone ranks nothing; whatever order the agency chooses is the order a model sees.
const CATALOGUE = [
  { id: "ws-1001", name: "Casa Alfama", pricePerNight: 118, rating: 4.6, slug: "casa-alfama" },
  { id: "ws-1003", name: "Miradouro Court", pricePerNight: 139, rating: 4.8, slug: "miradouro-court" },
  { id: "ws-1002", name: "Pensão Azul", pricePerNight: 74, rating: 4.1, slug: "pensao-azul" },
  { id: "ws-1004", name: "Rio Tejo Lofts", pricePerNight: 96, rating: 4.3, slug: "rio-tejo-lofts" },
];
const byStayId = (id) => CATALOGUE.find((s) => s.id === id);

/** OVER-EXPOSED: the agency's private rate sheet, present on every stay and again in rooms. */
function rateSheet(price) {
  const net = round2(price * 0.62);
  const commission = round2(price * 0.12);
  return { net, margin: round2(price - net), commission };
}

/** OVER-EXPOSED: raw markup with an image and a link on hosts the manifest never declares. */
function descriptionHtml(stay) {
  return (
    `<p><b>${stay.name}</b> is a fictional demo property.</p>` +
    `<img src="${UNDECLARED_MARKUP_HOST}/pixel/${stay.id}.gif" width="1" height="1">` +
    `<a href="${UNDECLARED_MARKUP_HOST}/offer?ref=${stay.id}">See today's special offer</a>`
  );
}

function stayRow(stay) {
  return {
    id: stay.id,
    name: stay.name,
    location: "Lisbon",
    pricePerNight: stay.pricePerNight,
    ...(stay.rating !== undefined ? { rating: stay.rating } : {}),
    currency: "EUR",
    ...rateSheet(stay.pricePerNight), // OVER-EXPOSED: net, margin, commission on every row
    description_html: descriptionHtml(stay), // OVER-EXPOSED
    hostContact: { name: "Front Desk (fictional)", phone: "+00 000 000 000" }, // OVER-EXPOSED
  };
}

function searchStays(body) {
  const where = String(body.destination ?? "").trim().toLowerCase();
  let rows;
  if (where === "lisbon" || where === "lisboa") {
    rows = CATALOGUE.map(stayRow);
  } else {
    // Other destinations: three generated rows, deterministic in the destination. Details,
    // photos and pages exist for the catalogue above only.
    const seed = hash(where || "anywhere");
    rows = Array.from({ length: 3 }, (_, i) => {
      const price = 85 + ((seed + i * 41) % 160);
      return stayRow({
        id: `ws-g${hex8(`${where}|${i}`).slice(0, 4)}`,
        name: `Generated Stay ${i + 1} (${body.destination ?? "anywhere"})`,
        pricePerNight: price,
        rating: Math.round((3.8 + ((seed + i * 17) % 12) / 10) * 10) / 10,
      });
    });
  }
  const budget = body.budget && typeof body.budget.amount === "number" ? body.budget.amount : undefined;
  if (budget !== undefined) rows = rows.filter((r) => r.pricePerNight <= budget);
  return { stays: rows, totalMatches: rows.length };
}

function stayDetails(stay) {
  const room = (suffix, name, sleeps, factor) => {
    const price = round2(stay.pricePerNight * factor);
    const amenity = (label, fee) => ({
      name: label,
      fee,
      host: { name: "Amenity host (fictional)", phone: "+00 000 000 111" }, // OVER-EXPOSED
      lastUsedBy: guestRecord(`${stay.id}|${suffix}|${label}`), // OVER-EXPOSED: depth 3
      history: [{ guests: [guestRecord(`${stay.id}|${suffix}|${label}|h`)] }], // OVER-EXPOSED: depth 4
    });
    return {
      id: `${stay.id}-${suffix}`,
      name,
      sleeps,
      pricePerNight: price,
      ...rateSheet(price), // OVER-EXPOSED: the rate sheet again, nested in the room
      guests: [guestRecord(`${stay.id}|${suffix}`)], // OVER-EXPOSED: depth 2
      amenities: [amenity("Breakfast", 9), amenity("Airport transfer", 25)],
    };
  };
  return {
    id: stay.id,
    name: stay.name,
    location: "Lisbon",
    pricePerNight: stay.pricePerNight,
    ...(stay.rating !== undefined ? { rating: stay.rating } : {}),
    currency: "EUR",
    ...rateSheet(stay.pricePerNight),
    description_html: descriptionHtml(stay),
    guests: [guestRecord(stay.id), guestRecord(`${stay.id}|2`)], // OVER-EXPOSED: depth 1
    rooms: [room("dbl", "Double Room", 2, 1), room("fam", "Family Room", 4, 1.45)],
  };
}

function stayPhotos(stay, imageBase) {
  return {
    stayId: stay.id,
    photos: [
      `${imageBase}/img/${stay.id}/1.svg`,
      `${imageBase}/img/${stay.id}/2.svg`,
      `${imageBase}/img/${stay.id}/3.svg`,
      `${UNDECLARED_IMAGE_HOST}/${stay.id}/4.jpg`, // OVER-EXPOSED: undeclared host, index 3
      `${imageBase}/img/${stay.id}/5.svg`,
    ],
  };
}

function stayPages(stay) {
  return {
    pages: [
      { name: stay.name, url: `${PAGES_BASE}/hotels/${stay.slug}` },
      // OVER-EXPOSED: a link on an origin the manifest does not declare.
      { name: `${stay.name} Annex (partner listing)`, url: `${UNDECLARED_PAGE_HOST}/listing/${stay.slug}-annex` },
    ],
    affiliateTracking: `${UNDECLARED_PAGE_HOST}/aff?ref=${stay.id}`, // OVER-EXPOSED, never mapped
  };
}

function svg(stayId, n) {
  const hue = hash(`${stayId}|${n}`) % 360;
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="640" height="400" viewBox="0 0 640 400">` +
    `<rect width="640" height="400" fill="hsl(${hue} 35% 80%)"/>` +
    `<rect x="40" y="220" width="560" height="140" fill="hsl(${hue} 30% 62%)"/>` +
    `<circle cx="500" cy="110" r="46" fill="hsl(${(hue + 40) % 360} 60% 70%)"/>` +
    `</svg>`
  );
}

// ---------------------------------------------------------------------------------------------
// Quotes, bookings, payments: derived from inputs, never stored
// ---------------------------------------------------------------------------------------------

const windowOf = (nowMs) => Math.floor(nowMs / QUOTE_WINDOW_MS);
const windowEnd = (win) => new Date((win + 1) * QUOTE_WINDOW_MS).toISOString();

const quoteId = (win, stayId, from, to, adults) =>
  `Q-${win.toString(36)}-${hex8(`${stayId}|${from}|${to}|${adults}|${win}`)}`;
const paymentQuoteId = (win, bookingId, amount, currency) =>
  `PQ-${win.toString(36)}-${hex8(`${bookingId}|${amount}|${currency}|${win}`)}`;

const QUOTE_RE = /^Q-([0-9a-z]+)-([0-9a-f]{8})$/;
const PAYMENT_QUOTE_RE = /^PQ-([0-9a-z]+)-([0-9a-f]{8})$/;
export const BOOKING_ID_RE = /^B-[0-9a-f]{8}$/;

const adultsOf = (party) => (party && Number.isInteger(party.adults) && party.adults >= 1 ? party.adults : 1);

function totalFor(stay, nights) {
  return money(stay.pricePerNight * nights);
}

async function postQuote(request, nowMs) {
  const body = await readJson(request);
  const stay = byStayId(body?.stayId);
  const dates = parseDates(body?.dates);
  if (!stay) return problem(404, "stay_not_found", "No such stay.");
  if (!dates) return problem(400, "bad_dates", "dates must be { from, to } as YYYY-MM-DD, 1 to 30 nights.");
  const win = windowOf(nowMs);
  const adults = adultsOf(body.travelers);
  return json({
    quoteId: quoteId(win, stay.id, dates.from, dates.to, adults),
    stayId: stay.id,
    dates: { from: dates.from, to: dates.to },
    nights: dates.nights,
    total: totalFor(stay, dates.nights),
    expiresAt: windowEnd(win),
    ...rateSheet(stay.pricePerNight * dates.nights), // OVER-EXPOSED
  });
}

function checkWindowToken(raw, re, nowMs, label) {
  if (typeof raw !== "string" || raw === "") return { error: problem(422, `${label}_required`, `A ${label.replace("_", " ")} is required.`) };
  const m = re.exec(raw);
  if (!m) return { error: problem(422, `${label}_invalid`, `That ${label.replace("_", " ")} is not one this agency issued.`) };
  const win = parseInt(m[1], 36);
  const now = windowOf(nowMs);
  if (win < now) return { error: problem(422, `${label}_expired`, `That ${label.replace("_", " ")} has expired.`) };
  if (win > now) return { error: problem(422, `${label}_invalid`, `That ${label.replace("_", " ")} is not one this agency issued.`) };
  return { win, tail: m[2] };
}

async function postBooking(request, nowMs) {
  const body = await readJson(request);
  if (!body) return problem(400, "bad_request", "A JSON body is required.");
  const stay = byStayId(body.stayId);
  const dates = parseDates(body.dates);
  if (!stay) return problem(404, "stay_not_found", "No such stay.");
  if (!dates) return problem(400, "bad_dates", "dates must be { from, to } as YYYY-MM-DD, 1 to 30 nights.");
  if (typeof body.guestName !== "string" || body.guestName.trim() === "") {
    return problem(400, "guest_required", "guestName is required.");
  }
  const checked = checkWindowToken(body.quoteId, QUOTE_RE, nowMs, "quote");
  if (checked.error) return checked.error;
  const adults = adultsOf(body.travelers);
  if (quoteId(checked.win, stay.id, dates.from, dates.to, adults) !== body.quoteId) {
    return problem(422, "quote_mismatch", "That quote was issued for a different stay, dates or party.");
  }
  const bookingId = `B-${hex8(`${body.quoteId}|${body.guestName.trim()}`)}`;
  const total = totalFor(stay, dates.nights);
  const win = windowOf(nowMs);
  return json(
    {
      bookingId,
      status: "confirmed",
      stayId: stay.id,
      dates: { from: dates.from, to: dates.to },
      total,
      paymentQuote: paymentQuoteId(win, bookingId, total.amount, total.currency),
      payBy: windowEnd(win),
      guests: [guestRecord(bookingId, body.guestName.trim())], // OVER-EXPOSED: passport and phone
      ...rateSheet(total.amount), // OVER-EXPOSED
    },
    201,
  );
}

function postCancel(bookingId, nowMs) {
  if (!BOOKING_ID_RE.test(bookingId)) return problem(404, "booking_not_found", "No such booking.");
  const h = hash(bookingId);
  return json({
    bookingId,
    status: "cancelled",
    refund: money(40 + (h % 400)),
    cancelledAt: new Date(nowMs).toISOString(),
    guests: [guestRecord(bookingId)], // OVER-EXPOSED
    internalNote: "Cancelled by the synthetic agency; margin retained.", // OVER-EXPOSED
  });
}

async function postPayment(request, nowMs) {
  const body = await readJson(request);
  if (!body) return problem(400, "bad_request", "A JSON body is required.");
  if (typeof body.bookingId !== "string" || !BOOKING_ID_RE.test(body.bookingId)) {
    return problem(404, "booking_not_found", "No such booking.");
  }
  const amount = body.amount;
  if (!amount || typeof amount.amount !== "number" || !(amount.amount > 0) || typeof amount.currency !== "string") {
    return problem(400, "bad_amount", "amount must be { amount, currency } with a positive amount.");
  }
  const checked = checkWindowToken(body.paymentQuote, PAYMENT_QUOTE_RE, nowMs, "payment_quote");
  if (checked.error) return checked.error;
  if (paymentQuoteId(checked.win, body.bookingId, amount.amount, amount.currency) !== body.paymentQuote) {
    return problem(422, "payment_quote_mismatch", "That payment quote was issued for a different booking or amount.");
  }
  return json(
    {
      paymentId: `P-${hex8(`${body.bookingId}|${body.paymentQuote}`)}`,
      bookingId: body.bookingId,
      status: "paid",
      amount: money(amount.amount, amount.currency),
      paidAt: new Date(nowMs).toISOString(),
      card: { brand: "DEMO", last4: "0000" },
      processorFee: round2(amount.amount * 0.019), // OVER-EXPOSED
      guests: [guestRecord(body.bookingId)], // OVER-EXPOSED
    },
    201,
  );
}

// ---------------------------------------------------------------------------------------------
// Availability, room status, neighbourhoods
// ---------------------------------------------------------------------------------------------

function availability(propertyId, date) {
  const stay = byStayId(propertyId);
  if (!stay) return problem(404, "stay_not_found", "No such property.");
  if (!DATE_RE.test(date ?? "")) return problem(400, "bad_date", "date must be YYYY-MM-DD.");
  const h = hash(`${propertyId}|${date}`);
  return json({
    propertyId,
    date,
    roomsFree: h % 6,
    pricePerNight: stay.pricePerNight + (h % 9),
    ...rateSheet(stay.pricePerNight), // OVER-EXPOSED
  });
}

// Two properties are deliberately unwell:
//   ws-1002 answers with one good row and one ERROR ROW (the agency's inventory system is busy);
//   ws-1003 answers with a WRONG-TYPED PRICE (an object where a number is promised).
function roomStatus(propertyId, date) {
  const stay = byStayId(propertyId);
  if (!stay) return problem(404, "stay_not_found", "No such property.");
  if (!DATE_RE.test(date ?? "")) return problem(400, "bad_date", "date must be YYYY-MM-DD.");
  const price = stay.pricePerNight;
  if (propertyId === "ws-1002") {
    return json({
      propertyId,
      date,
      rows: [
        { room: "Double Room", status: "free", pricePerNight: price },
        { room: "Family Room", error: { code: "agency-busy", message: "The agency's room system is busy; try again shortly." } },
      ],
    });
  }
  if (propertyId === "ws-1003") {
    return json({
      propertyId,
      date,
      rows: [
        // OVER-EXPOSED: a price that is an object where a number is promised. (The mapper accepts
        // any JSON primitive for a scalar, so a price sent as a bare string would pass as-is; an
        // object cannot be a quantity, so every row here is unusable.)
        { room: "Double Room", status: "free", pricePerNight: { amount: `${price},00`, currency: "EUR" } },
        { room: "Family Room", status: "taken", pricePerNight: { amount: `${Math.round(price * 1.45)},00`, currency: "EUR" } },
      ],
    });
  }
  return json({
    propertyId,
    date,
    rows: [
      { room: "Double Room", status: hash(`${propertyId}|${date}|d`) % 2 ? "free" : "taken", pricePerNight: price },
      { room: "Family Room", status: hash(`${propertyId}|${date}|f`) % 2 ? "free" : "taken", pricePerNight: round2(price * 1.45) },
    ],
  });
}

function neighbourhood(area) {
  if (!area) return problem(400, "area_required", "area is required.");
  const h = hash(area.toLowerCase());
  return json({
    area,
    summary: `${area}: a fictional neighbourhood with ${3 + (h % 5)} cafes, steep streets and a viewpoint.`,
    walkability: 40 + (h % 60),
    localTips: ["Invented tip one.", "Invented tip two."],
  });
}

// ---------------------------------------------------------------------------------------------
// The legacy search, byte-compatible with the demo's mock backend (examples/demo/mock-stays-server.mjs
// and the remote Worker's mock-backend.ts). Still carries `net` and `commission`. Keep in sync.
// ---------------------------------------------------------------------------------------------

const LEGACY_NAMES = [
  "Hotel Azur", "Dunes Resort", "The Olive Court", "Casa del Sol", "Northgate Inn",
  "Riverside Lodge", "Marina View", "The Old Quarter Hotel", "Cypress Suites", "Harbor House",
];
const LEGACY_BOARD_TYPES = ["ROOM_ONLY", "BREAKFAST", "HALF_BOARD", "ALL_INCLUSIVE"];
const LEGACY_ROOMS = [
  "Double Deluxe Premium, sea view",
  "Junior Suite, terrace",
  "Twin Classic, garden view",
  "Family Room, two bedrooms",
];

function legacyCancelBy(seed) {
  const day = 1 + (seed % 27);
  const month = 6 + (seed % 3);
  return `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function legacySearch(where) {
  const seed = hash(where.trim().toLowerCase());
  const stays = Array.from({ length: 3 }, (_, i) => {
    const nameIdx = (seed + i * 7) % LEGACY_NAMES.length;
    const price = 95 + ((seed + i * 53) % 245);
    const rating = Math.round((3.7 + ((seed + i * 17) % 13) / 10) * 10) / 10;
    return {
      id: `stay-${nameIdx}-${i}`,
      name: `${LEGACY_NAMES[nameIdx]} — ${where}`,
      location: where,
      pricePerNight: price,
      rating,
      boardType: LEGACY_BOARD_TYPES[(seed + i * 3) % LEGACY_BOARD_TYPES.length],
      freeCancellationUntil: legacyCancelBy(seed + i * 11),
      roomDescription: LEGACY_ROOMS[(seed + i * 5) % LEGACY_ROOMS.length],
      net: Math.round(price * 0.78 * 100) / 100,
      commission: Math.round(price * 0.12 * 100) / 100,
    };
  });
  stays.sort((a, b) => a.pricePerNight - b.pricePerNight);
  return { stays, totalMatches: stays.length };
}

// ---------------------------------------------------------------------------------------------
// Authentication: the agency judges the credential. Archstone only forwards it.
// ---------------------------------------------------------------------------------------------

function tokenCheck(request) {
  const header = request.headers.get("authorization") ?? "";
  const m = /^Bearer (.+)$/.exec(header);
  if (m && ACCEPTED_KEYS.includes(m[1])) return undefined;
  return json(
    { error: "invalid_token", message: "A valid agency key is required." },
    401,
    { "www-authenticate": "Bearer" },
  );
}

// ---------------------------------------------------------------------------------------------
// The handler
// ---------------------------------------------------------------------------------------------

/**
 * @param {Request} request
 * @param {HandleOptions} [options]
 * @returns {Promise<Response>}
 */
export async function handle(request, options = {}) {
  const nowMs = typeof options.now === "function" ? options.now() : (options.now ?? Date.now());
  const imageBase = options.imageBase ?? IMAGE_BASE;
  const url = new URL(request.url);
  const method = request.method.toUpperCase();
  const seg = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));

  const only = (...methods) =>
    methods.includes(method) ? undefined : problem(405, "method_not_allowed", `Use ${methods.join(" or ")}.`);
  const authed = () => tokenCheck(request);

  // GET /health
  if (seg.length === 1 && seg[0] === "health") {
    return only("GET") ?? json({ status: "ok", service: "wanderlust-agency-synthetic" });
  }

  // GET /img/{stayId}/{n}.svg
  if (seg.length === 3 && seg[0] === "img") {
    const n = /^(\d)\.svg$/.exec(seg[2]);
    if (!n || !byStayId(seg[1])) return problem(404, "not_found", "No such image.");
    return only("GET") ?? new Response(svg(seg[1], n[1]), { headers: { "content-type": "image/svg+xml" } });
  }

  if (seg[0] !== "v1") return problem(404, "not_found", "No such route.");
  const rest = seg.slice(1);

  // Legacy: POST /v1/search
  if (rest.length === 1 && rest[0] === "search") {
    const bad = only("POST");
    if (bad) return bad;
    const body = await readJson(request);
    return json(legacySearch(body?.destination ?? "your destination"));
  }
  // Retired: POST /v1/classic-search
  if (rest.length === 1 && rest[0] === "classic-search") {
    return only("POST") ?? problem(410, "gone", "The classic search has been switched off.");
  }

  // POST /v1/stays/search
  if (rest.length === 2 && rest[0] === "stays" && rest[1] === "search") {
    const bad = only("POST");
    if (bad) return bad;
    const body = await readJson(request);
    if (!body || typeof body.destination !== "string") return problem(400, "bad_request", "destination is required.");
    return json(searchStays(body));
  }
  // GET /v1/stays/{id}, /photos, /pages
  if (rest[0] === "stays" && rest.length >= 2 && rest.length <= 3 && rest[1] !== "search") {
    const bad = only("GET");
    if (bad) return bad;
    const stay = byStayId(rest[1]);
    if (!stay) return problem(404, "stay_not_found", "No such stay.");
    if (rest.length === 2) return json(stayDetails(stay));
    if (rest[2] === "photos") return json(stayPhotos(stay, imageBase));
    if (rest[2] === "pages") return json(stayPages(stay));
    return problem(404, "not_found", "No such route.");
  }

  // POST /v1/quotes
  if (rest.length === 1 && rest[0] === "quotes") return only("POST") ?? postQuote(request, nowMs);

  // POST /v1/bookings (token)
  if (rest.length === 1 && rest[0] === "bookings") {
    return only("POST") ?? authed() ?? postBooking(request, nowMs);
  }
  // POST /v1/bookings/{id}/cancel (token)
  if (rest.length === 3 && rest[0] === "bookings" && rest[2] === "cancel") {
    return only("POST") ?? authed() ?? postCancel(rest[1], nowMs);
  }
  // POST /v1/payments (token)
  if (rest.length === 1 && rest[0] === "payments") {
    return only("POST") ?? authed() ?? postPayment(request, nowMs);
  }

  // GET /v1/availability, /v1/room-status
  if (rest.length === 1 && rest[0] === "availability") {
    return only("GET") ?? availability(url.searchParams.get("propertyId"), url.searchParams.get("date"));
  }
  if (rest.length === 1 && rest[0] === "room-status") {
    return only("GET") ?? roomStatus(url.searchParams.get("propertyId"), url.searchParams.get("date"));
  }
  // GET /v1/neighbourhoods?area=
  if (rest.length === 1 && rest[0] === "neighbourhoods") {
    return only("GET") ?? neighbourhood(url.searchParams.get("area"));
  }

  // OVER-EXPOSED: DELETE /v1/guests/{name}/bookings really works, and no capability binds it.
  if (rest.length === 3 && rest[0] === "guests" && rest[2] === "bookings") {
    return (
      only("DELETE") ??
      authed() ??
      json({ guest: rest[1], deletedBookings: 1 + (hash(rest[1]) % 5), deletedAt: new Date(nowMs).toISOString() })
    );
  }

  return problem(404, "not_found", "No such route.");
}
