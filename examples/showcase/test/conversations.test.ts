// Conversation-level checks, deterministic: the arguments a model actually sends for the phrasings
// in examples/showcase/conversations/run.mjs, run through the real runtime against the synthetic
// API in-process. Asserts behaviour (nothing invented, nothing silently ignored, every id usable),
// never the wording of a refusal: that belongs to the runtime and changes independently.

import { describe, it, expect } from "vitest";
import { CATALOGUE } from "../api/wanderlust-api.mjs";
import { call, newContext, type RunContext } from "./harness";

const INPUT_INVALID = "dev.archstone/input_invalid";
/** The input contract refused this call before any backend work: the _meta is there, the backend saw nothing. */
function expectRefusedBeforeBackend(ctx: RunContext, r: { isError?: boolean; _meta?: Record<string, unknown> }, callsBefore: number) {
  expect(r.isError).toBe(true);
  const meta = r._meta?.[INPUT_INVALID] as { problems?: { path: string; expected: string }[] } | undefined;
  expect(meta?.problems?.length, "input_invalid problems").toBeGreaterThan(0);
  expect(ctx.spy.calls.length, "backend calls").toBe(callsBefore);
}

const DATES = { from: "2027-05-14", to: "2027-05-16" }; // "next weekend", as ISO
const PARTY = { adults: 2 };
const NAMES = new Set(CATALOGUE.map((s) => s.name));
const byName = (name: string) => CATALOGUE.find((s) => s.name === name)!;

interface Row { id?: string; name: string; location: string; pricePerNight: number; petPolicy?: string }

const SEARCHES = ["wanderlust_search", "tourism_search"] as const;

async function search(ctx: RunContext, tool: string, args: Record<string, unknown>) {
  const r = await call(ctx, tool, { dates: DATES, travelers: PARTY, ...args });
  const stays = ((r.structuredContent as { stays?: Row[] } | undefined)?.stays ?? []) as Row[];
  return { r, stays };
}

/** The invariants that hold for every successful search response. */
function assertSane(stays: Row[], budget?: number) {
  for (const s of stays) {
    expect(s.name, "a name outside the catalogue").toSatisfy((n: string) => NAMES.has(n));
    expect(s.name).not.toMatch(/Generated/);
    if (budget !== undefined) expect(s.pricePerNight).toBeLessThanOrEqual(budget);
  }
}

describe.each(SEARCHES)("%s: destination phrasings", (tool) => {
  const ctx = newContext();
  const lisbon = byName("Casa Alfama").city;

  it.each(["Lisbon", "Lisbon, Portugal", "lisbon", "LISBON", "Lisboa", "Lisabona", "Lisbon Portugal"])(
    "%s finds the four Lisbon stays",
    async (destination) => {
      const { r, stays } = await search(ctx, tool, { destination });
      expect(r.isError).toBeFalsy();
      expect(stays.map((s) => s.name).sort()).toEqual(CATALOGUE.filter((s) => s.city === lisbon).map((s) => s.name).sort());
      assertSane(stays);
    },
  );

  it("Porto, Portugal finds Porto stays", async () => {
    const { stays } = await search(ctx, tool, { destination: "Porto, Portugal" });
    expect(stays.length).toBeGreaterThan(0);
    expect(stays.every((s) => s.location === "Porto")).toBe(true);
  });

  it.each(["Atlantis", "Lisbon, Spain"])("%s is an honest empty result, not an error and not invented stays", async (destination) => {
    const { r, stays } = await search(ctx, tool, { destination });
    expect(r.isError).toBeFalsy();
    expect(stays).toEqual([]);
  });
});

describe.each(SEARCHES)("%s: dates", (tool) => {
  const ctx = newContext();
  it("ISO dates for 'next weekend' work", async () => {
    const { r, stays } = await search(ctx, tool, { destination: "Lisbon" });
    expect(r.isError).toBeFalsy();
    expect(stays.length).toBe(4);
  });
  it("a literal 'next weekend' is refused by the input contract, not an ignored field", async () => {
    const before = ctx.spy.calls.length;
    const r = await call(ctx, tool, { destination: "Lisbon", dates: "next weekend", travelers: PARTY });
    expectRefusedBeforeBackend(ctx, r, before);
  });
});

describe.each(SEARCHES)("%s: budget", (tool) => {
  const ctx = newContext();
  it("a per-night EUR ceiling is honoured", async () => {
    const { r, stays } = await search(ctx, tool, { destination: "Lisbon", budget: { amount: 150, currency: "EUR" } });
    expect(r.isError).toBeFalsy();
    expect(stays.length).toBe(4);
    const tight = await search(ctx, tool, { destination: "Lisbon", budget: { amount: 100, currency: "EUR" } });
    expect(tight.stays.map((s) => s.name).sort()).toEqual(["Pensão Azul", "Rio Tejo Lofts"]);
    assertSane(tight.stays, 100);
  });
  it("a ceiling nothing meets is an empty result", async () => {
    const { r, stays } = await search(ctx, tool, { destination: "Lisbon", budget: { amount: 10, currency: "EUR" } });
    expect(r.isError).toBeFalsy();
    expect(stays).toEqual([]);
  });
  it("another currency is an error, not silently treated as EUR", async () => {
    const r = await call(ctx, tool, { destination: "Lisbon", dates: DATES, travelers: PARTY, budget: { amount: 150, currency: "USD" } });
    expect(r.isError).toBe(true);
  });
  it.each([150, "150 EUR"])("a budget sent as %j is refused before the backend, not ignored", async (budget) => {
    const before = ctx.spy.calls.length;
    const r = await call(ctx, tool, { destination: "Lisbon", dates: DATES, travelers: PARTY, budget });
    expectRefusedBeforeBackend(ctx, r, before);
  });
  it.each([
    ["city", { city: "Lisbon" }],
    ["checkIn/checkOut", { checkIn: "2027-05-12", checkOut: "2027-05-15" }],
    ["guests", { guests: 2 }],
    ["maxPrice", { maxPrice: 150 }],
  ])("an undeclared key (%s) is refused before the backend, not dropped", async (_label, extra) => {
    const before = ctx.spy.calls.length;
    const r = await call(ctx, tool, { destination: "Lisbon", dates: DATES, travelers: PARTY, ...extra });
    expectRefusedBeforeBackend(ctx, r, before);
  });
  it("negative travellers are refused before the backend", async () => {
    const before = ctx.spy.calls.length;
    const r = await call(ctx, tool, { destination: "Lisbon", dates: DATES, travelers: { adults: -1 } });
    expectRefusedBeforeBackend(ctx, r, before);
  });
});

describe.each(SEARCHES)("%s: preferences", (tool) => {
  const ctx = newContext();
  const petFriendly = CATALOGUE.filter((s) => s.city === "Lisbon" && s.petPolicy !== "No pets").map((s) => s.name).sort();

  it.each(["pets", "pet-friendly", "cat", "dog", "pets-allowed"])("%j gives the pet-allowing subset", async (tag) => {
    const { r, stays } = await search(ctx, tool, { destination: "Lisbon", preferences: [tag] });
    expect(r.isError).toBeFalsy();
    expect(stays.map((s) => s.name).sort()).toEqual(petFriendly);
    expect(petFriendly.length).toBeGreaterThan(0);
    expect(petFriendly.length).toBeLessThan(4);
  });

  it("preferences is a declared input, so it is never refused", async () => {
    const before = ctx.spy.calls.length;
    const { r } = await search(ctx, tool, { destination: "Lisbon", preferences: ["pets", "sea view"] });
    expect(r.isError).toBeFalsy();
    expect(r._meta?.[INPUT_INVALID]).toBeUndefined();
    expect(ctx.spy.calls.length).toBe(before + 1);
  });

  it("an unknown tag is ignored", async () => {
    const { r, stays } = await search(ctx, tool, { destination: "Lisbon", preferences: ["sea view"] });
    expect(r.isError).toBeFalsy();
    expect(stays.length).toBe(4);
  });

  it("pets plus a budget combine", async () => {
    const { stays } = await search(ctx, tool, { destination: "Lisbon", preferences: ["cat"], budget: { amount: 100, currency: "EUR" } });
    expect(stays.map((s) => s.name)).toEqual(["Pensão Azul"]);
  });
});

describe("wanderlust_search: what the model is shown", () => {
  const ctx = newContext();

  it("declares petPolicy on each row, and on the details of the same stay", async () => {
    const { stays } = await search(ctx, "wanderlust_search", { destination: "Lisbon", preferences: ["pets"] });
    expect(stays.length).toBeGreaterThan(0);
    for (const s of stays) {
      expect(s.petPolicy, s.name).toBe(byName(s.name).petPolicy);
      const d = await call(ctx, "wanderlust_stay-details", { stayId: s.id });
      expect((d.structuredContent as { stay?: { petPolicy?: string } }).stay?.petPolicy).toBe(s.petPolicy);
    }
  });

  it("every id it returns resolves on details, photos, page, quote and availability", async () => {
    const cities = [...new Set(CATALOGUE.map((s) => s.city))];
    let seen = 0;
    for (const destination of cities) {
      for (const extra of [{}, { budget: { amount: 120, currency: "EUR" } }, { preferences: ["cat"] }]) {
        const { stays } = await search(ctx, "wanderlust_search", { destination, ...extra });
        for (const s of stays) {
          seen++;
          const stayId = s.id!;
          const followUps: [string, Record<string, unknown>][] = [
            ["wanderlust_stay-details", { stayId }],
            ["wanderlust_stay-photos", { stayId }],
            ["wanderlust_stay-page", { stayId }],
            ["wanderlust_quote", { stayId, dates: DATES, travelers: PARTY }],
            ["wanderlust_availability", { propertyId: stayId, date: "2027-06-05" }],
          ];
          for (const [name, args] of followUps) {
            // availability is rate-limited to 3 a minute per caller by design: a fresh counter each time
            const r = await call(name === "wanderlust_availability" ? newContext({ registry: ctx.registry }) : ctx, name, args);
            expect(r.isError, `${name} ${stayId}`).toBeFalsy();
          }
        }
      }
    }
    expect(seen).toBeGreaterThan(20);
  });
});
