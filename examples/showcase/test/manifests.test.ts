// The Showcase manifests, through the real pipeline: `archstone apply`, the registry, the MCP
// tool list, the runtime and `verify`, against the synthetic API in-process.
//
// This file proves the manifest set exists and behaves as the example claims (AC-1.3 to AC-1.9)
// and that every live scenario row runs end to end. The negative-scenario suite builds on the
// same harness; here only the pins that tell the manifest and the API are wired together.

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { load } from "@archstone/schema";
import { InMemoryRateLimitCounter } from "@archstone/emitter-support";
import { compile, lintIR, validateSemantics, type IRTool } from "@archstone/compiler";
import {
  CONTRACT_VIOLATION_META_KEY,
  LIFECYCLE_BLOCKED_META_KEY,
  POLICY_DENIED_META_KEY,
  callTool,
  createMcpServer,
  toolDefinitions,
} from "@archstone/runtime";
import { verifyTool } from "@archstone/runtime/verify";
import { parse as parseYaml } from "yaml";
import {
  MANIFEST_DIR,
  REPO_ROOT,
  VARIANT_DIR,
  backend,
  call,
  callerForLabel,
  loadScenarios,
  newContext,
  openRegistry,
  runRow,
  textOf,
  CLOCK_MS,
  type ScenarioRow,
} from "./harness";

const execFileAsync = promisify(execFile);
const tsx = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const cli = resolve(REPO_ROOT, "packages/cli/src/index.ts");

async function apply(dir: string): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(tsx, [cli, "apply", dir], { cwd: REPO_ROOT });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; code: number };
    return { stdout: err.stdout, code: err.code };
  }
}

const registry = openRegistry();
const tools = new Map<string, IRTool>(registry.ir.tools.map((t) => [t.id, t]));
const tool = (id: string): IRTool => {
  const t = tools.get(id);
  if (!t) throw new Error(`no capability ${id}`);
  return t;
};
const rows = loadScenarios().scenarios;
const row = (id: string): ScenarioRow => rows.find((r) => r.id === id)!;
const liveRows = rows.filter((r) => r.mode === "live");
const listed = new Set(toolDefinitions(registry).map((d) => d.name));
const definitionsOf = (name: string): string => toolDefinitions(registry).find((d) => d.name === name)?.description ?? "";

describe("AC-1.3: `archstone apply` on the manifest", () => {
  it("exits 0, reports 13 capabilities, and warns only about the two unenforced approval tokens", async () => {
    const r = await apply(MANIFEST_DIR);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("IR v0 — 13 capabilities, 13 invocable (bound)");
    expect(r.stdout).toContain("shapes valid");
    const warnings = r.stdout.split("\n").filter((l) => l.includes("⚠"));
    expect(warnings).toHaveLength(2);
    expect(warnings.some((l) => l.includes("'wanderlust.cancel'") && l.includes("human-approval"))).toBe(true);
    expect(warnings.some((l) => l.includes("'wanderlust.pay'") && l.includes("human-approval"))).toBe(true);
  });

  it("lists a tool for every live scenario S-01..S-09, S-11, S-12, S-13", () => {
    const wanted = ["S-01", "S-02", "S-03", "S-04", "S-05", "S-06", "S-07", "S-08", "S-09", "S-11", "S-12", "S-13"];
    for (const id of wanted) {
      const r = row(id);
      expect(r.mode, id).toBe("live");
      expect(listed.has(r.tool!), `${id} -> ${r.tool}`).toBe(true);
    }
    expect(new Set(wanted.map((id) => row(id).tool)).size).toBeGreaterThanOrEqual(10);
  });

  it("an experimental capability is unlisted but callable; a retired one is unlisted and refused; deletion is not a tool", async () => {
    expect(listed.has("wanderlust_neighbourhood")).toBe(false);
    expect(listed.has("tourism_search-classic")).toBe(false);
    expect([...listed].some((n) => /delete|remove|erase/i.test(n))).toBe(false);

    const ctx = newContext();
    const experimental = await call(ctx, "wanderlust_neighbourhood", { area: "Alfama" });
    expect(experimental.isError).toBe(false);

    const retired = await call(ctx, "tourism_search-classic", row("S-12").arguments!);
    expect(retired.isError).toBe(true);
    expect((retired._meta?.[LIFECYCLE_BLOCKED_META_KEY] as { lifecycle: string }).lifecycle).toBe("retired");
    expect(ctx.spy.calls).toEqual(["GET /v1/neighbourhoods"]); // the retired call never left the runtime

    const unknown = await call(ctx, row("S-14").tool!, row("S-14").arguments!);
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("unknown tool");
  });
});

describe("AC-1.4: effect and lifecycle variants", () => {
  it("covers read, write (quote) and irreversible (cancel, pay)", () => {
    expect(tool("wanderlust.search").effect).toBe("read");
    expect(tool("wanderlust.quote").effect).toBe("write");
    expect(tool("wanderlust.book").effect).toBe("write");
    expect(tool("wanderlust.cancel").effect).toBe("irreversible");
    expect(tool("wanderlust.pay").effect).toBe("irreversible");
  });

  it("advertises the effect as MCP annotations (a hint to the client, nothing Archstone enforces)", () => {
    const byName = new Map(toolDefinitions(registry).map((d) => [d.name, d.annotations]));
    expect(byName.get("wanderlust_search")).toEqual({ readOnlyHint: true });
    expect(byName.get("wanderlust_quote")).toEqual({ destructiveHint: false });
    expect(byName.get("wanderlust_cancel")).toEqual({ destructiveHint: true, idempotentHint: false });
    expect(byName.get("wanderlust_pay")).toEqual({ destructiveHint: true, idempotentHint: false });
  });

  it("names deprecated, beta, experimental and retired capabilities", () => {
    expect(tool("tourism.search").lifecycle).toBe("deprecated");
    expect(tool("wanderlust.availability").lifecycle).toBe("beta");
    expect(tool("wanderlust.neighbourhood").lifecycle).toBe("experimental");
    expect(tool("tourism.search-classic").lifecycle).toBe("retired");
    for (const id of ["wanderlust.search", "wanderlust.book", "wanderlust.pay"]) expect(tool(id).lifecycle).toBe("stable");
  });

  it("the deprecated tool keeps its name and its description carries the phasing-out note", () => {
    const def = toolDefinitions(registry).find((d) => d.name === "tourism_search");
    expect(def).toBeDefined();
    expect(def!.description).toMatch(/deprecated/i);
  });
});

describe("AC-1.5: policy variants", () => {
  it("book is authenticated, forwards the caller's token, and allows demo:visitor while denying demo:blocked", () => {
    const book = tool("wanderlust.book");
    expect(book.policies).toContain("authenticated");
    expect(book.connector!.rest!.headers).toEqual({ Authorization: "Bearer ${caller.accessToken}" });
    expect(book.policyRules).toEqual([{ id: "wanderlust-book-principals", allow: ["demo:visitor"], deny: ["demo:blocked"] }]);
  });

  it("cancel and pay are authenticated and declare human-approval", () => {
    for (const id of ["wanderlust.cancel", "wanderlust.pay"]) {
      expect(tool(id).policies).toEqual(["authenticated", "human-approval"]);
      expect(tool(id).connector!.rest!.headers).toEqual({ Authorization: "Bearer ${caller.accessToken}" });
    }
  });

  it("a rate limit exists on the availability capability only", () => {
    const limited = registry.ir.tools.filter((t) => (t.policyRules ?? []).some((r) => r.rateLimit !== undefined)).map((t) => t.id);
    expect(limited).toEqual(["wanderlust.availability"]);
    expect(tool("wanderlust.availability").policyRules![0].rateLimit).toEqual({ maxInvocations: 3, windowSeconds: 60 });
    expect(JSON.stringify(registry.ir.tools.filter((t) => t.id !== "wanderlust.availability"))).not.toContain("rateLimit");
  });
});

describe("AC-1.6: response variants", () => {
  const model = load(MANIFEST_DIR);

  it("has a map, a collection, onError, a nested projection, an image list and a web-page", () => {
    // map + collection
    expect(tool("wanderlust.stay-details").response!.collection).toBeUndefined();
    expect(tool("wanderlust.stay-details").response!.fields.length).toBeGreaterThan(1);
    expect(tool("wanderlust.search").response!.collection).toBe("$.stays[*]");
    // onError
    expect(tool("wanderlust.room-status").response!.onError).toMatchObject({ errorResource: "wanderlust.RoomStatusError", when: { path: "$.error", exists: true } });
    // nested: a resource whose field is a collection of another resource that itself nests one
    const res = registry.ir.resources;
    expect(res["wanderlust.StayDetails"].find((f) => f.name === "rooms")!.type).toEqual({ kind: "collection", of: "wanderlust.Room" });
    expect(res["wanderlust.Room"].find((f) => f.name === "amenities")!.type).toEqual({ kind: "collection", of: "wanderlust.Amenity" });
    // image + web-page
    expect(res["wanderlust.Gallery"].find((f) => f.name === "photos")!.type).toEqual({ kind: "list", items: "image" });
    expect(res["wanderlust.HotelPage"].find((f) => f.name === "url")!.type).toEqual({ kind: "scalar", semantic: "web-page" });
    expect(tool("wanderlust.stay-photos").origins).toEqual({ images: ["https://demo.archstone.dev"] });
    expect(tool("wanderlust.stay-page").origins).toEqual({ pages: ["https://www.wanderlust-agency.example"] });
    expect(model.ok).toBe(true);
  });
});

describe("AC-1.7: nothing is exposed for deletion, raw HTML, the margin, passports or phones", () => {
  it("no capability, field, mapping or connector names any of them", () => {
    const forbidden = /delete|description_html|margin|commission|"net"|passport|phone/i;
    for (const t of registry.ir.tools) {
      expect(t.connector?.rest?.method, t.id).not.toBe("DELETE");
      expect(t.id).not.toMatch(forbidden);
      // Compare everything except the recorded contract shape (which names backend paths by design).
      const { contract: _contract, ...rest } = t;
      expect(JSON.stringify(rest), t.id).not.toMatch(forbidden);
    }
    expect(JSON.stringify(registry.ir.resources)).not.toMatch(forbidden);
    // No output or resource field is about the guest (the one guest INPUT is the booking's guestName).
    const fieldNames = [...registry.ir.tools.flatMap((t) => t.output), ...Object.values(registry.ir.resources).flat()].map((f) => f.name);
    expect(fieldNames.filter((n) => /guest|html|net|margin|commission|passport|phone|email/i.test(n))).toEqual([]);
  });

  it("the booking resource declares no guest field at all", () => {
    expect(registry.ir.resources["wanderlust.Booking"].map((f) => f.name)).toEqual([
      "bookingId", "status", "stayId", "dates", "total", "pets", "petFee", "paymentQuote", "payBy",
    ]);
  });

  it("none of the manifest files outside a recorded contract mentions them", () => {
    const strip = (doc: unknown) => {
      const copy = JSON.parse(JSON.stringify(doc)) as { binding?: { contract?: unknown } };
      if (copy.binding) delete copy.binding.contract;
      return JSON.stringify(copy);
    };
    const files = [...readdirSync(MANIFEST_DIR), ...readdirSync(join(MANIFEST_DIR, "bindings")).map((f) => `bindings/${f}`)].filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(30);
    for (const f of files) {
      expect(strip(parseYaml(readFileSync(join(MANIFEST_DIR, f), "utf8"))), f).not.toMatch(/delete|description_html|margin|commission|passport|phone|"net"/i);
    }
  });
});

describe("AC-1.8: the mis-declared payment variant", () => {
  it("is outside the live manifest and `apply` exits 0 with the three irreversible-* warnings naming wanderlust.pay", async () => {
    expect(VARIANT_DIR.startsWith(`${MANIFEST_DIR}/`)).toBe(false);
    const r = await apply(VARIANT_DIR);
    expect(r.code).toBe(0);
    const warnings = r.stdout.split("\n").filter((l) => l.includes("⚠"));
    expect(warnings).toHaveLength(3);
    for (const w of warnings) expect(w).toContain("capability 'wanderlust.pay'");
    expect(warnings[0]).toContain("declares no failures");
    expect(warnings[1]).toContain("does not declare policies:[authenticated]");
    expect(warnings[2]).toContain("human-approval");
  });

  it("the lints are the three shipped codes, all warnings", () => {
    const model = load(VARIANT_DIR);
    expect(validateSemantics(model).filter((d) => d.severity === "error")).toEqual([]);
    const findings = lintIR(compile(model), model);
    expect(findings.map((f) => f.code)).toEqual([
      "irreversible-no-failures",
      "irreversible-unauthenticated",
      "irreversible-unenforced-policy",
    ]);
    expect(findings.every((f) => f.severity === "warning" && f.capability === "wanderlust.pay")).toBe(true);
  });

  it("has no quote step: no payment quote input, unlike the live pay capability", () => {
    const variant = compile(load(VARIANT_DIR)).tools[0];
    expect(variant.input.map((f) => f.name)).toEqual(["bookingId", "amount"]);
    expect(tool("wanderlust.pay").input.map((f) => f.name)).toContain("paymentQuote");
  });

  it("the live manifest's only findings are the two intended approval-token warnings", () => {
    const model = load(MANIFEST_DIR);
    const findings = lintIR(compile(model), model);
    expect(findings.map((f) => [f.code, f.capability])).toEqual([
      ["irreversible-unenforced-policy", "wanderlust.cancel"],
      ["irreversible-unenforced-policy", "wanderlust.pay"],
    ]);
  });
});

describe("AC-1.9: stateless by construction", () => {
  it("every binding is REST: no storage binding, no database", () => {
    expect(new Set(registry.ir.tools.map((t) => t.connector!.type))).toEqual(new Set(["rest"]));
  });

  it("book -> pay -> cancel works from derived ids with nothing remembered between calls", async () => {
    const ctx = newContext();
    const { result: booked, captured } = await runRow(ctx, { ...row("S-09"), arguments: { bookingId: "B-0000cafe", amount: { amount: 1, currency: "EUR" }, paymentQuote: "x" } });
    // The row's own call (a bad payment quote) is refused by the agency ...
    expect(booked.isError).toBe(true);
    expect(textOf(booked)).toContain("422");
    expect(captured.bookingId).toMatch(/^B-[0-9a-f]{12}$/);
    // ... and a fresh context (no shared memory at all) accepts the genuine one.
    const fresh = newContext();
    const paid = await call(fresh, "wanderlust_pay", { bookingId: captured.bookingId, amount: captured.total, paymentQuote: captured.paymentQuote }, "A");
    expect(paid.isError).toBe(false);
    const cancelled = await call(fresh, "wanderlust_cancel", { bookingId: captured.bookingId }, "A");
    expect(cancelled.structuredContent).toMatchObject({ cancellation: { bookingId: captured.bookingId, status: "cancelled" } });
  });
});

describe("every live scenario runs end to end against the synthetic API", () => {
  for (const r of liveRows) {
    it(`${r.id}: ${r.tool} as key ${r.key} -> ${r.outcome}`, async () => {
      const ctx = newContext();
      const { result } = await runRow(ctx, r);
      if (r.outcome === "success") {
        expect(result.isError, JSON.stringify(result)).toBe(false);
        expect(result.structuredContent).toBeDefined();
      } else if (r.outcome === "refused" && r.refusal === "input_invalid") {
        expect(result.isError).toBe(true);
        expect(result._meta?.["dev.archstone/input_invalid"]).toMatchObject({ error: "input_invalid" });
        expect(ctx.spy.calls).toEqual([]);
      } else if (r.outcome === "refused") {
        expect(result.isError).toBe(true);
        expect(result._meta?.[POLICY_DENIED_META_KEY]).toBeDefined();
        expect(ctx.spy.calls.filter((c) => c.startsWith("POST /v1/bookings"))).toEqual([]);
      } else {
        expect(r.outcome).toBe("unknown-tool");
        expect(result.isError).toBe(true);
        expect(textOf(result)).toContain("unknown tool");
        expect(ctx.spy.calls).toEqual([]);
      }
    });
  }

  it("a live row names a tool that exists, except the one that is absent on purpose", () => {
    const all = new Set(registry.invocableTools().map((t) => t.name));
    for (const r of liveRows) {
      if (r.absent) {
        expect(all.has(r.tool!), r.id).toBe(false);
      } else {
        expect(all.has(r.tool!), r.id).toBe(true);
        expect(tools.has(r.capability!), r.id).toBe(true);
      }
    }
  });
});

describe("what each manifest is wired to withhold, observed through the runtime", () => {
  const leaks = ["passport", "phone", "DEMO-PASS", "+00 000", "guest.example", "margin", "commission", "net\"", "description_html", "<img", "<a ", "unknown-host", "partner-photos", "partner-hotels", "hostContact", "lastUsedBy"];
  const clean = (r: { content: { text: string }[]; structuredContent?: unknown }) => {
    const all = JSON.stringify(r);
    for (const leak of leaks) expect(all, leak).not.toContain(leak);
  };

  it("search, details, photos and pages carry none of the over-exposed material", async () => {
    for (const id of ["S-01", "S-02", "S-03", "S-04"]) {
      const ctx = newContext();
      const { result } = await runRow(ctx, row(id));
      expect(result.isError, id).toBe(false);
      clean(result);
    }
  });

  it("details: rooms and amenities arrive, projected to the declared fields only", async () => {
    const { result } = await runRow(newContext(), row("S-02"));
    const stay = (result.structuredContent as { stay: { rooms: { amenities: Record<string, unknown>[] }[] } }).stay;
    expect(stay.rooms).toHaveLength(2);
    expect(Object.keys(stay.rooms[0]).sort()).toEqual(["amenities", "name", "pricePerNight", "sleeps"]);
    expect(Object.keys(stay.rooms[0].amenities[0]).sort()).toEqual(["fee", "name"]);
  });

  it("photos: the undeclared-host photo is dropped by position, never named by URL; nothing is fetched", async () => {
    const ctx = newContext();
    const { result } = await runRow(ctx, row("S-03"));
    expect((result.structuredContent as { gallery: { photos: string[] } }).gallery.photos).toHaveLength(4);
    // The note locates the value in the ORIGINAL response and says the returned list is shorter.
    expect(textOf(result)).toContain("gallery.photos[3] (removed; the list now has 4 items)");
    expect(textOf(result)).toContain("Every other value returned passed the origin check.");
    expect(ctx.spy.calls).toEqual(["GET /v1/stays/ws-1001/photos"]);
  });

  it("pages: the off-origin link is withheld, the row stays, nothing is opened", async () => {
    const ctx = newContext();
    const { result } = await runRow(ctx, row("S-04"));
    const pages = (result.structuredContent as { pages: { name: string; url?: string }[] }).pages;
    expect(pages).toHaveLength(2);
    expect(pages[0].url).toBe("https://www.wanderlust-agency.example/hotels/casa-alfama");
    expect(pages[1].url).toBeUndefined();
    // The note points at the partner row's link (index 1), not at the agency's own page (index 0).
    expect(textOf(result)).toContain("pages[1].url (field omitted)");
    expect(textOf(result)).not.toContain("pages[0]");
    expect(ctx.spy.calls).toEqual(["GET /v1/stays/ws-1001/pages"]);
  });

  it("search keeps the agency's order and does not rank", async () => {
    const { result } = await runRow(newContext(), row("S-01"));
    const names = (result.structuredContent as { stays: { name: string }[] }).stays.map((s) => s.name);
    expect(names).toEqual(["Casa Alfama", "Miradouro Court", "Pensão Azul", "Rio Tejo Lofts"]);
  });

  it("book: no credential is refused before the agency is asked; the blocked key is denied; an unlisted principal is not allowed", async () => {
    const r = row("S-06");
    const none = newContext();
    const noKey = await runRow(none, r, { key: "none" });
    expect(noKey.result._meta?.[POLICY_DENIED_META_KEY]).toMatchObject({ reason: "authenticated_no_credential" });
    expect(none.spy.calls).toEqual(["POST /v1/quotes"]); // only the setup quote; booking never left

    const blocked = await runRow(newContext(), row("S-07"));
    expect(blocked.result._meta?.[POLICY_DENIED_META_KEY]).toMatchObject({ reason: "principal_denied" });

    const stranger = await runRow(newContext(), row("S-07"), { key: "other" });
    expect(stranger.result._meta?.[POLICY_DENIED_META_KEY]).toMatchObject({ reason: "principal_not_allowed" });

    const allowed = await runRow(newContext(), r);
    expect(allowed.result.isError).toBe(false);
    const booking = (allowed.result.structuredContent as { booking: Record<string, unknown> }).booking;
    expect(Object.keys(booking).sort()).toEqual(["bookingId", "dates", "payBy", "paymentQuote", "petFee", "pets", "status", "stayId", "total"]);
    clean(allowed.result);
  });

  it("the agency, not Archstone, refuses a credential it does not know: it is forwarded and answered 401", async () => {
    const ctx = newContext();
    const forwarded = await callTool(ctx.registry, "wanderlust_cancel", { bookingId: "B-0000cafe" }, {
      env: { SHOWCASE_API_URL: "http://api.showcase.example" },
      fetchImpl: ctx.spy.fetchImpl,
      caller: { accessToken: "not-a-demo-key", principal: "demo:visitor" },
    });
    expect(forwarded.isError).toBe(true);
    expect(textOf(forwarded)).toContain("backend returned 401");
    expect(ctx.spy.calls).toEqual(["POST /v1/bookings/B-0000cafe/cancel"]);
  });

  it("pay: the agency refuses a missing, expired or foreign payment quote and Archstone only reports it", async () => {
    const wrong = await runRow(newContext(), row("S-09"), { arguments: { bookingId: "B-0000cafe", amount: { amount: 5, currency: "EUR" }, paymentQuote: "PQ-0-00000000" } });
    expect(wrong.result.isError).toBe(true);
    expect(textOf(wrong.result)).toContain("backend returned 422");
    expect(wrong.result._meta?.[POLICY_DENIED_META_KEY]).toBeUndefined();
  });

  it("availability: three calls answer, the fourth is refused, another capability still answers", async () => {
    const ctx = newContext();
    const r = row("S-11");
    for (let i = 1; i <= 3; i++) expect((await runRow(ctx, r)).result.isError, `call ${i}`).toBe(false);
    const fourth = await runRow(ctx, r);
    expect(fourth.result.isError).toBe(true);
    expect(fourth.result._meta?.[POLICY_DENIED_META_KEY]).toMatchObject({ reason: "rate_limit_exceeded" });
    expect(ctx.spy.calls.filter((c) => c.includes("availability"))).toHaveLength(3);
    expect((await runRow(ctx, row("S-01"))).result.isError).toBe(false);
  });

  it("room-status: an error row is returned as an error row; a wrong-typed price is a contract violation", async () => {
    const r13 = row("S-13");
    const busy = await runRow(newContext(), r13);
    expect(busy.result.isError).toBe(false);
    const rooms = (busy.result.structuredContent as { rooms: Record<string, unknown>[] }).rooms;
    expect(rooms.map((x) => x.$row)).toEqual(["ok", "error"]);
    expect(rooms[1]).toMatchObject({ code: "agency-busy" });

    const bad = await runRow(newContext(), r13, { arguments: r13.negative!.arguments });
    expect(bad.result.isError).toBe(true);
    expect(bad.result._meta?.[CONTRACT_VIOLATION_META_KEY]).toMatchObject({ error: "contract_violation", capability: "wanderlust.room-status", missing: [], invalid: [{ field: "pricePerNight", expected: "quantity" }] });
    // #196: present but the wrong shape is invalid, not missing, in the text as in `_meta`.
    expect(JSON.stringify(bad.result.content)).toContain("has a value of the wrong shape in field(s): pricePerNight (expected quantity)");
    expect(JSON.stringify(bad.result.content)).not.toContain("missing required field");
    expect(JSON.stringify(bad.result)).not.toContain("139,00");
  });

  it("the deprecated search works and returns the legacy shape", async () => {
    const { result } = await runRow(newContext(), row("S-12"));
    expect(result.isError).toBe(false);
    const stays = (result.structuredContent as { stays: Record<string, unknown>[] }).stays;
    expect(Object.keys(stays[0]).sort()).toEqual(["location", "name", "pricePerNight", "rating"]);
  });
});

describe("over the MCP wire: the reference client validates every live answer against the advertised outputSchema", () => {
  async function withClient(key: "none" | "A", fn: (client: Client) => Promise<void>): Promise<void> {
    const server = createMcpServer(registry, {
      env: { SHOWCASE_API_URL: "http://api.showcase.example" },
      fetchImpl: backend().fetchImpl,
      caller: callerForLabel(key),
      rateLimitCounter: new InMemoryRateLimitCounter(() => CLOCK_MS),
    });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "showcase-test", version: "0" }, { capabilities: {} });
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    try {
      await client.listTools(); // arms the client's outputSchema validation, as in production
      await fn(client);
    } finally {
      await client.close();
      await server.close();
    }
  }

  it("lists exactly the tools the registry lists", async () => {
    await withClient("none", async (client) => {
      const names = (await client.listTools()).tools.map((t) => t.name).sort();
      expect(names).toEqual([...listed].sort());
      expect(names).toHaveLength(11); // 13 declared, minus one experimental and one retired
    });
  });

  it("answers each no-setup success scenario, including the withheld photo and the error row", async () => {
    const wired = liveRows.filter((r) => r.outcome === "success" && !r.setup && r.key !== "B");
    expect(wired.map((r) => r.id)).toEqual(["S-01", "S-02", "S-03", "S-04", "S-05", "S-08", "S-11", "S-12", "S-13"]);
    for (const key of ["none", "A"] as const) {
      await withClient(key, async (client) => {
        for (const r of wired.filter((w) => w.key === key)) {
          const result = await client.callTool({ name: r.tool!, arguments: r.arguments! });
          expect(result.isError, r.id).toBe(false);
          expect(result.structuredContent, r.id).toBeDefined();
        }
      });
    }
  });
});

describe("`verify` replays the recorded contracts against the synthetic API", () => {
  const withContract = registry.ir.tools.filter((t) => t.contract);

  it("covers the read capabilities whose output has nothing to withhold; every one is green", async () => {
    expect(withContract.map((t) => t.id).sort()).toEqual([
      "tourism.search",
      "wanderlust.neighbourhood",
      "wanderlust.room-status",
      "wanderlust.search",
      "wanderlust.stay-details",
    ]);
    const opts = { env: { SHOWCASE_API_URL: "http://api.showcase.example" }, fetchImpl: backend().fetchImpl };
    for (const t of withContract) {
      const r = await verifyTool(t, MANIFEST_DIR, registry.ir.resources, opts);
      expect(r.status, `${t.id}: ${JSON.stringify(r)}`).toBe("green");
    }
  });

  it("the tourism contract still has the fingerprint the original tourism example recorded", () => {
    const original = readFileSync(resolve(REPO_ROOT, "examples/manifests/tourism/bindings/tourism.search.binding.yaml"), "utf8");
    const fingerprint = /fingerprint: "(sha256:[0-9a-f]{64})"/.exec(original)![1];
    expect(tool("tourism.search").contract!.fingerprint).toBe(fingerprint);
  });
});

describe("#201: a believable agency, through the real runtime", () => {
  const DATES = { from: "2027-05-12", to: "2027-05-15" };
  const quoteArgs = { stayId: "ws-1001", dates: DATES, travelers: { adults: 2 } };
  const bookArgs = (quoteId: string) => ({ ...quoteArgs, quoteId, guestName: "Ana Pop" });
  const quoteOf = (r: { structuredContent?: unknown }) => (r.structuredContent as { quote: { quoteId: string; total: { amount: number }; petFee?: { amount: number }; expiresAt: string } }).quote;

  it("R1: a quote booked after its 15 minutes is refused by the agency; Archstone only reports it", async () => {
    let now = CLOCK_MS;
    const ctx = newContext({ now: () => now });
    const q = quoteOf(await call(ctx, "wanderlust_quote", quoteArgs));
    expect(Date.parse(q.expiresAt) - now).toBe(15 * 60_000);
    now += 14 * 60_000;
    expect((await call(ctx, "wanderlust_book", bookArgs(q.quoteId), "A")).isError).toBe(false);
    now += 60_000; // exactly at expiry
    const late = await call(ctx, "wanderlust_book", bookArgs(q.quoteId), "A");
    expect(late.isError).toBe(true);
    expect(textOf(late)).toContain("backend returned 422");
    expect(late._meta?.[POLICY_DENIED_META_KEY]).toBeUndefined();
  });

  it("R1: pay refuses an expired payment quote the same way", async () => {
    let now = CLOCK_MS;
    const ctx = newContext({ now: () => now });
    const q = quoteOf(await call(ctx, "wanderlust_quote", quoteArgs));
    const booking = ((await call(ctx, "wanderlust_book", bookArgs(q.quoteId), "A")).structuredContent as { booking: { bookingId: string; total: unknown; paymentQuote: string } }).booking;
    const payArgs = { bookingId: booking.bookingId, amount: booking.total, paymentQuote: booking.paymentQuote };
    now += 15 * 60_000;
    const late = await call(ctx, "wanderlust_pay", payArgs, "A");
    expect(late.isError).toBe(true);
    expect(textOf(late)).toContain("backend returned 422");
    now = CLOCK_MS + 60_000;
    expect((await call(ctx, "wanderlust_pay", payArgs, "A")).isError).toBe(false);
  });

  it("R2: pets is a declared optional input; the quote itemises the fee, and a bad count never reaches the agency", async () => {
    const ctx = newContext();
    const q = quoteOf(await call(ctx, "wanderlust_quote", { ...quoteArgs, pets: 1 }));
    expect(q.petFee?.amount).toBe(30);
    expect(q.total.amount).toBe(384);
    const callsBefore = ctx.spy.calls.length;
    const bad = await call(ctx, "wanderlust_quote", { ...quoteArgs, pets: "one cat" });
    expect(bad._meta?.["dev.archstone/input_invalid"]).toMatchObject({ problems: [{ path: "pets", expected: "number" }] });
    expect(ctx.spy.calls.length).toBe(callsBefore);
    const refused = await call(ctx, "wanderlust_quote", { ...quoteArgs, stayId: "ws-1003", pets: 1 });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("backend returned 422");
    expect(tool("wanderlust.quote").input.map((f) => f.name)).toContain("pets");
    expect(definitionsOf("wanderlust_quote")).toMatch(/refuses a quote for a party with pets/);
  });

  it("a stay's nightly rate is one figure in search, quote, room-status and availability, on any date (#201 round 2)", async () => {
    const ctx = newContext();
    const search = await call(ctx, "wanderlust_search", { destination: "Lisbon", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } });
    const stays = (search.structuredContent as { stays: { id: string; pricePerNight: number }[] }).stays;
    expect(stays.length).toBeGreaterThan(0);
    for (const s of stays) {
      for (const date of ["2027-05-12", "2027-05-13", "2027-06-05", "2027-06-06", "2027-07-19"]) {
        // A fresh context per call: availability's rate limit is a scenario, not this test's business.
        const av = await call(newContext(), "wanderlust_availability", { propertyId: s.id, date });
        expect(av.isError, `${s.id} ${date}`).toBeFalsy();
        expect((av.structuredContent as { availability: { pricePerNight: number } }).availability.pricePerNight, `${s.id} ${date}`).toBe(s.pricePerNight);
        const rs = await call(ctx, "wanderlust_room-status", { propertyId: s.id, date });
        const free = (rs.structuredContent as { rooms?: { room: string; pricePerNight?: unknown }[] } | undefined)?.rooms?.find((r) => r.room === "Double Room");
        if (typeof free?.pricePerNight === "number") expect(free.pricePerNight, `${s.id} ${date}`).toBe(s.pricePerNight);
      }
      const q = await call(ctx, "wanderlust_quote", { stayId: s.id, dates: { from: "2027-05-12", to: "2027-05-13" }, travelers: { adults: 2 } });
      expect((q.structuredContent as { quote: { total: { amount: number } } }).quote.total.amount).toBe(s.pricePerNight);
    }
  });

  it("cancel and pay say they need the agency key and an allowed principal; stay-page says the partner link is withheld (#201 round 2)", () => {
    for (const name of ["wanderlust_book", "wanderlust_cancel", "wanderlust_pay"]) {
      expect(definitionsOf(name), name).toMatch(/Needs the agency key and a principal the manifest's policy allows: Archstone's policy refuses a missing key or a caller who is not allowed before the agency is asked/);
    }
    for (const name of ["wanderlust_cancel", "wanderlust_pay"]) {
      expect(definitionsOf(name), name).toMatch(/a person should approve it; this version of Archstone does not enforce that/);
    }
    expect(definitionsOf("wanderlust_pay")).toMatch(/the agency, not Archstone, checks it/);
    expect(definitionsOf("wanderlust_stay-page")).toMatch(/agency's own page is returned/);
    expect(definitionsOf("wanderlust_stay-page")).toMatch(/partner listing on another site[^.]*link is withheld/);
  });

  it("R4: a stay's name is a destination, on both searches", async () => {
    const ctx = newContext();
    for (const name of ["wanderlust_search", "tourism_search"]) {
      const r = await call(ctx, name, { destination: "Pensão Azul", dates: DATES, travelers: { adults: 2 } });
      expect((r.structuredContent as { stays: { name: string }[] }).stays.map((x) => x.name), name).toEqual(["Pensão Azul"]);
    }
    expect(JSON.stringify(toolDefinitions(registry).find((d) => d.name === "wanderlust_search")!.inputSchema)).toContain("exact name of one stay");
  });

  it("R5: Pensão Azul answers for June weekends; the busy row is only on the scenario's date", async () => {
    const ctx = newContext();
    for (const date of ["2027-06-05", "2027-06-06", "2027-06-12", "2027-06-13"]) {
      const r = await call(ctx, "wanderlust_room-status", { propertyId: "ws-1002", date });
      expect(r.isError, date).toBe(false);
      expect(JSON.stringify(r), date).not.toContain("agency-busy");
    }
  });

  it("R6: cancelling an id the agency never issued is its 404; the seeded booking refunds its total", async () => {
    const ctx = newContext();
    const unknown = await call(ctx, "wanderlust_cancel", { bookingId: "B-ffffffffffff" }, "A");
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain("backend returned 404");
    const seeded = await call(ctx, "wanderlust_cancel", { bookingId: "B-0000cafe" }, "A");
    const refund = (seeded.structuredContent as { cancellation: { refund: { amount: number } } }).cancellation.refund.amount;
    expect(refund).toBe(quoteOf(await call(ctx, "wanderlust_quote", quoteArgs)).total.amount);
  });

  it("R3: the official page is on the declared origin and returned; the partner link is withheld", async () => {
    const { result } = await runRow(newContext(), row("S-04"));
    const pages = (result.structuredContent as { pages: { name: string; url?: string }[] }).pages;
    expect(pages[0].url).toMatch(/^https:\/\/www\.wanderlust-agency\.example\/hotels\//);
    expect(pages[1].url).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain("partner-hotels");
  });

  it("S-06 / S-07: the copy says who enforces what, and the two cards agree", () => {
    const s6 = row("S-06").copy.en;
    const s7 = row("S-07").copy.en;
    expect(s6.refused).toMatch(/before the agency is asked/);
    expect(s6.refused).toMatch(/Archstone does not check keys itself/);
    expect(s6.refused).toMatch(/the agency checks the key and the quote/);
    expect(s6.refused).not.toMatch(/Archstone does not check who you are/);
    expect(s7.happens).toMatch(/Archstone's rules before the agency is asked/);
    expect(s7.refused).toMatch(/paying and cancelling too/);
  });
});

describe("clock", () => {
  it("scenarios run against the clock the scenario table declares", () => {
    expect(new Date(CLOCK_MS).toISOString()).toBe("2027-05-01T10:07:00.000Z");
  });
});
