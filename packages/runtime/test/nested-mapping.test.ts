// #146 end to end: a real manifest on disk whose output resource nests another resource, served
// through the reference MCP SDK client — undeclared keys inside the nested value reach neither
// `structuredContent` nor the model-facing text — and replayed by `verifyTool`, which names (never
// shows) what it dropped without changing the verdict.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fingerprintShape } from "@archstone/compiler";
import type { Registry } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { buildRegistry } from "../src/registry";
import { createMcpServer } from "../src/server";
import { verifyTool } from "../src/verify";

const body = { stays: [{ name: "Casa", host: { name: "Ana", phone: "+40 700 000 000", internalNote: "do not show" } }] };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function manifest(): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-nested-rt-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - tourism.search\nproviders:\n  - stays\n",
    "tourism.search.capability.yaml":
      "capability:\n  id: tourism.search\n  description: find stays\n  effect: read\n  provider: stays\n  output:\n    stays:\n      collection: Stay\n",
    "tourism.Stay.resource.yaml": "resource:\n  name: tourism.Stay\n  fields:\n    name:\n      type: text\n    host:\n      type: Host\n",
    "tourism.Host.resource.yaml": "resource:\n  name: tourism.Host\n  fields:\n    name:\n      type: text\n",
    "bindings/tourism.search.binding.yaml":
      'binding:\n  capabilityId: tourism.search\n  connector:\n    type: rest\n    rest:\n      baseUrl: "${API_URL}"\n      method: GET\n      path: /search\n' +
      '  response:\n    collection: "$.stays[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      host: "$.host"\n' +
      `  contract:\n    source: recorded\n    fingerprint: "${fingerprintShape(body)}"\n    verifiedAt: "2026-10-01T00:00:00Z"\n    probe:\n      fixture: fixtures/golden.json\n`,
    "fixtures/golden.json": JSON.stringify({ capabilityId: "tourism.search", request: {} }),
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const fetchImpl: FetchLike = async () => new Response(JSON.stringify(body), { status: 200 });
const opts = { env: { API_URL: "https://api.example.com" }, fetchImpl };

function registryAt(dir: string): Registry {
  const built = buildRegistry(dir);
  expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
  return built.registry!;
}

describe("#146 over MCP: a nested resource value carries only its declared fields", () => {
  it("structuredContent and the text content contain neither phone nor internalNote", async () => {
    const server = createMcpServer(registryAt(manifest()), opts);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.listTools(); // arms the client's outputSchema validator, as in production
      const result = await client.callTool({ name: "tourism_search", arguments: {} });
      expect(result.isError).toBe(false);
      expect(result.structuredContent).toEqual({ stays: [{ name: "Casa", host: { name: "Ana" } }] });
      const all = JSON.stringify(result);
      for (const leak of ["phone", "internalNote", "+40 700", "do not show"]) expect(all).not.toContain(leak);
    } finally {
      await client.close();
      await server.close();
    }
  });
});

describe("#146 in verify: dropped nested keys are named, never shown, and never change the verdict", () => {
  it("green, with undeclaredNested naming host.phone and host.internalNote", async () => {
    const dir = manifest();
    const registry = registryAt(dir);
    const tool = registry.listCapabilities().find((t) => t.id === "tourism.search")!;
    const r = await verifyTool(tool, dir, registry.ir.resources, opts);
    expect(r.status).toBe("green");
    expect(r.undeclaredNested).toEqual(["host.phone", "host.internalNote"]);
    expect(JSON.stringify(r)).not.toContain("+40 700");
    expect(JSON.stringify(r)).not.toContain("do not show");
  });
});
