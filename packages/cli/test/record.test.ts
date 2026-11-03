import { describe, it, expect, afterEach } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { load } from "@archstone/schema";
import { compile, validateSemantics } from "@archstone/compiler";

// `archstone record`: records a `contract:` for an EXISTING manifest. Every test works on a
// temp COPY of examples/manifests/tourism — the checked-in example is never written.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const tourism = resolve(root, "examples/manifests/tourism");
const BINDING = "bindings/tourism.search.binding.yaml";
const FIXTURE = "fixtures/tourism.search.golden.json";

/** Exactly the shape the example's contract was recorded from. */
const STAY = {
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
};
const RECORDED_BODY = { stays: [STAY], totalMatches: 1 };

const checkedIn = readFileSync(join(tourism, BINDING), "utf8");
const checkedInFingerprint = /fingerprint: "([^"]+)"/.exec(checkedIn)![1];

const scratch: string[] = [];
afterEach(() => {
  for (const d of scratch.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A temp copy of the tourism manifest; `stripContract` removes the binding's contract block
 *  (and the comment introducing it) so the copy is a manifest that was never recorded. */
function copyTourism(stripContract: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-record-test-"));
  scratch.push(dir);
  cpSync(tourism, dir, { recursive: true });
  if (stripContract) {
    const cut = checkedIn.indexOf("  # What we last verified");
    writeFileSync(join(dir, BINDING), checkedIn.slice(0, cut).replace(/\n+$/, "\n"));
  }
  return dir;
}

function startMock(status: number, body: unknown): Promise<{ url: string; hits: () => number; close: () => Promise<void> }> {
  return new Promise((res) => {
    let hits = 0;
    const server = createServer((_req, r) => {
      hits++;
      r.statusCode = status;
      r.setHeader("content-type", "application/json");
      r.end(JSON.stringify(body));
    });
    server.listen(0, () => {
      const port = (server.address() as { port: number }).port;
      res({
        url: `http://localhost:${port}`,
        hits: () => hits,
        close: () => new Promise((done) => server.close(() => done())),
      });
    });
  });
}

/**
 * Run the verb. With `answers` undefined, stdin is already at EOF (`"ignore"` hands the child
 * /dev/null) — the piped/CI invocation. With `answers`, each one is typed only once its prompt
 * has appeared: readline drops lines that arrive while no question is pending, so answers cannot
 * be piped in up front (see `terminalAsk`). When the answers run out, stdin is closed.
 */
function runRecord(args: string[], url: string, answers?: string[]): Promise<{ code: number; out: string; prompts: number }> {
  return new Promise((res) => {
    const child = spawn(tsx, [cli, "record", ...args], {
      cwd: root,
      env: { ...process.env, STAYS_API_URL: url },
      stdio: [answers ? "pipe" : "ignore", "pipe", "pipe"],
    });
    let out = "";
    let prompts = 0;
    child.stdout!.on("data", (d) => {
      out += d;
      const seen = out.split("[y/N] ").length - 1;
      while (prompts < seen) {
        const answer = answers?.[prompts];
        prompts++;
        if (answer === undefined) child.stdin?.end();
        else child.stdin?.write(`${answer}\n`);
      }
    });
    child.stderr!.on("data", (d) => (out += d));
    child.on("close", (code) => res({ code: code ?? 1, out, prompts }));
  });
}

function compilesClean(dir: string): void {
  const loaded = load(dir);
  expect(loaded.ok).toBe(true);
  expect(validateSemantics(loaded).filter((d) => d.severity === "error")).toEqual([]);
  expect(() => compile(loaded)).not.toThrow();
}

/** Every line of `before` is in `after`, in order — the edit only ever adds or replaces lines. */
function expectLinesPreserved(before: string, after: string, except: (line: string) => boolean = () => false): void {
  const out = after.split("\n");
  let at = 0;
  for (const line of before.split("\n")) {
    if (except(line)) continue;
    const found = out.indexOf(line, at);
    expect(found, `line not preserved in order: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(0);
    at = found + 1;
  }
}

describe("archstone record — a contract for a manifest that has none", () => {
  it("records it: the binding gains contract:, every original line survives, the fixture is untouched", async () => {
    const dir = copyTourism(true);
    const before = readFileSync(join(dir, BINDING), "utf8");
    const fixtureBefore = readFileSync(join(dir, FIXTURE), "utf8");
    const mock = await startMock(200, RECORDED_BODY);
    try {
      // consent, the POST-is-not-a-GET confirmation (R-8), write.
      const { code, out, prompts } = await runRecord([dir], mock.url, ["y", "y", "y"]);
      expect(out).toContain("POST /v1/search");
      expect(out).toContain(FIXTURE);
      expect(prompts).toBe(3);
      expect(code).toBe(0);
      expect(mock.hits()).toBe(1);

      const after = readFileSync(join(dir, BINDING), "utf8");
      expect(after.startsWith(before.replace(/\n$/, ""))).toBe(true);
      expectLinesPreserved(before, after);
      expect(after).toContain("\n  contract:\n    source: recorded\n");
      // The same backend shape the example was recorded from → the same fingerprint and shape.
      expect(after).toContain(`    fingerprint: "${checkedInFingerprint}"`);
      const shapeOf = (y: string) => y.slice(y.indexOf("    shape:\n"), y.indexOf("    verifiedAt:"));
      expect(shapeOf(after)).toBe(shapeOf(checkedIn));
      expect(after).toMatch(/\n {4}verifiedAt: "\d{4}-\d\d-\d\dT[^"]+Z"\n {4}probe:\n {6}fixture: fixtures\/tourism\.search\.golden\.json\n$/);

      compilesClean(dir);
      expect(readFileSync(join(dir, FIXTURE), "utf8")).toBe(fixtureBefore);
    } finally {
      await mock.close();
    }
  }, 60_000);

  it("refuses without a human: stdin closed → nothing written, exit 1, and no request was sent", async () => {
    const dir = copyTourism(true);
    const before = readFileSync(join(dir, BINDING), "utf8");
    const mock = await startMock(200, RECORDED_BODY);
    try {
      const { code, out } = await runRecord([dir], mock.url);
      expect(out).toContain("no more input");
      expect(code).toBe(1);
      expect(mock.hits()).toBe(0);
      expect(readFileSync(join(dir, BINDING), "utf8")).toBe(before);
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("a 'no' at the consent prompt sends nothing and writes nothing", async () => {
    const dir = copyTourism(true);
    const before = readFileSync(join(dir, BINDING), "utf8");
    const mock = await startMock(200, RECORDED_BODY);
    try {
      const { code, out } = await runRecord([dir], mock.url, ["n"]);
      expect(out).toContain("not recorded");
      expect(code).toBe(0);
      expect(mock.hits()).toBe(0);
      expect(readFileSync(join(dir, BINDING), "utf8")).toBe(before);
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("a red recording (a required field missing) writes nothing and exits 1", async () => {
    const dir = copyTourism(true);
    const before = readFileSync(join(dir, BINDING), "utf8");
    const { name: _dropped, ...noName } = STAY;
    const mock = await startMock(200, { stays: [noName], totalMatches: 1 });
    try {
      const { code, out } = await runRecord([dir], mock.url, ["y", "y"]);
      expect(out).toContain("red");
      expect(out).toContain("Nothing written");
      expect(code).toBe(1);
      expect(mock.hits()).toBe(1);
      expect(readFileSync(join(dir, BINDING), "utf8")).toBe(before);
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("a backend error (500) writes nothing and exits 1", async () => {
    const dir = copyTourism(true);
    const before = readFileSync(join(dir, BINDING), "utf8");
    const mock = await startMock(500, { error: "boom" });
    try {
      const { code } = await runRecord([dir], mock.url, ["y", "y"]);
      expect(code).toBe(1);
      expect(readFileSync(join(dir, BINDING), "utf8")).toBe(before);
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("a missing fixture is a skip that says what to create — no prompt, no request", async () => {
    const dir = copyTourism(true);
    rmSync(join(dir, FIXTURE));
    const mock = await startMock(200, RECORDED_BODY);
    try {
      const { code, out } = await runRecord([dir], mock.url);
      expect(out).toContain(`no fixture at ${FIXTURE}`);
      expect(out).toContain('"request"');
      expect(code).toBe(0);
      expect(mock.hits()).toBe(0);
    } finally {
      await mock.close();
    }
  }, 30_000);
});

describe("archstone record — never a request for write or irreversible", () => {
  function addCapability(dir: string, id: string, effect: string): void {
    const caps = readFileSync(join(dir, "capabilities.yaml"), "utf8");
    writeFileSync(join(dir, "capabilities.yaml"), caps.replace("  - tourism.search\n", `  - tourism.search\n  - ${id}\n`));
    writeFileSync(
      join(dir, `${id}.capability.yaml`),
      [
        "capability:",
        `  id: ${id}`,
        "  description: Act on an existing reservation.",
        `  effect: ${effect}`,
        "  input:",
        "    reference:",
        "      type: identifier",
        "  output:",
        "    confirmation:",
        "      type: identifier",
        "  provider: booking-engine",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, `bindings/${id}.binding.yaml`),
      [
        "binding:",
        `  capabilityId: ${id}`,
        "  connector:",
        "    type: rest",
        "    rest:",
        '      baseUrl: "${STAYS_API_URL}"',
        "      method: POST",
        `      path: /v1/${id}`,
        "  extract:",
        '    confirmation: "$.confirmation"',
        "",
      ].join("\n"),
    );
    // A perfectly usable fixture, so the effect is the ONLY reason it is not recorded.
    writeFileSync(join(dir, `fixtures/${id}.golden.json`), JSON.stringify({ capabilityId: id, request: { reference: "r-1" } }));
  }

  it("skips them with the reason, prompts for nothing, sends nothing, writes nothing", async () => {
    const dir = copyTourism(false); // tourism.search already recorded → also skipped
    addCapability(dir, "tourism.cancel", "write");
    addCapability(dir, "tourism.void", "irreversible");
    compilesClean(dir);
    const before = ["tourism.cancel", "tourism.void"].map((id) => readFileSync(join(dir, `bindings/${id}.binding.yaml`), "utf8"));
    const mock = await startMock(200, { confirmation: "c-1" });
    try {
      // stdin closed: any prompt at all would end the run with exit 1.
      const { code, out, prompts } = await runRecord([dir, "--rerecord", "tourism.cancel"], mock.url);
      expect(out).toMatch(/tourism\.cancel: skipped — effect is write — never recorded/);
      expect(out).toMatch(/tourism\.void: skipped — effect is irreversible — never recorded/);
      expect(prompts).toBe(0);
      expect(code).toBe(0);
      expect(mock.hits()).toBe(0);
      expect(["tourism.cancel", "tourism.void"].map((id) => readFileSync(join(dir, `bindings/${id}.binding.yaml`), "utf8"))).toEqual(before);
    } finally {
      await mock.close();
    }
  }, 30_000);
});

describe("archstone record — an existing contract", () => {
  it("is skipped without --rerecord", async () => {
    const dir = copyTourism(false);
    const mock = await startMock(200, RECORDED_BODY);
    try {
      const { code, out } = await runRecord([dir], mock.url);
      expect(out).toContain("already recorded — pass --rerecord tourism.search to replace it");
      expect(code).toBe(0);
      expect(mock.hits()).toBe(0);
      expect(readFileSync(join(dir, BINDING), "utf8")).toBe(checkedIn);
    } finally {
      await mock.close();
    }
  }, 30_000);

  it("is replaced with --rerecord: new fingerprint, shape and verifiedAt; every comment kept", async () => {
    const dir = copyTourism(false);
    const mock = await startMock(200, { stays: [{ ...STAY, distanceToBeachM: 240 }], totalMatches: 1 });
    try {
      const { code } = await runRecord([dir, "--rerecord", "tourism.search"], mock.url, ["y", "y", "y"]);
      expect(code).toBe(0);
      expect(mock.hits()).toBe(1);
      const after = readFileSync(join(dir, BINDING), "utf8");
      expect(after).not.toContain(checkedInFingerprint);
      expect(after).toMatch(/ {4}fingerprint: "sha256:[0-9a-f]{64}"/);
      expect(after).toContain('      "$.stays[].distanceToBeachM": number');
      expect(after).not.toContain('verifiedAt: "2026-09-11T00:00:00Z"');
      // Every comment, in order; the only replaced lines are the machine-written values.
      expectLinesPreserved(checkedIn, after, (l) => /^\s*(fingerprint|verifiedAt):/.test(l));
      compilesClean(dir);
    } finally {
      await mock.close();
    }
  }, 60_000);

  it("an unknown --rerecord id is a usage error, exit 2, before any prompt or request", async () => {
    const dir = copyTourism(false);
    const mock = await startMock(200, RECORDED_BODY);
    try {
      const { code, out, prompts } = await runRecord([dir, "--rerecord", "tourism.nope"], mock.url, ["y", "y", "y"]);
      expect(out).toContain("tourism.nope");
      expect(code).toBe(2);
      expect(prompts).toBe(0);
      expect(mock.hits()).toBe(0);
    } finally {
      await mock.close();
    }
  }, 30_000);
});
