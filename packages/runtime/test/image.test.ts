// `image` over MCP, in the Registry, at contract recording and in `verify` (issue #152):
// S-B14 (MCP leg), S-C4, S-D1, S-D2, S-D3. A real manifest on disk, built by `buildRegistry`,
// served through the reference MCP SDK client over its own InMemoryTransport — the client that
// validates `structuredContent` against the advertised `outputSchema` unconditionally.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { Registry } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { buildRegistry } from "../src/registry";
import { callTool, createMcpServer } from "../src/server";
import { recordContract, verifyTool } from "../src/verify";

const IMG = "https://img.example.com";
const EVIL = "https://evil.example.net/a.jpg";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

/** A `shop.search` manifest: a collection of Stay rows whose `photos` is a `list: image`. */
function manifest(photosRequired: boolean, origins = `  origins:\n    images:\n      - "${IMG}"\n`): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-image-rt-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
    "shop.search.capability.yaml":
      "capability:\n  id: shop.search\n  description: find stays\n  effect: read\n  provider: store\n  output:\n    stays:\n      collection: Stay\n",
    "shop.Stay.resource.yaml": `resource:\n  name: shop.Stay\n  fields:\n    name:\n      type: text\n    photos:\n      list: image\n      required: ${photosRequired}\n`,
    "bindings/shop.search.binding.yaml":
      'binding:\n  capabilityId: shop.search\n  connector:\n    type: rest\n    rest:\n      baseUrl: "${API_URL}"\n      method: GET\n      path: /search\n' +
      '  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      photos: "$.photos"\n' +
      origins,
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function registryFor(photosRequired: boolean, origins?: string): Registry {
  const built = buildRegistry(manifest(photosRequired, origins));
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.registry!;
}

const respond = (photos: unknown): FetchLike => async () => new Response(JSON.stringify({ results: [{ name: "Hotel A", photos }] }), { status: 200 });
const opts = (photos: unknown) => ({ env: { API_URL: "https://api.example.com" }, fetchImpl: respond(photos) });
const textOf = (result: object): string => (((result as { content?: unknown }).content ?? []) as { text?: string }[]).map((c) => c.text ?? "").join("\n");

async function withClient(registry: Registry, photos: unknown, fn: (client: Client) => Promise<void>): Promise<void> {
  const server = createMcpServer(registry, opts(photos));
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  try {
    await client.listTools(); // arms the client's outputSchema validator, as in production
    await fn(client);
  } finally {
    await client.close();
    await server.close();
  }
}

describe("S-B14 (MCP) / S-C4: a shortened list is served and still validates against the advertised outputSchema", () => {
  it("one off-origin item is dropped; the response names photos[1]; the real client accepts it", async () => {
    await withClient(registryFor(false), [`${IMG}/1.jpg`, EVIL, `${IMG}/3.jpg`], async (client) => {
      const result = await client.callTool({ name: "shop_search", arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ stays: [{ name: "Hotel A", photos: [`${IMG}/1.jpg`, `${IMG}/3.jpg`] }] });
      expect(textOf(result)).toContain("photos[1]");
      expect(JSON.stringify(result)).not.toContain("evil.example.net");
    });
  });

  it("a required list with every item withheld is served present and empty, not as a violation", async () => {
    await withClient(registryFor(true), [EVIL, EVIL], async (client) => {
      const result = await client.callTool({ name: "shop_search", arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ stays: [{ name: "Hotel A", photos: [] }] });
      expect(textOf(result)).toContain("photos[0]");
      expect(textOf(result)).toContain("photos[1]");
      expect(JSON.stringify(result)).not.toContain("evil.example.net");
    });
  });

  it("the advertised property is an array of uri strings with no minItems", async () => {
    await withClient(registryFor(false), [], async (client) => {
      const { tools } = await client.listTools();
      const schema = tools.find((t) => t.name === "shop_search")!.outputSchema as unknown as { properties: { stays: { items: { properties: { photos: Record<string, unknown> } } } } };
      const photos = schema.properties.stays.items.properties.photos;
      expect(photos.items).toEqual({ type: "string", format: "uri" });
      expect(photos).not.toHaveProperty("minItems");
    });
  });

  it("callTool: a clean list is served untouched", async () => {
    const r = await callTool(registryFor(false), "shop_search", {}, opts([`${IMG}/1.jpg`]));
    expect(r.isError).toBeFalsy();
    expect(r.structuredContent).toEqual({ stays: [{ name: "Hotel A", photos: [`${IMG}/1.jpg`] }] });
  });
});

describe("Registry: the marker survives, and one resource may reach both origin-bound types", () => {
  it("the tool reports origins.images and the field is a list of image", () => {
    const registry = registryFor(false);
    expect(registry.getCapability("shop.search")!.origins).toEqual({ images: [IMG] });
    expect(registry.getResource("shop.Stay")!.find((f) => f.name === "photos")?.type).toEqual({ kind: "list", items: "image" });
  });

  it("a resource carrying both a web-page and an image is checked per list (a page-host URL in a photo is withheld)", async () => {
    const dir = manifest(false, `  origins:\n    pages:\n      - "https://www.example.com"\n    images:\n      - "${IMG}"\n`);
    writeFileSync(
      join(dir, "shop.Stay.resource.yaml"),
      "resource:\n  name: shop.Stay\n  fields:\n    name:\n      type: text\n    listingUrl:\n      type: web-page\n      required: false\n    photos:\n      list: image\n      required: false\n",
    );
    writeFileSync(
      join(dir, "bindings/shop.search.binding.yaml"),
      'binding:\n  capabilityId: shop.search\n  connector:\n    type: rest\n    rest:\n      baseUrl: "${API_URL}"\n      method: GET\n      path: /search\n' +
        '  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      listingUrl: "$.url"\n      photos: "$.photos"\n' +
        `  origins:\n    pages:\n      - "https://www.example.com"\n    images:\n      - "${IMG}"\n`,
    );
    const built = buildRegistry(dir);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ results: [{ name: "A", url: `${IMG}/p`, photos: ["https://www.example.com/a.jpg", `${IMG}/b.jpg`] }] }), { status: 200 });
    const r = await callTool(built.registry!, "shop_search", {}, { env: { API_URL: "https://api.example.com" }, fetchImpl });
    expect(r.structuredContent).toEqual({ stays: [{ name: "A", photos: [`${IMG}/b.jpg`] }] });
    expect(textOf(r)).toContain("listingUrl");
    expect(textOf(r)).toContain("photos[0]");
  });
});

describe("S-D1 / S-D3: recording a contract", () => {
  const record = (registry: Registry, photos: unknown) =>
    recordContract(registry.getCapability("shop.search")!, {}, registry.ir.resources, opts(photos));

  it("S-D1: the recorded shape marks the list as an array of strings, never the type name", async () => {
    const r = await record(registryFor(false), [`${IMG}/1.jpg`]);
    expect(r.outcome).toBe("green");
    expect(JSON.stringify(r.shape)).not.toContain("image");
    expect(JSON.stringify(r.shape)).toContain("string");
  });

  it("S-D3: only the URL values differ → equal fingerprints", async () => {
    const registry = registryFor(false);
    const a = await record(registry, [`${IMG}/1.jpg`]);
    const b = await record(registry, [`${IMG}/completely/other.jpg`]);
    expect(a.fingerprint).toBeDefined();
    expect(a.fingerprint).toBe(b.fingerprint);
  });

  it("an off-origin item at record time → red, nothing kept, names only", async () => {
    const r = await record(registryFor(false), [`${IMG}/1.jpg`, EVIL]);
    expect(r.outcome).toBe("red");
    expect(r.withheld).toEqual(["photos[1]"]);
    expect(r.fixture).toBeUndefined();
    expect(r.fingerprint).toBeUndefined();
    expect(r.detail).toBe("not recorded: value outside declared origins in: photos[1]");
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });
});

describe("S-D2: verify is red for a withheld item, optional or required", () => {
  for (const required of [false, true]) {
    it(`${required ? "required" : "optional"} list: red, naming photos[1], never the value`, async () => {
      const dir = mkdtempSync(join(tmpdir(), "archstone-image-verify-"));
      dirs.push(dir);
      writeFileSync(join(dir, "fixture.json"), JSON.stringify({ capabilityId: "shop.search", request: {} }));
      const registry = registryFor(required);
      const tool = { ...registry.getCapability("shop.search")!, contract: { fingerprint: "sha256:x", probeFixture: "fixture.json" } };
      const r = await verifyTool(tool, dir, registry.ir.resources, opts([`${IMG}/1.jpg`, EVIL]));
      expect(r.status).toBe("red");
      expect(r.detail).toBe("value outside declared origins in: photos[1]");
      expect(JSON.stringify(r)).not.toContain("evil.example.net");
    });
  }
});

describe("pass-through floor: an unmapped list: image on a hand-written IR is refused", () => {
  it("callTool refuses instead of forwarding the raw body", async () => {
    const ir = {
      version: "0" as const,
      company: { id: "acme" },
      resources: {},
      tools: [
        {
          id: "shop.raw",
          description: "",
          effect: "read" as const,
          provider: "store",
          policies: [],
          lifecycle: "stable" as const,
          input: [],
          output: [{ name: "photos", required: false, type: { kind: "list" as const, items: "image" as const } }],
          connector: { type: "rest" as const, rest: { baseUrl: "${API_URL}", method: "GET", path: "/raw" } },
          origins: { images: [IMG] },
        },
      ],
    };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ photos: [EVIL] }), { status: 200 });
    const r = await callTool(new Registry(ir), "shop_raw", {}, { env: { API_URL: "https://api.example.com" }, fetchImpl });
    expect(r.isError).toBe(true);
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });
});
