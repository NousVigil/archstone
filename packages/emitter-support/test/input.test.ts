import { describe, it, expect } from "vitest";
import type { IRField, IRResourceRegistry } from "@archstone/compiler";
import { validateInput, inputInvalidMessage, MAX_INPUT_PROBLEMS } from "../src/input";
import { inputJsonSchema } from "../src/lowering";

// #195 — validateInput holds a caller to the contract inputJsonSchema advertises. The drift test at
// the bottom is the point: both are driven off the same IR fields, so a change to one that is not
// mirrored in the other fails here.

const scalar = (name: string, semantic: IRField["type"] extends infer T ? (T extends { kind: "scalar"; semantic: infer S } ? S : never) : never, required = true, values?: string[]): IRField => ({
  name,
  required,
  type: { kind: "scalar", semantic, ...(values ? { values } : {}) },
});

const fields: IRField[] = [
  scalar("destination", "location"),
  scalar("dates", "date-range"),
  scalar("travelers", "party"),
  scalar("budget", "money", false),
  scalar("tier", "enum", false, ["basic", "plus"]),
  scalar("nights", "quantity", false),
  scalar("checkin", "date", false),
  scalar("at", "datetime", false),
  scalar("prefs", "preference-set", false),
  { name: "tags", required: false, type: { kind: "list", items: "string" } },
  { name: "guest", required: false, type: { kind: "resource", name: "Guest" } },
  { name: "guests", required: false, type: { kind: "collection", of: "Guest" } },
  { name: "hotelId", required: false, type: { kind: "resource", name: "Hotel", identity: true } },
];
const resources: IRResourceRegistry = {
  Guest: [scalar("name", "string"), scalar("age", "quantity", false)],
};
const valid = {
  destination: "Lisbon",
  dates: { from: "2027-05-12", to: "2027-05-15" },
  travelers: { adults: 2 },
};

const problemsOf = (args: unknown) => {
  const r = validateInput(fields, args, resources);
  return r.ok ? [] : r.problems;
};

describe("validateInput — accepts what the contract allows", () => {
  it("a minimal valid input", () => expect(validateInput(fields, valid, resources)).toEqual({ ok: true }));
  it("every optional field, well-formed", () => {
    expect(
      validateInput(
        fields,
        {
          ...valid,
          travelers: { adults: 2, children: 1 },
          budget: { amount: 150.5, currency: "EUR" },
          tier: "plus",
          nights: 3,
          checkin: "2028-02-29",
          at: "2027-05-12T10:00:00+02:00",
          prefs: ["quiet"],
          tags: ["a", "b"],
          guest: { name: "Ana", age: 31 },
          guests: [{ name: "Ana" }, { name: "Bo" }],
          hotelId: "h-1",
        },
        resources,
      ),
    ).toEqual({ ok: true });
  });
  it("null on an optional field is absent, as the REST provider already treats it", () => {
    expect(validateInput(fields, { ...valid, budget: null, tier: undefined }, resources)).toEqual({ ok: true });
  });
});

describe("validateInput — refusals name a path and an expectation", () => {
  it("the operator-injection repro: object for a string, string for a date-range, number for a party", () => {
    const p = problemsOf({ destination: { $ne: 1 }, dates: "tomorrow", travelers: -1 });
    expect(p).toEqual([
      { path: "destination", expected: "string" },
      { path: "dates", expected: "object" },
      { path: "travelers", expected: "object" },
    ]);
  });
  it("missing required, including null on a required field", () => {
    expect(problemsOf({ dates: valid.dates, travelers: valid.travelers })).toEqual([{ path: "destination", expected: "required" }]);
    expect(problemsOf({ ...valid, destination: null })).toEqual([{ path: "destination", expected: "required" }]);
  });
  it("enum miss and non-string enum", () => {
    expect(problemsOf({ ...valid, tier: "gold" })).toEqual([{ path: "tier", expected: "one of the declared values" }]);
    expect(problemsOf({ ...valid, tier: 1 })).toEqual([{ path: "tier", expected: "string" }]);
  });
  it("no coercion: a numeric string is not a number, a number is not a string", () => {
    expect(problemsOf({ ...valid, nights: "3" })).toEqual([{ path: "nights", expected: "number" }]);
    expect(problemsOf({ ...valid, destination: 7 })).toEqual([{ path: "destination", expected: "string" }]);
    expect(problemsOf({ ...valid, nights: Number.NaN })).toEqual([{ path: "nights", expected: "number" }]);
  });
  it("date-range members must be real calendar dates", () => {
    expect(problemsOf({ ...valid, dates: { from: "2027-02-30", to: "2027-05-15" } })).toEqual([{ path: "dates.from", expected: "date (YYYY-MM-DD)" }]);
    expect(problemsOf({ ...valid, dates: { from: "2027-05-12" } })).toEqual([{ path: "dates.to", expected: "required" }]);
    expect(problemsOf({ ...valid, dates: { from: "tomorrow", to: 4 } })).toHaveLength(2);
  });
  it("party counts are non-negative integers", () => {
    expect(problemsOf({ ...valid, travelers: { adults: -1 } })).toEqual([{ path: "travelers.adults", expected: "non-negative integer" }]);
    expect(problemsOf({ ...valid, travelers: { adults: 1.5, children: -2 } })).toHaveLength(2);
    expect(problemsOf({ ...valid, travelers: { children: 1 } })).toEqual([{ path: "travelers.adults", expected: "required" }]);
  });
  it("money needs a numeric amount and a string currency", () => {
    expect(problemsOf({ ...valid, budget: { amount: "150", currency: "EUR" } })).toEqual([{ path: "budget.amount", expected: "number" }]);
    expect(problemsOf({ ...valid, budget: { amount: 1 } })).toEqual([{ path: "budget.currency", expected: "required" }]);
  });
  it("datetime must be RFC 3339 with an offset", () => {
    expect(problemsOf({ ...valid, at: "2027-05-12 10:00" })).toEqual([{ path: "at", expected: "date-time (RFC 3339)" }]);
    expect(problemsOf({ ...valid, at: "2027-05-12T25:00:00Z" })).toHaveLength(1);
  });
  it("list items and collection items carry an index in the path", () => {
    expect(problemsOf({ ...valid, tags: ["a", 2] })).toEqual([{ path: "tags[1]", expected: "string" }]);
    expect(problemsOf({ ...valid, prefs: [{}] })).toEqual([{ path: "prefs[0]", expected: "string" }]);
    expect(problemsOf({ ...valid, guests: [{ name: "Ana" }, { age: 3 }] })).toEqual([{ path: "guests[1].name", expected: "required" }]);
    expect(problemsOf({ ...valid, guest: "Ana" })).toEqual([{ path: "guest", expected: "object" }]);
  });
  it("a non-object argument bundle is refused", () => {
    for (const bad of [null, undefined, "x", 3, []]) expect(problemsOf(bad)).toEqual([{ path: "$", expected: "object" }]);
  });
});

describe("validateInput — undeclared keys are refused, never echoed", () => {
  it("top level, reported once against $", () => {
    expect(problemsOf({ ...valid, evil: 1, evil2: 2 })).toEqual([{ path: "$", expected: "no undeclared properties" }]);
  });
  it("inside a composite and inside a resource", () => {
    expect(problemsOf({ ...valid, travelers: { adults: 1, injected: 1 } })).toEqual([{ path: "travelers", expected: "no undeclared properties" }]);
    expect(problemsOf({ ...valid, dates: { ...valid.dates, x: 1 } })).toEqual([{ path: "dates", expected: "no undeclared properties" }]);
    expect(problemsOf({ ...valid, budget: { amount: 1, currency: "EUR", x: 1 } })).toEqual([{ path: "budget", expected: "no undeclared properties" }]);
    expect(problemsOf({ ...valid, guest: { name: "A", x: 1 } })).toEqual([{ path: "guest", expected: "no undeclared properties" }]);
  });
  it("a caller-field name supplied by the caller is just an undeclared key", () => {
    expect(problemsOf({ ...valid, "caller.accessToken": "t", accessToken: "t" })).toEqual([{ path: "$", expected: "no undeclared properties" }]);
  });
  it("an own __proto__ key (from JSON.parse) is undeclared, not special", () => {
    expect(problemsOf(JSON.parse('{"destination":"x","dates":{"from":"2027-01-01","to":"2027-01-02"},"travelers":{"adults":1},"__proto__":{"a":1}}'))).toEqual([
      { path: "$", expected: "no undeclared properties" },
    ]);
  });
});

describe("validateInput — bounded output, no leaks", () => {
  it("caps at MAX_INPUT_PROBLEMS and says so", () => {
    const r = validateInput(fields, { ...valid, tags: Array.from({ length: 1000 }, () => 1) }, resources);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.problems).toHaveLength(MAX_INPUT_PROBLEMS);
      expect(r.truncated).toBe(true);
    }
  });
  it("exactly the cap is not truncated", () => {
    const r = validateInput(fields, { ...valid, tags: Array.from({ length: MAX_INPUT_PROBLEMS }, () => 1) }, resources);
    expect(r.ok === false && r.truncated).toBeFalsy();
  });
  it("neither the problems nor the message contain a sent value or a sent key", () => {
    const sent = { destination: { SECRET_KEY_9: "SECRET_VALUE_9" }, dates: "SECRET_DATE_9", travelers: { adults: 1, SECRET_KEY_8: 1 }, SECRET_KEY_7: 1, tier: "SECRET_TIER_9" };
    const r = validateInput(fields, sent, resources);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    const text = JSON.stringify(r) + inputInvalidMessage("stays.search", r.problems, r.truncated);
    expect(text).not.toMatch(/SECRET/);
  });
});

// Drift: for each semantic type, take samples the advertised JSON Schema accepts/rejects and assert
// validateInput agrees. The schema side is a tiny interpreter over exactly the keywords the
// lowering emits (type, enum, format date/date-time, minimum, properties, required,
// additionalProperties, items), so a new keyword in the lowering that the interpreter does not know
// fails loudly rather than being silently ignored.
describe("drift: validateInput agrees with inputJsonSchema", () => {
  type S = Record<string, unknown>;
  const KNOWN = new Set(["type", "description", "enum", "format", "minimum", "properties", "required", "additionalProperties", "items"]);
  function accepts(schema: S, v: unknown): boolean {
    for (const k of Object.keys(schema)) if (!KNOWN.has(k)) throw new Error(`drift test does not understand keyword '${k}'`);
    const t = schema.type;
    if (t === "string") {
      if (typeof v !== "string") return false;
      if (schema.enum && !(schema.enum as string[]).includes(v)) return false;
      if (schema.format === "date") return /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v)) && new Date(v).toISOString().startsWith(v);
      if (schema.format === "date-time") return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(v) && !Number.isNaN(Date.parse(v));
      return true;
    }
    if (t === "number") return typeof v === "number" && Number.isFinite(v);
    if (t === "integer") return typeof v === "number" && Number.isInteger(v) && (schema.minimum === undefined || v >= (schema.minimum as number));
    if (t === "array") return Array.isArray(v) && v.every((x) => accepts(schema.items as S, x));
    if (t === "object") {
      if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
      const props = (schema.properties ?? {}) as Record<string, S>;
      const o = v as Record<string, unknown>;
      if (schema.additionalProperties === false && Object.keys(o).some((k) => !(k in props))) return false;
      if (((schema.required ?? []) as string[]).some((r) => o[r] === undefined)) return false;
      return Object.entries(props).every(([k, s]) => o[k] === undefined || accepts(s, o[k]));
    }
    throw new Error(`drift test does not understand type '${String(t)}'`);
  }

  const samples: unknown[] = [
    "", "x", "2027-05-12", "2027-02-30", "2027-05-12T10:00:00Z", "2027-05-12T10:00:00+02:00", "2027-05-12 10:00",
    0, 1, -1, 1.5, "3", null, true, [], ["a"], [1], {}, { from: "2027-01-01", to: "2027-01-02" }, { from: "2027-01-01" },
    { adults: 1 }, { adults: 0, children: 2 }, { adults: -1 }, { adults: 1.5 }, { adults: 1, x: 1 }, { amount: 1, currency: "EUR" },
    { amount: "1", currency: "EUR" }, { amount: 1 }, { $ne: 1 }, "basic", "gold",
  ];
  const semantics = ["location", "date-range", "party", "preference-set", "money", "identifier", "string", "text", "time-slot", "quantity", "enum", "date", "datetime"] as const;

  for (const semantic of semantics) {
    it(`${semantic}: every sample is judged the same by the schema and by validateInput`, () => {
      const f: IRField[] = [{ name: "f", required: true, type: { kind: "scalar", semantic, ...(semantic === "enum" ? { values: ["basic", "plus"] } : {}) } }];
      const schema = inputJsonSchema(f) as { properties: Record<string, S> } & S;
      for (const sample of samples) {
        const viaSchema = sample === null ? false : accepts(schema, { f: sample });
        const viaValidator = validateInput(f, { f: sample }).ok;
        expect({ semantic, sample, ok: viaValidator }).toEqual({ semantic, sample, ok: viaSchema });
      }
    });
  }

  it("the advertised schema is closed, and party counts have a minimum of 0", () => {
    const s = inputJsonSchema(fields, resources) as { additionalProperties?: boolean; properties: Record<string, S> };
    expect(s.additionalProperties).toBe(false);
    const party = s.properties.travelers as { additionalProperties?: boolean; properties: Record<string, S> };
    expect(party.additionalProperties).toBe(false);
    expect(party.properties.adults.minimum).toBe(0);
    expect(party.properties.children.minimum).toBe(0);
    expect((s.properties.guest as S).additionalProperties).toBe(false);
  });
});
