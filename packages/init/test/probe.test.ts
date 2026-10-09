import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@archstone/provider-rest";
import type { IR, IRTool } from "@archstone/compiler";
import { fingerprintShape } from "@archstone/compiler";
import { runInit } from "@archstone/init/loop";
import { verifyRecorded } from "../src/probe";
import { arrayOf, draftModel, inputField, objectNode, operation, property, scalarNode } from "./draft";
import type { DecisionRecord } from "@archstone/init";

// ADD-37 §6 step 6 — the probe leg.
//
// THE INVARIANT UNDER TEST IS NOT "the gate returns the right value". It is "no request was
// issued", which is a different claim and the only one the business owner cares about. So
// every refusal test below counts calls to an INJECTED fetch: a gate that returned `false` and
// then called anyway would pass an assertion on its return value and fail these.

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../../..");
const MOCK_SERVER = resolve(REPO, "examples/demo/mock-stays-server.mjs");

/** A counting stub. Nothing in this file may reach a real socket except the round-trip suite
 *  at the bottom, which spawns the repo's own mock backend. */
function countingFetch(body: unknown, status = 200): { fetchImpl: FetchLike; calls: () => number; lastMethod: () => string | undefined } {
  let calls = 0;
  let lastMethod: string | undefined;
  const fetchImpl: FetchLike = async (_input, init) => {
    calls += 1;
    lastMethod = (init?.method ?? "GET").toUpperCase();
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  };
  return { fetchImpl, calls: () => calls, lastMethod: () => lastMethod };
}

const searchOperation = operation("POST", "/v1/search", {
  description: "Search stays.",
  input: [inputField("destination", "body", { type: "location", required: true })],
  response: objectNode([
    property(
      "stays",
      arrayOf(
        objectNode(
          [
            property("name", scalarNode({ type: "text", nullable: false }), { declaredRequired: true }),
            property("location", scalarNode({ type: "location", nullable: false }), { declaredRequired: true }),
            property("pricePerNight", scalarNode({ type: "quantity", nullable: false }), { declaredRequired: true }),
            property("rating", scalarNode({ type: "quantity" }), { declaredRequired: false }),
          ],
          { name: "Stay", description: "A place to stay." },
        ),
      ),
    ),
  ]),
});

const listOperation = operation("GET", "/v1/stays", {
  description: "List stays.",
  response: objectNode([
    property(
      "stays",
      arrayOf(objectNode([property("name", scalarNode({ type: "text", nullable: false }), { declaredRequired: true })], { name: "Stay" })),
    ),
  ]),
});

const STAYS_BODY = { stays: [{ name: "Hotel A", location: "Nice", pricePerNight: 100, rating: 4.5 }] };

function decisions(overrides: Partial<Extract<DecisionRecord["decisions"][number], { keep: true }>> = {}, op = searchOperation): DecisionRecord {
  return {
    version: "0",
    company: { id: "acme" },
    baseUrlEnvVar: "ACME_API_URL",
    decisions: [{ operation: op.key, keep: true, capabilityId: "tourism.search", effect: "read", ...overrides } as DecisionRecord["decisions"][number]],
  };
}

function workspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "archstone-init-probe-test-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

const env = { ACME_API_URL: "https://stays.test" };

describe("R-8 — `init` never issues a write, and never probes without consent", () => {
  it("makes NO request at all when `--probe` was not given, whatever the Decision Record says", async () => {
    // The top-level opt-in, checked before the per-capability gate. A Decision Record that
    // says `probe: true` on every capability must still produce zero traffic without the flag.
    const ws = workspace();
    const net = countingFetch(STAYS_BODY);
    const result = await runInit(draftModel([searchOperation]), decisions({ probe: true, probeNonReadMethodConfirmed: true, sampleInput: { destination: "Nice" } }), {
      targetDir: join(ws.dir, "out"),
      interactive: true,
      invoke: { env, fetchImpl: net.fetchImpl },
    });
    expect(net.calls()).toBe(0);
    expect(result.ok).toBe(true);
    ws.cleanup();
  });

  it("makes no request for a capability whose confirmed effect is not `read`, under any flag", async () => {
    const ws = workspace();
    const net = countingFetch(STAYS_BODY);
    const result = await runInit(
      draftModel([searchOperation]),
      decisions({ effect: "write", probe: true, probeNonReadMethodConfirmed: true, sampleInput: { destination: "Nice" } }),
      { targetDir: join(ws.dir, "out"), probe: true, interactive: true, invoke: { env, fetchImpl: net.fetchImpl } },
    );
    expect(net.calls()).toBe(0);
    expect(result.probes[0]).toMatchObject({ outcome: "refused", refusal: "effect-not-read" });
    ws.cleanup();
  });

  it("a non-GET probe is IMPOSSIBLE non-interactively — there is no flag that enables one", async () => {
    // `probeNonReadMethodConfirmed: true` is present and is deliberately not enough. The
    // second confirmation is a human act, and CI has no human; a flag that stood in for one
    // would make the whole two-condition gate decorative.
    const ws = workspace();
    const net = countingFetch(STAYS_BODY);
    const result = await runInit(
      draftModel([searchOperation]),
      decisions({ probe: true, probeNonReadMethodConfirmed: true, sampleInput: { destination: "Nice" } }),
      { targetDir: join(ws.dir, "out"), probe: true, interactive: false, invoke: { env, fetchImpl: net.fetchImpl } },
    );
    expect(net.calls()).toBe(0);
    expect(result.probes[0]).toMatchObject({ outcome: "refused", refusal: "non-interactive-non-read-method" });
    ws.cleanup();
  });

  it("a non-GET probe needs a SECOND confirmation even interactively", async () => {
    const ws = workspace();
    const net = countingFetch(STAYS_BODY);
    const result = await runInit(draftModel([searchOperation]), decisions({ probe: true, sampleInput: { destination: "Nice" } }), {
      targetDir: join(ws.dir, "out"),
      probe: true,
      interactive: true,
      invoke: { env, fetchImpl: net.fetchImpl },
    });
    expect(net.calls()).toBe(0);
    expect(result.probes[0]).toMatchObject({ outcome: "refused", refusal: "method-not-confirmed" });
    ws.cleanup();
  });

  it("`GET` rides on the confirmed read alone — the method rule is a SECOND condition, not a substitute", async () => {
    // And the reason the rule is not "GET only": `tourism.search` is a POST with
    // `effect: read`, the canonical search shape. Both directions have to work.
    const ws = workspace();
    const net = countingFetch(STAYS_BODY);
    const record: DecisionRecord = {
      version: "0",
      company: { id: "acme" },
      baseUrlEnvVar: "ACME_API_URL",
      decisions: [{ operation: listOperation.key, keep: true, capabilityId: "tourism.list", effect: "read", probe: true }],
    };
    const result = await runInit(draftModel([listOperation]), record, {
      targetDir: join(ws.dir, "out"),
      probe: true,
      interactive: false,
      invoke: { env, fetchImpl: net.fetchImpl },
    });
    expect(net.lastMethod()).toBe("GET");
    expect(result.probes[0]!.outcome).toBe("green");
    ws.cleanup();
  });

  it("refuses to probe when no sample input exists for a required field (§1.3)", async () => {
    const ws = workspace();
    const net = countingFetch(STAYS_BODY);
    const result = await runInit(draftModel([searchOperation]), decisions({ probe: true, probeNonReadMethodConfirmed: true }), {
      targetDir: join(ws.dir, "out"),
      probe: true,
      interactive: true,
      invoke: { env, fetchImpl: net.fetchImpl },
    });
    expect(net.calls()).toBe(0);
    expect(result.probes[0]).toMatchObject({ outcome: "refused", refusal: "probe-input-unavailable" });
    // A report line, never a fallback — and pointedly NOT the adapter's own `example:`, which
    // in a real document may name a real customer's record (D-13).
    expect(result.probes[0]!.detail).toContain("destination");
    ws.cleanup();
  });
});

describe("the fourth probe outcome — `not-attempted` (§A-5)", () => {
  it("an unset environment variable is `not-attempted`, not `red`", async () => {
    // `invokeRest` returns `{ok:false, status:0, error:"missing env var(s): …"}` BEFORE it
    // sends anything. Reporting that as red asserts the backend disagreed with the manifest,
    // which is false — and false reds are how people learn to ignore reds. This one would fire
    // on the very first run of every generated manifest whose variable is not set yet.
    const ws = workspace();
    const net = countingFetch(STAYS_BODY);
    const record: DecisionRecord = {
      version: "0",
      company: { id: "acme" },
      baseUrlEnvVar: "ACME_API_URL",
      decisions: [{ operation: listOperation.key, keep: true, capabilityId: "tourism.list", effect: "read", probe: true }],
    };
    const result = await runInit(draftModel([listOperation]), record, {
      targetDir: join(ws.dir, "out"),
      probe: true,
      interactive: false,
      invoke: { env: {}, fetchImpl: net.fetchImpl },
    });
    expect(net.calls()).toBe(0);
    expect(result.probes[0]!.outcome).toBe("not-attempted");
    expect(result.probes[0]!.detail).toMatch(/no request was sent/);
    ws.cleanup();
  });

  it("a real network failure stays `red` — the two are not conflated", async () => {
    const ws = workspace();
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const record: DecisionRecord = {
      version: "0",
      company: { id: "acme" },
      baseUrlEnvVar: "ACME_API_URL",
      decisions: [{ operation: listOperation.key, keep: true, capabilityId: "tourism.list", effect: "read", probe: true }],
    };
    const result = await runInit(draftModel([listOperation]), record, {
      targetDir: join(ws.dir, "out"),
      probe: true,
      interactive: false,
      invoke: { env, fetchImpl },
    });
    expect(result.probes[0]!.outcome).toBe("red");
    ws.cleanup();
  });
});

describe("a failed probe leaves no fixture and no `contract:` (D-6, all-or-nothing)", () => {
  it("a forced red writes the manifest but not one byte of contract", async () => {
    const ws = workspace();
    const target = join(ws.dir, "out");
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 500 });
    const record: DecisionRecord = {
      version: "0",
      company: { id: "acme" },
      baseUrlEnvVar: "ACME_API_URL",
      decisions: [{ operation: listOperation.key, keep: true, capabilityId: "tourism.list", effect: "read", probe: true }],
    };
    const result = await runInit(draftModel([listOperation]), record, {
      targetDir: target,
      probe: true,
      interactive: false,
      invoke: { env, fetchImpl },
    });
    expect(result.probes[0]!.outcome).toBe("red");
    expect(result.ok).toBe(true); // the manifest still lands; only the safety net is withheld
    expect(existsSync(join(target, "fixtures"))).toBe(false);
    const binding = readFileSync(join(target, "bindings/tourism.list.binding.yaml"), "utf8");
    expect(binding).not.toMatch(/^\s*contract:/m);
    expect(binding).not.toMatch(/fingerprint/);
    ws.cleanup();
  });

  it("a VIOLATION on the recorded response keeps nothing — n=1 is not a classification", async () => {
    // A field the manifest marks required came back null on the very response being recorded.
    // The loosening belongs at the gate, offered to a human; applying it here would silently
    // rewrite a contract to match one sample.
    const ws = workspace();
    const target = join(ws.dir, "out");
    const net = countingFetch({ stays: [{ name: null }] });
    const record: DecisionRecord = {
      version: "0",
      company: { id: "acme" },
      baseUrlEnvVar: "ACME_API_URL",
      decisions: [{ operation: listOperation.key, keep: true, capabilityId: "tourism.list", effect: "read", probe: true }],
    };
    const result = await runInit(draftModel([listOperation]), record, {
      targetDir: target,
      probe: true,
      interactive: false,
      invoke: { env, fetchImpl: net.fetchImpl },
    });
    expect(result.probes[0]!.outcome).toBe("red");
    expect(result.probes[0]!.missing).toContain("name");
    expect(readdirSync(target).includes("fixtures")).toBe(false);
    ws.cleanup();
  });
});

// ---------------------------------------------------------------------------------------
// R-1's headline mitigation, against a REAL backend over a REAL socket.
// ---------------------------------------------------------------------------------------

describe("record → write → the shipped `runVerify` is green (R-1)", () => {
  let server: ChildProcess;
  const port = 8891;

  beforeAll(async () => {
    server = spawn(process.execPath, [MOCK_SERVER], { env: { ...process.env, PORT: String(port) }, stdio: ["ignore", "ignore", "pipe"] });
    await new Promise<void>((done, fail) => {
      const timer = setTimeout(() => fail(new Error("mock backend did not start")), 10_000);
      server.stderr!.on("data", (chunk: Buffer) => {
        if (chunk.toString().includes("mock stays API")) {
          clearTimeout(timer);
          done();
        }
      });
    });
  });

  afterAll(() => {
    server.kill();
  });

  it("writes a fixture the SHIPPED verifier replays green, over a real socket", async () => {
    // The whole point of D-6: `recordContract` lives beside `verifyTool`, over one
    // `invokeRest` call, so the artifact `init` writes IS the artifact `verify` trusts. A
    // second orchestration living in `init` would look green at record time and be
    // unreplayable afterwards — silently, for the manifest's lifetime. `runInit` proves it
    // here by replaying every recording through the real `runVerify` before committing.
    const ws = workspace();
    const target = join(ws.dir, "out");
    const result = await runInit(
      draftModel([searchOperation]),
      decisions({ probe: true, probeNonReadMethodConfirmed: true, sampleInput: { destination: "Nice" } }),
      {
        targetDir: target,
        probe: true,
        interactive: true,
        invoke: { env: { ACME_API_URL: `http://localhost:${port}` } },
      },
    );

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    expect(result.probes[0]!.outcome, result.probes[0]!.detail).toBe("green");
    expect(result.verifications).toEqual([expect.objectContaining({ capabilityId: "tourism.search", status: "green" })]);

    const binding = readFileSync(join(target, "bindings/tourism.search.binding.yaml"), "utf8");
    expect(binding).toMatch(/^\s*contract:/m);
    expect(binding).toMatch(/source: recorded/);
    expect(binding).toMatch(/fingerprint: "sha256:[0-9a-f]{64}"/);
    expect(binding).toMatch(/fixture: fixtures\/tourism\.search\.golden\.json/);

    const fixture = JSON.parse(readFileSync(join(target, "fixtures/tourism.search.golden.json"), "utf8"));
    // O-7, the constraint that makes §1.3 bite: the fixture's `request` is CAPABILITY input,
    // not an HTTP request. `verifyTool` hands it straight to `invokeRest`.
    expect(fixture).toMatchObject({ capabilityId: "tourism.search", request: { destination: "Nice" } });
    ws.cleanup();
  }, 30_000);
});

// ---------------------------------------------------------------------------------------
// #124 (ADD-124 D-8/D-9) — `runVerify` now declines to replay a non-`read` contract, and
// `verifyRecorded` is its one internal consumer.
// ---------------------------------------------------------------------------------------

describe("verifyRecorded under the effect gate (#124, D-9)", () => {
  const resources = {
    Stay: [
      { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "location", required: true, type: { kind: "scalar", semantic: "location" } },
    ],
  } as unknown as IR["resources"];

  const body = { stays: [{ name: "Hotel A", location: "Nice" }] };

  function irWith(effect: IRTool["effect"]): IR {
    return {
      version: "0",
      company: { id: "acme" },
      resources,
      tools: [
        {
          id: "tourism.book",
          description: "",
          effect,
          provider: "p",
          policies: [],
          lifecycle: "stable",
          input: [],
          output: [],
          connector: { type: "rest", rest: { baseUrl: "https://x.test", method: "POST", path: "/book" } },
          contract: { fingerprint: fingerprintShape(body), probeFixture: "fixture.json" },
        },
      ],
    } as unknown as IR;
  }

  function withDir(fn: (dir: string) => Promise<void>): Promise<void> {
    const dir = mkdtempSync(join(tmpdir(), "archstone-init-effectgate-"));
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ capabilityId: "tourism.book", request: {} }));
    return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
  }

  it("(a) an init-produced manifest is unaffected: a `read` contract is still replayed and lands green", async () => {
    // D-9's claim made concrete. `recordContract` is reachable only through the probe gate,
    // which refuses any non-`read` effect before recording (R-8), so every contract `init` can
    // write is for a `read` capability — the new default skip is a no-op against init's own
    // output. This is the negative control for (b) below.
    await withDir(async (dir) => {
      const net = countingFetch(body);
      const { green, reports } = await verifyRecorded(irWith("read"), dir, { fetchImpl: net.fetchImpl });
      expect(net.calls()).toBe(1);
      expect(reports).toHaveLength(1);
      expect(green.has("tourism.book")).toBe(true);
    });
  });

  it("(b) a contract hand-added to a non-`read` capability between init runs is skipped here too — no carve-out for init", async () => {
    // The residual case #124 exists to close, and init's incremental-amend path gets no
    // exemption from it: no request is issued, the contract lands outside `green`, and the
    // final emit drops it. Conservative and correct — `init` commits a contract only when it
    // has watched the shipped verifier replay it.
    await withDir(async (dir) => {
      const net = countingFetch(body);
      const { green, reports } = await verifyRecorded(irWith("irreversible"), dir, { fetchImpl: net.fetchImpl });
      expect(net.calls()).toBe(0);
      expect(reports).toEqual([]);
      expect(green.has("tourism.book")).toBe(false);
    });
  });
});
