import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IR, IRTool } from "@archstone/compiler";
import { Registry, InMemoryRateLimitCounter, type ExecutionRecord } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { callTool, createMcpServer, INPUT_INVALID_META_KEY, POLICY_DENIED_META_KEY, toolDefinitions } from "../src/server";

// #195 — the declared input contract is enforced on the MCP path before any connector work.
// Every refusal case spy-asserts ZERO provider calls and that nothing the caller sent is echoed.

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

const ir = (...tools: IRTool[]): IR => ({ version: "0", company: { id: "acme" }, tools, resources: {} });
const registry = (...tools: IRTool[]) => new Registry(ir(...tools));

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
    name: "the issue repro: operator-injection object, free-text date, negative travelers",
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
  { name: "malformed party (negative adults)", args: { ...valid, travelers: { adults: -1 } }, problems: [{ path: "travelers.adults", expected: "non-negative integer" }] },
  { name: "malformed money", args: { ...valid, budget: { amount: "150", currency: "EUR" } }, problems: [{ path: "budget.amount", expected: "number" }] },
  { name: "unknown top-level key", args: { ...valid, injected: "x" }, problems: [{ path: "$", expected: "no undeclared properties" }] },
  { name: "unknown nested key (party)", args: { ...valid, travelers: { adults: 1, injected: 1 } }, problems: [{ path: "travelers", expected: "no undeclared properties" }] },
  { name: "unknown nested key (date-range)", args: { ...valid, dates: { ...valid.dates, injected: 1 } }, problems: [{ path: "dates", expected: "no undeclared properties" }] },
  { name: "unknown nested key (money)", args: { ...valid, budget: { amount: 1, currency: "EUR", injected: 1 } }, problems: [{ path: "budget", expected: "no undeclared properties" }] },
  { name: "a caller-field name supplied by the caller", args: { ...valid, "caller.accessToken": "stolen" }, problems: [{ path: "$", expected: "no undeclared properties" }] },
];

describe("callTool — input_invalid (#195)", () => {
  for (const c of refusals) {
    it(`refuses: ${c.name} — zero provider calls, structured _meta`, async () => {
      const s = spy();
      const r = await callTool(registry(search), "stays_search", c.args, { fetchImpl: s.fetchImpl });
      expect(s.calls()).toBe(0);
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toBeUndefined();
      expect(r._meta).toEqual({ [INPUT_INVALID_META_KEY]: { error: "input_invalid", capability: "stays.search", problems: c.problems } });
    });
  }

  it("never echoes a sent value or a sent key in the text or the _meta", async () => {
    const s = spy();
    const r = await callTool(
      registry(search),
      "stays_search",
      { destination: { SECRET_KEY_1: "SECRET_VAL_1" }, dates: "SECRET_VAL_2", travelers: { adults: 1, SECRET_KEY_3: 1 }, SECRET_KEY_4: "SECRET_VAL_4", tier: "SECRET_VAL_5" },
      { fetchImpl: s.fetchImpl },
    );
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toMatch(/SECRET/);
    expect(s.calls()).toBe(0);
  });

  it("more than 16 problems are cut at 16 with truncated: true", async () => {
    const many: IRTool = {
      ...search,
      input: Array.from({ length: 20 }, (_, i) => ({ name: `f${i}`, required: true, type: { kind: "scalar" as const, semantic: "string" as const } })),
    };
    const s = spy();
    const r = await callTool(registry(many), "stays_search", {}, { fetchImpl: s.fetchImpl });
    const meta = r._meta?.[INPUT_INVALID_META_KEY] as { problems: unknown[]; truncated?: boolean };
    expect(meta.problems).toHaveLength(16);
    expect(meta.truncated).toBe(true);
    expect(s.calls()).toBe(0);
  });

  it("a valid input is forwarded exactly as before", async () => {
    const s = spy();
    const r = await callTool(registry(search), "stays_search", { ...valid, budget: { amount: 100, currency: "EUR" }, tier: "plus" }, { fetchImpl: s.fetchImpl });
    expect(r.isError).toBe(false);
    expect(r._meta).toBeUndefined();
    expect(s.calls()).toBe(1);
  });
});

describe("callTool — gate order (#195 D-2)", () => {
  it("a policy denial wins over a malformed input: the refused caller learns nothing about the schema", async () => {
    const authed: IRTool = { ...search, policies: ["authenticated"] };
    const s = spy();
    const r = await callTool(registry(authed), "stays_search", { bogus: 1 }, { fetchImpl: s.fetchImpl });
    expect(r._meta?.[POLICY_DENIED_META_KEY]).toBeDefined();
    expect(r._meta?.[INPUT_INVALID_META_KEY]).toBeUndefined();
  });

  it("a retired capability answers lifecycle_blocked whatever the arguments are", async () => {
    const r = await callTool(registry({ ...search, lifecycle: "retired" }), "stays_search", { bogus: 1 }, {});
    expect(r._meta?.["dev.archstone/lifecycle_blocked"]).toBeDefined();
    expect(r._meta?.[INPUT_INVALID_META_KEY]).toBeUndefined();
  });

  it("a malformed call does not burn rate-limit quota", async () => {
    const limited: IRTool = { ...search, policyRules: [{ id: "rl", rateLimit: { maxInvocations: 1, windowSeconds: 60 } }] };
    const counter = new InMemoryRateLimitCounter(() => 0);
    const s = spy();
    const reg = registry(limited);
    for (let i = 0; i < 5; i++) {
      const bad = await callTool(reg, "stays_search", { ...valid, injected: 1 }, { fetchImpl: s.fetchImpl, rateLimitCounter: counter });
      expect(bad._meta?.[INPUT_INVALID_META_KEY]).toBeDefined();
    }
    const good = await callTool(reg, "stays_search", valid, { fetchImpl: s.fetchImpl, rateLimitCounter: counter });
    expect(good.isError).toBe(false);
    expect(s.calls()).toBe(1);
  });
});

describe("callTool — audit (#195 D-6)", () => {
  it("records phase denied, denialReason input_invalid, and no connector contact", async () => {
    const records: ExecutionRecord[] = [];
    const s = spy();
    await callTool(registry(search), "stays_search", { ...valid, destination: 5 }, { fetchImpl: s.fetchImpl, auditSink: (r) => void records.push(r) });
    expect(records).toHaveLength(1);
    expect(records[0].status.phase).toBe("denied");
    expect(records[0].status.denialReason).toBe("input_invalid");
    expect(records[0].status.reachedConnector).toBeUndefined();
    expect(records[0].status.message).not.toMatch(/5\b/);
  });
});

describe("tools/list advertises the contract that is enforced (#195 D-4)", () => {
  it("inputSchema is closed and party counts have minimum 0", () => {
    const def = toolDefinitions(registry(search))[0];
    const schema = def.inputSchema as { additionalProperties?: boolean; properties: Record<string, { additionalProperties?: boolean; properties?: Record<string, { minimum?: number }> }> };
    expect(schema.additionalProperties).toBe(false);
    expect(schema.properties.travelers.additionalProperties).toBe(false);
    expect(schema.properties.travelers.properties?.adults.minimum).toBe(0);
  });
});

describe("over the MCP wire (in-memory transport, the reference SDK client) (#195)", () => {
  async function withClient(s: ReturnType<typeof spy>, fn: (c: Client) => Promise<void>): Promise<void> {
    const server = createMcpServer(registry(search), { fetchImpl: s.fetchImpl });
    const [ct, st] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "t", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(st), client.connect(ct)]);
    try {
      await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("the issue repro is refused over the wire with the namespaced _meta and zero provider calls", async () => {
    const s = spy();
    await withClient(s, async (client) => {
      const r = await client.callTool({ name: "stays_search", arguments: { destination: { $ne: 1 }, dates: "tomorrow", travelers: -1 } });
      expect(r.isError).toBe(true);
      expect((r._meta?.[INPUT_INVALID_META_KEY] as { error: string }).error).toBe("input_invalid");
      expect(JSON.stringify(r)).not.toContain("$ne");
      expect(JSON.stringify(r)).not.toContain("tomorrow");
    });
    expect(s.calls()).toBe(0);
  });

  it("a valid call over the wire still reaches the provider once", async () => {
    const s = spy();
    await withClient(s, async (client) => {
      const r = await client.callTool({ name: "stays_search", arguments: valid });
      expect(r.isError).toBe(false);
    });
    expect(s.calls()).toBe(1);
  });
});
