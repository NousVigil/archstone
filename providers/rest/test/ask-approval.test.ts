import { describe, it, expect, vi, afterEach } from "vitest";
import type { IRDecisionGate } from "@archstone/compiler";
import type { ApprovalRequest } from "@archstone/emitter-support";
import { askApproval, type FetchLike } from "../src/index";

// ADD-393 §4/§5 (archstone#165) — `askApproval`, the decision gate's only HTTP. Pinned against
// the ADD: one POST of exactly the fixed body to a static path; HTTPS except loopback; a `${VAR}`
// secret in `Authorization` that must resolve non-empty; `redirect: "manual"` and never followed;
// a timeout bounded even for a fetch that ignores its signal; a 64 KiB capped read. Every failure
// is a non-answer (`ok: false`) whose `detail` is Archstone's wording — never a secret and never
// the endpoint's text. Classification of a 2xx body is NOT here (emitter-support's classifyAnswer).

const SECRET = "s3cr3t-approvals-token-77";
const ENV = { APPROVALS_URL: "https://approvals.test", APPROVALS_TOKEN: SECRET };

function gate(over: Partial<IRDecisionGate["ask"]> = {}): IRDecisionGate {
  return {
    input: "approval",
    ask: {
      baseUrl: "${APPROVALS_URL}",
      path: "/approvals/consume",
      headers: { Authorization: "Bearer ${APPROVALS_TOKEN}" },
      ...over,
    },
  };
}

const REQUEST: ApprovalRequest = {
  version: 1,
  token: "human-approval",
  capabilityId: "banking.initiate-transfer",
  effect: "irreversible",
  principal: "user-17",
  approvalId: "APR-2026-0042",
  input: { source: "ACC-1", amount: { amount: 450, currency: "EUR" }, approval: "APR-2026-0042" },
};

/** A fake fetch that records its calls and answers with `respond()`. */
function recorder(respond: () => Response | Promise<Response> = () => json({ approvalId: REQUEST.approvalId, outcome: "allowed", reference: "R-1" })) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url: String(url), init: init ?? {} });
    return respond();
  };
  return { fetchImpl, calls };
}

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

/** `detail` must never carry the secret, the endpoint's text, or the request's values. */
function expectClean(detail: string) {
  expect(detail).not.toContain(SECRET);
  expect(detail).not.toContain("ENDPOINT-TEXT");
  expect(detail).not.toContain("APR-2026-0042");
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("askApproval — the request (ADD-393 §2)", () => {
  it("POSTs exactly JSON.stringify(request) to baseUrl+path, redirect manual, a signal, JSON content-type, Authorization from env", async () => {
    const r = recorder();
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
    expect(res).toEqual({ ok: true, body: { approvalId: "APR-2026-0042", outcome: "allowed", reference: "R-1" } });
    expect(r.calls).toHaveLength(1);
    const { url, init } = r.calls[0]!;
    expect(url).toBe("https://approvals.test/approvals/consume");
    expect(init.method).toBe("POST");
    expect(init.body).toBe(JSON.stringify(REQUEST));
    expect(init.redirect).toBe("manual");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    const headers = init.headers as Record<string, string>;
    expect(headers["content-type"] ?? headers["Content-Type"]).toBe("application/json");
    expect(headers.Authorization).toBe(`Bearer ${SECRET}`);
  });

  it("resolves `${caller.NAME}` in a non-Authorization header from the caller", async () => {
    const r = recorder();
    const res = await askApproval(gate({ headers: { Authorization: "Bearer ${APPROVALS_TOKEN}", "X-End-User": "${caller.accessToken}" } }), REQUEST, {
      env: ENV,
      fetchImpl: r.fetchImpl,
      caller: { accessToken: "end-user-jwt" },
    });
    expect(res.ok).toBe(true);
    expect((r.calls[0]!.init.headers as Record<string, string>)["X-End-User"]).toBe("end-user-jwt");
  });

  it("a `${caller.NAME}` the caller lacks → not ok, no fetch", async () => {
    const r = recorder();
    const res = await askApproval(gate({ headers: { Authorization: "Bearer ${APPROVALS_TOKEN}", "X-End-User": "${caller.accessToken}" } }), REQUEST, {
      env: ENV,
      fetchImpl: r.fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, sent: false });
  });

  it("accepts a lowercase `authorization` header name", async () => {
    const r = recorder();
    const res = await askApproval(gate({ headers: { authorization: "Bearer ${APPROVALS_TOKEN}" } }), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(true);
  });
});

describe("askApproval — answers (ADD-393 §3/§4)", () => {
  it("2xx JSON → { ok: true, body } — the body is passed through unclassified", async () => {
    for (const status of [200, 201, 299]) {
      const r = recorder(() => json({ anything: "goes", n: status }, status));
      expect(await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl })).toEqual({ ok: true, body: { anything: "goes", n: status } });
    }
  });

  for (const status of [400, 401, 404, 409, 500, 503]) {
    it(`HTTP ${status} → not ok (a 404 is a wiring fact, never a refusal), endpoint text never in detail`, async () => {
      const r = recorder(() => json({ approvalId: REQUEST.approvalId, outcome: "refused", reference: "R", message: "ENDPOINT-TEXT" }, status));
      const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
      expect(res.ok).toBe(false);
      expect(res).toMatchObject({ sent: true });
      if (!res.ok) expectClean(res.detail);
    });
  }

  for (const status of [301, 302, 303, 307, 308]) {
    it(`HTTP ${status} → not ok, never followed (fetch called once)`, async () => {
      const r = recorder(() => new Response(null, { status, headers: { location: "https://elsewhere.test/ENDPOINT-TEXT" } }));
      const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
      expect(res.ok).toBe(false);
      expect(r.calls).toHaveLength(1);
      expect(res).toMatchObject({ ok: false, sent: true });
      if (!res.ok) {
        expectClean(res.detail);
        expect(res.detail).not.toContain("elsewhere");
      }
    });
  }

  it('`type: "opaqueredirect"` (status 0) → not ok, never followed', async () => {
    const opaque = { type: "opaqueredirect", status: 0, ok: false, body: null, headers: new Headers() } as unknown as Response;
    const r = recorder(() => opaque);
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ sent: true });
    expect(r.calls).toHaveLength(1);
  });

  it("a body of exactly 65536 bytes that is valid JSON → ok", async () => {
    const text = `"${"a".repeat(65534)}"`;
    expect(new TextEncoder().encode(text).byteLength).toBe(65536);
    const r = recorder(() => new Response(text, { status: 200 }));
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
    expect(res).toEqual({ ok: true, body: "a".repeat(65534) });
  });

  it("a body of 65537 bytes → not ok (read with a cap)", async () => {
    const text = `"${"a".repeat(65535)}"`;
    expect(new TextEncoder().encode(text).byteLength).toBe(65537);
    const r = recorder(() => new Response(text, { status: 200 }));
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ sent: true });
  });

  it("an oversize body delivered in many small chunks → not ok (the cap counts across chunks)", async () => {
    const chunk = new TextEncoder().encode("a".repeat(1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent >= 1024) return controller.close(); // 1 MiB total, never fully read
        sent++;
        controller.enqueue(chunk);
      },
    });
    const r = recorder(() => new Response(stream, { status: 200 }));
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(false);
    expect(sent).toBeLessThan(1024);
  });

  it("an oversize body from a response with no stream (arrayBuffer fallback) → not ok", async () => {
    const big = new TextEncoder().encode(`"${"a".repeat(65535)}"`);
    const noStream = { type: "basic", status: 200, ok: true, body: null, headers: new Headers(), arrayBuffer: async () => big.buffer } as unknown as Response;
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: recorder(() => noStream).fetchImpl });
    expect(res.ok).toBe(false);
  });

  it("a non-JSON 2xx body → not ok, its text never in detail", async () => {
    const r = recorder(() => new Response("<html>ENDPOINT-TEXT</html>", { status: 200 }));
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ sent: true });
    if (!res.ok) expectClean(res.detail);
  });
});

describe("askApproval — timeout (ADD-393 §4: default 10, 1–50)", () => {
  it("a fetch that honours the signal and never answers → not ok within ~1–2 s", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl: FetchLike = (_url, init) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(init.signal!.reason));
      });
    const t0 = Date.now();
    const res = await askApproval(gate({ timeoutSeconds: 1 }), REQUEST, { env: ENV, fetchImpl });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4500);
    if (!res.ok) expectClean(res.detail);
  });

  it("a fetch that IGNORES the signal and never answers → still not ok within ~1–2 s", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl: FetchLike = () => new Promise<Response>(() => undefined);
    const t0 = Date.now();
    const res = await askApproval(gate({ timeoutSeconds: 1 }), REQUEST, { env: ENV, fetchImpl });
    const elapsed = Date.now() - t0;
    expect(res.ok).toBe(false);
    expect(res).toMatchObject({ sent: true });
    expect(elapsed).toBeGreaterThanOrEqual(900);
    expect(elapsed).toBeLessThan(4500);
  });

  it("a body that stalls after the headers → not ok within the timeout (the read is bounded too)", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const stalled = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"approvalId":'));
      },
    });
    const t0 = Date.now();
    const res = await askApproval(gate({ timeoutSeconds: 1 }), REQUEST, { env: ENV, fetchImpl: recorder(() => new Response(stalled, { status: 200 })).fetchImpl });
    expect(res.ok).toBe(false);
    expect(Date.now() - t0).toBeLessThan(4500);
  });
});

describe("askApproval — network failure (scrubbed, ADD-393 §9)", () => {
  it("a throw → not ok with `request failed (<code>)`, no secret in detail; stderr scrubbed", async () => {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl: FetchLike = async () => {
      const cause = Object.assign(new Error(`connect ECONNREFUSED approvals.test Bearer ${SECRET}`), { code: "ECONNREFUSED" });
      throw new TypeError("fetch failed", { cause });
    };
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl });
    expect(res).toEqual({ ok: false, sent: true, detail: "request failed (ECONNREFUSED)" });
    const lines = stderr.mock.calls.map((c) => c.join(" ")).join("\n");
    expect(lines).not.toContain(SECRET);
  });

  it("a throw with no recognisable code → `request failed (error code unknown)`", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const fetchImpl: FetchLike = async () => {
      throw new Error(`ENDPOINT-TEXT ${SECRET}`);
    };
    const res = await askApproval(gate(), REQUEST, { env: ENV, fetchImpl });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.detail).toMatch(/^request failed \(.+\)$/);
      expectClean(res.detail);
    }
  });
});

describe("askApproval — the Authorization secret (ADD-393 §5)", () => {
  it("a missing env var → not ok, no fetch", async () => {
    const r = recorder();
    const res = await askApproval(gate(), REQUEST, { env: { APPROVALS_URL: "https://approvals.test" }, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, sent: false });
  });

  it("a missing baseUrl env var → not ok, no fetch", async () => {
    const r = recorder();
    const res = await askApproval(gate(), REQUEST, { env: { APPROVALS_TOKEN: SECRET }, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, sent: false });
    if (!res.ok) expectClean(res.detail);
  });

  it('Authorization ${VAR} set to "" → not ok, no fetch (stricter than the connector)', async () => {
    const r = recorder();
    const res = await askApproval(gate(), REQUEST, { env: { ...ENV, APPROVALS_TOKEN: "" }, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, sent: false });
  });

  it('one of two ${VAR}s in Authorization set to "" → not ok, no fetch', async () => {
    const r = recorder();
    const res = await askApproval(gate({ headers: { Authorization: "Basic ${USER}:${APPROVALS_TOKEN}" } }), REQUEST, {
      env: { ...ENV, USER: "" },
      fetchImpl: r.fetchImpl,
    });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, sent: false });
  });

  const noSecret: [string, Record<string, string>][] = [
    ["no Authorization header", { "X-Api-Key": "${APPROVALS_TOKEN}" }],
    ["a literal-only Authorization", { Authorization: "Bearer hard-coded-literal" }],
    ["Authorization with only ${caller.x}", { Authorization: "Bearer ${caller.accessToken}" }],
  ];
  for (const [label, headers] of noSecret) {
    it(`${label} → not ok, no fetch`, async () => {
      const r = recorder();
      const res = await askApproval(gate({ headers }), REQUEST, { env: ENV, fetchImpl: r.fetchImpl, caller: { accessToken: "end-user-jwt" } });
      expect(res.ok).toBe(false);
      expect(r.calls).toHaveLength(0);
      expect(res).toMatchObject({ ok: false, sent: false });
      if (!res.ok) {
        expectClean(res.detail);
        expect(res.detail).not.toContain("hard-coded-literal");
        expect(res.detail).not.toContain("end-user-jwt");
      }
    });
  }
});

describe("askApproval — HTTPS except loopback (ADD-393 §4)", () => {
  for (const base of ["http://localhost:8080", "http://127.0.0.1:9000", "http://[::1]:7000", "http://LOCALHOST"]) {
    it(`${base} is allowed`, async () => {
      const r = recorder();
      const res = await askApproval(gate({ baseUrl: base }), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
      expect(res.ok).toBe(true);
      expect(r.calls).toHaveLength(1);
    });
  }

  for (const base of ["http://example.com", "http://localhost.example.com", "http://127.0.0.1.nip.io", "ftp://approvals.test", "not a url"]) {
    it(`${base} → not ok, no fetch`, async () => {
      const r = recorder();
      const res = await askApproval(gate({ baseUrl: base }), REQUEST, { env: ENV, fetchImpl: r.fetchImpl });
      expect(res.ok).toBe(false);
      expect(r.calls).toHaveLength(0);
      expect(res).toMatchObject({ ok: false, sent: false });
    });
  }

  it("checked after ${VAR} resolution: an env var resolving to http://example.com → not ok, no fetch", async () => {
    const r = recorder();
    const res = await askApproval(gate(), REQUEST, { env: { ...ENV, APPROVALS_URL: "http://example.com" }, fetchImpl: r.fetchImpl });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, sent: false });
  });

  it("a baseUrl containing ${caller.x} → not ok, no fetch", async () => {
    const r = recorder();
    const res = await askApproval(gate({ baseUrl: "https://${caller.tenantId}.approvals.test" }), REQUEST, {
      env: ENV,
      fetchImpl: r.fetchImpl,
      caller: { tenantId: "acme" },
    });
    expect(res.ok).toBe(false);
    expect(r.calls).toHaveLength(0);
    expect(res).toMatchObject({ ok: false, sent: false });
  });
});
