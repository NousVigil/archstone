import { describe, it, expect, vi } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { invokeRest, hostMatchesPattern, type FetchLike, type CallerContext } from "../src/index";

// Isolated unit test — build the IR tools directly, no load/compile dependency.
const search: IRTool = {
  id: "tourism.search",
  description: "Find accommodation.",
  effect: "read",
  provider: "booking-api",
  policies: [],
  input: [],
  output: [],
  connector: {
    type: "rest",
    rest: { baseUrl: "${BOOKING_API_URL}", method: "POST", path: "/api/v1/hotels/search" },
  },
};

// ADD-32 — a capability that DOES require a caller credential.
const authedSearch: IRTool = {
  ...search,
  policies: ["authenticated"],
  connector: {
    type: "rest",
    rest: {
      baseUrl: "${BOOKING_API_URL}",
      method: "POST",
      path: "/api/v1/hotels/search",
      headers: { Authorization: "Bearer ${caller.accessToken}" },
    },
  },
};

const unbound: IRTool = {
  id: "tourism.book",
  description: "Book.",
  effect: "write",
  provider: "booking-api",
  policies: [],
  input: [],
  output: [],
};

describe("invokeRest", () => {
  it("resolves ${env} baseUrl and POSTs the input as JSON", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    };
    const r = await invokeRest(
      search,
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl },
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://api.example.com/api/v1/hotels/search");
    expect(captured?.init.method).toBe("POST");
    expect(JSON.parse(String(captured?.init.body))).toEqual({ destination: "Nice" });
    expect(r.data).toEqual({ hotels: [{ id: "h1" }] });
  });

  it("interpolates {path} params from input", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response("{}", { status: 200 });
    };
    const withParam: IRTool = {
      ...search,
      connector: { type: "rest", rest: { baseUrl: "${API}", method: "GET", path: "/hotels/{id}" } },
    };
    await invokeRest(withParam, { id: "abc 1" }, { env: { API: "https://x.test" }, fetchImpl });
    expect(captured?.url).toBe("https://x.test/hotels/abc%201");
  });

  it("errors when a required env var is missing", async () => {
    const fetchImpl: FetchLike = async () => new Response("");
    const r = await invokeRest(search, {}, { env: {}, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing env var/);
  });

  it("errors when the capability has no REST connector", async () => {
    const fetchImpl: FetchLike = async () => new Response("");
    const r = await invokeRest(unbound, {}, { env: {}, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/no REST connector/);
  });

  it("surfaces a non-2xx backend status", async () => {
    const fetchImpl: FetchLike = async () => new Response("nope", { status: 500 });
    const r = await invokeRest(
      search,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(500);
  });
});

// #43 (ADD-43 D-4 / AC BR-20, EC-14) — these two tests previously asserted that `invokeRest`
// ITSELF refused an `authenticated` capability with no caller. That gate has MOVED to the one
// shared evaluation point in @archstone/emitter-support: `invokeRest` now performs no
// authorization at all, and a third party calling it directly proceeds where it used to fail
// closed. That is a named, ratified, deliberate behaviour change, so these are the two
// assertions AC BR-44 exempts from "every existing test must pass unmodified" — rewritten to
// pin the NEW contract rather than deleted, because "this layer decides nothing" is exactly the
// property a future reader will be tempted to undo by re-adding the gate here.
//
// The `authenticated` enforcement these used to prove is not lost: it is asserted at all three
// consumers (runtime/test/mcp.test.ts, runtime/test/http.test.ts, agent/test/mcp.test.ts,
// agent/test/execute.test.ts) and unit-tested in emitter-support/test/policy.test.ts.
describe("invokeRest — ADD-32 caller credential propagation", () => {
  it("performs NO authorization: an authenticated capability with no caller is not refused here (the gate moved, #43 D-4)", async () => {
    // The binding below happens to reference ${caller.accessToken}, so this specific call still
    // fails closed — but via the placeholder-resolution path, NOT an authorization decision.
    // The distinction is the whole point: the message proves which mechanism refused.
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the missing placeholder must short-circuit first");
    };
    const r = await invokeRest(authedSearch, {}, { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing caller credential\(s\): accessToken/);
    expect(r.error).not.toMatch(/requires policies:\[authenticated\]/);
  });

  it("performs NO authorization: an authenticated capability whose binding needs no caller placeholder reaches the backend", async () => {
    // The sharp edge of EC-14, isolated: with nothing forcing a caller placeholder, there is
    // now NOTHING in this layer between an `authenticated` capability and its backend. If this
    // test ever fails, someone re-added a policy decision to the HTTP adapter — read
    // `invokeRest`'s doc comment before "fixing" it.
    let called = false;
    const fetchImpl: FetchLike = async () => {
      called = true;
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const noPlaceholder: IRTool = { ...search, policies: ["authenticated"] };
    const r = await invokeRest(noPlaceholder, {}, { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl });
    expect(r.ok).toBe(true);
    expect(called).toBe(true);
  });

  it("does not let a policy decision mask a missing env var — env resolution now reports itself", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    const r = await invokeRest(authedSearch, {}, { env: {}, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toMatch(/missing env var/);
    expect(r.error).not.toMatch(/requires policies:\[authenticated\]/);
  });

  it("attaches ${caller.accessToken} to the outbound request when supplied", async () => {
    let captured: { headers: Record<string, string> } | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = { headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response("{}", { status: 200 });
    };
    const caller: CallerContext = { accessToken: "user-token-123" };
    const r = await invokeRest(
      authedSearch,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, caller },
    );
    expect(r.ok).toBe(true);
    expect(captured?.headers.Authorization).toBe("Bearer user-token-123");
  });

  it("treats an empty-string accessToken as present — the gate passes, the call proceeds", async () => {
    let captured: { headers: Record<string, string> } | undefined;
    const fetchImpl: FetchLike = async (_url, init) => {
      captured = { headers: (init?.headers ?? {}) as Record<string, string> };
      return new Response("{}", { status: 200 });
    };
    const r = await invokeRest(
      authedSearch,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, caller: { accessToken: "" } },
    );
    expect(r.ok).toBe(true);
    expect(captured?.headers.Authorization).toBe("Bearer ");
  });

  it("reports a missing ${caller.NAME} template key distinctly from a missing env var", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    // Not `authenticated`, so the gate doesn't fire — but the binding still references a
    // caller placeholder that's never supplied. Distinct message from "missing env var(s)".
    const tool: IRTool = {
      ...search,
      connector: {
        type: "rest",
        rest: {
          baseUrl: "${BOOKING_API_URL}",
          method: "GET",
          path: "/hotels",
          headers: { "X-User": "${caller.accessToken}" },
        },
      },
    };
    const r = await invokeRest(tool, {}, { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl });
    expect(r.ok).toBe(false);
    expect(r.error).toBe("missing caller credential(s): accessToken");
  });

  it("a service-account-only capability (no authenticated policy, no ${caller.…} template) is byte-for-byte unaffected", async () => {
    let captured: { url: string; init: RequestInit } | undefined;
    const fetchImpl: FetchLike = async (url, init) => {
      captured = { url: String(url), init: init ?? {} };
      return new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    };
    const r = await invokeRest(
      search,
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl },
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://api.example.com/api/v1/hotels/search");
    expect(r.data).toEqual({ hotels: [{ id: "h1" }] });
  });
});

// Security hardening (follow-up to ADD-32): baseUrl is the one placeholder destination where a
// caller-controlled value can redirect the ENTIRE outbound request, not just its content — so a
// binding whose baseUrl contains ${caller.NAME} must have its resolved host checked against a
// deployer-configured InvokeOptions.allowedHosts, failing closed by default. No shipped binding
// uses ${caller.…} in baseUrl today (hence the tool fixture below is synthetic, not a real
// manifest) — this is proactive hardening of the mechanism, not a fix for a live exploit.
describe("invokeRest — caller-influenced baseUrl allowlist (security hardening)", () => {
  // Per-tenant routing: the whole host is caller-controlled via ${caller.tenantId}.
  const tenantRouted: IRTool = {
    ...search,
    id: "tenant.accounts",
    connector: {
      type: "rest",
      rest: { baseUrl: "https://${caller.tenantId}", method: "GET", path: "/accounts" },
    },
  };

  it("regression: a ${VAR}-only baseUrl with no allowedHosts configured behaves exactly as before", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    };
    const r = await invokeRest(
      search,
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl }, // no allowedHosts at all
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://api.example.com/api/v1/hotels/search");
  });

  it("proceeds when the resolved host is an exact match in allowedHosts", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response("{}", { status: 200 });
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      {
        env: {},
        fetchImpl,
        caller: { tenantId: "tenant-a.core.example.com" },
        allowedHosts: ["tenant-a.core.example.com"],
      },
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://tenant-a.core.example.com/accounts");
  });

  it("proceeds when the resolved host matches a *.suffix wildcard entry", async () => {
    let captured: { url: string } | undefined;
    const fetchImpl: FetchLike = async (url) => {
      captured = { url: String(url) };
      return new Response("{}", { status: 200 });
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      {
        env: {},
        fetchImpl,
        caller: { tenantId: "tenant-a.core.example.com" },
        allowedHosts: ["*.core.example.com"],
      },
    );
    expect(r.ok).toBe(true);
    expect(captured?.url).toBe("https://tenant-a.core.example.com/accounts");
  });

  it("a *.suffix wildcard must NOT match a host missing the dot separator (no false-positive prefix match)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — 'evilcore.example.com' is not a subdomain of core.example.com");
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      {
        env: {},
        fetchImpl,
        caller: { tenantId: "evilcore.example.com" },
        allowedHosts: ["*.core.example.com"],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/not in the caller-influenced-baseUrl allowlist/);
    expect(r.error).toContain("evilcore.example.com");
  });

  it("fails closed, with no network attempt, when the resolved host is not in the allowlist at all", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the allowlist gate must short-circuit before any request");
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      {
        env: {},
        fetchImpl,
        caller: { tenantId: "tenant-b.core.example.com" },
        allowedHosts: ["tenant-a.core.example.com"],
      },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/not in the caller-influenced-baseUrl allowlist/);
  });

  it("fails closed by default when allowedHosts is entirely omitted — not a silent bypass", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — an undefined allowlist must not be treated as allow-all");
    };
    const r = await invokeRest(
      tenantRouted,
      {},
      { env: {}, fetchImpl, caller: { tenantId: "tenant-a.core.example.com" } }, // no allowedHosts
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/not in the caller-influenced-baseUrl allowlist/);
  });

  it("fails closed with a distinct error when the resolved baseUrl is not a valid URL", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called");
    };
    // caller.tenantId resolves to "" (empty, but present per ADD-32 §3/R-6) — baseUrl becomes
    // the bare string "https://", which `new URL()` rejects (no host).
    const r = await invokeRest(
      tenantRouted,
      {},
      { env: {}, fetchImpl, caller: { tenantId: "" }, allowedHosts: ["anything.example.com"] },
    );
    expect(r.ok).toBe(false);
    expect(r.status).toBe(0);
    expect(r.error).toMatch(/baseUrl is not a valid URL after caller-placeholder substitution/);
    expect(r.error).not.toMatch(/allowlist/);
  });
});

// Issue #39 / ADD-31: onResponse — a fire-and-forget raw-response observation hook.
describe("invokeRest — onResponse hook (#39)", () => {
  it("S-US1.1: fires exactly once on a 2xx round-trip, with capabilityId/status/data", async () => {
    const calls: { capabilityId: string; status: number; data: unknown; durationMs: number }[] = [];
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    const r = await invokeRest(
      search,
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    );
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0].capabilityId).toBe("tourism.search");
    expect(calls[0].status).toBe(200);
    expect(calls[0].data).toEqual({ hotels: [{ id: "h1" }] });
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(0);
  });

  it("S-US1.2: fires exactly once on a non-2xx round-trip, with the raw (unmapped) body", async () => {
    const calls: { capabilityId: string; status: number; data: unknown }[] = [];
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ error: "boom" }), { status: 500 });
    const r = await invokeRest(
      search,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    );
    expect(r.ok).toBe(false);
    expect(calls).toHaveLength(1);
    expect(calls[0].status).toBe(500);
    expect(calls[0].data).toEqual({ error: "boom" });
  });

  it("S-US1.4: durationMs is a non-negative number at least as large as an artificial fetch delay", async () => {
    const calls: { durationMs: number }[] = [];
    const fetchImpl: FetchLike = async () => {
      await new Promise((res) => setTimeout(res, 50));
      return new Response("{}", { status: 200 });
    };
    await invokeRest(
      search,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    );
    expect(calls).toHaveLength(1);
    // `Date.now()` resolution/timer jitter can shave a couple of ms off a nominal
    // `setTimeout` delay — assert against a threshold with headroom rather than the
    // exact delay, so this doesn't flake on a slower/virtualized CI runner.
    expect(calls[0].durationMs).toBeGreaterThanOrEqual(35);
  });

  it("S-US1.5/BR-7: omitting onResponse is a byte-for-byte no-op vs. pre-#39 behavior", async () => {
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ hotels: [{ id: "h1" }] }), { status: 200 });
    const withoutHook = await invokeRest(search, { destination: "Nice" }, { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl });
    const withNoopHook = await invokeRest(
      search,
      { destination: "Nice" },
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, onResponse: () => {} },
    );
    expect(withoutHook).toEqual(withNoopHook);
  });

  it("EC-7: an empty body still fires the hook, with data: undefined", async () => {
    const calls: { data: unknown }[] = [];
    // Node's Response constructor rejects a non-null body alongside a 204 status (undici,
    // correctly enforcing the fetch spec) — use 200 with an empty body to exercise the same
    // "empty body -> data: undefined" path (safeJson's `text ? ... : undefined` branch) without
    // that unrelated constructor restriction getting in the way.
    const fetchImpl: FetchLike = async () => new Response("", { status: 200 });
    await invokeRest(
      search,
      {},
      { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0].data).toBeUndefined();
  });

  it("EC-11: fires once per invocation, independently, across repeated calls with the same callback", async () => {
    const calls: { status: number }[] = [];
    const fetchImpl: FetchLike = async () => new Response("{}", { status: 200 });
    const opts = { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, onResponse: (info: { status: number }) => { calls.push(info); } };
    await invokeRest(search, {}, opts);
    await invokeRest(search, {}, opts);
    expect(calls).toHaveLength(2);
  });

  describe("BR-4/EC-1..EC-6 — never fires when no HTTP round-trip completes", () => {
    it("EC-1: no REST connector", async () => {
      const calls: unknown[] = [];
      const fetchImpl: FetchLike = async () => {
        throw new Error("must not be called");
      };
      await invokeRest(unbound, {}, { env: {}, fetchImpl, onResponse: (i) => { calls.push(i); } });
      expect(calls).toHaveLength(0);
    });

    it("EC-2: authenticated policy gate failure (no caller credential)", async () => {
      const calls: unknown[] = [];
      const fetchImpl: FetchLike = async () => {
        throw new Error("must not be called");
      };
      await invokeRest(authedSearch, {}, { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, onResponse: (i) => { calls.push(i); } });
      expect(calls).toHaveLength(0);
    });

    it("EC-3: missing env var", async () => {
      const calls: unknown[] = [];
      const fetchImpl: FetchLike = async () => new Response("");
      await invokeRest(search, {}, { env: {}, fetchImpl, onResponse: (i) => { calls.push(i); } });
      expect(calls).toHaveLength(0);
    });

    it("EC-4: caller-influenced-baseUrl allowlist rejection", async () => {
      const calls: unknown[] = [];
      const tenantRouted: IRTool = {
        ...search,
        id: "tenant.accounts",
        connector: { type: "rest", rest: { baseUrl: "https://${caller.tenantId}", method: "GET", path: "/accounts" } },
      };
      const fetchImpl: FetchLike = async () => {
        throw new Error("must not be called");
      };
      await invokeRest(tenantRouted, {}, {
        env: {},
        fetchImpl,
        caller: { tenantId: "tenant-a.core.example.com" },
        allowedHosts: ["tenant-b.core.example.com"],
        onResponse: (i) => { calls.push(i); },
      });
      expect(calls).toHaveLength(0);
    });

    it("EC-5: missing required path parameter", async () => {
      const calls: unknown[] = [];
      const withParam: IRTool = {
        ...search,
        connector: { type: "rest", rest: { baseUrl: "${API}", method: "GET", path: "/hotels/{id}" } },
      };
      const fetchImpl: FetchLike = async () => {
        throw new Error("must not be called");
      };
      await invokeRest(withParam, {}, { env: { API: "https://x.test" }, fetchImpl, onResponse: (i) => { calls.push(i); } });
      expect(calls).toHaveLength(0);
    });

    it("EC-6: doFetch throws (network error/timeout)", async () => {
      const calls: unknown[] = [];
      const fetchImpl: FetchLike = async () => {
        throw new Error("network down");
      };
      const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
      try {
        const r = await invokeRest(search, {}, { env: { BOOKING_API_URL: "https://api.example.com" }, fetchImpl, onResponse: (i) => { calls.push(i); } });
        expect(r).toEqual({ ok: false, status: 0, error: "request failed (error code unknown)" });
        expect(calls).toHaveLength(0);
      } finally {
        stderr.mockRestore();
      }
    });
  });

  describe("S-US4 — a misbehaving hook can never affect InvokeResult", () => {
    it("S-US4.1: a throwing (sync) onResponse does not affect InvokeResult, and does not throw out of invokeRest", async () => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ hotels: [] }), { status: 200 });
      const r = await invokeRest(
        search,
        {},
        {
          env: { BOOKING_API_URL: "https://api.example.com" },
          fetchImpl,
          onResponse: () => {
            throw new Error("boom");
          },
        },
      );
      expect(r).toEqual({ ok: true, status: 200, data: { hotels: [] }, error: undefined });
    });

    it("S-US4.2/EC-8: a rejecting async onResponse does not affect InvokeResult", async () => {
      const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ hotels: [] }), { status: 200 });
      const r = await invokeRest(
        search,
        {},
        {
          env: { BOOKING_API_URL: "https://api.example.com" },
          fetchImpl,
          onResponse: async () => {
            throw new Error("async boom");
          },
        },
      );
      expect(r).toEqual({ ok: true, status: 200, data: { hotels: [] }, error: undefined });
    });

    it("EC-14: a hook that does useful work then throws on a later line still leaves InvokeResult unaffected", async () => {
      let sideEffect = 0;
      const fetchImpl: FetchLike = async () => new Response("{}", { status: 200 });
      const r = await invokeRest(
        search,
        {},
        {
          env: { BOOKING_API_URL: "https://api.example.com" },
          fetchImpl,
          onResponse: () => {
            sideEffect = 1;
            throw new Error("boom after side effect");
          },
        },
      );
      expect(r.ok).toBe(true);
      expect(sideEffect).toBe(1);
    });
  });
});

describe("invokeRest — fetch errors never reach the caller", () => {
  const ENV = { BOOKING_API_URL: "https://api.internal:8443" };

  async function run(
    thrown: () => unknown,
    opts: { tool?: IRTool; input?: Record<string, unknown>; env?: Record<string, string>; caller?: CallerContext; onResponse?: () => void } = {},
  ) {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stdout = vi.spyOn(process.stdout, "write");
    const log = vi.spyOn(console, "log");
    const fetchImpl: FetchLike = async () => {
      throw thrown();
    };
    try {
      const result = await invokeRest(opts.tool ?? search, opts.input ?? {}, {
        env: opts.env ?? ENV,
        fetchImpl,
        caller: opts.caller,
        onResponse: opts.onResponse,
      });
      return { result, lines: stderr.mock.calls.map((c) => c.join(" ")), stdoutCalls: stdout.mock.calls.length, logCalls: log.mock.calls.length };
    } finally {
      stderr.mockRestore();
      stdout.mockRestore();
      log.mockRestore();
    }
  }

  it("undici's `fetch failed`: the cause's errno code only to the caller, the cause chain (host included) to stderr", async () => {
    const onResponse = vi.fn();
    const { result, lines, stdoutCalls, logCalls } = await run(
      () => new TypeError("fetch failed", { cause: Object.assign(new Error("getaddrinfo ENOTFOUND api.internal"), { code: "ENOTFOUND" }) }),
      { onResponse },
    );
    expect(result).toEqual({ ok: false, status: 0, error: "request failed (ENOTFOUND)" });
    expect(result.error).not.toContain("api.internal");
    expect(lines).toEqual(["archstone: request failed for capability 'tourism.search' (ENOTFOUND): fetch failed: getaddrinfo ENOTFOUND api.internal"]);
    expect(onResponse).not.toHaveBeenCalled(); // BR-4
    expect(stdoutCalls).toBe(0);
    expect(logCalls).toBe(0);
  });

  it("an errno code on the thrown error itself is used; an IP and port in the message stay off the caller's error", async () => {
    const { result, lines } = await run(() => Object.assign(new Error("connect ECONNREFUSED 10.0.3.7:443"), { code: "ECONNREFUSED" }));
    expect(result.error).toBe("request failed (ECONNREFUSED)");
    expect(lines).toEqual(["archstone: request failed for capability 'tourism.search' (ECONNREFUSED): connect ECONNREFUSED 10.0.3.7:443"]);
  });

  it("the request URL, header credentials, URL userinfo, query values and the caller's token are scrubbed from stderr", async () => {
    const API_KEY = "sk_live_9f8e7d6c";
    const TOKEN = "caller-tok-abc123";
    const STATIC = "static-key-xyz";
    const keyed: IRTool = {
      ...search,
      id: "tourism.lookup",
      connector: {
        type: "rest",
        rest: {
          baseUrl: "https://svc:pa%24%24word@api.internal",
          method: "GET",
          path: "/hotels",
          headers: { Authorization: "Bearer ${caller.accessToken}", "X-Api-Key": "${STATIC_KEY}" },
        },
      },
    };
    const url = `https://svc:pa%24%24word@api.internal/hotels?api_key=${API_KEY}&q=a%2Fb`;
    const message = [
      `request to ${url} failed`,
      `header Bearer ${TOKEN} / ${STATIC}`,
      `bare token ${TOKEN}, key ${API_KEY}, user svc, password pa$$word / pa%24%24word, query a/b`,
      "second line",
    ].join("\n");
    const { result, lines } = await run(() => new Error(message), {
      tool: keyed,
      input: { api_key: API_KEY, q: "a/b" },
      env: { STATIC_KEY: STATIC },
      caller: { accessToken: TOKEN },
    });
    expect(result).toEqual({ ok: false, status: 0, error: "request failed (error code unknown)" });
    expect(lines).toHaveLength(1);
    expect(lines[0]).toBe(
      "archstone: request failed for capability 'tourism.lookup' (error code unknown): " +
        "request to [url] failed " +
        "header [redacted] / [redacted] " +
        "bare token [redacted], key [redacted], user [redacted], password [redacted] / [redacted], query [redacted] " +
        "second line",
    );
    for (const secret of [API_KEY, TOKEN, STATIC, "pa$$word", "pa%24%24word", "a%2Fb", "\n"]) {
      expect(lines[0]).not.toContain(secret);
      expect(result.error).not.toContain(secret);
    }
  });

  it("an undici code, an AbortError and a TimeoutError are reported by name", async () => {
    const timeout = await run(() => new TypeError("fetch failed", { cause: Object.assign(new Error("Connect Timeout Error"), { code: "UND_ERR_CONNECT_TIMEOUT" }) }));
    expect(timeout.result.error).toBe("request failed (UND_ERR_CONNECT_TIMEOUT)");
    const abort = await run(() => new DOMException("This operation was aborted", "AbortError"));
    expect(abort.result.error).toBe("request failed (AbortError)");
    const timedOut = await run(() => new DOMException("The operation was aborted due to timeout", "TimeoutError"));
    expect(timedOut.result.error).toBe("request failed (TimeoutError)");
  });

  it("a code that is not code-shaped is unknown and never echoed to the caller", async () => {
    const { result, lines } = await run(() => Object.assign(new Error("boom"), { code: "ECONN host=x" }));
    expect(result.error).toBe("request failed (error code unknown)");
    expect(lines).toEqual(["archstone: request failed for capability 'tourism.search' (error code unknown): boom"]);
  });

  it("a thrown string, a null-prototype object, null, a non-string message, a cause cycle and a throwing getter never throw", async () => {
    const str = await run(() => "connect to api.internal refused");
    expect(str.result.error).toBe("request failed (error code unknown)");
    expect(str.lines).toEqual(["archstone: request failed for capability 'tourism.search' (error code unknown): connect to api.internal refused"]);

    const bare = await run(() => Object.create(null));
    expect(bare.result.error).toBe("request failed (error code unknown)");
    expect(bare.lines).toEqual(["archstone: request failed for capability 'tourism.search' (error code unknown): (non-string error)"]);

    const nul = await run(() => null);
    expect(nul.result.error).toBe("request failed (error code unknown)");
    expect(nul.lines).toEqual(["archstone: request failed for capability 'tourism.search' (error code unknown): (non-string error)"]);

    const odd = await run(() => Object.assign(new Error(), { message: { host: "10.0.3.7" } }));
    expect(odd.result.error).toBe("request failed (error code unknown)");
    expect(odd.lines[0]).not.toContain("10.0.3.7");

    const cyclic = new Error("outer") as Error & { cause?: unknown };
    const inner = new Error("inner") as Error & { cause?: unknown };
    cyclic.cause = inner;
    inner.cause = cyclic;
    const cycle = await run(() => cyclic);
    expect(cycle.lines).toEqual(["archstone: request failed for capability 'tourism.search' (error code unknown): outer: inner"]);

    const hostile = Object.defineProperties({}, {
      code: { get: () => { throw new Error("getter"); } },
      message: { get: () => { throw new Error("getter"); } },
      cause: { get: () => { throw new Error("getter"); } },
    });
    const getters = await run(() => hostile);
    expect(getters.result.error).toBe("request failed (error code unknown)");
    expect(getters.lines).toEqual(["archstone: request failed for capability 'tourism.search' (error code unknown): (non-string error)"]);
  });

  it("a response body that fails to read takes the same path, and onResponse does not fire", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const onResponse = vi.fn();
    const fetchImpl: FetchLike = async () =>
      ({
        ok: true,
        status: 200,
        text: () => Promise.reject(Object.assign(new Error("other side closed 10.0.3.7:443"), { code: "UND_ERR_SOCKET" })),
      }) as unknown as Response;
    try {
      const r = await invokeRest(search, {}, { env: ENV, fetchImpl, onResponse });
      expect(r).toEqual({ ok: false, status: 0, error: "request failed (UND_ERR_SOCKET)" });
      expect(stderr.mock.calls.map((c) => c.join(" "))).toEqual([
        "archstone: request failed for capability 'tourism.search' (UND_ERR_SOCKET): other side closed 10.0.3.7:443",
      ]);
      expect(onResponse).not.toHaveBeenCalled();
    } finally {
      stderr.mockRestore();
    }
  });
});

describe("hostMatchesPattern", () => {
  it("exact match", () => {
    expect(hostMatchesPattern("api.example.com", "api.example.com")).toBe(true);
    expect(hostMatchesPattern("api.example.com", "other.example.com")).toBe(false);
  });

  it("wildcard matches any subdomain but not the bare suffix itself unless listed separately", () => {
    expect(hostMatchesPattern("tenant-a.example.com", "*.example.com")).toBe(true);
    expect(hostMatchesPattern("example.com", "*.example.com")).toBe(false);
  });

  it("wildcard does not false-positive-match a host that merely ends with the suffix text (no dot boundary)", () => {
    expect(hostMatchesPattern("evilexample.com", "*.example.com")).toBe(false);
  });

  it("case-insensitive on both host and pattern", () => {
    expect(hostMatchesPattern("API.Example.COM", "api.example.com")).toBe(true);
    expect(hostMatchesPattern("Tenant-A.Example.com", "*.EXAMPLE.com")).toBe(true);
  });
});
