import { describe, it, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IR, IRTool } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { callTool, createMcpServer, CONTRACT_VIOLATION_META_KEY, INPUT_INVALID_META_KEY } from "../src/server";

// #212 — `boolean` over the MCP path: the advertised schemas, strict input before dispatch, a real
// boolean returned unchanged, and a non-boolean provider value as a contract violation.

const tool = (required: boolean): IRTool => ({
  id: "rooms.check",
  description: "Is a room available.",
  effect: "read",
  provider: "booking",
  policies: [],
  lifecycle: "stable",
  input: [{ name: "flag", required: true, type: { kind: "scalar", semantic: "boolean" } }],
  output: [{ name: "available", required, type: { kind: "scalar", semantic: "boolean" } }],
  connector: { type: "rest", rest: { baseUrl: "https://rooms.example", method: "GET", path: "/check" } },
  extract: [{ name: "available", path: "$.available" }],
});

const registry = (t: IRTool) => new Registry({ version: "0", company: { id: "acme" }, tools: [t], resources: {} } satisfies IR);

function provider(body: unknown): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return {
    urls,
    fetchImpl: async (url) => {
      urls.push(String(url));
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    },
  };
}

async function withClient(t: IRTool, p: ReturnType<typeof provider>, fn: (c: Client) => Promise<void>): Promise<void> {
  const server = createMcpServer(registry(t), { fetchImpl: p.fetchImpl });
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

describe("AC-1: tools/list advertises {type: boolean} in both schemas", () => {
  it("inputSchema and outputSchema", async () => {
    await withClient(tool(true), provider({}), async (client) => {
      const listed = (await client.listTools()).tools[0]!;
      expect((listed.inputSchema.properties as Record<string, unknown>).flag).toEqual({ type: "boolean" });
      expect((listed.outputSchema!.properties as Record<string, unknown>).available).toEqual({ type: "boolean" });
    });
  });
});

describe("AC-2: input is strict and checked before dispatch", () => {
  for (const [v, wire] of [[true, "flag=true"], [false, "flag=false"]] as const) {
    it(`${v} reaches the provider as ${wire} (false is not dropped)`, async () => {
      const p = provider({ available: true });
      const r = await callTool(registry(tool(true)), "rooms_check", { flag: v }, { fetchImpl: p.fetchImpl });
      expect(r.isError).toBe(false);
      expect(p.urls).toHaveLength(1);
      expect(p.urls[0]).toContain(wire);
    });
  }

  for (const bad of ["true", "false", 1, 0, null, {}, []]) {
    it(`${JSON.stringify(bad)} is refused naming the field; the provider is never called`, async () => {
      const p = provider({ available: true });
      const r = await callTool(registry(tool(true)), "rooms_check", { flag: bad }, { fetchImpl: p.fetchImpl });
      expect(r.isError).toBe(true);
      const meta = r._meta?.[INPUT_INVALID_META_KEY] as { problems: { path: string }[] };
      expect(meta.problems.map((x) => x.path)).toEqual(["flag"]);
      expect(p.urls).toHaveLength(0);
    });
  }
});

describe("AC-3: a real boolean is returned unchanged, over a real MCP client", () => {
  for (const v of [true, false]) {
    it(`${v}: structuredContent.available === ${v}, and the SDK's output validation accepts it`, async () => {
      await withClient(tool(true), provider({ available: v }), async (client) => {
        const r = await client.callTool({ name: "rooms_check", arguments: { flag: true } });
        expect(r.isError).toBeFalsy();
        expect(r.structuredContent).toEqual({ available: v });
      });
    });
  }
});

describe("AC-4: a non-boolean provider value is a contract violation that names boolean, never the value", () => {
  for (const v of [1, 0, "true", "t"]) {
    it(`required, provider sends ${JSON.stringify(v)}`, async () => {
      const r = await callTool(registry(tool(true)), "rooms_check", { flag: true }, { fetchImpl: provider({ available: v }).fetchImpl });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toBeUndefined();
      expect(r._meta?.[CONTRACT_VIOLATION_META_KEY]).toBeDefined();
      const text = JSON.stringify(r.content);
      expect(text).toContain("available (expected boolean)");
      expect(text).not.toContain(`"${String(v)}"`);
    });
  }

  it("optional, provider sends 1: the field is omitted and the result is degraded", async () => {
    const r = await callTool(registry(tool(false)), "rooms_check", { flag: true }, { fetchImpl: provider({ available: 1 }).fetchImpl });
    expect(r.isError).toBe(false);
    expect(r.structuredContent).toEqual({});
    expect(JSON.stringify(r.content)).toContain("available");
  });
});
