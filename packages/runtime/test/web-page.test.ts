// `web-page` over MCP, in the Registry, and at contract recording (issue #141): S-B.6 – S-B.8,
// S-C.2, S-C.3, S-C.5, S-D.5. A real manifest on disk, built by `buildRegistry`, served through
// the reference MCP SDK client over its own InMemoryTransport — the client that validates
// `structuredContent` against the advertised `outputSchema` unconditionally.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { IR, IRTool } from "@archstone/compiler";
import { Registry, type AuditSink, type ExecutionRecord } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { buildRegistry } from "../src/registry";
import { callTool, createMcpServer, CONTRACT_VIOLATION_META_KEY } from "../src/server";
import { recordContract, verifyTool } from "../src/verify";

const EVIL = "https://evil.example.net/x";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A `shop.search` manifest: a collection of Stay rows whose `listingUrl` is a web-page. */
function manifest(listingRequired: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-webpage-rt-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
    "shop.search.capability.yaml":
      "capability:\n  id: shop.search\n  description: find stays\n  effect: read\n  provider: store\n  output:\n    stays:\n      collection: Stay\n",
    "shop.Stay.resource.yaml": `resource:\n  name: shop.Stay\n  fields:\n    name:\n      type: text\n    listingUrl:\n      type: web-page\n      required: ${listingRequired}\n`,
    "bindings/shop.search.binding.yaml":
      'binding:\n  capabilityId: shop.search\n  connector:\n    type: rest\n    rest:\n      baseUrl: "${API_URL}"\n      method: GET\n      path: /search\n' +
      '  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      listingUrl: "$.url"\n' +
      '  origins:\n    pages:\n      - "https://www.example.com"\n',
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function registryFor(listingRequired: boolean): Registry {
  const built = buildRegistry(manifest(listingRequired));
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.registry!;
}

const respond = (url: unknown): FetchLike => async () => new Response(JSON.stringify({ results: [{ name: "Hotel A", url }] }), { status: 200 });
const opts = (url: unknown) => ({ env: { API_URL: "https://api.example.com" }, fetchImpl: respond(url) });

/** Connect the reference client to a server for `registry`, list tools (arming its outputSchema
 *  validator, as in production), then run `fn`. */
async function withClient(registry: Registry, url: unknown, fn: (client: Client) => Promise<void>): Promise<void> {
  const server = createMcpServer(registry, opts(url));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("shop_search");
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

const textOf = (result: object): string => (((result as { content?: unknown }).content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");

describe("S-B.6: over MCP, a required withheld value is a violation carried in _meta, never structuredContent", () => {
  it("callTool returns an error whose _meta names the withheld field", async () => {
    const r = await callTool(registryFor(true), "shop_search", {}, opts(EVIL));
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(r._meta?.[CONTRACT_VIOLATION_META_KEY]).toEqual({ error: "contract_violation", capability: "shop.search", missing: [], withheld: ["listingUrl"] });
    expect(textOf(r)).toContain("listingUrl");
    expect(textOf(r)).toContain("outside the declared origins");
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("the audit record names the field and never carries the value", async () => {
    const records: ExecutionRecord[] = [];
    const sink: AuditSink = (rec) => {
      records.push(rec);
    };
    await callTool(registryFor(true), "shop_search", {}, { ...opts(EVIL), auditSink: sink });
    expect(records).toHaveLength(1);
    expect(records[0].status.phase).toBe("failed");
    expect(records[0].status.message).toContain("listingUrl");
    expect(JSON.stringify(records)).not.toContain("evil.example.net");
  });
});

describe("S-B.7: the reference MCP client survives a withheld-value violation", () => {
  it("returns the error result without throwing an output-validation error", async () => {
    await withClient(registryFor(true), EVIL, async (client) => {
      const result = await client.callTool({ name: "shop_search", arguments: {} });
      expect(result.isError).toBe(true);
      expect(result.structuredContent).toBeUndefined();
      expect((result._meta as Record<string, unknown>)[CONTRACT_VIOLATION_META_KEY]).toMatchObject({ withheld: ["listingUrl"] });
      expect(JSON.stringify(result)).not.toContain("evil.example.net");
    });
  });
});

describe("S-B.8 / S-C.3: an optional withheld value never reaches the model", () => {
  it("the response text names the field and does not contain the off-origin host; nor does structuredContent", async () => {
    await withClient(registryFor(false), EVIL, async (client) => {
      const result = await client.callTool({ name: "shop_search", arguments: {} });
      expect(result.isError).toBe(false);
      const text = textOf(result);
      expect(text).toContain("listingUrl");
      expect(text).toContain("withheld");
      expect(text).not.toContain("evil.example.net");
      expect(result.structuredContent).toEqual({ stays: [{ name: "Hotel A" }] });
      expect(JSON.stringify(result)).not.toContain("evil.example.net");
    });
  });
});

describe("S-C.2: the lowered outputSchema accepts the emitted (normalised) value", () => {
  it("a declared-origin value with a space in its path passes the reference client's validation", async () => {
    await withClient(registryFor(true), "https://WWW.example.com/stays/my stay", async (client) => {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "shop_search")!.outputSchema as unknown as { properties: { stays: { items: { properties: Record<string, unknown> } } } };
      expect(schema.properties.stays.items.properties.listingUrl).toEqual({ type: "string", format: "uri" });

      const result = await client.callTool({ name: "shop_search", arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ stays: [{ name: "Hotel A", listingUrl: "https://www.example.com/stays/my%20stay" }] });
    });
  });
});

describe("S-C.5: the Registry keeps the marker", () => {
  it("the tool's output field reports the web-page semantic and the tool reports its origins.pages", () => {
    const registry = registryFor(false);
    const tool = registry.getCapability("shop.search")!;
    expect(tool.origins).toEqual({ pages: ["https://www.example.com"] });
    const stay = registry.getResource("shop.Stay")!;
    expect(stay.find((f) => f.name === "listingUrl")?.type).toEqual({ kind: "scalar", semantic: "web-page" });
  });
});

describe("pass-through floor: a hand-written IR with an unmapped web-page output fails closed", () => {
  it("callTool refuses instead of forwarding the raw body", async () => {
    const tool: IRTool = {
      id: "shop.raw",
      description: "",
      effect: "read",
      provider: "store",
      policies: [],
      lifecycle: "stable",
      input: [],
      output: [{ name: "listingUrl", required: false, type: { kind: "scalar", semantic: "web-page" } }],
      connector: { type: "rest", rest: { baseUrl: "${API_URL}", method: "GET", path: "/raw" } },
      origins: { pages: ["https://www.example.com"] },
    };
    const ir: IR = { version: "0", company: { id: "acme" }, tools: [tool], resources: {} };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ listingUrl: EVIL }), { status: 200 });
    const r = await callTool(new Registry(ir), "shop_raw", {}, { env: { API_URL: "https://api.example.com" }, fetchImpl });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });
});

describe("S-D.5: recording a contract reports withheld", () => {
  it("an optional off-origin value at record time → red, nothing kept, field names only", async () => {
    const registry = registryFor(false);
    const tool = registry.getCapability("shop.search")!;
    const r = await recordContract(tool, {}, registry.ir.resources, { env: { API_URL: "https://api.example.com" }, fetchImpl: respond(EVIL) });
    expect(r.outcome).toBe("red");
    expect(r.withheld).toEqual(["listingUrl"]);
    expect(r.fixture).toBeUndefined();
    expect(r.fingerprint).toBeUndefined();
    expect(r.shape).toBeUndefined();
    expect(r.detail).toBe("not recorded: value outside declared origins in: listingUrl");
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("a required off-origin value is red through the violation, named as withheld", async () => {
    const registry = registryFor(true);
    const r = await recordContract(registry.getCapability("shop.search")!, {}, registry.ir.resources, { env: { API_URL: "https://api.example.com" }, fetchImpl: respond(EVIL) });
    expect(r.outcome).toBe("red");
    expect(r.withheld).toEqual(["listingUrl"]);
    expect(r.fixture).toBeUndefined();
    expect(r.detail).toBe("contract violation on the recorded response: value outside declared origins in: listingUrl");
  });

  it("an on-origin value records green, as before", async () => {
    const registry = registryFor(false);
    const r = await recordContract(registry.getCapability("shop.search")!, {}, registry.ir.resources, { env: { API_URL: "https://api.example.com" }, fetchImpl: respond("https://www.example.com/a") });
    expect(r.outcome).toBe("green");
    expect(r.fixture).toBeDefined();
    expect(r.withheld).toBeUndefined();
  });
});

describe("verifyTool: a withheld value is red, never yellow", () => {
  it("optional withheld → red with the withheld detail; required → red through the violation", async () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-webpage-verify-"));
    dirs.push(dir);
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ capabilityId: "shop.search", request: {} }));
    for (const [required, detail] of [
      [false, "value outside declared origins in: listingUrl"],
      [true, "contract violation: value outside declared origins in: listingUrl"],
    ] as const) {
      const registry = registryFor(required);
      const tool = { ...registry.getCapability("shop.search")!, contract: { fingerprint: "sha256:x", probeFixture: "fixture.json" } };
      const r = await verifyTool(tool, dir, registry.ir.resources, { env: { API_URL: "https://api.example.com" }, fetchImpl: respond(EVIL) });
      expect(r.status).toBe("red");
      expect(r.detail).toBe(detail);
    }
  });
});
