// #182 — one money-shape rule, two paths. `applyResponseMapping` (provider → model) and
// `validateExtraction` (model → business system) must return the same verdict on the same value.
import { describe, it, expect } from "vitest";
import type { IRField, IRResourceRegistry, IRTool } from "@archstone/compiler";
import { applyResponseMapping } from "../src/mapping";
import { validateExtraction } from "../src/extraction";
import { isMoneyShape } from "../src/money";

const GOOD: unknown[] = [
  { amount: 129, currency: "EUR" },
  { amount: 0, currency: "RON" },
  { amount: -5.5, currency: "USD" },
];
const BAD: unknown[] = [
  "129.00", 120, true, null, [120, "EUR"],
  {}, { amount: 120 }, { currency: "EUR" },
  { amount: "129.00", currency: "EUR" },
  { amount: Number.POSITIVE_INFINITY, currency: "EUR" },
  { amount: Number.NaN, currency: "EUR" },
  { amount: 120, currency: "euro" },
  { amount: 120, currency: "eur" },
  { amount: 120, currency: "" },
  { amount: 120, currency: "EU" },
  { amount: 120, currency: "EURO" },
  { amount: 120, currency: 978 },
  { amount: 120, currency: "EUR\n" },
];

function mapVerdict(required: boolean, value: unknown): "pass" | "withheld" | "violation" {
  const resources: IRResourceRegistry = {
    Stay: [
      { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "v", required, type: { kind: "scalar", semantic: "money" } },
    ],
  };
  const tool: IRTool = {
    id: "t.search",
    description: "",
    effect: "read",
    provider: "stays",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [{ name: "stays", required: true, type: { kind: "collection", of: "Stay" } }],
    connector: { type: "rest", rest: { method: "GET", path: "/stays" } },
    response: {
      resource: "Stay",
      field: "stays",
      collection: "$.stays[*]",
      fields: ["name", "v"].map((name) => ({ name, path: `$.${name}` })),
    },
  };
  const r = applyResponseMapping(tool, { stays: [{ name: "Casa", v: value }] }, resources);
  if (r.status === "ok") return "pass";
  return r.status === "degraded" ? "withheld" : "violation";
}

function extractVerdict(required: boolean, value: unknown): "pass" | "withheld" | "violation" {
  const fields: IRField[] = [{ name: "v", required, type: { kind: "scalar", semantic: "money" } }];
  const r = validateExtraction(fields, { v: value });
  if (r.status === "ok") return "pass";
  return r.status === "degraded" ? "withheld" : "violation";
}

describe("#182: money shape parity between mapping and extraction", () => {
  it("both paths accept exactly what the shared validator accepts", () => {
    for (const value of [...GOOD, ...BAD]) {
      for (const required of [true, false]) {
        const label = `${required ? "required" : "optional"} ${JSON.stringify(value)}`;
        if (value === null) continue; // null is absence on both paths, not a shape question
        const shape = isMoneyShape(value);
        expect(mapVerdict(required, value) === "pass", label).toBe(shape);
        expect(extractVerdict(required, value) === "pass", label).toBe(shape);
      }
    }
  });

  it("a malformed value follows each path's own existing rule: mapping withholds an optional field; extraction never repairs, so it is a violation (ADR-0011)", () => {
    for (const bad of BAD) {
      if (bad === null) continue;
      expect(mapVerdict(false, bad), JSON.stringify(bad)).toBe("withheld");
      expect(mapVerdict(true, bad), JSON.stringify(bad)).toBe("violation");
      expect(extractVerdict(false, bad), JSON.stringify(bad)).toBe("violation");
      expect(extractVerdict(true, bad), JSON.stringify(bad)).toBe("violation");
    }
  });

  it("extraction keeps only amount and currency and names the rest", () => {
    const fields: IRField[] = [{ name: "v", required: true, type: { kind: "scalar", semantic: "money" } }];
    const r = validateExtraction(fields, { v: { amount: 1, currency: "EUR", netRate: 0.7 } });
    expect(r.data).toEqual({ v: { amount: 1, currency: "EUR" } });
    expect(r.undeclared).toEqual(["v.netRate"]);
  });
});
