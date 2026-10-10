import { describe, it, expect } from "vitest";
import type { IR, IRTool } from "@archstone/compiler";
import type { ExecutionRecord } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { fromIR } from "../src/index";

// #195 — the SAME input-contract gate on the embedded execute() path.

const search: IRTool = {
  id: "stays.search",
  description: "Find stays.",
  effect: "read",
  provider: "booking",
  policies: [],
  lifecycle: "stable",
  input: [
    { name: "destination", required: true, type: { kind: "scalar", semantic: "location" } },
    { name: "dates", required: true, type: { kind: "scalar", semantic: "date-range" } },
    { name: "travelers", required: true, type: { kind: "scalar", semantic: "party" } },
    { name: "budget", required: false, type: { kind: "scalar", semantic: "money" } },
    { name: "tier", required: false, type: { kind: "scalar", semantic: "enum", values: ["basic", "plus"] } },
  ],
  output: [],
  connector: { type: "rest", rest: { baseUrl: "https://stays.example", method: "POST", path: "/search" } },
};
const artifact = (tool: IRTool = search): IR => ({ version: "0", company: { id: "acme" }, tools: [tool], resources: {} });

function spy(): { fetchImpl: FetchLike; calls: () => number } {
  let n = 0;
  return {
    fetchImpl: async () => {
      n += 1;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    },
    calls: () => n,
  };
}
const valid = { destination: "Lisbon", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };

const refusals: { name: string; args: Record<string, unknown>; problems: { path: string; expected: string }[] }[] = [
  {
    name: "the issue repro",
    args: { destination: { $ne: 1 }, dates: "tomorrow", travelers: -1 },
    problems: [
      { path: "destination", expected: "string" },
      { path: "dates", expected: "object" },
      { path: "travelers", expected: "object" },
    ],
  },
  { name: "wrong type", args: { ...valid, destination: 42 }, problems: [{ path: "destination", expected: "string" }] },
  { name: "missing required", args: { dates: valid.dates, travelers: valid.travelers }, problems: [{ path: "destination", expected: "required" }] },
  { name: "enum miss", args: { ...valid, tier: "gold" }, problems: [{ path: "tier", expected: "one of the declared values" }] },
  { name: "malformed date-range", args: { ...valid, dates: { from: "2027-13-40", to: "2027-05-15" } }, problems: [{ path: "dates.from", expected: "date (YYYY-MM-DD)" }] },
  { name: "malformed party", args: { ...valid, travelers: { adults: -1 } }, problems: [{ path: "travelers.adults", expected: "non-negative integer" }] },
  { name: "malformed money", args: { ...valid, budget: { amount: "150", currency: "EUR" } }, problems: [{ path: "budget.amount", expected: "number" }] },
  { name: "unknown top-level key", args: { ...valid, injected: "x" }, problems: [{ path: "$", expected: "no undeclared properties" }] },
  { name: "unknown nested key", args: { ...valid, travelers: { adults: 1, injected: 1 } }, problems: [{ path: "travelers", expected: "no undeclared properties" }] },
];

describe("execute() — input_invalid (#195)", () => {
  for (const c of refusals) {
    it(`refuses: ${c.name} — zero provider calls, denial carries paths`, async () => {
      const s = spy();
      const r = await fromIR(artifact()).execute("stays.search", c.args, { fetchImpl: s.fetchImpl });
      expect(s.calls()).toBe(0);
      expect(r.status).toBe("error");
      expect(r.denial).toEqual({ reason: "input_invalid", capability: "stays.search", problems: c.problems });
    });
  }

  it("never echoes a sent value or a sent key", async () => {
    const s = spy();
    const r = await fromIR(artifact()).execute(
      "stays.search",
      { destination: { SECRET_KEY_1: "SECRET_VAL_1" }, dates: "SECRET_VAL_2", SECRET_KEY_4: 1, tier: "SECRET_VAL_5" },
      { fetchImpl: s.fetchImpl },
    );
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
    expect(s.calls()).toBe(0);
  });

  it("more than 16 problems are cut at 16 with truncated: true", async () => {
    const many: IRTool = {
      ...search,
      input: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, required: true, type: { kind: "scalar" as const, semantic: "string" as const } })),
    };
    const r = await fromIR(artifact(many)).execute("stays.search", {}, { fetchImpl: spy().fetchImpl });
    expect(r.denial?.problems).toHaveLength(16);
    expect(r.denial?.truncated).toBe(true);
  });

  it("a valid input is forwarded as before", async () => {
    const s = spy();
    const r = await fromIR(artifact()).execute("stays.search", { ...valid, tier: "basic" }, { fetchImpl: s.fetchImpl });
    expect(r.status).toBe("ok");
    expect(r.denial).toBeUndefined();
    expect(s.calls()).toBe(1);
  });

  it("policy denies first: a refused caller gets policy_denied, not the schema", async () => {
    const r = await fromIR(artifact({ ...search, policies: ["authenticated"] })).execute("stays.search", { bogus: 1 }, { fetchImpl: spy().fetchImpl });
    expect(r.denial?.reason).not.toBe("input_invalid");
    expect(r.denial?.problems).toBeUndefined();
  });

  it("records phase denied / input_invalid in the audit trail", async () => {
    const records: ExecutionRecord[] = [];
    await fromIR(artifact()).execute("stays.search", { ...valid, destination: 5 }, { fetchImpl: spy().fetchImpl, auditSink: (r) => void records.push(r) });
    expect(records).toHaveLength(1);
    expect(records[0].status.phase).toBe("denied");
    expect(records[0].status.denialReason).toBe("input_invalid");
  });
});
