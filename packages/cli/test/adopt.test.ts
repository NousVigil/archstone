import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");
const stayFile = resolve(tourism, "tourism.Stay.resource.yaml");
const bindingFile = resolve(tourism, "bindings/tourism.search.binding.yaml");

/** The recorded shape, plus a field the manifest has never heard of. */
const GROWN_STAY = {
  id: "azur-01",
  name: "Hotel Azur",
  location: "Nice, France",
  pricePerNight: 118,
  rating: 4.5,
  boardType: "BREAKFAST",
  freeCancellationUntil: "2026-07-11",
  roomDescription: "Junior Suite, terrace",
  net: 92.04,
  commission: 14.16,
  distanceToBeachM: 240,
};

function startMock(body: unknown): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((res) => {
    const server = createServer((_req, r) => {
      r.setHeader("content-type", "application/json");
      r.end(JSON.stringify(body));
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      res({
        url: `http://localhost:${port}`,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Run the verb with stdin already at EOF — the ordinary piped/CI invocation.
 *
 * `spawn` with `stdio[0] = "ignore"` hands the child /dev/null, which ends immediately.
 * `execFile` cannot express this: it gives the child a pipe that stays open, so readline's
 * question never settles and the test hangs rather than exercising the refusal.
 */
function runAdopt(url: string): Promise<{ code: number; out: string }> {
  return new Promise((res) => {
    const child = spawn(tsx, [cli, "adopt", tourism], {
      cwd: root,
      env: { ...process.env, STAYS_API_URL: url },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => res({ code: code ?? 1, out }));
  });
}

describe("archstone adopt — it needs a person (ADD-117 D-2, ADR-0008 R-1)", () => {
  it("refuses without a human, writes nothing, and exits non-zero", async () => {
    const before = { stay: readFileSync(stayFile, "utf8"), binding: readFileSync(bindingFile, "utf8") };
    const mock = await startMock({ stays: [GROWN_STAY], totalMatches: 1 });
    try {
      const { code, out } = await runAdopt(mock.url);
      // It got far enough to SEE the field — this is not a "nothing to do" pass.
      expect(out).toContain("distanceToBeachM");
      expect(out).toContain("nothing written");
      expect(code).not.toBe(0);
      // And the manifest is untouched, which is the property that matters.
      expect(readFileSync(stayFile, "utf8")).toBe(before.stay);
      expect(readFileSync(bindingFile, "utf8")).toBe(before.binding);
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("exits 0 and writes nothing when the backend has gained nothing", async () => {
    const { distanceToBeachM: _unused, ...unchanged } = GROWN_STAY;
    const before = readFileSync(stayFile, "utf8");
    const mock = await startMock({ stays: [unchanged], totalMatches: 1 });
    try {
      const { code, out } = await runAdopt(mock.url);
      expect(out).toContain("nothing to adopt");
      expect(code).toBe(0);
      expect(readFileSync(stayFile, "utf8")).toBe(before);
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("reports what it will not adopt rather than dropping it silently", async () => {
    const mock = await startMock({ stays: [{ ...GROWN_STAY, refundable: true, amenities: ["wifi"] }], totalMatches: 1 });
    try {
      const { out } = await runAdopt(mock.url);
      expect(out).toContain("not adoptable");
      expect(out).toContain("structure rather than a value");
    } finally {
      await mock.close();
    }
  }, 30_000);
});
