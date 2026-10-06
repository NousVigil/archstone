// #146 through the real CLI: `archstone verify` prints the names — never the values — of the
// undeclared keys the mapper dropped from a nested resource value, as an informational line under
// the capability. It does not change the verdict or the exit code.

import { describe, it, expect, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fingerprintShape } from "@archstone/compiler";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");

const body = { stays: [{ name: "Casa", host: { name: "Ana", phone: "+40 700 000 000", internalNote: "do not show" } }] };
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function writeManifest(): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-cli-nested-"));
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

function startMock(): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const server = createServer((_req, resp) => {
      resp.setHeader("content-type", "application/json");
      resp.end(JSON.stringify(body));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ url: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function run(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; code: number }> {
  try {
    const { stdout, stderr } = await execFileAsync(tsx, [cli, ...args], { cwd: root, env: { ...process.env, ...env } });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, code: err.code };
  }
}

describe("archstone verify — undeclared nested keys (#146)", () => {
  it("prints the dropped key names under a green result, never the values; exit 0", async () => {
    const dir = writeManifest();
    const mock = await startMock();
    try {
      const r = await run(["verify", dir], { API_URL: mock.url });
      expect(r.code).toBe(0);
      const lines = r.stdout.split("\n");
      const i = lines.findIndex((l) => l.includes("tourism.search —"));
      expect(lines[i]).toMatch(/🟢 tourism\.search — fingerprint unchanged, mapping OK$/);
      expect(lines[i + 1].trim()).toBe("nested keys not declared (dropped): host.phone, host.internalNote");
      expect(r.stdout + r.stderr).not.toContain("+40 700");
      expect(r.stdout + r.stderr).not.toContain("do not show");
    } finally {
      await mock.close();
    }
  }, 20000);
});
