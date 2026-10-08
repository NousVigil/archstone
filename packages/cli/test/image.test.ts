// `image` through the real CLI (issue #152): `archstone apply` exit codes for the compile rules
// and warnings, `archstone verify` against a mock backend (S-D2), and `archstone adopt`, which
// records the replayed response against the manifest's own resources so a withheld image item
// stops the adoption (names only). Manifests are generated into a temp dir per test.

import { describe, it, expect, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { fingerprintShape } from "@archstone/compiler";

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");

const IMG = "https://img.example.com";
const EVIL = "https://evil.example.net/a.jpg";
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

interface Manifest {
  photosRequired: boolean;
  /** Body the mock serves, and the contract's fingerprint is computed from (omit: no contract). */
  body?: unknown;
  /** Replaces the default binding blocks (response: + origins:). */
  bindingBlocks?: string;
  output?: string;
  input?: string;
}

function writeManifest(m: Manifest): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-cli-image-"));
  dirs.push(dir);
  const contract =
    m.body === undefined
      ? ""
      : `  contract:\n    source: recorded\n    fingerprint: "${fingerprintShape(m.body)}"\n    verifiedAt: "2026-10-01T00:00:00Z"\n    probe:\n      fixture: fixtures/shop.search.golden.json\n`;
  const files: Record<string, string> = {
    "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
    "shop.search.capability.yaml":
      "capability:\n  id: shop.search\n  description: find stays\n  effect: read\n  provider: store\n" + (m.input ?? "") + (m.output ?? "  output:\n    stays:\n      collection: Stay\n"),
    "shop.Stay.resource.yaml": `resource:\n  name: shop.Stay\n  fields:\n    name:\n      type: text\n    photos:\n      list: image\n      required: ${m.photosRequired}\n`,
    "bindings/shop.search.binding.yaml":
      'binding:\n  capabilityId: shop.search\n  connector:\n    type: rest\n    rest:\n      baseUrl: "${API_URL}"\n      method: GET\n      path: /search\n' +
      (m.bindingBlocks ??
        `  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      photos: "$.photos"\n  origins:\n    images:\n      - "${IMG}"\n`) +
      contract,
  };
  if (m.body !== undefined) files["fixtures/shop.search.golden.json"] = JSON.stringify({ capabilityId: "shop.search", request: {} });
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

function startMock(body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const server = createServer((_req, resp) => {
      resp.setHeader("content-type", "application/json");
      resp.end(JSON.stringify(body));
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      res({ url: `http://localhost:${port}`, close: () => new Promise((r) => server.close(() => r())) });
    });
  });
}

const stays = (...photos: unknown[][]) => ({ results: photos.map((p, i) => ({ name: `Hotel ${i}`, photos: p })) });

describe("archstone apply — the image compile rules", () => {
  it("a list: image input field fails apply, exit 1", async () => {
    const r = await run(["apply", writeManifest({ photosRequired: false, input: "  input:\n    pics:\n      list: image\n" })]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("input field 'pics' is of type list: image, which is output-only");
  }, 20000);

  it("a list: image output with no origins.images fails apply (image-no-origins), exit 1", async () => {
    const r = await run(["apply", writeManifest({ photosRequired: false, bindingBlocks: '  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      photos: "$.photos"\n' })]);
    expect(r.code).toBe(1);
    expect(r.stdout + r.stderr).toContain("declares no origins.images");
  }, 20000);

  it("unused origins.images warns, exit 0", async () => {
    const r = await run([
      "apply",
      writeManifest({ photosRequired: false, output: "  output:\n    title:\n      type: text\n", bindingBlocks: `  extract:\n    title: "$.title"\n  origins:\n    images:\n      - "${IMG}"\n` }),
    ]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).toMatch(/⚠ .*declares origins\.images, but capability 'shop\.search''s output reaches no field/);
  }, 20000);

  it("a required list: image in a collection compiles clean — no required-in-collection warning, exit 0", async () => {
    const r = await run(["apply", writeManifest({ photosRequired: true })]);
    expect(r.code).toBe(0);
    expect(r.stdout + r.stderr).not.toContain("required inside a collection");
  }, 20000);
});

describe("archstone verify — a withheld image item", () => {
  async function verify(m: Manifest, body: unknown): Promise<Run> {
    const dir = writeManifest({ ...m, body });
    const mock = await startMock(body);
    try {
      return await run(["verify", dir], { API_URL: mock.url });
    } finally {
      await mock.close();
    }
  }
  const line = (out: string) => out.split("\n").find((l) => l.includes("shop.search —")) ?? "";

  for (const required of [false, true]) {
    it(`S-D2: an off-origin item in a ${required ? "required" : "optional"} list is red, naming photos[1], exit 1, no value printed`, async () => {
      const r = await verify({ photosRequired: required }, stays([`${IMG}/1.jpg`, EVIL]));
      expect(r.code).toBe(1);
      expect(line(r.stdout)).toMatch(/🔴 shop\.search — value outside declared origins in: photos\[1\]$/);
      expect(r.stdout + r.stderr).not.toContain("evil.example.net");
    }, 20000);
  }

  it("a fixture whose images are all on the declared origin stays green, exit 0", async () => {
    const r = await verify({ photosRequired: true }, stays([`${IMG}/1.jpg`, "https://IMG.example.com/2.jpg"]));
    expect(r.code).toBe(0);
    expect(line(r.stdout)).toMatch(/🟢 shop\.search — fingerprint unchanged, mapping OK$/);
  }, 20000);
});

describe("archstone adopt — records against the manifest's own resources", () => {
  /** stdin at EOF, as in an ordinary piped invocation (see adopt.test.ts). */
  function runAdopt(dir: string, url: string): Promise<{ code: number; out: string }> {
    return new Promise((res) => {
      const child = spawn(tsx, [cli, "adopt", dir], { cwd: root, env: { ...process.env, API_URL: url }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      child.stderr.on("data", (d) => (out += d));
      child.on("close", (code) => res({ code: code ?? 1, out }));
    });
  }

  it("an off-origin item stops the adoption: red, field name only, manifest untouched", async () => {
    const body = stays([`${IMG}/1.jpg`, EVIL]);
    const dir = writeManifest({ photosRequired: false, body });
    const before = readFileSync(join(dir, "bindings/shop.search.binding.yaml"), "utf8");
    const mock = await startMock(body);
    try {
      const { code, out } = await runAdopt(dir, mock.url);
      expect(code).not.toBe(0);
      expect(out).toContain("value outside declared origins in: photos[1]");
      expect(out).not.toContain("evil.example.net");
      expect(readFileSync(join(dir, "bindings/shop.search.binding.yaml"), "utf8")).toBe(before);
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("on-origin images record fine: nothing to adopt, exit 0", async () => {
    const body = stays([`${IMG}/1.jpg`, `${IMG}/2.jpg`]);
    const dir = writeManifest({ photosRequired: false, body });
    const mock = await startMock(body);
    try {
      const { code, out } = await runAdopt(dir, mock.url);
      expect(out).toContain("nothing to adopt");
      expect(code).toBe(0);
    } finally {
      await mock.close();
    }
  }, 30_000);
});
