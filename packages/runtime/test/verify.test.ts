import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRResourceRegistry, IRTool, Lifecycle } from "@archstone/compiler";
import { describeShape, fingerprintShape } from "@archstone/compiler";
import type { FetchLike } from "@archstone/provider-rest";
import { verifyTool, runVerify, recordContract } from "../src/verify";

const resources: IRResourceRegistry = {
  Stay: [
    { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
    { name: "location", required: true, type: { kind: "scalar", semantic: "location" } },
    { name: "price", required: true, type: { kind: "scalar", semantic: "quantity" } },
    { name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } },
  ],
};

const goldenBody = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5 }] };
const goldenFingerprint = fingerprintShape(goldenBody);

function tool(contractFingerprint: string, fixtureName = "fixture.json"): IRTool {
  return {
    id: "tourism.search",
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [{ name: "stays", required: true, type: { kind: "collection", of: "Stay" } }],
    connector: { type: "rest", rest: { baseUrl: "https://x.test", method: "POST", path: "/search" } },
    response: {
      resource: "Stay",
      field: "stays",
      collection: "$.stays[*]",
      fields: [
        { name: "name", path: "$.name" },
        { name: "location", path: "$.location" },
        { name: "price", path: "$.price" },
        { name: "rating", path: "$.rating" },
      ],
    },
    contract: { fingerprint: contractFingerprint, probeFixture: fixtureName },
  };
}

function withFixture(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "archstone-verify-"));
  writeFileSync(join(dir, "fixture.json"), JSON.stringify({ capabilityId: "tourism.search", request: {}, expects: { collectionNonEmpty: true } }));
  return fn(dir).finally(() => rmSync(dir, { recursive: true, force: true }));
}

describe("verifyTool (ADD-18)", () => {
  it("green: fingerprint unchanged, mapping OK", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("green");
    }));

  it("yellow: fingerprint changed (new field added) but required fields still resolve", () =>
    withFixture(async (dir) => {
      const drifted = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5, currency: "EUR" }] };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(drifted), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("yellow");
      expect(r.detail).toMatch(/shape changed/);
    }));

  it("yellow: optional field absent → DEGRADED", () =>
    withFixture(async (dir) => {
      const noRating = { stays: [{ name: "Hotel A", location: "Nice", price: 100 }] };
      const fp = fingerprintShape(noRating);
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(noRating), { status: 200 });
      const r = await verifyTool(tool(fp), dir, resources, { fetchImpl });
      expect(r.status).toBe("yellow");
      expect(r.detail).toMatch(/degraded/);
    }));

  it("red: required field missing → VIOLATION", () =>
    withFixture(async (dir) => {
      const noPrice = { stays: [{ name: "Hotel A", location: "Nice" }] };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(noPrice), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/price/);
    }));

  it("red: collectionNonEmpty expected but the collection is empty", () =>
    withFixture(async (dir) => {
      const empty = { stays: [] };
      const fp = fingerprintShape(empty);
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(empty), { status: 200 });
      const r = await verifyTool(tool(fp), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/non-empty/);
    }));

  it("red: live request fails", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response("boom", { status: 500 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/live request failed/);
    }));

  it("red: fixture file missing", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint, "does-not-exist.json"), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/fixture not found/);
    }));

  it("red: no contract declared", () =>
    withFixture(async (dir) => {
      const t = tool(goldenFingerprint);
      delete t.contract;
      const r = await verifyTool(t, dir, resources);
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/no contract/);
    }));
});

// Issue #18: `detail`'s prose already named the live fingerprint that decided `status` — this
// asserts the same value is now readable as data, and only where a probe actually ran.
describe("verifyTool — observedFingerprint (#18)", () => {
  it("yellow: carries the ACTUAL live fingerprint, not merely a truthy value", () =>
    withFixture(async (dir) => {
      const drifted = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5, currency: "EUR" }] };
      const liveFingerprint = fingerprintShape(drifted);
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(drifted), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("yellow");
      // The two fingerprints differ (that's what made this yellow) and detail's prose already
      // names both — this pins the field to the SAME value, not a copy of the recorded one.
      expect(r.observedFingerprint).toBe(liveFingerprint);
      expect(r.observedFingerprint).not.toBe(goldenFingerprint);
      expect(r.detail).toContain(liveFingerprint);
    }));

  it("green: also present — a green run reports what it observed, not just the word \"unchanged\"", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("green");
      // Unchanged means observed and recorded coincide — asserted against the real recorded
      // value, not merely `toBeDefined()`.
      expect(r.observedFingerprint).toBe(goldenFingerprint);
    }));

  it("degraded (yellow) and violation (red) also carry it — a probe ran and returned a response in both", () =>
    withFixture(async (dir) => {
      const noRating = { stays: [{ name: "Hotel A", location: "Nice", price: 100 }] };
      const fp = fingerprintShape(noRating);
      const degradedFetch: FetchLike = async () => new Response(JSON.stringify(noRating), { status: 200 });
      const degraded = await verifyTool(tool(fp), dir, resources, { fetchImpl: degradedFetch });
      expect(degraded.status).toBe("yellow");
      expect(degraded.observedFingerprint).toBe(fp);

      const noPrice = { stays: [{ name: "Hotel A", location: "Nice" }] };
      const violationFetch: FetchLike = async () => new Response(JSON.stringify(noPrice), { status: 200 });
      const violation = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl: violationFetch });
      expect(violation.status).toBe("red");
      expect(violation.observedFingerprint).toBe(fingerprintShape(noPrice));
    }));

  it("omitted (not null, not the recorded value) when no probe was made: no contract, no fixture, or the request itself failed", () =>
    withFixture(async (dir) => {
      const noContract = tool(goldenFingerprint);
      delete noContract.contract;
      expect((await verifyTool(noContract, dir, resources)).observedFingerprint).toBeUndefined();

      const missingFixture = tool(goldenFingerprint, "does-not-exist.json");
      expect((await verifyTool(missingFixture, dir, resources)).observedFingerprint).toBeUndefined();

      const failingFetch: FetchLike = async () => new Response("boom", { status: 500 });
      const failed = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl: failingFetch });
      expect(failed.status).toBe("red");
      expect(failed.observedFingerprint).toBeUndefined();
    }));
});

// Issue #39 / ADD-31 (BR-15/S-US6.1): verifyTool/runVerify already forward a generic
// InvokeOptions bag into invokeRest with ZERO code change to verify.ts — this confirms it by
// a passing test rather than merely assuming it from the pass-through shape.
describe("verifyTool/runVerify — onResponse pass-through, zero code change to verify.ts (#39)", () => {
  it("S-US6.1: verifyTool forwards onResponse, firing once with the fixture's capabilityId/status/data/durationMs", () =>
    withFixture(async (dir) => {
      const calls: { capabilityId: string; status: number; data: unknown; durationMs: number }[] = [];
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl, onResponse: (info) => { calls.push(info); } });
      expect(r.status).toBe("green");
      expect(calls).toHaveLength(1);
      expect(calls[0].capabilityId).toBe("tourism.search");
      expect(calls[0].status).toBe(200);
      expect(calls[0].data).toEqual(goldenBody);
      expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
    }));

  it("S-US6.1: runVerify forwards onResponse to every contract-bearing tool it verifies", () =>
    withFixture(async (dir) => {
      const calls: { capabilityId: string }[] = [];
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const { results: reports } = await runVerify([tool(goldenFingerprint)], dir, resources, {
        fetchImpl,
        onResponse: (info) => { calls.push(info); },
      });
      expect(reports).toHaveLength(1);
      expect(calls).toHaveLength(1);
      expect(calls[0].capabilityId).toBe("tourism.search");
    }));

  it("a throwing onResponse never affects the ToolVerification result", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, {
        fetchImpl,
        onResponse: () => {
          throw new Error("boom");
        },
      });
      expect(r.status).toBe("green");
    }));
});

describe("runVerify — filters to contract-bearing tools", () => {
  it("only verifies tools that declare a contract", () =>
    withFixture(async (dir) => {
      const withContract = tool(goldenFingerprint);
      const withoutContract: IRTool = { ...tool(goldenFingerprint), id: "tourism.other", contract: undefined };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const { results: reports } = await runVerify([withContract, withoutContract], dir, resources, { fetchImpl });
      expect(reports).toHaveLength(1);
      expect(reports[0].capabilityId).toBe("tourism.search");
    }));
});

// #54 (ADD-51 D-6's named residual risk, R-2): a retired capability whose binding still
// carries a `contract:` block must never turn the CI release gate (`reports.some(r =>
// r.status === "red")`, `cli/src/index.ts`) red — retiring a capability is a normal
// operational event, not a misconfiguration. Direction 1 from the issue: exclude
// non-invocable (`lifecycle: retired`) capabilities from `runVerify`'s contract-bearing
// filter entirely, so a withdrawn capability is never probed and never enters the report —
// not "verified, then ignored".
describe("runVerify — excludes retired capabilities from the contract gate (#54)", () => {
  it("a retired capability with a broken/drifted contract does not appear in the report at all — only the stable one does", () =>
    withFixture(async (dir) => {
      const stable = tool(goldenFingerprint); // id: tourism.search, matches the fixture's golden body
      const retiredBroken: IRTool = {
        ...tool(goldenFingerprint),
        id: "tourism.retired-search",
        lifecycle: "retired",
        // Deliberately drifted: this fingerprint would never match a live fetch of `goldenBody`,
        // so if `runVerify` still probed this tool the mock below would turn it red.
        contract: { fingerprint: "sha256:does-not-match-anything", probeFixture: "fixture.json" },
      };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const { results: reports } = await runVerify([stable, retiredBroken], dir, resources, { fetchImpl });

      expect(reports).toHaveLength(1);
      expect(reports[0].capabilityId).toBe("tourism.search");
      expect(reports.some((r) => r.status === "red")).toBe(false);
      // The CLI's actual gate expression (cli/src/index.ts) — asserted directly here so this
      // test fails if that expression's inputs ever regress.
      expect(reports.some((r) => r.status === "red") ? 1 : 0).toBe(0);
    }));

  it("regression: a non-retired (stable) capability with a broken contract still fails the gate — this fix must not weaken it", () =>
    withFixture(async (dir) => {
      const brokenStable: IRTool = {
        ...tool(goldenFingerprint),
        id: "tourism.search",
        lifecycle: "stable",
        contract: { fingerprint: "sha256:does-not-match-anything", probeFixture: "fixture.json" },
      };
      // A response missing the required `price` field — a genuine contract VIOLATION, not
      // merely a fingerprint mismatch — so a live, still-invocable capability's drift is
      // caught exactly as before this fix.
      const noPrice = { stays: [{ name: "Hotel A", location: "Nice" }] };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(noPrice), { status: 200 });
      const { results: reports } = await runVerify([brokenStable], dir, resources, { fetchImpl });

      expect(reports).toHaveLength(1);
      expect(reports[0].status).toBe("red");
      expect(reports.some((r) => r.status === "red") ? 1 : 0).toBe(1);
    }));

  // Bug fix (found reviewing #54): the original fix filtered on `lifecycleExposure(...).invocable`,
  // which is `false` for BOTH `retired` (the actual #54 target) AND an unrecognized `lifecycle`
  // value (`blockedReason: "unevaluatable"`, ADD-56) — a hand-written or forward-versioned IR.
  // That conflated the two: a capability with a corrupted/unrecognized lifecycle AND a broken
  // contract was silently dropped from the report instead of being probed and flagged red,
  // undermining ADD-56's "make incompatibility loud" goal on this one path. The filter must
  // exclude only `blockedReason === "retired"`.
  it("a contract-bearing tool with an UNRECOGNIZED lifecycle value is still probed and appears red — not silently dropped (bug fix, found reviewing #54)", () =>
    withFixture(async (dir) => {
      const unrecognizedLifecycle: IRTool = {
        ...tool(goldenFingerprint),
        id: "tourism.unrecognized-lifecycle",
        lifecycle: "bogus-value" as Lifecycle,
      };
      // A genuine contract VIOLATION (required `price` missing) — if this tool is silently
      // excluded (the bug), the mock below never turns it red and it simply vanishes from the
      // report instead.
      const noPrice = { stays: [{ name: "Hotel A", location: "Nice" }] };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(noPrice), { status: 200 });
      const { results: reports } = await runVerify([unrecognizedLifecycle], dir, resources, { fetchImpl });

      expect(reports).toHaveLength(1);
      expect(reports[0].capabilityId).toBe("tourism.unrecognized-lifecycle");
      expect(reports[0].status).toBe("red");
    }));

  it("experimental (unlisted but invocable) capabilities are still verified — only `retired` is excluded", () =>
    withFixture(async (dir) => {
      const experimental: IRTool = { ...tool(goldenFingerprint), id: "tourism.search", lifecycle: "experimental" };
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
      const { results: reports } = await runVerify([experimental], dir, resources, { fetchImpl });
      expect(reports).toHaveLength(1);
      expect(reports[0].status).toBe("green");
    }));
});

// #124 (ADD-124 D-1/D-5): a replay IS an invocation (Axiom A-1), so `runVerify` must not replay
// a `write`/`irreversible` binding's fixture against the live backend by default. Every test
// below counts fetches rather than reading the report, because "no request was issued" is the
// only claim that matters and a gate that reported a skip and then called anyway would pass an
// assertion on the report.
describe("runVerify — the effect gate (#124)", () => {
  const counting = (): { fetchImpl: FetchLike; calls: () => number } => {
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response(JSON.stringify(goldenBody), { status: 200 });
    };
    return { fetchImpl, calls: () => calls };
  };

  for (const effect of ["write", "irreversible"] as const) {
    it(`does not probe a contract-bearing \`${effect}\` capability — zero fetches, and it is reported as skipped, not as a status`, () =>
      withFixture(async (dir) => {
        const nonRead: IRTool = { ...tool(goldenFingerprint), effect };
        const net = counting();
        const { results, skipped } = await runVerify([nonRead], dir, resources, { fetchImpl: net.fetchImpl });

        expect(net.calls()).toBe(0);
        expect(results).toEqual([]);
        expect(skipped).toHaveLength(1);
        expect(skipped[0].capabilityId).toBe("tourism.search");
        expect(skipped[0].effect).toBe(effect);
        expect(skipped[0].detail).toMatch(new RegExp(effect));
        // D-2: a skip carries no green/yellow/red. Nothing was inspected, so no colour is
        // earned, and a dashboard cannot read it as a pass.
        expect((skipped[0] as unknown as { status?: unknown }).status).toBeUndefined();
        // D-6: the CLI's actual gate expression, asserted directly — an all-skipped run exits 0,
        // exactly like today's all-empty run.
        expect(results.some((r) => r.status === "red")).toBe(false);
      }));
  }

  it("still probes a `read` capability in the same registry — the gate filters, it does not disable verify", () =>
    withFixture(async (dir) => {
      const read = tool(goldenFingerprint);
      const pay: IRTool = { ...tool(goldenFingerprint), id: "tourism.pay", effect: "irreversible" };
      const net = counting();
      const { results, skipped } = await runVerify([read, pay], dir, resources, { fetchImpl: net.fetchImpl });

      expect(net.calls()).toBe(1); // exactly one — the read one
      expect(results).toHaveLength(1);
      expect(results[0]).toMatchObject({ capabilityId: "tourism.search", status: "green" });
      expect(skipped.map((s) => s.capabilityId)).toEqual(["tourism.pay"]);
    }));

  it("`includeNonRead` (the CLI's --sandbox) re-includes them, and empties `skipped`", () =>
    withFixture(async (dir) => {
      const pay: IRTool = { ...tool(goldenFingerprint), id: "tourism.pay", effect: "irreversible" };
      const net = counting();
      const { results, skipped } = await runVerify([pay], dir, resources, { fetchImpl: net.fetchImpl }, { includeNonRead: true });

      expect(net.calls()).toBe(1);
      expect(results).toHaveLength(1);
      expect(results[0].status).toBe("green");
      expect(skipped).toEqual([]);
    }));

  it("`includeNonRead` does not re-include a RETIRED capability — #54's filter is independent and still applies", () =>
    withFixture(async (dir) => {
      const retiredWrite: IRTool = { ...tool(goldenFingerprint), id: "tourism.retired-hold", effect: "write", lifecycle: "retired" };
      const net = counting();
      const { results, skipped } = await runVerify([retiredWrite], dir, resources, { fetchImpl: net.fetchImpl }, { includeNonRead: true });

      expect(net.calls()).toBe(0);
      expect(results).toEqual([]);
      expect(skipped).toEqual([]); // never contract-bearing for this purpose at all — not "skipped for effect"
    }));

  it("an unrecognized `effect` value is NOT probed — the fail-closed direction, deliberately opposite to the lifecycle rule", () =>
    withFixture(async (dir) => {
      // Getting `lifecycle` wrong costs a misreported line (so ADD-56 probes anyway, loudly).
      // Getting `effect` wrong costs a real side effect on someone's production backend, which
      // does not undo. Anything this build cannot confirm is a read is treated as unsafe.
      const bogus: IRTool = { ...tool(goldenFingerprint), effect: "sell-the-company" as IRTool["effect"] };
      const net = counting();
      const { results, skipped } = await runVerify([bogus], dir, resources, { fetchImpl: net.fetchImpl });

      expect(net.calls()).toBe(0);
      expect(results).toEqual([]);
      expect(skipped).toHaveLength(1);
    }));

  it("`verifyTool` itself stays UNGATED — a caller can still probe a write capability on purpose (D-1)", () =>
    withFixture(async (dir) => {
      // Same reason #54 left it ungated: gating the primitive would make it impossible to ever
      // deliberately probe such a tool — from a test, or against a scratch backend. The default
      // policy belongs in the orchestrator, not in the primitive.
      const pay: IRTool = { ...tool(goldenFingerprint), effect: "irreversible" };
      const net = counting();
      const r = await verifyTool(pay, dir, resources, { fetchImpl: net.fetchImpl });

      expect(net.calls()).toBe(1);
      expect(r.status).toBe("green");
    }));
});

// ---------------------------------------------------------------------------------------
// recordContract (ADD-37 D-6 / R-1) — the sibling of verifyTool, not a flag on it.
// ---------------------------------------------------------------------------------------

/** The same tool, minus the one thing `recordContract` exists to create. */
function unrecorded(): IRTool {
  const { contract: _contract, ...rest } = tool(goldenFingerprint);
  return rest;
}

/**
 * An extract:-only tool: no `response:` at all, only a capability-level scalar reached via
 * `extract:` — isolates the gap where `verifyTool`/`recordContract`'s `if (!tool.response)`
 * gates fell through to "no mapping to validate" for a tool that in fact declares one, via
 * `extract:` instead of `response:` (the same gap `callTool`, runtime/src/server.ts, already
 * closed with `if (tool.response || tool.extract)`).
 */
function extractOnlyTool(contractFingerprint: string, fixtureName = "fixture.json"): IRTool {
  const { response: _response, ...rest } = tool(contractFingerprint, fixtureName);
  return {
    ...rest,
    output: [{ name: "totalMatches", required: true, type: { kind: "scalar", semantic: "quantity" } }],
    extract: [{ name: "totalMatches", path: "$.totalMatches" }],
  };
}

describe("recordContract (ADD-37 D-6)", () => {
  it("records a fingerprint and a fixture for a tool that has NO contract yet", async () => {
    // Why a sibling and not a flag: `verifyTool` returns `red` on `!tool.contract` before
    // doing anything, and the contract is precisely what this creates. The chicken-and-egg is
    // structural, not stylistic.
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
    const r = await recordContract(unrecorded(), { where: "Nice" }, resources, { fetchImpl, now: new Date("2026-07-31T00:00:00Z") });
    expect(r.outcome).toBe("green");
    expect(r.fingerprint).toBe(goldenFingerprint);
    expect(r.fixture).toEqual({ capabilityId: "tourism.search", recordedAt: "2026-07-31T00:00:00.000Z", request: { where: "Nice" } });
  });

  it("the fingerprint it records is byte-identical to the one `verifyTool` compares against", async () => {
    // R-1 in one assertion: one `fingerprintShape` call over one `invokeRest` result, in one
    // module. A second orchestration of this in `init` could drift from the replay silently,
    // and the manifest would carry a safety net that had quietly become a liability.
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(goldenBody), { status: 200 });
    const recorded = await recordContract(unrecorded(), {}, resources, { fetchImpl });
    await withFixture(async (dir) => {
      const verified = await verifyTool(tool(recorded.fingerprint!), dir, resources, { fetchImpl });
      expect(verified.status).toBe("green");
    });
  });

  it("yellow on a degraded mapping — and it keeps the fixture, because degradation is evidence", async () => {
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel A", location: "Nice", price: 100 }] }), { status: 200 });
    const r = await recordContract(unrecorded(), {}, resources, { fetchImpl });
    expect(r.outcome).toBe("yellow");
    expect(r.degraded).toContain("rating");
    expect(r.fixture).toBeDefined();
  });

  it("red on a VIOLATION, and keeps NOTHING", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ stays: [{ name: null, location: "Nice", price: 100 }] }), { status: 200 });
    const r = await recordContract(unrecorded(), {}, resources, { fetchImpl });
    expect(r.outcome).toBe("red");
    expect(r.missing).toContain("name");
    expect(r.fingerprint).toBeUndefined();
    expect(r.fixture).toBeUndefined();
  });

  it("`not-attempted` when an env var is unset — no request was sent, so nothing was learned", async () => {
    // The fourth outcome (ADD-37 Amendment 1 §A-5). Reporting this as `red` asserts the
    // backend disagreed with the manifest, which is false; false reds are how people learn to
    // ignore reds.
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    const envTool: IRTool = { ...unrecorded(), connector: { type: "rest", rest: { baseUrl: "${NOPE_API_URL}", method: "POST", path: "/search" } } };
    const r = await recordContract(envTool, {}, resources, { fetchImpl, env: {} });
    expect(r.outcome).toBe("not-attempted");
    expect(calls).toBe(0);
    expect(r.fixture).toBeUndefined();
  });

  it("a genuine network failure is `red`, not `not-attempted`", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("ECONNREFUSED");
    };
    const r = await recordContract(unrecorded(), {}, resources, { fetchImpl });
    expect(r.outcome).toBe("red");
  });

  it("a policy denial is `not-attempted` — the probe observed nothing about the backend", async () => {
    // `init` never emits `policies:`, so this cannot fire on a generated manifest. It is here
    // so that RE-recording an existing hand-written one cannot route around the gate
    // `verifyTool` already routes through (#43 / ADD-43 D-6).
    let calls = 0;
    const fetchImpl: FetchLike = async () => {
      calls += 1;
      return new Response("{}", { status: 200 });
    };
    const gated: IRTool = { ...unrecorded(), policies: ["authenticated"] };
    const r = await recordContract(gated, {}, resources, { fetchImpl });
    expect(r.outcome).toBe("not-attempted");
    expect(calls).toBe(0);
  });
});

describe("verifyTool — extract:-only capability is enforced through the SAME gate as response: (no response: at all)", () => {
  it("red: the extract:-mapped required field (totalMatches) is absent — not reported as 'no response mapping to validate'", () =>
    withFixture(async (dir) => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ stays: [{ name: "Hotel A" }] }), { status: 200 });
      const r = await verifyTool(extractOnlyTool(goldenFingerprint), dir, resources, { fetchImpl });
      expect(r.status).toBe("red");
      expect(r.detail).toMatch(/totalMatches/);
      expect(r.detail).not.toMatch(/no response mapping to validate/);
    }));

  it("green: the extract:-mapped field is present and the fingerprint matches", () =>
    withFixture(async (dir) => {
      const body = { totalMatches: 3 };
      const fp = fingerprintShape(body);
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify(body), { status: 200 });
      const r = await verifyTool(extractOnlyTool(fp), dir, resources, { fetchImpl });
      expect(r.status).toBe("green");
    }));
});

describe("recordContract — extract:-only capability is enforced through the SAME gate as response: (no response: at all)", () => {
  function unrecordedExtractOnly(): IRTool {
    const { contract: _contract, ...rest } = extractOnlyTool(goldenFingerprint);
    return rest;
  }

  it("red on a VIOLATION of the extract:-mapped required field, and keeps NOTHING", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ stays: [{ name: "Hotel A" }] }), { status: 200 });
    const r = await recordContract(unrecordedExtractOnly(), {}, resources, { fetchImpl });
    expect(r.outcome).toBe("red");
    expect(r.missing).toContain("totalMatches");
    expect(r.fingerprint).toBeUndefined();
    expect(r.fixture).toBeUndefined();
  });

  it("green, and records a fixture, when the extract:-mapped field is present", async () => {
    const body = { totalMatches: 3 };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(body), { status: 200 });
    const r = await recordContract(unrecordedExtractOnly(), {}, resources, { fetchImpl });
    expect(r.outcome).toBe("green");
    expect(r.fingerprint).toBe(fingerprintShape(body));
    expect(r.fixture).toBeDefined();
  });
});

describe("verifyTool — naming what moved (ADD-114)", () => {
  /** The same tool, plus the shape a real recording would have written beside the fingerprint. */
  function toolWithShape(body: unknown, fingerprint = fingerprintShape(body)): IRTool {
    const t = tool(fingerprint);
    t.contract = { ...t.contract!, shape: describeShape(body) };
    return t;
  }

  const respond = (body: unknown): FetchLike => async () => new Response(JSON.stringify(body), { status: 200 });

  it("names a field the provider gained, and carries it structurally in drift", () =>
    withFixture(async (dir) => {
      const live = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5, boardType: "BREAKFAST" }] };
      const r = await verifyTool(toolWithShape(goldenBody), dir, resources, { fetchImpl: respond(live) });
      expect(r.status).toBe("yellow");
      expect(r.detail).toContain("gained 1 field(s): $.stays[].boardType (string)");
      expect(r.drift).toEqual({
        added: [{ path: "$.stays[].boardType", type: "string" }],
        removed: [],
        retyped: [],
      });
    }));

  // The body a real provider returns: more fields than the manifest maps. `net` is the
  // wholesale rate every accommodation API carries beside the public price, and nothing maps
  // it — so it is exactly the kind of field whose disappearance only the shape can see.
  const recordedBody = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5, net: 78 }] };

  it("names an UNMAPPED field the provider lost", () =>
    withFixture(async (dir) => {
      const live = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5 }] };
      const r = await verifyTool(toolWithShape(recordedBody), dir, resources, { fetchImpl: respond(live) });
      expect(r.status).toBe("yellow");
      expect(r.drift?.removed).toEqual([{ path: "$.stays[].net", type: "number" }]);
    }));

  it("a MAPPED optional field going missing still reports DEGRADED, not drift — ADD-18's ordering, unchanged", () =>
    withFixture(async (dir) => {
      // Deliberate characterization: applyResponseMapping's degraded branch returns before the
      // fingerprint check, and ADD-114 does not touch it. For a field the mapping names,
      // "optional field absent — rating" is the more precise sentence anyway; drift naming
      // earns its keep on the fields the mapping says nothing about.
      const live = { stays: [{ name: "Hotel A", location: "Nice", price: 100, net: 78 }] };
      const r = await verifyTool(toolWithShape(recordedBody), dir, resources, { fetchImpl: respond(live) });
      expect(r.status).toBe("yellow");
      expect(r.detail).toContain("degraded: optional field(s) absent — rating");
      expect(r.drift).toBeUndefined();
    }));

  it("names a field that changed type, with both types", () =>
    withFixture(async (dir) => {
      const live = { stays: [{ name: "Hotel A", location: "Nice", price: "100", rating: 4.5 }] };
      const r = await verifyTool(toolWithShape(goldenBody), dir, resources, { fetchImpl: respond(live) });
      expect(r.detail).toContain("$.stays[].price (number → string)");
      expect(r.drift?.retyped).toEqual([{ path: "$.stays[].price", from: "number", to: "string" }]);
    }));

  it("reports all three at once", () =>
    withFixture(async (dir) => {
      const live = { stays: [{ name: "Hotel A", location: "Nice", price: "100", rating: 4.5, boardType: "BREAKFAST" }] };
      const r = await verifyTool(toolWithShape(recordedBody), dir, resources, { fetchImpl: respond(live) });
      expect(r.drift?.added.map((e) => e.path)).toEqual(["$.stays[].boardType"]);
      expect(r.drift?.removed.map((e) => e.path)).toEqual(["$.stays[].net"]);
      expect(r.drift?.retyped.map((e) => e.path)).toEqual(["$.stays[].price"]);
    }));

  it("D-3: a shape that disagrees with its own fingerprint names nothing and says so", () =>
    withFixture(async (dir) => {
      // A hand-edit: the recorded shape describes a DIFFERENT response than the fingerprint does.
      const t = tool(goldenFingerprint);
      t.contract = { ...t.contract!, shape: describeShape({ totally: { different: "thing" } }) };
      const live = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5, boardType: "BREAKFAST" }] };
      const r = await verifyTool(t, dir, resources, { fetchImpl: respond(live) });
      expect(r.status).toBe("yellow");
      expect(r.detail).toContain("recorded shape is stale and was not used");
      expect(r.detail).not.toContain("gained");
      expect(r.drift).toBeUndefined();
    }));

  it("a contract with no shape reports exactly what it reported before ADD-114", () =>
    withFixture(async (dir) => {
      const live = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5, boardType: "BREAKFAST" }] };
      const r = await verifyTool(tool(goldenFingerprint), dir, resources, { fetchImpl: respond(live) });
      expect(r.detail).toMatch(/^mapping still resolves; response shape changed \(fingerprint sha256:[0-9a-f]{64} → sha256:[0-9a-f]{64}\)$/);
      expect(r.drift).toBeUndefined();
    }));

  it("stays green — and silent — when nothing moved", () =>
    withFixture(async (dir) => {
      const r = await verifyTool(toolWithShape(goldenBody), dir, resources, { fetchImpl: respond(goldenBody) });
      expect(r.status).toBe("green");
      expect(r.drift).toBeUndefined();
    }));

  it("recordContract writes a shape consistent with the fingerprint it writes beside it", async () => {
    const body = { stays: [{ name: "Hotel A", location: "Nice", price: 100, rating: 4.5 }] };
    const rec = await recordContract(tool(goldenFingerprint), {}, resources, {
      fetchImpl: async () => new Response(JSON.stringify(body), { status: 200 }),
      now: new Date("2026-08-24T00:00:00Z"),
    });
    expect(rec.outcome).toBe("green");
    expect(rec.shape).toEqual(describeShape(body));
    expect(rec.fingerprint).toBe(fingerprintShape(body));
    expect(JSON.stringify(rec.shape)).not.toContain("Hotel A");
  });
});
