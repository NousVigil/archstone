// `web-page` through the real CLI (issue #141): `archstone apply` exit codes for the compile
// rules (S-A.4, S-A.13, S-A.14) and `archstone verify` end to end against a mock backend
// (S-D.1 – S-D.4). Manifests are generated into a temp dir per test; each contract's fingerprint
// is computed from the very body the mock serves, so drift never colours a result.

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

const EVIL = "https://evil.example.net/x";
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}
async function run(args: string[], env: Record<string, string> = {}): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(tsx, [cli, ...args], { cwd: root, env: { ...process.env, ...env } });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, code: err.code };
  }
}

interface Cap {
  /** The part after `shop.`; also the backend path. */
  name: string;
  listingRequired: boolean;
  /** What the mock backend returns for this capability — the contract is recorded against it. */
  body?: unknown;
  /** Replaces the default binding blocks (response: + origins:) — for the apply tests. */
  bindingBlocks?: string;
  /** Replaces the default `output:` block. */
  output?: string;
  input?: string;
}

function writeManifest(caps: Cap[]): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-cli-webpage-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "capabilities.yaml": `company:\n  id: acme\ncapabilities:\n${caps.map((c) => `  - shop.${c.name}\n`).join("")}providers:\n  - store\n`,
  };
  for (const c of caps) {
    files[`shop.${c.name}.capability.yaml`] =
      `capability:\n  id: shop.${c.name}\n  description: find stays\n  effect: read\n  provider: store\n` +
      (c.input ?? "") +
      (c.output ?? `  output:\n    stays:\n      collection: Stay${cap(c.name)}\n`);
    files[`shop.Stay${cap(c.name)}.resource.yaml`] =
      `resource:\n  name: shop.Stay${cap(c.name)}\n  fields:\n    name:\n      type: text\n    listingUrl:\n      type: web-page\n      required: ${c.listingRequired}\n`;
    const blocks =
      c.bindingBlocks ??
      `  response:\n    collection: "$.results[*]"\n    resource: Stay${cap(c.name)}\n    map:\n      name: "$.name"\n      listingUrl: "$.url"\n` +
        '  origins:\n    pages:\n      - "https://www.example.com"\n';
    const contract =
      c.body === undefined
        ? ""
        : `  contract:\n    source: recorded\n    fingerprint: "${fingerprintShape(c.body)}"\n    verifiedAt: "2026-10-01T00:00:00Z"\n    probe:\n      fixture: fixtures/shop.${c.name}.golden.json\n`;
    files[`bindings/shop.${c.name}.binding.yaml`] =
      `binding:\n  capabilityId: shop.${c.name}\n  connector:\n    type: rest\n    rest:\n      baseUrl: "\${API_URL}"\n      method: GET\n      path: /${c.name}\n` + blocks + contract;
    if (c.body !== undefined) files[`fixtures/shop.${c.name}.golden.json`] = JSON.stringify({ capabilityId: `shop.${c.name}`, request: {} });
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function cap(name: string): string {
  return name
    .split("-")
    .map((p) => p[0].toUpperCase() + p.slice(1))
    .join("");
}

/** A mock backend serving each capability's `body` at `/<name>`. */
function startMock(caps: Cap[]): Promise<{ url: string; close: () => Promise<void> }> {
  const byPath = new Map(caps.map((c) => [`/${c.name}`, c.body]));
  return new Promise((res) => {
    const server = createServer((req, resp) => {
      resp.setHeader("content-type", "application/json");
      resp.end(JSON.stringify(byPath.get((req.url ?? "").split("?")[0]) ?? {}));
    });
    server.listen(0, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      res({ url: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

async function verify(caps: Cap[]): Promise<Run> {
  const dir = writeManifest(caps);
  const mock = await startMock(caps);
  try {
    return await run(["verify", dir], { API_URL: mock.url });
  } finally {
    await mock.close();
  }
}

const line = (out: string, id: string) => out.split("\n").find((l) => l.includes(`shop.${id} —`)) ?? "";

describe("archstone apply — the web-page compile rules", () => {
  it("S-A.4: a web-page input field fails apply with web-page-in-input, exit 1", async () => {
    const dir = writeManifest([{ name: "search", listingRequired: false, input: "  input:\n    page:\n      type: web-page\n" }]);
    const r = await run(["apply", dir]);
    expect(r.code).toBe(1);
    // apply prints the diagnostic's message (the code is the compiler test's to pin).
    expect(r.stdout + r.stderr).toContain("input field 'page' is of type web-page, which is output-only");
  }, 20000);

  it("S-A.13: unused origins warn, exit 0", async () => {
    const dir = writeManifest([
      {
        name: "search",
        listingRequired: false,
        output: "  output:\n    title:\n      type: text\n",
        bindingBlocks: '  extract:\n    title: "$.title"\n  origins:\n    pages:\n      - "https://www.example.com"\n',
      },
    ]);
    const r = await run(["apply", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/⚠ .*declares origins\.pages, but capability 'shop\.search''s output reaches no field/);
  }, 20000);

  it("S-A.14: a required web-page in a collection without onError warns, exit 0", async () => {
    const dir = writeManifest([{ name: "search", listingRequired: true }]);
    const r = await run(["apply", dir]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/⚠ .*web-page field 'stays\.listingUrl' is required inside a collection .* Consider making the field optional/);
  }, 20000);
});

describe("archstone verify — a withheld value", () => {
  it("S-D.1: an off-origin optional value is red, with the withheld detail line, exit 1", async () => {
    const r = await verify([{ name: "off", listingRequired: false, body: { results: [{ name: "A", url: EVIL }] } }]);
    expect(r.code).toBe(1);
    expect(line(r.stdout, "off")).toMatch(/🔴 shop\.off — value outside declared origins in: listingUrl$/);
    expect(r.stdout + r.stderr).not.toContain("evil.example.net");
  }, 20000);

  it("S-D.2: absent-optional is yellow with the degraded text; withheld is red with the withheld text", async () => {
    const r = await verify([
      { name: "absent", listingRequired: false, body: { results: [{ name: "A" }] } },
      { name: "withheld", listingRequired: false, body: { results: [{ name: "A", url: EVIL }] } },
    ]);
    expect(r.code).toBe(1);
    expect(line(r.stdout, "absent")).toMatch(/🟡 shop\.absent — degraded: optional field\(s\) absent — listingUrl$/);
    expect(line(r.stdout, "withheld")).toMatch(/🔴 shop\.withheld — value outside declared origins in: listingUrl$/);
  }, 20000);

  it("S-D.3: a required off-origin value is red through the violation, named as withheld not missing, exit 1", async () => {
    const r = await verify([{ name: "required", listingRequired: true, body: { results: [{ name: "A", url: EVIL }] } }]);
    expect(r.code).toBe(1);
    const l = line(r.stdout, "required");
    expect(l).toMatch(/🔴 shop\.required — contract violation: value outside declared origins in: listingUrl$/);
    expect(l).not.toContain("missing");
    expect(r.stdout + r.stderr).not.toContain("evil.example.net");
  }, 20000);

  it("S-D.4: a fixture whose web-page values are all on declared origins stays green, exit 0", async () => {
    const r = await verify([{ name: "clean", listingRequired: true, body: { results: [{ name: "A", url: "https://www.example.com/a" }, { name: "B", url: "https://WWW.example.com/b" }] } }]);
    expect(r.code).toBe(0);
    expect(line(r.stdout, "clean")).toMatch(/🟢 shop\.clean — fingerprint unchanged, mapping OK$/);
  }, 20000);
});
