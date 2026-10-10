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

/** The origin the agency's own images answer on: the public demo Worker, which serves `/img/...`
 *  from the same script as the API. Constant on purpose: not derived from the request, so the output
 *  is identical under any runtime and any local address (a local run still names this origin). The
 *  stay-photos binding declares the same origin; change the two together. */
export const IMAGE_BASE = "https://demo.archstone.dev";
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

// Fictional properties, listed in the AGENCY's own order: not by price, not by rating. Archstone
// ranks nothing; whatever order the agency chooses is the order a model sees. This is the ONE
// catalogue: both searches, details, photos, pages, quote and availability read it, so every id the
// API emits resolves everywhere by construction. ws-1001..ws-1004 are the Lisbon rows the scenarios
// and the recorded transcripts depend on; do not change them.
const NO_PETS = "No pets";
const stay = (id, city, country, name, slug, pricePerNight, rating, petPolicy, breakfast, family) => ({
  id, city, country, name, slug, pricePerNight, rating, petPolicy, breakfast, family,
});
/** @type {readonly Readonly<{ id: string, city: string, country: string, name: string, slug: string, pricePerNight: number, rating: number, petPolicy: string, breakfast: boolean, family: boolean }>[]} */
export const CATALOGUE = [
  stay("ws-1001", "Lisbon", "Portugal", "Casa Alfama", "casa-alfama", 118, 4.6, "Cats and small dogs welcome, EUR 10 per night", true, false),
  stay("ws-1003", "Lisbon", "Portugal", "Miradouro Court", "miradouro-court", 139, 4.8, NO_PETS, true, true),
  stay("ws-1002", "Lisbon", "Portugal", "Pensão Azul", "pensao-azul", 74, 4.1, "Pets welcome, free of charge", false, true),
  stay("ws-1004", "Lisbon", "Portugal", "Rio Tejo Lofts", "rio-tejo-lofts", 96, 4.3, NO_PETS, false, false),
  stay("ws-2001", "Porto", "Portugal", "Ribeira Terrace", "ribeira-terrace", 89, 4.4, "Dogs welcome, EUR 12 per night", true, false),
  stay("ws-2002", "Porto", "Portugal", "Douro Light House", "douro-light-house", 124, 4.7, NO_PETS, true, true),
  stay("ws-2003", "Porto", "Portugal", "Clerigos Rooms", "clerigos-rooms", 67, 4.0, NO_PETS, false, false),
  stay("ws-3001", "Barcelona", "Spain", "Gracia Courtyard", "gracia-courtyard", 132, 4.5, "Cats welcome, EUR 15 per night", true, true),
  stay("ws-3002", "Barcelona", "Spain", "Born Atelier", "born-atelier", 158, 4.7, NO_PETS, true, false),
  stay("ws-3003", "Barcelona", "Spain", "Poblenou Beach Flats", "poblenou-beach-flats", 110, 4.2, "Pets welcome, free of charge", false, true),
  stay("ws-4001", "Nice", "France", "Promenade Maison", "promenade-maison", 171, 4.6, NO_PETS, true, false),
  stay("ws-4002", "Nice", "France", "Vieux Nice Suites", "vieux-nice-suites", 129, 4.3, "Cats welcome, EUR 10 per night", false, false),
  stay("ws-4003", "Nice", "France", "Cimiez Garden Hotel", "cimiez-garden-hotel", 98, 4.1, "Pets welcome, free of charge", true, true),
  stay("ws-5001", "Bucharest", "Romania", "Calea Victoriei Loft", "calea-victoriei-loft", 72, 4.4, "Small pets welcome, EUR 8 per night", false, false),
  stay("ws-5002", "Bucharest", "Romania", "Cismigiu Garden Rooms", "cismigiu-garden-rooms", 58, 4.0, NO_PETS, true, true),
  stay("ws-5003", "Bucharest", "Romania", "Lipscani House", "lipscani-house", 85, 4.5, "Pets welcome, free of charge", true, true),
];
const byStayId = (id) => CATALOGUE.find((s) => s.id === id);

// -- Destination resolver ---------------------------------------------------------------------
// One pure function shared by both searches. Case-, diacritics- and punctuation-insensitive; a
// "City, Country" or "City Country" form is accepted; a country that contradicts the city
// ("Lisbon, Spain") matches nothing. No fuzzy matching: an unknown place is an honest empty result.

/** city -> accepted spellings, already folded (lower case, no diacritics). */
const CITY_ALIASES = {
  Lisbon: ["lisbon", "lisboa", "lisabona", "lisbonne", "lissabon"],
  Porto: ["porto", "oporto"],
  Barcelona: ["barcelona", "barcelone"],
  Nice: ["nice", "nizza", "nisa"],
  Bucharest: ["bucharest", "bucuresti", "bucarest", "bukarest"],
};
const COUNTRY_ALIASES = {
  Portugal: ["portugal", "portugalia"],
  Spain: ["spain", "espana", "spania"],
  France: ["france", "franta"],
  Romania: ["romania"],
};
const CITY_COUNTRY = Object.fromEntries(CATALOGUE.map((s) => [s.city, s.country]));

const fold = (text) =>
  String(text)
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();

/** @param {unknown} text @returns {string | undefined} the catalogue city, or undefined */
export function resolveDestination(text) {
  if (typeof text !== "string") return undefined;
  const segments = fold(text)
    .split(/[,;\-\u2013\u2014/()]+/)
    .map((seg) => seg.replace(/[^a-z0-9 ]+/g, " ").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const cities = [];
  const countries = [];
  for (const segment of segments) {
    let rest = segment;
    for (const [country, names] of Object.entries(COUNTRY_ALIASES)) {
      for (const name of names) {
        const re = new RegExp(`(^| )${name}( |$)`);
        if (re.test(rest)) {
          if (!countries.includes(country)) countries.push(country);
          rest = rest.replace(re, " ").trim();
        }
      }
    }
    if (rest === "") continue;
    const city = Object.keys(CITY_ALIASES).find((c) => CITY_ALIASES[c].includes(rest));
    if (!city) return undefined;
    if (!cities.includes(city)) cities.push(city);
  }
  if (cities.length !== 1) return undefined;
  const [city] = cities;
  for (const country of countries) if (country !== CITY_COUNTRY[city]) return undefined;
  return city;
}

// -- Preferences ------------------------------------------------------------------------------
// Recognised tags: pets, breakfast, family (AND semantics). Synonyms are normalised; anything else
// is ignored, and the capability's input description says so.
const PREFERENCE_SYNONYMS = {
  pets: ["pets", "pet", "pet friendly", "pets allowed", "pet allowed", "pets welcome", "cat", "cats", "dog", "dogs", "animals"],
  breakfast: ["breakfast", "breakfast included", "with breakfast"],
  family: ["family", "family friendly", "families", "kids", "children", "child friendly", "kid friendly"],
};
/** @param {unknown} list @returns {string[]} the recognised tags, de-duplicated */
export function normalizePreferences(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    if (typeof item !== "string") continue;
    const key = fold(item).replace(/[^a-z0-9]+/g, " ").trim();
    for (const [tag, names] of Object.entries(PREFERENCE_SYNONYMS)) if (names.includes(key) && !out.includes(tag)) out.push(tag);
  }
  return out;
}
const hasTag = (stay, tag) =>
  tag === "pets" ? stay.petPolicy !== NO_PETS : tag === "breakfast" ? stay.breakfast : stay.family;

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
    location: stay.city,
    pricePerNight: stay.pricePerNight,
    ...(stay.rating !== undefined ? { rating: stay.rating } : {}),
    petPolicy: stay.petPolicy,
    currency: "EUR",
    ...rateSheet(stay.pricePerNight), // OVER-EXPOSED: net, margin, commission on every row
    description_html: descriptionHtml(stay), // OVER-EXPOSED
    hostContact: { name: "Front Desk (fictional)", phone: "+00 000 000 000" }, // OVER-EXPOSED
  };
}

/**
 * The search both endpoints share: resolve the destination, validate dates and budget, filter.
 * @returns {{ error: Response } | { stays: typeof CATALOGUE[number][] }}
 */
function findStays(body) {
  if (body.dates !== undefined && !parseDates(body.dates)) {
    return { error: problem(400, "bad_dates", "dates must be { from, to } as YYYY-MM-DD, 1 to 30 nights.") };
  }
  let ceiling;
  if (body.budget !== undefined && body.budget !== null) {
    const b = body.budget;
    if (typeof b !== "object" || typeof b.amount !== "number" || !(b.amount >= 0)) {
      return { error: problem(400, "bad_budget", "budget must be { amount, currency }: the maximum nightly rate in EUR.") };
    }
    if (b.currency !== undefined && b.currency !== "EUR") {
      return {
        error: problem(400, "unsupported_currency", `Budget currency ${JSON.stringify(b.currency)} is not supported; send the maximum nightly rate in EUR.`),
      };
    }
    ceiling = b.amount;
  }
  const city = resolveDestination(body.destination);
  if (!city) return { stays: [] };
  const tags = normalizePreferences(body.preferences);
  const stays = CATALOGUE.filter(
    (s) => s.city === city && (ceiling === undefined || s.pricePerNight <= ceiling) && tags.every((t) => hasTag(s, t)),
  );
  return { stays };
}

function searchStays(body) {
  const found = findStays(body);
  if (found.error) return found.error;
  return json({ stays: found.stays.map(stayRow), totalMatches: found.stays.length });
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
    location: stay.city,
    pricePerNight: stay.pricePerNight,
    ...(stay.rating !== undefined ? { rating: stay.rating } : {}),
    petPolicy: stay.petPolicy,
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
// The legacy search: the same catalogue, resolver and filters as the current one, in the old row
// shape. Still carries `net` and `commission`, and still orders by price.
// ---------------------------------------------------------------------------------------------

const LEGACY_ROOMS = [
  "Double Deluxe Premium, sea view",
  "Junior Suite, terrace",
  "Twin Classic, garden view",
];

function legacyCancelBy(seed) {
  const day = 1 + (seed % 27);
  const month = 6 + (seed % 3);
  return `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function legacyRow(stay) {
  const seed = hash(stay.id);
  return {
    id: stay.id,
    name: stay.name,
    location: stay.city,
    pricePerNight: stay.pricePerNight,
    rating: stay.rating,
    boardType: stay.breakfast ? "BREAKFAST" : "ROOM_ONLY",
    freeCancellationUntil: legacyCancelBy(seed),
    roomDescription: stay.family ? "Family Room, two bedrooms" : LEGACY_ROOMS[seed % LEGACY_ROOMS.length],
    net: round2(stay.pricePerNight * 0.78),
    commission: round2(stay.pricePerNight * 0.12),
  };
}

function legacySearch(body) {
  const found = findStays(body);
  if (found.error) return found.error;
  const stays = found.stays.map(legacyRow).sort((a, b) => a.pricePerNight - b.pricePerNight);
  return json({ stays, totalMatches: stays.length });
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
  let seg;
  try {
    seg = url.pathname.split("/").filter(Boolean).map((s) => decodeURIComponent(s));
  } catch {
    return problem(400, "bad_request", "The path contains a malformed % sequence.");
  }

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
    if (!body) return problem(400, "bad_request", "A JSON body is required.");
    return legacySearch(body);
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
    return searchStays(body);
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
