import { readFileSync, readdirSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import defaultWorker from "../src/index";
import { mockStaysResponse } from "../src/mock-backend";
import { IMAGE_BASE } from "../../../showcase/api/wanderlust-api.mjs";
import { runBattery } from "../scripts/battery";
import { KEY_A, KEY_B, ORIGIN, POLICY_META, newWorker } from "./support";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

// #195: the declared input contract is enforced, so a search carries every required field.
const searchArgs = { destination: "Lisbon", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };
const quoteArgs = { stayId: "ws-1001", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };

async function bookArgs(w: ReturnType<typeof newWorker>) {
  const q = await w.call("wanderlust_quote", quoteArgs);
  const quoteId = (q.result?.structuredContent as { quote: { quoteId: string } }).quote.quoteId;
  return { ...quoteArgs, quoteId, guestName: "Ana Pop" };
}

const reason = (r: { result?: { _meta?: Record<string, { reason?: string }> } }) => r.result?._meta?.[POLICY_META]?.reason;

describe("the legacy mock backend (the tourism demo's own; the Showcase API no longer mirrors it)", () => {
  it("returns three stays for a destination, deterministically", async () => {
    const req = () => new Request(`${ORIGIN}/v1/search`, { method: "POST", body: JSON.stringify({ destination: "Lisbon" }) });
    const a = (await (await mockStaysResponse(req())).json()) as { stays: { location: string }[] };
    expect(a.stays).toHaveLength(3);
    expect(a.stays[0].location).toBe("Lisbon");
    expect(await (await mockStaysResponse(req())).json()).toEqual(a);
  });
});

describe("AC-3.1 POST /mcp serves the Showcase IR and the synthetic API from one origin", () => {
  it("initializes over JSON, stateless", async () => {
    const w = newWorker();
    const init = await w.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "vitest", version: "0" },
    });
    expect(init.status).toBe(200);
    expect(init.headers.get("content-type")).toContain("application/json");
    expect(init.result?.serverInfo?.name).toBeDefined();
  });

  it("lists the Showcase tools and omits the retired capability", async () => {
    const w = newWorker();
    const names = ((await w.rpc("tools/list", {})).result?.tools ?? []).map((t) => t.name);
    expect(names).toEqual(expect.arrayContaining(["wanderlust_search", "wanderlust_book", "wanderlust_availability", "tourism_search"]));
    expect(names).not.toContain("tourism_search-classic");
  });

  it("answers a tool call from the API on the same origin, in-process, and counts the requests", async () => {
    const w = newWorker();
    const r = await w.call("wanderlust_search", searchArgs);
    expect(r.result?.isError).not.toBe(true);
    expect(w.apiCalls.every((c) => c.includes("/v1/"))).toBe(true);
    expect(r.headers.get("x-showcase-backend-calls")).toBe(String(w.apiCalls.length));
    expect(w.apiCalls.length).toBeGreaterThan(0);
  });

  it("serves the API and the images on the same origin, and image URLs name that origin", async () => {
    const w = newWorker();
    expect((await w.fetch("/img/ws-1001/1.svg")).headers.get("content-type")).toBe("image/svg+xml");
    expect((await w.fetch("/v1/search", { method: "POST", body: JSON.stringify({ destination: "Nice" }) })).status).toBe(200);
    const photos = await w.call("wanderlust_stay-photos", { stayId: "ws-1001" });
    const urls = (photos.result?.structuredContent as { gallery: { photos: string[] } }).gallery.photos;
    expect(IMAGE_BASE).toBe("https://demo.archstone.dev");
    expect(urls).toHaveLength(4); // the fourth photo sits on an undeclared host and is withheld
    expect(urls.every((u) => u.startsWith(`${IMAGE_BASE}/img/`))).toBe(true);
  });

  it("never reaches the network: only the Worker's own origin is fetchable", async () => {
    const w = newWorker();
    const before = w.apiCalls.length;
    await w.call("wanderlust_stay-page", { stayId: "ws-1001" });
    expect(w.apiCalls.slice(before).every((c) => c.startsWith("GET /v1/"))).toBe(true);
  });
});

describe("AC-3.2 the legacy tool keeps working, advertised as deprecated", () => {
  it("keeps the Worker name and the tool name", () => {
    const cfg = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as { name: string };
    expect(cfg.name).toBe("archstone-demo-tourism-mcp");
  });

  it("tourism_search is listed as deprecated and still answers", async () => {
    const w = newWorker();
    const tool = (await w.rpc("tools/list", {})).result?.tools?.find((t) => t.name === "tourism_search");
    expect(tool?.description).toMatch(/deprecated/i);
    const r = await w.call("tourism_search", searchArgs);
    expect(r.result?.isError).not.toBe(true);
    expect((r.result?.structuredContent as { stays: unknown[] }).stays).toHaveLength(4);
    expect(JSON.stringify(r.result)).not.toMatch(/"(net|commission|margin)"/);
  });
});

describe("AC-3.3 / AC-3.4 the published keys and the policy", () => {
  it("the visitor key is allowed to book", async () => {
    const w = newWorker();
    const r = await w.call("wanderlust_book", await bookArgs(w), `Bearer ${KEY_A}`);
    expect(r.result?.isError).not.toBe(true);
    expect(r.result?.structuredContent).toBeDefined();
  });

  it("the blocked key is denied principal_denied, and the backend is not asked to book", async () => {
    const w = newWorker();
    const args = await bookArgs(w);
    const r = await w.call("wanderlust_book", args, `Bearer ${KEY_B}`);
    expect(r.result?.isError).toBe(true);
    expect(reason(r)).toBe("principal_denied");
    expect(w.apiCalls).not.toContain("POST /v1/bookings");
  });

  it("the blocked key is denied on pay and cancel too, and the backend is not asked", async () => {
    const w = newWorker();
    const pay = await w.call("wanderlust_pay", { bookingId: "B-0000cafe", amount: { amount: 354, currency: "EUR" }, paymentQuote: "PQ-0-00000000" }, `Bearer ${KEY_B}`);
    const cancel = await w.call("wanderlust_cancel", { bookingId: "B-0000cafe" }, `Bearer ${KEY_B}`);
    expect([reason(pay), reason(cancel)]).toEqual(["principal_denied", "principal_denied"]);
    expect(w.apiCalls).toEqual([]);
    const ok = await w.call("wanderlust_cancel", { bookingId: "B-0000cafe" }, `Bearer ${KEY_A}`);
    expect(ok.result?.isError).not.toBe(true);
    expect(w.apiCalls).toEqual(["POST /v1/bookings/B-0000cafe/cancel"]);
  });

  it("no Authorization header: authenticated_no_credential, backend never called", async () => {
    const w = newWorker();
    const args = await bookArgs(w);
    const before = w.apiCalls.length;
    const r = await w.call("wanderlust_book", args);
    expect(reason(r)).toBe("authenticated_no_credential");
    expect(w.apiCalls.length).toBe(before);
    expect(r.headers.get("x-showcase-backend-calls")).toBe("0");
  });

  it("another bearer has a credential but no principal: refused before the backend", async () => {
    const w = newWorker();
    const args = await bookArgs(w);
    const before = w.apiCalls.length;
    const r = await w.call("wanderlust_book", args, "Bearer not-one-of-the-two-keys");
    expect(r.result?.isError).toBe(true);
    expect(w.apiCalls.length).toBe(before);
  });

  it("an Authorization header that is not Bearer makes the policy unevaluatable", async () => {
    const w = newWorker();
    const args = await bookArgs(w);
    const r = await w.call("wanderlust_book", args, "Basic dXNlcjpwYXNz");
    expect(reason(r)).toBe("policy_unevaluatable");
  });

  it("does not echo a credential into any denial", async () => {
    const w = newWorker();
    const r = await w.call("wanderlust_book", await bookArgs(w), `Bearer ${KEY_B}`);
    expect(JSON.stringify(r.result)).not.toContain(KEY_B);
    expect(JSON.stringify(r.result)).not.toContain("demo:blocked");
  });
});

describe("AC-3.7 the availability rate limit", () => {
  const args = { propertyId: "ws-1001", date: "2027-06-05" };

  it("refuses the 4th call in a minute, and states the limit is approximate", async () => {
    const w = newWorker();
    const outcomes: (string | undefined)[] = [];
    let last = await w.call("wanderlust_availability", args);
    for (let i = 0; i < 4; i++) {
      last = await w.call("wanderlust_availability", args);
      outcomes.push(last.result?.isError ? reason(last) : "ok");
    }
    // call 1 was the warm-up; calls 2 and 3 pass, 4 is the fourth of the minute
    expect(outcomes).toEqual(["ok", "ok", "rate_limit_exceeded", "rate_limit_exceeded"]);
    expect(last.headers.get("x-showcase-rate-limit")).toMatch(/approximate/i);
  });

  it("starts a fresh count in the next window", async () => {
    const w = newWorker();
    for (let i = 0; i < 4; i++) await w.call("wanderlust_availability", args);
    w.advance(61_000);
    expect((await w.call("wanderlust_availability", args)).result?.isError).not.toBe(true);
  });

  it("does not touch other capabilities called with the same (no) key", async () => {
    const w = newWorker();
    for (let i = 0; i < 5; i++) await w.call("wanderlust_availability", args);
    for (let i = 0; i < 5; i++) {
      expect((await w.call("wanderlust_search", searchArgs)).result?.isError).not.toBe(true);
    }
  });
});

describe("AC-3.8 a retired capability", () => {
  it("is absent from tools/list and denied lifecycle_blocked when called by name", async () => {
    const w = newWorker();
    const r = await w.call("tourism_search-classic", { destination: "Lisbon" });
    expect(r.result?.isError).toBe(true);
    expect(r.result?._meta?.["dev.archstone/lifecycle_blocked"]?.error).toBe("lifecycle_blocked");
    expect(w.apiCalls).toEqual([]);
  });
});

describe("routes", () => {
  it("/mcp is POST-only: GET and DELETE are 405 with Allow: POST, never a dead SSE stream", async () => {
    const w = newWorker();
    for (const method of ["GET", "DELETE", "PUT"]) {
      const res = await w.fetch("/mcp", { method });
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toBe("POST");
    }
  });

  it("404s everywhere else, including /health and unknown /run ids", async () => {
    const w = newWorker();
    for (const path of ["/nope", "/health", "/", "/run", "/run/", "/run/S-99", "/run/S-10", "/run/S-15", "/run/%E0%A4%A"]) {
      const res = await w.fetch(path, { method: "POST" });
      expect(res.status, path).toBe(404);
    }
  });

  it("the default export is a plain handler with fetch", async () => {
    expect(Object.keys(defaultWorker)).toEqual(["fetch"]);
    expect((await defaultWorker.fetch(new Request(`${ORIGIN}/nope`))).status).toBe(404);
  });
});

describe("POST /run/{scenarioId}", () => {
  it("returns the call and the raw result, in the documented shape, ignoring the body", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-07", { method: "POST", body: JSON.stringify({ tool: "wanderlust_cancel", arguments: { bookingId: "x" } }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown> & { arguments: Record<string, unknown>; result: Record<string, unknown> };
    expect(Object.keys(body).sort()).toEqual(["arguments", "backendCalls", "caller", "result", "scenario", "tool"]);
    expect(body.backendCalls).toBe(1); // the setup quote; the booking itself was refused by policy
    expect(body.scenario).toBe("S-07");
    expect(body.tool).toBe("wanderlust_book");
    expect(body.caller).toBe("demo key B");
    expect(body.arguments.guestName).toBe("Ana Pop");
    expect(body.arguments.quoteId).toMatch(/^Q-/);
    expect(Object.keys(body.result).every((k) => ["content", "structuredContent", "_meta", "isError"].includes(k))).toBe(true);
    expect(body.result.isError).toBe(true);
    expect((body.result._meta as Record<string, { reason: string }>)[POLICY_META].reason).toBe("principal_denied");
  });

  it("S-06 runs the setup quote and books with key A; S-01 names caller none", async () => {
    const w = newWorker();
    const s6 = (await (await w.fetch("/run/S-06", { method: "POST" })).json()) as { caller: string; result: { isError: boolean } };
    expect(s6.caller).toBe("demo key A");
    expect(s6.result.isError).toBe(false);
    const s1 = (await (await w.fetch("/run/S-01", { method: "POST" })).json()) as { caller: string };
    expect(s1.caller).toBe("none");
  });

  it("S-12 returns the deprecation note it relies on, and where it lives", async () => {
    const w = newWorker();
    const body = (await (await w.fetch("/run/S-12", { method: "POST" })).json()) as {
      result: { isError: boolean };
      evidence: { kind: string; tool: string; where: string; excerpt: string };
    };
    expect(body.result.isError).toBe(false);
    expect(body.evidence).toMatchObject({ kind: "tool-description", tool: "tourism_search" });
    expect(body.evidence.where).toContain("tools/list");
    expect(body.evidence.excerpt).toMatch(/deprecated: it is being phased out/i);
    // It is the very text tools/list advertises.
    const listed = (await w.rpc("tools/list", {})).result?.tools?.find((t) => t.name === "tourism_search");
    expect(listed?.description).toContain(body.evidence.excerpt);
    // Scenarios without evidence do not carry the field.
    const s1 = (await (await w.fetch("/run/S-01", { method: "POST" })).json()) as Record<string, unknown>;
    expect(s1.evidence).toBeUndefined();
  });

  it("S-13 also runs the wrong-format price call, reported as an invalid field, beside the busy-row answer", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-13", { method: "POST" });
    const body = (await res.json()) as {
      result: { isError: boolean; content: { text: string }[] };
      alsoRun: { label: string; arguments: Record<string, unknown>; result: { isError: boolean; _meta: Record<string, { missing: unknown[]; invalid: { field: string }[] }> } }[];
      backendCalls: number;
    };
    expect(body.result.isError).toBe(false);
    expect(JSON.stringify(body.result)).toContain("agency-busy");
    expect(body.alsoRun).toHaveLength(1);
    expect(body.alsoRun[0].label).toBe("wrong-format-price");
    expect(body.alsoRun[0].arguments).toEqual({ propertyId: "ws-1003", date: "2027-05-12" });
    expect(body.alsoRun[0].result.isError).toBe(true);
    expect(body.alsoRun[0].result._meta["dev.archstone/contract_violation"]).toMatchObject({ missing: [], invalid: [{ field: "pricePerNight" }] });
    expect(JSON.stringify(body.alsoRun[0].result)).not.toContain("139,00");
    expect(body.backendCalls).toBe(2);
    expect(res.headers.get("x-showcase-backend-calls")).toBe("2");
  });

  it("S-23 refuses a wrong-shaped argument set before the agency is called: input_invalid, zero backend calls", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-23", { method: "POST", body: JSON.stringify({ arguments: { destination: "Lisbon" } }) });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      caller: string;
      arguments: Record<string, unknown>;
      backendCalls: number;
      result: { isError: boolean; _meta: Record<string, { error: string; problems: { path: string }[] }> };
    };
    expect(body.caller).toBe("none");
    expect(body.arguments).toEqual({ destination: { $ne: 1 }, dates: "tomorrow", travelers: -1 }); // the body is ignored
    expect(body.result.isError).toBe(true);
    const meta = body.result._meta["dev.archstone/input_invalid"];
    expect(meta.error).toBe("input_invalid");
    expect(meta.problems.map((p) => p.path).sort()).toEqual(["dates", "destination", "travelers"]);
    expect(body.backendCalls).toBe(0);
    expect(res.headers.get("x-showcase-backend-calls")).toBe("0");
    expect(w.apiCalls).toEqual([]);
  });

  it("S-14 reports an unknown tool: there is no tool for the DELETE route", async () => {
    const w = newWorker();
    const body = (await (await w.fetch("/run/S-14", { method: "POST" })).json()) as { result: { isError: boolean; content: { text: string }[] } };
    expect(body.result.isError).toBe(true);
    expect(body.result.content[0].text).toMatch(/unknown tool/);
    expect(w.apiCalls.some((c) => c.startsWith("DELETE"))).toBe(false);
  });

  it("is POST-only and OPTIONS-aware (405 otherwise)", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-01");
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST, OPTIONS");
  });

  it("S-11 refuses the 4th call from one visitor, and another visitor is not affected", async () => {
    const w = newWorker();
    const tap = async (ip: string) => {
      const res = await w.fetch("/run/S-11", { method: "POST", headers: { "cf-connecting-ip": ip } });
      return { res, body: (await res.json()) as { result: { isError: boolean; _meta?: Record<string, { reason: string }> } } };
    };
    const first = [await tap("203.0.113.7"), await tap("203.0.113.7"), await tap("203.0.113.7")];
    expect(first.map((t) => t.body.result.isError)).toEqual([false, false, false]);
    const fourth = await tap("203.0.113.7");
    expect(fourth.body.result._meta?.[POLICY_META].reason).toBe("rate_limit_exceeded");
    expect(fourth.res.headers.get("x-showcase-rate-limit")).toMatch(/approximate/i);
    expect((await tap("198.51.100.9")).body.result.isError).toBe(false);
  });

  it("the body of a rate-limited scenario states the limit is approximate; others carry no such field", async () => {
    const w = newWorker();
    const s11 = (await (await w.fetch("/run/S-11", { method: "POST" })).json()) as { rateLimit?: string; result: Record<string, unknown> };
    expect(s11.rateLimit).toMatch(/approximate/i);
    expect(Object.keys(s11.result).every((k) => ["content", "structuredContent", "_meta", "isError"].includes(k))).toBe(true);
    const s01 = (await (await w.fetch("/run/S-01", { method: "POST" })).json()) as Record<string, unknown>;
    expect("rateLimit" in s01).toBe(false);
  });

  it("S-11 neither returns nor reveals the per-visitor principal", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-11", { method: "POST", headers: { "cf-connecting-ip": "203.0.113.7" } });
    const text = await res.text();
    expect(text).not.toMatch(/demo:anon/);
    expect(text).not.toContain("203.0.113.7");
    expect(JSON.stringify([...res.headers])).not.toMatch(/demo:anon|203\.0\.113\.7/);
  });

  it("S-11 over /run does not use the shared anonymous bucket of /mcp", async () => {
    const w = newWorker();
    for (let i = 0; i < 5; i++) await w.call("wanderlust_availability", { propertyId: "ws-1001", date: "2027-06-05" });
    const body = (await (await w.fetch("/run/S-11", { method: "POST" })).json()) as { result: { isError: boolean } };
    expect(body.result.isError).toBe(false);
  });
});

describe("AC-3.10 no per-visitor state", () => {
  it("wrangler.jsonc declares no storage, queue or object bindings", () => {
    const cfg = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8")) as Record<string, unknown>;
    const forbidden = [
      "kv_namespaces", "d1_databases", "r2_buckets", "durable_objects", "queues", "vectorize", "hyperdrive",
      "services", "analytics_engine_datasets", "ai", "migrations", "workflows", "browser", "send_email",
    ];
    expect(Object.keys(cfg).filter((k) => forbidden.includes(k))).toEqual([]);
  });

  it("the README states it is a demo prop, not product hosting", () => {
    const readme = readFileSync(join(root, "README.md"), "utf8");
    expect(readme).toMatch(/demo prop/i);
    expect(readme).toMatch(/not product hosting/i);
  });
});

describe("AC-3.11 every value reachable through the public keys is invented", () => {
  it("no e-mail outside the reserved .example domain, and passports/phones are placeholders, in any /run result", async () => {
    const w = newWorker();
    const ids = Array.from({ length: 14 }, (_, i) => `S-${String(i + 1).padStart(2, "0")}`).filter((id) => id !== "S-10");
    let text = "";
    for (const id of ids) text += await (await w.fetch(`/run/${id}`, { method: "POST" })).text();
    const emails = text.match(/[\w.+-]+@[\w.-]+\.[a-z]+/gi) ?? [];
    expect(emails.every((e) => e.endsWith(".example"))).toBe(true);
    expect((text.match(/passport/gi) ?? []).length).toBe(0);
  });
});

describe("the wrangler-free live battery, run in-process against the Worker", () => {
  it("passes every check", async () => {
    const w = newWorker();
    const checks = await runBattery((path, init) => w.fetch(path, init));
    expect(checks.filter((c) => !c.ok)).toEqual([]);
    expect(checks.length).toBeGreaterThan(30);
  });
});

describe("AC-3.12 public-repo hygiene of the files this increment adds", () => {
  const forbidden = [
    ["archstone", "internal"].join("-"),
    ["showcase", "add"].join("-"),
    ["archstone", "console"].join("-"),
    "CONSTITUTION",
    "internal/docs",
  ];
  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir)) {
      if (e === "node_modules" || e === ".wrangler" || e === "ir.generated.json") continue;
      const p = join(dir, e);
      if (statSync(p).isDirectory()) walk(p, out);
      else out.push(p);
    }
    return out;
  }
  it("names no private repository or document", () => {
    const files = [
      ...walk(root).filter((f) => !f.endsWith("worker.test.ts")),
      resolve(root, "../../../.github/workflows/deploy-demo-worker.yml"),
    ];
    for (const f of files) {
      const text = readFileSync(f, "utf8");
      for (const word of forbidden) expect(text, `${f} mentions ${word}`).not.toContain(word);
    }
  });
});
