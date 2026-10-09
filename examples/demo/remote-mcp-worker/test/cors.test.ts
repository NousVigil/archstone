import { describe, expect, it } from "vitest";
import { DEFAULT_ORIGIN, allowedOrigins } from "../src/cors";
import { SITE, newWorker } from "./support";

const OTHER = "https://example.invalid";

describe("AC-3.5 CORS on the browser path allows the site origin only", () => {
  it("echoes exactly the configured origin, with Vary: Origin", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-01", { method: "POST", headers: { origin: SITE } });
    expect(res.status).toBe(200);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(res.headers.get("vary")).toContain("Origin");
    expect(res.headers.get("access-control-expose-headers")).toContain("x-showcase-rate-limit");
  });

  it("any other origin gets no allow header, and is not given the call either", async () => {
    const w = newWorker();
    for (const origin of [OTHER, "https://archstone.dev.evil.example", "http://archstone.dev", "https://www.archstone.dev", "null"]) {
      const res = await w.fetch("/run/S-01", { method: "POST", headers: { origin } });
      expect(res.headers.has("access-control-allow-origin"), origin).toBe(false);
      expect(res.status, origin).toBe(403);
      expect(res.headers.get("vary")).toContain("Origin");
    }
    expect(w.apiCalls).toEqual([]);
  });

  it("a request without an Origin (curl, a server) works and carries no allow header", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-01", { method: "POST" });
    expect(res.status).toBe(200);
    expect(res.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("never answers with a wildcard", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-01", { method: "POST", headers: { origin: SITE } });
    expect(res.headers.get("access-control-allow-origin")).not.toBe("*");
  });
});

describe("AC-3.6 the preflight", () => {
  it("from the site origin: 204 with the allow headers", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-01", {
      method: "OPTIONS",
      headers: { origin: SITE, "access-control-request-method": "POST", "access-control-request-headers": "content-type" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-origin")).toBe(SITE);
    expect(res.headers.get("access-control-allow-methods")).toBe("POST, OPTIONS");
    expect(res.headers.get("access-control-allow-headers")).toBe("content-type");
    expect(res.headers.get("vary")).toContain("Origin");
  });

  it("from another origin: refused, no allow header of any kind", async () => {
    const w = newWorker();
    const res = await w.fetch("/run/S-01", { method: "OPTIONS", headers: { origin: OTHER, "access-control-request-method": "POST" } });
    expect(res.status).toBe(403);
    for (const h of ["access-control-allow-origin", "access-control-allow-methods", "access-control-allow-headers"]) {
      expect(res.headers.has(h), h).toBe(false);
    }
  });

  it("with no Origin at all: refused", async () => {
    const w = newWorker();
    expect((await w.fetch("/run/S-01", { method: "OPTIONS" })).status).toBe(403);
  });
});

describe("CORS_ORIGINS adds origins for local development", () => {
  it("defaults to the site origin only", () => {
    expect(allowedOrigins(undefined)).toEqual([DEFAULT_ORIGIN]);
    expect(DEFAULT_ORIGIN).toBe("https://archstone.dev");
  });

  it("allows a configured localhost origin, and still only exact matches", async () => {
    const w = newWorker();
    const env = { CORS_ORIGINS: "http://localhost:4321, http://127.0.0.1:4321" };
    const ok = await w.fetch("/run/S-01", { method: "POST", headers: { origin: "http://localhost:4321" } }, env);
    expect(ok.headers.get("access-control-allow-origin")).toBe("http://localhost:4321");
    const site = await w.fetch("/run/S-01", { method: "POST", headers: { origin: SITE } }, env);
    expect(site.headers.get("access-control-allow-origin")).toBe(SITE);
    const no = await w.fetch("/run/S-01", { method: "POST", headers: { origin: "http://localhost:9999" } }, env);
    expect(no.headers.has("access-control-allow-origin")).toBe(false);
  });
});

describe("no CORS anywhere else", () => {
  it("/mcp carries no CORS header even for the site origin, and has no preflight", async () => {
    const w = newWorker();
    const post = await w.rpc("tools/list", {}, undefined, { origin: SITE });
    expect(post.status).toBe(200);
    expect(post.headers.has("access-control-allow-origin")).toBe(false);
    const pre = await w.fetch("/mcp", { method: "OPTIONS", headers: { origin: SITE, "access-control-request-method": "POST" } });
    expect(pre.status).toBe(405);
    expect(pre.headers.has("access-control-allow-origin")).toBe(false);
  });

  it("the synthetic API and the images carry no CORS header", async () => {
    const w = newWorker();
    for (const path of ["/img/ws-1001/1.svg", "/v1/search"]) {
      const res = await w.fetch(path, { method: path.startsWith("/img") ? "GET" : "POST", headers: { origin: SITE }, ...(path.startsWith("/v1") ? { body: "{}" } : {}) });
      expect(res.headers.has("access-control-allow-origin"), path).toBe(false);
    }
  });
});
