import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import type { FetchLike } from "@archstone/provider-rest";
import { fromIR, InvalidArtifactError } from "../src/index";

// #195: the declared input contract is enforced, so a tourism.search call must carry every
// required field (destination, dates, travelers) in its declared shape.
const NICE_SEARCH = { destination: "Nice", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };


const here = dirname(fileURLToPath(import.meta.url));
const tourism = resolve(here, "../../../examples/manifests/tourism");

/** `archstone build`'s artifact is IR round-tripped through JSON — simulate that exactly. */
function loadArtifact(): unknown {
  const ir = buildRegistry(tourism).registry!.ir;
  return JSON.parse(JSON.stringify(ir));
}

// tourism.search's binding: POST ${STAYS_API_URL}/v1/search, response mapped to Stay
// (name/location/pricePerNight required, rating optional) — see
// examples/manifests/tourism/bindings/tourism.search.binding.yaml.

describe("execute() — 4-state result (ADD-0008 #28, R-8)", () => {
  it("ok: full mapped response", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 });
    expect(r.missing).toBeUndefined();
    expect(r.degraded).toBeUndefined();
    expect(r.error).toBeUndefined();
  });

  it("degraded: optional field (rating) absent — mapped data still returned", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }], totalMatches: 1 }), {
        status: 200,
      });
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["rating"]);
    expect(r.data).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }], totalMatches: 1 });
  });

  it("violation: required field (pricePerNight) absent — no raw data leaks through", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice" }], totalMatches: 1 }), { status: 200 });
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["pricePerNight"]);
    expect(r.data).toBeUndefined();
  });

  it("error: missing env var — invokeRest short-circuits before any request (R-8, not a violation)", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — missing env must short-circuit first");
    };
    // env deliberately omitted: STAYS_API_URL is never resolvable.
    const r = await archstone.execute("tourism.search", NICE_SEARCH, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/STAYS_API_URL/);
    expect(r.data).toBeUndefined();
    expect(r.missing).toBeUndefined();
  });

  it("error: network failure — invokeRest's ok:false surfaces verbatim as .error", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("network down");
    };
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/request failed/i);
  });

  it("error: unknown capability id", async () => {
    const archstone = fromIR(loadArtifact());
    const r = await archstone.execute("does.not-exist", {});
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/unknown capability/i);
  });

  it("never falls back to process.env when opts.env is omitted (Workers-safety, ADD-0008 §7.2)", async () => {
    process.env.STAYS_API_URL = "https://should-not-be-used.test";
    try {
      const archstone = fromIR(loadArtifact());
      const fetchImpl: FetchLike = async () => {
        throw new Error("must not be called — process.env must never be consulted");
      };
      const r = await archstone.execute("tourism.search", NICE_SEARCH, { fetchImpl });
      expect(r.status).toBe("error");
      expect(r.error).toMatch(/STAYS_API_URL/);
    } finally {
      delete process.env.STAYS_API_URL;
    }
  });
});

// Extends the fix for the gap where an extract:-only capability (declaring `extract:` but no
// `response:` at all) fell through execute()'s `if (tool.response)` gate into raw pass-through,
// skipping extract:'s own required/degraded enforcement — the same gate `callTool`
// (runtime/src/server.ts) already widened to `tool.response || tool.extract`. tourism.search's
// real binding declares both; deleting `response` from the loaded artifact leaves `extract:
// totalMatches` as the only mapping, isolating the gap.
describe("execute() — extract:-only capability is enforced through the SAME gate as response: (no response: at all)", () => {
  function extractOnlyArtifact(): unknown {
    const artifact = loadArtifact() as { tools: { id: string; response?: unknown }[] };
    delete artifact.tools.find((t) => t.id === "tourism.search")!.response;
    return artifact;
  }

  it("violation: the extract:-mapped required field (totalMatches) is absent — no raw pass-through", async () => {
    const archstone = fromIR(extractOnlyArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }] }), { status: 200 });
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["totalMatches"]);
    expect(r.data).toBeUndefined();
  });

  it("ok: the extract:-mapped field is present — mapped data returned, not the raw body", async () => {
    const archstone = fromIR(extractOnlyArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ irrelevant: "field" }], totalMatches: 7 }), { status: 200 });
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("ok");
    // Only the extract:-mapped field — the `stays` array (no response: to map it) is dropped,
    // proving this went through applyResponseMapping rather than the raw pass-through branch.
    expect(r.data).toEqual({ totalMatches: 7 });
  });
});

// ADD-51 (#51) BR-10/BR-12: only `lifecycle: retired` may block invocation through execute() —
// `experimental`/`beta`/`deprecated`/`stable` must remain exactly as invocable as they were
// before this increment. A gate that over-fires on any of these is a worse defect than the one
// #51 fixes (US-3).
describe("execute() — US-3: every lifecycle state other than retired stays invocable (#51)", () => {
  const fetchImpl: FetchLike = async () =>
    new Response(
      JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
      { status: 200 },
    );

  it.each(["experimental", "beta", "deprecated", "stable"] as const)(
    "lifecycle '%s' remains invocable and reaches the backend (S-US3.1..S-US3.4)",
    async (lifecycle) => {
      const artifact = loadArtifact() as { tools: { id: string; lifecycle?: string }[] };
      artifact.tools.find((t) => t.id === "tourism.search")!.lifecycle = lifecycle;
      const archstone = fromIR(artifact);
      const r = await archstone.execute(
        "tourism.search",
        NICE_SEARCH,
        { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
      );
      expect(r.status).toBe("ok");
      expect(r.denial).toBeUndefined();
    },
  );

  // ADD-56 (#56) — CORRECTED, not merely updated: this test's title and assertion, as they read
  // before this ADD, pinned the exact fail-open BUG #56 exists to close, mislabeled as
  // "defaults to stable". `loadArtifact()` round-trips a REAL compiled artifact through JSON —
  // `compile()`'s own "absent lifecycle defaults to stable" behavior (`lowerLifecycle`,
  // asserted directly against the compiler in `packages/compiler/test/compile.test.ts`) had
  // ALREADY run and written an explicit `lifecycle: "stable"` onto this tool. Deleting the key
  // afterwards does not "undo" that default — it simulates a hand-written/corrupted artifact
  // missing the field entirely, exactly EC-3's scenario, which reached `lifecycleExposure`'s old
  // switch, matched no case, and fell through to `undefined` — the bug, not a default, and
  // `getExposure`'s old fallback happened to also resolve to `invocable:true`, which is why the
  // old assertion (`r.status === "ok"`) passed for the wrong reason. Per ADD-56 D-1/EC-3/
  // S-US1.3, this now correctly refuses.
  it("a lifecycle field entirely absent from a hand-written/corrupted artifact is refused (EC-3, S-US1.3) — the compile-time 'defaults to stable' behavior lives ONLY inside compile(), never inside lifecycleExposure", async () => {
    const artifact = loadArtifact() as { tools: { id: string; lifecycle?: string }[] };
    delete artifact.tools.find((t) => t.id === "tourism.search")!.lifecycle;
    const archstone = fromIR(artifact);
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("error");
    expect(r.denial?.reason).toBe("lifecycle_unevaluatable");
  });
});

// ADD-56 (#56) BR-14/BR-15/BR-16/S-US4.3: a `default`-branch gate that over-fires on a
// RECOGNIZED lifecycle state is a worse defect than the fail-open one this ADD closes. Only a
// hand-authored, out-of-vocabulary value may ever trigger `lifecycle_unevaluatable`.
describe("execute() — US-4: the five recognized lifecycle states never produce lifecycle_unevaluatable (#56)", () => {
  const fetchImpl: FetchLike = async () =>
    new Response(
      JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
      { status: 200 },
    );

  it.each(["experimental", "beta", "stable", "deprecated"] as const)(
    "lifecycle '%s' never reports denial.reason lifecycle_unevaluatable (S-US4.3)",
    async (lifecycle) => {
      const artifact = loadArtifact() as { tools: { id: string; lifecycle?: string }[] };
      artifact.tools.find((t) => t.id === "tourism.search")!.lifecycle = lifecycle;
      const archstone = fromIR(artifact);
      const r = await archstone.execute(
        "tourism.search",
        NICE_SEARCH,
        { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
      );
      expect(r.status).toBe("ok");
      expect(r.denial?.reason).not.toBe("lifecycle_unevaluatable");
    },
  );

  it("retired reports lifecycle_blocked, never lifecycle_unevaluatable (BR-16)", async () => {
    const artifact = loadArtifact() as { tools: { id: string; lifecycle?: string }[] };
    artifact.tools.find((t) => t.id === "tourism.search")!.lifecycle = "retired";
    const archstone = fromIR(artifact);
    const r = await archstone.execute("tourism.search", NICE_SEARCH, { fetchImpl });
    expect(r.denial?.reason).toBe("lifecycle_blocked");
  });

  it("an unrecognized lifecycle reports lifecycle_unevaluatable, never lifecycle_blocked (BR-16, EC-1)", async () => {
    const artifact = loadArtifact() as { tools: { id: string; lifecycle?: string }[] };
    artifact.tools.find((t) => t.id === "tourism.search")!.lifecycle = "sunset";
    const archstone = fromIR(artifact);
    const r = await archstone.execute("tourism.search", NICE_SEARCH, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.denial?.reason).toBe("lifecycle_unevaluatable");
    expect(r.denial?.reason).not.toBe("lifecycle_blocked");
  });

  it("EC-4: a near-miss spelling of 'retired' (capitalized) is treated as unrecognized, never coerced to the retired case", async () => {
    const artifact = loadArtifact() as { tools: { id: string; lifecycle?: string }[] };
    artifact.tools.find((t) => t.id === "tourism.search")!.lifecycle = "Retired";
    const archstone = fromIR(artifact);
    const r = await archstone.execute("tourism.search", NICE_SEARCH, { fetchImpl });
    expect(r.denial?.reason).toBe("lifecycle_unevaluatable");
  });
});

// ADD-32: execute() forwards `caller` to invokeRest as a pure pass-through — no policy
// logic lives here. tourism.search itself carries no `authenticated` policy (#32 removed
// it as a mislabeled demo policy — see tourism.search.capability.yaml), so this uses a
// synthetic authenticated tool built from the same registry's connector shape instead of
// depending on manifest content that may change independently of this test's intent.
describe("execute() — caller credential propagation (ADD-32)", () => {
  it("reaches the backend with the caller's token attached via a ${caller.…} binding placeholder", async () => {
    let capturedAuth: string | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      capturedAuth = (init?.headers as Record<string, string> | undefined)?.Authorization;
      return new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    };
    // Simulate an authenticated binding by mutating the loaded IR's tool connector headers
    // in place — this only exercises invokeRest's ${caller.…} resolution, not policy gating
    // (covered by the dedicated policies test below).
    const artifact = loadArtifact() as { tools: { id: string; connector?: { rest?: { headers?: Record<string, string> } } }[] };
    const tool = artifact.tools.find((t) => t.id === "tourism.search")!;
    tool.connector!.rest!.headers = { Authorization: "Bearer ${caller.accessToken}" };
    const withHeader = fromIR(artifact);

    const r = await withHeader.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl, caller: { accessToken: "user-token-abc" } },
    );
    expect(r.status).toBe("ok");
    expect(capturedAuth).toBe("Bearer user-token-abc");
  });

  it("an authenticated capability with no caller supplied fails closed with status: 'error'", async () => {
    const artifact = loadArtifact() as { tools: { id: string; policies: string[] }[] };
    const tool = artifact.tools.find((t) => t.id === "tourism.search")!;
    tool.policies = ["authenticated"];
    const archstone = fromIR(artifact);

    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the gate must short-circuit first");
    };
    const r = await archstone.execute("tourism.search", NICE_SEARCH, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/requires policies:\[authenticated\]/);
  });

  it("allowedHosts reaches invokeRest — proceeds when the caller-influenced baseUrl host matches the allowlist", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    // Synthetic per-tenant-routed connector — no shipped binding does this today (see
    // providers/rest security-hardening comment); mutate the loaded IR the same way the
    // caller-propagation test above does, to isolate execute()'s pass-through of allowedHosts.
    const artifact = loadArtifact() as {
      tools: { id: string; response?: unknown; extract?: unknown; connector?: { rest?: Record<string, unknown> } }[];
    };
    const tool = artifact.tools.find((t) => t.id === "tourism.search")!;
    // raw pass-through — isolate the allowlist gate, not response mapping. Both response: and
    // extract: must go (tourism.search's real binding declares both; execute()'s gate now
    // considers either one, per the fix above), or this would hit applyResponseMapping instead.
    delete tool.response;
    delete tool.extract;
    tool.connector!.rest = { baseUrl: "https://${caller.tenantId}", method: "GET", path: "/stays" };
    const archstone = fromIR(artifact);

    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { fetchImpl, caller: { tenantId: "tenant-a.core.example.com" }, allowedHosts: ["*.core.example.com"] },
    );
    expect(r.status).toBe("ok");
    // #195: the call now carries its (valid) input, which a GET puts on the query string.
    expect(captured?.url.split("?")[0]).toBe("https://tenant-a.core.example.com/stays");
  });

  it("allowedHosts reaches invokeRest — fails closed when the caller-influenced baseUrl host is not allowlisted", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the allowlist gate must short-circuit first");
    };
    const artifact = loadArtifact() as {
      tools: { id: string; response?: unknown; connector?: { rest?: Record<string, unknown> } }[];
    };
    const tool = artifact.tools.find((t) => t.id === "tourism.search")!;
    delete tool.response;
    tool.connector!.rest = { baseUrl: "https://${caller.tenantId}", method: "GET", path: "/stays" };
    const archstone = fromIR(artifact);

    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { fetchImpl, caller: { tenantId: "evilcore.example.com" }, allowedHosts: ["*.core.example.com"] },
    );
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/not in the caller-influenced-baseUrl allowlist/);
  });

  it("omitting caller behaves exactly as before for a non-authenticated capability", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("ok");
  });
});

// Issue #39 / ADD-31: ExecuteOptions.onResponse is a pure pass-through to invokeRest — no
// policy/logic lives in execute() itself.
describe("execute() — onResponse pass-through (#39)", () => {
  it("S-US2.1: onResponse reaches invokeRest verbatim, with the same capabilityId/status/data/durationMs shape", async () => {
    const calls: { capabilityId: string; status: number; data: unknown; durationMs: number }[] = [];
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    );
    expect(r.status).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0].capabilityId).toBe("tourism.search");
    expect(calls[0].status).toBe(200);
    expect(calls[0].data).toEqual({
      stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }],
      totalMatches: 1,
    });
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("S-US2.2: ExecuteResult is identical whether onResponse is supplied (no-op) or omitted", async () => {
    const archstone = fromIR(loadArtifact());
    const responseBody = JSON.stringify({
      stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }],
      totalMatches: 1,
    });
    const withHook = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl: async () => new Response(responseBody, { status: 200 }), onResponse: () => {} },
    );
    const withoutHook = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl: async () => new Response(responseBody, { status: 200 }) },
    );
    expect(withHook).toEqual(withoutHook);
  });

  it("S-US4.3: a throwing onResponse does not affect ExecuteResult, and execute()'s own Promise does not reject", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const r = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      {
        env: { STAYS_API_URL: "https://x.test" },
        fetchImpl,
        onResponse: () => {
          throw new Error("boom");
        },
      },
    );
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 });
  });
});

// ADD-30 (#30): tools(format) advertises "tourism_search" (toolName("tourism.search")) —
// execute() must resolve that exact advertised string back to "tourism.search", identically
// across every ToolFormat (BR-1/BR-7), since all four share the one toolName() lowering.
describe("round trip — tools(format)'s advertised name resolves in execute() (BR-1/BR-7)", () => {
  const formats = ["anthropic", "openai", "gemini", "json-schema"] as const;

  it.each(formats)("%s: the advertised name invokes the same capability as its raw id", async (format) => {
    const archstone = fromIR(loadArtifact());
    const advertised = archstone.tools(format)[0] as { name?: string; function?: { name: string } };
    const name = advertised.name ?? advertised.function?.name;
    expect(name).toBe("tourism_search"); // toolName("tourism.search")

    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const r = await archstone.execute(
      name!,
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 });
  });

  it("S-US1.5: the round trip preserves a degraded outcome, identical to the raw-id call", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118 }], totalMatches: 1 }), {
        status: 200,
      });
    const viaSanitized = await archstone.execute(
      "tourism_search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    const viaRawId = await archstone.execute(
      "tourism.search",
      NICE_SEARCH,
      { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    );
    expect(viaSanitized.status).toBe("degraded");
    expect(viaSanitized).toEqual(viaRawId);
  });
});

describe("US-3 — unresolved name never crashes or misroutes (EC-2/EC-6/EC-7)", () => {
  it("EC-2/S-US3.3: an empty string never resolves to any capability", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — empty string must not resolve");
    };
    const r = await archstone.execute("", {}, { fetchImpl });
    expect(r.status).toBe("error");
  });

  it("S-US3.2: a near-miss (typo'd) name is never treated as a match, no outbound request is made", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — a misspelled name must not resolve");
    };
    const r = await archstone.execute("tourism_serach", {}, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/tourism_serach/);
  });

  it("EC-6: case differs from the advertised name — treated as unresolved, no case-insensitive fallback", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — case must not be folded");
    };
    const r = await archstone.execute("Tourism_Search", {}, { fetchImpl });
    expect(r.status).toBe("error");
  });

  it("EC-7: a raw string with characters toolName() would itself sanitize is never re-sanitized to force a match", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — execute() must not re-sanitize its input");
    };
    const r = await archstone.execute("tourism search", {}, { fetchImpl });
    expect(r.status).toBe("error");
    expect(r.error).toMatch(/tourism search/);
  });
});

describe("fromIR — fail-closed version check", () => {
  it("throws on a missing version", () => {
    expect(() => fromIR({ tools: [], resources: {}, company: { id: "x" } })).toThrow(/version/);
  });

  it("throws on a wrong version", () => {
    expect(() => fromIR({ version: "1", tools: [], resources: {}, company: { id: "x" } })).toThrow(/version/);
  });

  it("throws on a non-object", () => {
    expect(() => fromIR(null)).toThrow();
    expect(() => fromIR("archstone.ir.json")).toThrow();
  });

  it("accepts a valid version:'0' artifact", () => {
    const archstone = fromIR(loadArtifact());
    expect(archstone.registry.size).toBeGreaterThan(0);
  });
});

// ADD-30 (#30) D-2: fromIR refuses an artifact with a tool-name collision before tools()/
// execute() are ever reachable — the primary, practical boundary this fix protects, since
// an externally-produced IR artifact (unlike a real CDL-authored manifest, whose
// `capability.id` pattern can never itself produce a toolName() collision) is not
// re-validated against cdl.schema.json.
describe("fromIR — refuses an artifact with a tool-name collision (ADD-30 D-2)", () => {
  const collidingIr = {
    version: "0",
    company: { id: "acme" },
    resources: {},
    tools: [
      {
        id: "a.b",
        description: "d",
        effect: "read",
        provider: "p",
        policies: [],
        input: [],
        output: [],
        connector: { type: "rest", rest: { method: "GET", path: "/a" } },
      },
      {
        id: "a_b",
        description: "d",
        effect: "read",
        provider: "p",
        policies: [],
        input: [],
        output: [],
        connector: { type: "rest", rest: { method: "GET", path: "/b" } },
      },
    ],
  };

  it("throws InvalidArtifactError naming both colliding ids", () => {
    let caught: unknown;
    try {
      fromIR(collidingIr);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(InvalidArtifactError);
    expect((caught as Error).message).toMatch(/a\.b/);
    expect((caught as Error).message).toMatch(/a_b/);
  });

  it("tools()/execute() are never reached — the throw happens inside fromIR itself", () => {
    expect(() => fromIR(collidingIr)).toThrow(InvalidArtifactError);
  });
});
