import { describe, it, expect, vi } from "vitest";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Registry } from "@archstone/emitter-support";
import { buildRegistry } from "../src/registry";
import { toolDefinitions, callTool, createMcpServer } from "../src/mcp";
import type { FetchLike, InvokeOptions } from "@archstone/provider-rest";

// #195: the declared input contract is enforced, so a tourism.search call must carry every
// required field (destination, dates, travelers) in its declared shape.
const NICE_SEARCH = { destination: "Nice", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };


// The pure lowering unit tests (toolName, inputJsonSchema field-kind coverage, the
// objectJsonSchema resource cycle-guard) moved to @archstone/emitter-support (ADD-0008 #27)
// along with the code — packages/emitter-support/test/lowering.test.ts. This file keeps the
// tests that exercise runtime-specific behavior (toolDefinitions/callTool/createMcpServer
// routing through a real Registry/REST provider/MCP SDK).

const here = dirname(fileURLToPath(import.meta.url));
const booking = resolve(here, "../../../examples/manifests/booking");
const tourism = resolve(here, "../../../examples/manifests/tourism");
const bank = resolve(here, "../../../examples/manifests/bank");
const registry = buildRegistry(booking).registry!;

describe("toolDefinitions — IR → MCP tools", () => {
  const defs = toolDefinitions(registry);

  it("emits only bound capabilities as tools", () => {
    // booking has 4 capabilities but only tourism.search is bound
    expect(defs).toHaveLength(1);
    expect(defs[0].name).toBe("tourism_search");
  });

  it("lowers semantic input to JSON Schema", () => {
    const schema = defs[0].inputSchema as {
      type: string;
      properties: Record<string, { type: string }>;
      required?: string[];
    };
    expect(schema.type).toBe("object");
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(["destination", "dates", "travelers", "preferences"]),
    );
    expect(schema.required).toContain("destination"); // required semantic field
    expect(schema.required ?? []).not.toContain("preferences"); // required: false in CDL
    expect(schema.properties.destination.type).toBe("string"); // location → string
    expect(schema.properties.dates.type).toBe("object"); // date-range → object
  });
});

describe("#11: outputSchema — typed, described resource lowering", () => {
  const defs = toolDefinitions(buildRegistry(tourism).registry!);
  const search = defs.find((d) => d.name === "tourism_search")!;

  it("emits an outputSchema; collection Stay → array of typed Stay objects", () => {
    const out = search.outputSchema as {
      type: string;
      properties: Record<string, { type: string; items?: { type: string; properties: Record<string, { type: string; description?: string }> } }>;
    };
    expect(out.type).toBe("object");
    const stays = out.properties.stays;
    expect(stays.type).toBe("array");
    // items carry Stay's typed properties — NOT a bare { type: object }.
    const item = stays.items!;
    expect(item.type).toBe("object");
    expect(Object.keys(item.properties)).toEqual(expect.arrayContaining(["name", "location", "pricePerNight", "rating"]));
    expect(item.properties.location.type).toBe("string"); // location semantic → string
    expect(item.properties.location.description).toMatch(/city|region|address/i); // described
  });
});

describe("callTool — routing to the REST provider", () => {
  it("invokes the backend and returns its response as content", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    const r = await callTool(
      registry,
      "tourism_search",
      NICE_SEARCH,
      { env: { BOOKING_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.isError).toBe(false);
    expect(r.content[0].text).toContain("hotels");
    // #11 R-4: the raw body is surfaced verbatim as structuredContent (pass-through, unmapped).
    expect(r.structuredContent).toEqual({ hotels: [{ id: "h1" }] });
  });

  it("returns an error for an unknown tool", async () => {
    const r = await callTool(registry, "does_not_exist", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/);
  });

  it("does not resolve an unbound capability's tool name (NF-6)", async () => {
    // tourism.book exists in booking but has no binding, so it is never emitted
    // as a tool; its sanitized name must be treated as unknown, not routed.
    expect(registry.getCapability("tourism.book")).toBeDefined();
    expect(toolDefinitions(registry).map((d) => d.name)).not.toContain("tourism_book");

    const r = await callTool(registry, "tourism_book", {});
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/unknown tool/);
  });
});

describe("callTool — response mapping (ADD-12, tourism binding has a response:)", () => {
  const tourismReg = buildRegistry(tourism).registry!;

  it("maps the provider body to Stay and drops unmapped fields (structuredContent = outputSchema)", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }],
          totalMatches: 1,
        }),
        { status: 200 },
      );
    const r = await callTool(tourismReg, "tourism_search", NICE_SEARCH, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(false);
    // `id` is not part of Stay → dropped by the mapping; structuredContent is the mapped shape.
    // `totalMatches` is not part of Stay either — it is a capability-level scalar reached by
    // `extract:` (per the accepted architecture decision extending ADD-12), merged into the
    // same structuredContent alongside `response:`'s `stays`.
    expect(r.structuredContent).toEqual({
      stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }],
      totalMatches: 1,
    });
  });

  it("fails closed on a missing REQUIRED field — no raw pass-through (D-6)", async () => {
    // pricePerNight (required) absent → VIOLATION; the raw body must NOT leak through.
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice" }], totalMatches: 1 }), { status: 200 });
    const r = await callTool(tourismReg, "tourism_search", NICE_SEARCH, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/contract violation/i);
    expect(r.content[0].text).toMatch(/pricePerNight/);
    // #19 BR-4/US-2: the text message names the violating capability id too.
    expect(r.content[0].text).toContain("tourism.search");
    // #19 ADD-19 Rev 2 D-3′: structuredContent stays absent on VIOLATION — a client-side
    // schema-validating regression guard (a non-empty structuredContent here would crash the
    // reference SDK client, since it doesn't conform to the tool's outputSchema).
    expect(r.structuredContent).toBeUndefined();
    // #19 ADD-19 Rev 2 D-6: the structured, machine-readable error object moves to `_meta`.
    expect(r._meta?.["dev.archstone/contract_violation"]).toEqual({
      error: "contract_violation",
      capability: "tourism.search",
      missing: ["pricePerNight"],
    });
  });

  it("dedups the structured missing list across multiple violating collection items (BR-8/S-US1.6)", async () => {
    // item 1 is missing pricePerNight; item 2 is missing location — both required, both
    // fields must appear exactly once in structuredContent.missing, order-independent.
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          stays: [
            { name: "Hotel Azur", location: "Nice" },
            { name: "Hotel Riviera", pricePerNight: 200 },
          ],
          totalMatches: 2,
        }),
        { status: 200 },
      );
    const r = await callTool(tourismReg, "tourism_search", NICE_SEARCH, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    const structured = r._meta?.["dev.archstone/contract_violation"] as { error: string; capability: string; missing: string[] };
    expect(structured.error).toBe("contract_violation");
    expect(structured.capability).toBe("tourism.search");
    expect([...structured.missing].sort()).toEqual(["location", "pricePerNight"]);
  });

  it("degrades on a missing OPTIONAL field — result returned with a note", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }], totalMatches: 1 }), { status: 200 });
    const r = await callTool(tourismReg, "tourism_search", NICE_SEARCH, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }], totalMatches: 1 });
    expect(r.content.some((c) => /degraded/i.test(c.text))).toBe(true);
  });
});

// `extract:` (per the accepted architecture decision extending ADD-12): tourism.search's real
// binding now ALSO extracts `totalMatches`, a capability-level scalar with no resource to anchor
// it, straight off the raw body root — alongside the `stays` collection `response:` maps. This
// proves the ADD's own suggested concrete scenario end to end, against the real example binding
// (not a synthetic fixture): a merged structuredContent that validates against the full
// outputSchema, and a merged VIOLATION when the extracted field is dropped.
describe("callTool — response + extract together (extends ADD-12, tourism binding also has an extract:)", () => {
  const tourismReg = buildRegistry(tourism).registry!;

  it("populates BOTH `stays` (response:) and `totalMatches` (extract:) in one structuredContent, valid against outputSchema", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({
          stays: [
            { id: "azur-01", name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 },
            { id: "dunes-02", name: "Dunes Resort", location: "Nice", pricePerNight: 98 },
          ],
          totalMatches: 2,
        }),
        { status: 200 },
      );
    const r = await callTool(tourismReg, "tourism_search", NICE_SEARCH, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({
      stays: [
        { name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 },
        { name: "Dunes Resort", location: "Nice", pricePerNight: 98 },
      ],
      totalMatches: 2,
    });

    // The full merged structuredContent must carry exactly the fields the tool's own
    // outputSchema declares — the exact regression ADD-19/#61 exist to prevent, now proven
    // for BOTH mechanisms landing in the same document at once.
    const def = toolDefinitions(tourismReg).find((d) => d.name === "tourism_search")!;
    const props = Object.keys((def.outputSchema as { properties: Record<string, unknown> }).properties);
    expect(props.sort()).toEqual(["stays", "totalMatches"]);
    expect(Object.keys(r.structuredContent as Record<string, unknown>).sort()).toEqual(["stays", "totalMatches"]);
  });

  it("dropping the extract:-mapped field from the backend response yields ONE merged VIOLATION, not a partial/crashing result", async () => {
    // `totalMatches` absent — extract:'s own required-ness (read from `output:` directly, D-6)
    // fires a VIOLATION merged into the SAME accumulators `response:`'s own checks use (D-7):
    // one `MappingResult`, one error, never a partial success or a second error path.
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }] }),
        { status: 200 },
      );
    const r = await callTool(tourismReg, "tourism_search", NICE_SEARCH, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(true);
    expect(r.content[0].text).toMatch(/contract violation/i);
    expect(r.content[0].text).toMatch(/totalMatches/);
    // No partial structuredContent — the whole result is withheld, fail-closed (D-6/ADD-19).
    expect(r.structuredContent).toBeUndefined();
    expect(r._meta?.["dev.archstone/contract_violation"]).toEqual({
      error: "contract_violation",
      capability: "tourism.search",
      missing: ["totalMatches"],
    });
  });

  it("a merged VIOLATION lists missing fields from BOTH response: and extract: together, not as two separate errors", async () => {
    // pricePerNight (response:'s Stay field) AND totalMatches (extract:'s output field) both
    // absent — one violation naming both, order-independent.
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice" }] }), { status: 200 });
    const r = await callTool(tourismReg, "tourism_search", NICE_SEARCH, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });
    expect(r.isError).toBe(true);
    const structured = r._meta?.["dev.archstone/contract_violation"] as { missing: string[] };
    expect([...structured.missing].sort()).toEqual(["pricePerNight", "totalMatches"]);
  });
});

describe("#19 ADD-19 Rev 2 R2.2/R2.7 step 4 — a real SDK Client survives a VIOLATION result", () => {
  // This is the actual regression test for the bug that blocked Rev 1: the crash happened
  // inside the CLIENT's callTool() (it schema-validates structuredContent against the
  // advertised outputSchema whenever one is declared, unconditionally on isError), not the
  // server's. A unit test calling the exported `callTool` function directly cannot see that —
  // it has to go through a real Client instance talking to a real Server, in-process, over the
  // SDK's own InMemoryTransport, exactly as the architect reproduced it in R2.2.
  const tourismReg = buildRegistry(tourism).registry!;

  it("does not throw on VIOLATION, and the structured error survives in result._meta", async () => {
    // pricePerNight (required) is absent from the mock backend body → VIOLATION.
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice" }], totalMatches: 1 }), { status: 200 });
    const server = createMcpServer(tourismReg, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      // Call listTools() first so the client caches an outputSchema validator for
      // tourism_search, the same way it does in production — this is what arms the
      // validation path that crashed under Rev 1's structuredContent-based mechanism.
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("tourism_search");

      const result = await client.callTool({ name: "tourism_search", arguments: NICE_SEARCH });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result._meta?.["dev.archstone/contract_violation"]).toEqual({
        error: "contract_violation",
        capability: "tourism.search",
        missing: ["pricePerNight"],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// #43 (S-US3.2 / BR-26): `policy_denied` follows ADD-19 Rev 2 D-3′/D-6 VERBATIM, so the same
// client-crash property is re-PROVEN here rather than assumed. The reference SDK Client
// validates `structuredContent` against the advertised `outputSchema` unconditionally — not
// gated on `isError` — so a third `_meta` mechanism that quietly grew a `structuredContent`
// would reintroduce the exact failure ADD-19 Rev 1 shipped and had to withdraw.
describe("#43 — a real SDK Client survives a policy denial (S-US3.2)", () => {
  it("does not throw, and the structured refusal survives in result._meta", async () => {
    const base = buildRegistry(tourism).registry!.ir;
    // tourism.search declares an outputSchema (collection Stay) — that is what arms the
    // client-side validator. Attach a policy that denies the (caller-less) invocation.
    const ir = JSON.parse(JSON.stringify(base)) as typeof base;
    ir.tools[0].policyRules = [{ id: "nobody", allow: ["user:alice"] }];

    const fetchImpl: FetchLike = () => {
      throw new Error("must not be called — denied before any connector work");
    };
    const server = createMcpServer(new Registry(ir), { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools(); // caches the outputSchema validator
      expect(tools.map((t) => t.name)).toContain("tourism_search");

      const result = await client.callTool({ name: "tourism_search", arguments: NICE_SEARCH });

      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect(result._meta?.["dev.archstone/policy_denied"]).toEqual({
        error: "policy_denied",
        capability: "tourism.search",
        reason: "principal_not_allowed",
      });
    } finally {
      await client.close();
      await server.close();
    }
  });
});

// Issue #39 / ADD-31: callTool routes InvokeOptions.onResponse straight into invokeRest — no
// new plumbing here, but the firing/fail-safe/D-6-divergence guarantees need proving at the
// MCP-tool-call boundary specifically, since that's the surface an AI agent actually reaches.
describe("callTool — onResponse hook (#39)", () => {
  const tourismReg = buildRegistry(tourism).registry!;

  it("S-US1.3: onResponse receives the raw body, including fields the response mapping would discard", async () => {
    const calls: { data: unknown }[] = [];
    // `usage` is not part of tourism.search's `response:` mapping (name/location/pricePerNight/
    // rating only) — a real LLM-backed connector's usage sidecar, simulated here.
    const rawBody = {
      stays: [{ id: "azur-01", name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }],
      totalMatches: 1,
      usage: { promptTokens: 42, completionTokens: 7 },
    };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(rawBody), { status: 200 });
    const r = await callTool(
      tourismReg,
      "tourism_search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    );
    expect(r.isError).toBe(false);
    // The mapped structuredContent drops `id` and `usage` — confirming the mapping DID discard.
    expect(r.structuredContent).toEqual({
      stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }],
      totalMatches: 1,
    });
    // But onResponse still saw the full raw body, usage sidecar included.
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toEqual(rawBody);
  });

  it("S-US5.1/S-US5.2: fires once with the full raw body on a contract VIOLATION, even though structuredContent withholds it (D-6)", async () => {
    const calls: { status: number; data: unknown }[] = [];
    // pricePerNight (required) absent -> VIOLATION.
    const rawBody = { stays: [{ name: "Hotel Azur", location: "Nice" }] };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(rawBody), { status: 200 });
    const r = await callTool(
      tourismReg,
      "tourism_search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    );
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined(); // D-6: withheld from the MCP client
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toEqual(rawBody); // but the hook (trusted process) still sees it
  });

  it("S-US5.2: fires exactly once, identically, across OK, DEGRADED, and VIOLATION classifications", async () => {
    const bodies = {
      ok: { stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 },
      degraded: { stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }], totalMatches: 1 }, // rating absent
      violation: { stays: [{ name: "Hotel Azur", location: "Nice" }], totalMatches: 1 }, // pricePerNight absent
    } as const;

    for (const [label, rawBody] of Object.entries(bodies)) {
      const calls: { status: number; data: unknown }[] = [];
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(rawBody), { status: 200 });
      await callTool(
        tourismReg,
        "tourism_search",
        NICE_SEARCH,
        { env: { STAYS_API_URL: "https://x.test" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
      );
      expect(calls, `classification: ${label}`).toHaveLength(1);
      expect(calls[0].data).toEqual(rawBody);
    }
  });

  it("S-US4.4: a throwing onResponse never affects the MCP CallResult (via a real client/server round-trip)", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const withThrowingHook = createMcpServer(tourismReg, {
      env: { STAYS_API_URL: "https://x.test" },
      fetchImpl,
      onResponse: () => {
        throw new Error("boom");
      },
    });
    const withoutHook = createMcpServer(tourismReg, { env: { STAYS_API_URL: "https://x.test" }, fetchImpl });

    async function callViaClient(server: ReturnType<typeof createMcpServer>) {
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        await client.listTools();
        return await client.callTool({ name: "tourism_search", arguments: NICE_SEARCH });
      } finally {
        await client.close();
        await server.close();
      }
    }

    const resultWithHook = await callViaClient(withThrowingHook);
    const resultWithoutHook = await callViaClient(withoutHook);
    expect(resultWithHook.isError).toBeFalsy();
    expect(resultWithHook.structuredContent).toEqual(resultWithoutHook.structuredContent);
    expect(resultWithHook.content).toEqual(resultWithoutHook.content);
    expect(resultWithHook._meta).toEqual(resultWithoutHook._meta);
  });
});

describe("serveStdio — forwards `invoke` to createMcpServer (ADD-32 step 5)", () => {
  // serveStdio itself connects a real StdioServerTransport (reads process.stdin) and blocks
  // on server.connect() — not something a unit test should exercise directly (no in-process
  // way to end that without touching real stdin, and no existing test does). Mock both the
  // SDK's stdio transport and this module's own createMcpServer so this test proves exactly
  // one thing — the `invoke` param, once added, reaches createMcpServer verbatim — without
  // ever opening a real stdio channel.
  it("passes the invoke option through to createMcpServer, unlike before #32 (no InvokeOptions could ever reach it)", async () => {
    vi.resetModules();
    let captured: InvokeOptions | undefined;
    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock("../src/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/server")>();
      return {
        ...actual,
        createMcpServer: (reg: unknown, invoke?: InvokeOptions) => {
          captured = invoke;
          return { connect: async () => {} } as unknown as ReturnType<typeof actual.createMcpServer>;
        },
      };
    });
    try {
      const { serveStdio } = await import("../src/mcp");
      const caller = { accessToken: "static-per-process-token" };
      await serveStdio(bank, { env: { CORE_BANKING_URL: "https://core.example" }, caller });
      expect(captured?.caller).toEqual(caller);
    } finally {
      vi.doUnmock("@modelcontextprotocol/sdk/server/stdio.js");
      vi.doUnmock("../src/server");
      vi.resetModules();
    }
  });

  // Security-hardening follow-up to ADD-32: `allowedHosts` is a NEW field on the same
  // `InvokeOptions` bag the test above already proves is forwarded verbatim, unchanged — so
  // this test only needs to confirm the same pass-through covers the new field too, with zero
  // code change in mcp.ts (serveStdio forwards `invoke` as a whole, never destructures it).
  it("passes InvokeOptions.allowedHosts through to createMcpServer as part of the same verbatim forward", async () => {
    vi.resetModules();
    let captured: InvokeOptions | undefined;
    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock("../src/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/server")>();
      return {
        ...actual,
        createMcpServer: (reg: unknown, invoke?: InvokeOptions) => {
          captured = invoke;
          return { connect: async () => {} } as unknown as ReturnType<typeof actual.createMcpServer>;
        },
      };
    });
    try {
      const { serveStdio } = await import("../src/mcp");
      const allowedHosts = ["tenant-a.core.example.com"];
      await serveStdio(bank, { env: { CORE_BANKING_URL: "https://core.example" }, allowedHosts });
      expect(captured?.allowedHosts).toEqual(allowedHosts);
    } finally {
      vi.doUnmock("@modelcontextprotocol/sdk/server/stdio.js");
      vi.doUnmock("../src/server");
      vi.resetModules();
    }
  });

  // Issue #39 / ADD-31: onResponse is one more key inside the same `invoke` bag the two tests
  // above already prove is forwarded verbatim — this confirms it, per BR-11/S-US3.1, with zero
  // additional code in mcp.ts.
  it("S-US3.1: passes InvokeOptions.onResponse through to createMcpServer as part of the same verbatim forward", async () => {
    vi.resetModules();
    let captured: InvokeOptions | undefined;
    vi.doMock("@modelcontextprotocol/sdk/server/stdio.js", () => ({
      StdioServerTransport: class {},
    }));
    vi.doMock("../src/server", async (importOriginal) => {
      const actual = await importOriginal<typeof import("../src/server")>();
      return {
        ...actual,
        createMcpServer: (reg: unknown, invoke?: InvokeOptions) => {
          captured = invoke;
          return { connect: async () => {} } as unknown as ReturnType<typeof actual.createMcpServer>;
        },
      };
    });
    try {
      const { serveStdio } = await import("../src/mcp");
      const onResponse = () => {};
      await serveStdio(bank, { env: { CORE_BANKING_URL: "https://core.example" }, onResponse });
      expect(captured?.onResponse).toBe(onResponse);
    } finally {
      vi.doUnmock("@modelcontextprotocol/sdk/server/stdio.js");
      vi.doUnmock("../src/server");
      vi.resetModules();
    }
  });
});

// S-US3.1 (full integration variant): a real MCP client, over the SDK's own InMemoryTransport,
// calling a bound tool served by createMcpServer(registry, { onResponse }) — proves the hook
// actually fires on a real tool call reached through the stdio-serving path's own building
// block (createMcpServer), not just that the reference is threaded through.
describe("createMcpServer — onResponse fires on a real MCP tool call (#39, S-US3.1 integration)", () => {
  it("fires exactly once per tools/call, with the invoked capability's raw response", async () => {
    const tourismReg = buildRegistry(tourism).registry!;
    const calls: { capabilityId: string; status: number; data: unknown }[] = [];
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const server = createMcpServer(tourismReg, {
      env: { STAYS_API_URL: "https://x.test" },
      fetchImpl,
      onResponse: (info) => { calls.push(info); },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.listTools();
      const result = await client.callTool({ name: "tourism_search", arguments: NICE_SEARCH });
      expect(result.isError).toBeFalsy();
      expect(calls).toHaveLength(1);
      expect(calls[0].capabilityId).toBe("tourism.search");
      expect(calls[0].status).toBe(200);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("ADD-32 step 9 — a tool call reaches a real backend with the CALLER token attached, not ${API_KEY}", () => {
  // A genuine end-to-end path: a real MCP Client, over the SDK's own InMemoryTransport, talking
  // to createMcpServer(bankRegistry, { caller }) — which in turn makes a REAL network request
  // (node:http, not an injected fetchImpl stub) to a local mock backend. Proves banking.
  // list-accounts' ${caller.accessToken} placeholder — not an env var — is what the backend
  // actually receives.
  function startMock(): Promise<{ url: string; close: () => Promise<void>; authHeaders: string[] }> {
    const authHeaders: string[] = [];
    return new Promise((res) => {
      const server = createServer((req, resp) => {
        authHeaders.push(req.headers.authorization ?? "");
        resp.setHeader("content-type", "application/json");
        resp.end(
          JSON.stringify({
            accounts: [{ number: "IBAN123", currency: "EUR", balance: { amount: 100, currency: "EUR" }, status: "active" }],
          }),
        );
      });
      server.listen(0, () => {
        const addr = server.address();
        const port = typeof addr === "object" && addr ? addr.port : 0;
        res({ url: `http://127.0.0.1:${port}`, close: () => new Promise((r) => server.close(() => r())), authHeaders });
      });
    });
  }

  it("banking.list-accounts: the backend receives 'Bearer <caller token>', never a service-account env var", async () => {
    const bankRegistry = buildRegistry(bank).registry!;
    const mock = await startMock();
    const server = createMcpServer(bankRegistry, {
      env: { CORE_BANKING_URL: mock.url }, // deliberately NOT an API key — nothing else is set
      caller: { accessToken: "end-user-jwt-xyz" },
    });

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("banking_list-accounts");

      const result = await client.callTool({ name: "banking_list-accounts", arguments: {} });
      expect(result.isError).toBeFalsy();
      expect(mock.authHeaders).toEqual(["Bearer end-user-jwt-xyz"]);
    } finally {
      await client.close();
      await server.close();
      await mock.close();
    }
  });

  it("with no caller supplied, the same tool call fails closed and the mock backend never receives a request", async () => {
    const bankRegistry = buildRegistry(bank).registry!;
    const mock = await startMock();
    const server = createMcpServer(bankRegistry, { env: { CORE_BANKING_URL: mock.url } }); // no caller

    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      const result = await client.callTool({ name: "banking_list-accounts", arguments: {} });
      expect(result.isError).toBe(true);
      const text = (result.content as { type: string; text: string }[])[0].text;
      expect(text).toMatch(/requires policies:\[authenticated\]/);
      expect(mock.authHeaders).toHaveLength(0);
    } finally {
      await client.close();
      await server.close();
      await mock.close();
    }
  });
});

// #81/#82 (ADD-12 §8.1/§8.2) — the SDK-client regression test the review flagged as missing
// (290-response-arrays-review.md): `objectJsonSchema`'s oneOf/list shapes proved correct in
// isolation (emitter-support/test/lowering.test.ts) are exactly the kind of thing a strict
// client-side JSON Schema validator can reject even when the generator believes it is valid —
// the ADD-19 precedent above exists for the identical reason. This runs a real Client against
// a real Server over InMemoryTransport and lets the SDK's OWN validation see it.
describe("#81/#82 — onError oneOf and extract: text[] survive the real SDK Client (ADD-12 §8)", () => {
  function shopManifest(): string {
    const dir = mkdtempSync(join(tmpdir(), "archstone-mcp-onerror-"));
    writeFileSync(join(dir, "capabilities.yaml"), "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n");
    writeFileSync(
      join(dir, "shop.search.capability.yaml"),
      [
        "capability:",
        "  id: shop.search",
        "  description: find",
        "  effect: read",
        "  provider: store",
        "  output:",
        "    items:",
        "      collection: Widget",
        "    warnings:",
        "      list: text",
        "      required: false",
        "",
      ].join("\n"),
    );
    writeFileSync(join(dir, "shop.Widget.resource.yaml"), "resource:\n  name: shop.Widget\n  fields:\n    name:\n      type: text\n");
    writeFileSync(
      join(dir, "shop.RowError.resource.yaml"),
      "resource:\n  name: shop.RowError\n  fields:\n    code:\n      type: identifier\n    message:\n      type: text\n      required: false\n",
    );
    mkdirSync(join(dir, "bindings"), { recursive: true });
    writeFileSync(
      join(dir, "bindings", "shop.search.binding.yaml"),
      [
        "binding:",
        "  capabilityId: shop.search",
        "  connector:",
        "    type: rest",
        "    rest:",
        '      baseUrl: "${SHOP_API_URL}"',
        "      method: GET",
        "      path: /search",
        "  response:",
        '    collection: "$.results[*]"',
        "    resource: Widget",
        "    map:",
        '      name: "$.n"',
        "    onError:",
        "      errorResource: RowError",
        "      when:",
        '        path: "$.code"',
        "        exists: true",
        "  extract:",
        '    warnings: "$.warnings[*]"',
        "",
      ].join("\n"),
    );
    return dir;
  }

  async function connect(server: ReturnType<typeof createMcpServer>) {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    return { client, server };
  }

  it("a mixed collection (valid row + declared error row) validates against the oneOf outputSchema", async () => {
    const dir = shopManifest();
    try {
      const shopRegistry = buildRegistry(dir).registry!;
      const fetchImpl: FetchLike = async () =>
        new Response(
          JSON.stringify({
            results: [{ n: "Widget A" }, { code: "out-of-stock", message: "no longer available" }],
            warnings: ["price may be stale"],
          }),
          { status: 200 },
        );
      const server = createMcpServer(shopRegistry, { env: { SHOP_API_URL: "https://x.test" }, fetchImpl });
      const { client } = await connect(server);
      try {
        const { tools } = await client.listTools();
        expect(tools.map((t) => t.name)).toContain("shop_search");

        const result = await client.callTool({ name: "shop_search", arguments: {} });
        // The regression this proves: the SDK client validates structuredContent against the
        // oneOf outputSchema on every call, unconditionally — if the generated schema were
        // wrong, THIS throws (or isError flips true), not a hand-rolled assertion.
        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as { items: Record<string, unknown>[]; warnings: string[] };
        expect(structured.items).toEqual([
          { $row: "ok", name: "Widget A" },
          { $row: "error", code: "out-of-stock", message: "no longer available" },
        ]);
        expect(structured.warnings).toEqual(["price may be stale"]);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("extract: text[] — an empty array validates as OK, not DEGRADED", async () => {
    const dir = shopManifest();
    try {
      const shopRegistry = buildRegistry(dir).registry!;
      const fetchImpl: FetchLike = async () =>
        new Response(JSON.stringify({ results: [{ n: "Widget A" }], warnings: [] }), { status: 200 });
      const server = createMcpServer(shopRegistry, { env: { SHOP_API_URL: "https://x.test" }, fetchImpl });
      const { client } = await connect(server);
      try {
        await client.listTools();
        const result = await client.callTool({ name: "shop_search", arguments: {} });
        expect(result.isError).toBeFalsy();
        const structured = result.structuredContent as { warnings: string[] };
        expect(structured.warnings).toEqual([]);
      } finally {
        await client.close();
        await server.close();
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
