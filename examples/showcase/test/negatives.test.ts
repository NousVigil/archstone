// The negative-scenario suite (AC-2.1 to AC-2.20): what Archstone withholds and what it refuses,
// asserted through the real runtime, never a mock of it.
//
// Every case compiles the live manifest, runs it through `callTool` / `createMcpServer` (the MCP
// path) or `fromIR(...).execute` (the embedded path), and watches a request spy wrapped around the
// in-process synthetic API. Three suite-wide invariants close the file: no request to any image or
// page origin, no DELETE ever, and (the positive control) the API's over-exposure is still there,
// measured with the SAME absence check the cases use.
//
// Test titles that open with `N-xx` are the registry AC-2.17 reads: a scenario's negative is covered
// here exactly when a test is titled with its id.
//
// Honesty notes that shape the assertions below:
//   - Archstone does not make a real backend safe; it forwards only what the manifest names.
//   - Effects are MCP annotations (hints a client may use). Nothing here claims Archstone enforces
//     one, and nothing takes credit for a confirmation a client chose to ask.
//   - `human-approval` is declared, not enforced (runtime enforcement is a locked, unbuilt step).

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { load } from "@archstone/schema";
import { compile, lintIR } from "@archstone/compiler";
import { toolDefinitions } from "@archstone/runtime";
import { handle } from "../api/wanderlust-api.mjs";
import { DEMO_KEY_A } from "../credentials.mjs";
import {
  MANIFEST_DIR,
  REPO_ROOT,
  SHOWCASE_DIR,
  VARIANT_DIR,
  loadScenarios,
  textOf,
  type ScenarioRow,
} from "./harness";
import {
  allRequests,
  expectNoLeaks,
  findLeaks,
  installGlobalInvariants,
  modelFacing,
  rawPassthrough,
  reasonOf,
  registry,
  session,
} from "./negatives-support";

const execFileAsync = promisify(execFile);
const tsx = resolve(REPO_ROOT, "node_modules/.bin/tsx");
const cli = resolve(REPO_ROOT, "packages/cli/src/index.ts");

async function cliRun(args: string[]): Promise<{ stdout: string; code: number }> {
  try {
    const { stdout } = await execFileAsync(tsx, [cli, ...args], { cwd: REPO_ROOT });
    return { stdout, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; code: number };
    return { stdout: err.stdout, code: err.code };
  }
}

const rows = loadScenarios().scenarios;
const row = (id: string): ScenarioRow => rows.find((r) => r.id === id)!;
const definitions = new Map(toolDefinitions(registry()).map((d) => [d.name, d]));

const POLICY = "dev.archstone/policy_denied";
const CONTRACT = "dev.archstone/contract_violation";
const LIFECYCLE = "dev.archstone/lifecycle_blocked";

/** Every value stored under one of these field names anywhere in `raw`. */
function valuesOf(raw: unknown, names: string[]): string[] {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        if (names.includes(k) && typeof child === "string") out.push(child);
        walk(child);
      }
    }
  };
  walk(raw);
  return out;
}

installGlobalInvariants();

describe("the absence check itself (so a pass is not an accident)", () => {
  it("finds a planted field and a planted value at any depth, and nothing in a clean object", () => {
    expect(findLeaks({ a: { b: [{ passport: "x" }] } }).map((l) => [l.kind, l.path, l.depth])).toEqual([["field", "a.b[].passport", 2]]);
    expect(findLeaks({ a: { b: ["call DEMO-PASS-000001 now"] } }).map((l) => [l.kind, l.path])).toEqual([["value", "a.b[]"]]);
    expect(findLeaks({ stays: [{ name: "Casa Alfama", pricePerNight: 74 }] })).toEqual([]);
  });
});

describe("N-01 / AC-2.1: the margin never reaches the model, and the order is the backend's", () => {
  it("N-01 search result has no margin at any depth and keeps the agency's order", async () => {
    const s = session();
    const { result } = await s.run(row("S-01"));
    expect(result.isError).toBe(false);
    expectNoLeaks(modelFacing(result), "S-01");
    expect(JSON.stringify(result)).not.toMatch(/margin|commission/i);

    const raw = (await rawPassthrough("/v1/stays/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destination: "Lisbon", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 }, budget: { amount: 150, currency: "EUR" } }),
    })) as { stays: { name: string }[] };
    const names = (result.structuredContent as { stays: { name: string }[] }).stays.map((x) => x.name);
    expect(names).toEqual(raw.stays.map((x) => x.name));
    expect(names.length).toBeGreaterThan(1);
  });
});

describe("N-02 / AC-2.2, AC-2.3: guest data and raw HTML never reach the model", () => {
  it("N-02 details carry neither the field names nor the values of passport and phone, at any level", async () => {
    const s = session();
    const { result } = await s.run(row("S-02"));
    expect(result.isError).toBe(false);
    expectNoLeaks(modelFacing(result), "S-02");

    const raw = await rawPassthrough("/v1/stays/ws-1001");
    const secrets = valuesOf(raw, ["passport", "phone", "email"]);
    expect(secrets.length).toBeGreaterThanOrEqual(6); // the raw answer really carries them
    const everything = JSON.stringify(result);
    for (const secret of secrets) expect(everything, secret).not.toContain(secret);
    for (const name of ["passport", "phone", "email", "guests", "lastUsedBy", "history"]) expect(everything, name).not.toContain(`"${name}"`);
  });

  it("N-02 the raw description_html is absent from the result and from the advertised output schema", async () => {
    const s = session();
    const { result } = await s.run(row("S-02"));
    const raw = (await rawPassthrough("/v1/stays/ws-1001")) as { description_html: string };
    expect(raw.description_html).toContain("<img");
    expect(JSON.stringify(result)).not.toContain("description_html");
    expect(JSON.stringify(result)).not.toContain(raw.description_html.slice(0, 24));
    const def = definitions.get("wanderlust_stay-details")!;
    expect(JSON.stringify(def.outputSchema)).not.toMatch(/description_html|passport|phone|email|margin|commission/);
    // The same holds on the wire: what a client is advertised is what it can ever receive.
    await s.withClient("none", async (client) => {
      const listed = (await client.listTools()).tools.find((t) => t.name === "wanderlust_stay-details")!;
      expect(JSON.stringify(listed.outputSchema)).not.toMatch(/description_html|passport|phone|email|margin|commission/);
      const viaWire = await client.callTool({ name: "wanderlust_stay-details", arguments: row("S-02").arguments! });
      expect(viaWire.isError).toBe(false);
      expect(JSON.stringify(viaWire)).not.toContain("description_html");
    });
  });
});

describe("N-03 / AC-2.4, AC-2.5: a photo on an undeclared host is withheld, by path, and never fetched", () => {
  it("N-03 the embedded SDK reports outcome degraded and names the field path, never the URL", async () => {
    const s = session();
    const r = await s.execute("wanderlust.stay-photos", row("S-03").arguments!);
    expect(r.status).toBe("degraded");
    expect(r.withheld).toEqual(["photos[3]"]);
    expect(JSON.stringify(r.withheld)).not.toMatch(/https?:|partner-photos|\.svg/);
    const photos = (r.data as { gallery: { photos: string[] } }).gallery.photos;
    expect(photos).toHaveLength(4); // the other items remain
    expect(photos.every((u) => u.startsWith("https://images.wanderlust-agency.example/"))).toBe(true);
    expect(JSON.stringify(r)).not.toContain("partner-photos");
  });

  it("N-03 the MCP tool answers with the four declared photos and a note naming the path, not the URL", async () => {
    const s = session();
    const { result } = await s.run(row("S-03"));
    expect(result.isError).toBe(false);
    const photos = (result.structuredContent as { gallery: { photos: string[] } }).gallery.photos;
    expect(photos).toHaveLength(4);
    expect(textOf(result)).toContain("withheld");
    expect(textOf(result)).toContain("photos[3]");
    expect(textOf(result)).not.toContain("partner-photos");
    expectNoLeaks(modelFacing(result), "S-03");
  });

  it("N-03 AC-2.5: zero outbound requests to any image URL, only the API's own endpoint is called", async () => {
    const s = session();
    await s.run(row("S-03"));
    await s.execute("wanderlust.stay-photos", row("S-03").arguments!);
    await s.withClient("none", (c) => c.callTool({ name: "wanderlust_stay-photos", arguments: row("S-03").arguments! }));
    expect(s.spy.foreign()).toEqual([]);
    expect(s.spy.requests.filter((r) => r.pathname.startsWith("/img/"))).toEqual([]);
    expect(new Set(s.spy.apiCalls())).toEqual(new Set(["GET /v1/stays/ws-1001/photos"]));
    expect(s.spy.requests).toHaveLength(3);
  });
});

describe("N-04 / AC-2.6: a page link on an undeclared origin is withheld, by path, and never opened", () => {
  it("N-04 the off-origin link is withheld and named by field path; the row itself stays", async () => {
    const s = session();
    const r = await s.execute("wanderlust.stay-page", row("S-04").arguments!);
    expect(r.status).toBe("degraded");
    expect(r.withheld).toEqual(["url"]);
    expect(JSON.stringify(r.withheld)).not.toMatch(/https?:|partner-hotels/);
    const pages = (r.data as { pages: { name: string; url?: string }[] }).pages;
    expect(pages).toHaveLength(2);
    expect(pages[0].url).toBe("https://www.wanderlust-agency.example/hotels/casa-alfama");
    expect(pages[1].url).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("partner-hotels");

    const { result } = await s.run(row("S-04"));
    expect(textOf(result)).toContain("withheld");
    expect(textOf(result)).not.toContain("partner-hotels");
  });

  it("N-04 nothing is opened: no request leaves for any page host", async () => {
    const s = session();
    await s.run(row("S-04"));
    await s.execute("wanderlust.stay-page", row("S-04").arguments!);
    expect(s.spy.foreign()).toEqual([]);
    expect(new Set(s.spy.apiCalls())).toEqual(new Set(["GET /v1/stays/ws-1001/pages"]));
  });
});

describe("N-05 / AC-2.7: a quote books nothing", () => {
  it("N-05 the quote result is a price that expires; no booking is made, however often it is asked", async () => {
    const s = session();
    const first = await s.run(row("S-05"));
    const second = await s.run(row("S-05"));
    expect(first.result.isError).toBe(false);
    const quote = (first.result.structuredContent as { quote: Record<string, unknown> }).quote;
    expect(Object.keys(quote).sort()).toEqual(["dates", "expiresAt", "nights", "quoteId", "stayId", "total"]);
    expect(JSON.stringify(first.result)).not.toMatch(/bookingId|"status"|paymentQuote/);
    // Stateless agency: there is no booking read to ask. What can be shown is that two quotes
    // are the same quote (nothing was consumed or created) and that no booking request was made.
    expect((second.result.structuredContent as { quote: { quoteId: string } }).quote.quoteId).toBe(quote.quoteId as string);
    expect(s.spy.apiCalls()).toEqual(["POST /v1/quotes", "POST /v1/quotes"]);
  });

  it("N-05 the tool advertises a non-destructive write: destructiveHint false, not read-only", () => {
    const annotations = definitions.get("wanderlust_quote")!.annotations;
    expect(annotations).toEqual({ destructiveHint: false });
    expect(annotations?.readOnlyHint).toBeUndefined();
    expect(registry().ir.tools.find((t) => t.id === "wanderlust.quote")!.effect).toBe("write");
  });
});

describe("N-06 / AC-2.8: booking without a credential is denied before the agency is asked", () => {
  it("N-06 reason authenticated_no_credential; the backend receives no booking request", async () => {
    const s = session();
    const { result } = await s.run(row("S-06"), { key: "none" });
    expect(result.isError).toBe(true);
    expect(result._meta?.[POLICY]).toMatchObject({ error: "policy_denied", capability: "wanderlust.book", reason: "authenticated_no_credential" });
    expect(s.spy.apiCalls()).toEqual(["POST /v1/quotes"]); // only the setup quote
  });

  it("N-06 the denial carries a reason and a capability, and nothing about the policy itself", async () => {
    const s = session();
    const { result } = await s.run(row("S-06"), { key: "none" });
    expect(Object.keys(result._meta?.[POLICY] as object).sort()).toEqual(["capability", "error", "reason"]);
    expect(JSON.stringify(result)).not.toMatch(/demo:visitor|demo:blocked|wanderlust-book-principals/);
  });
});

describe("N-07 / AC-2.9: principal rules deny before the agency is asked", () => {
  const book = row("S-07");

  it("N-07 a blocked principal is denied principal_denied", async () => {
    const s = session();
    const { result } = await s.run(book); // key B is accepted by the agency but denied by the manifest
    expect(result.isError).toBe(true);
    expect(reasonOf(result._meta)).toBe("principal_denied");
    expect(s.spy.apiCalls()).toEqual(["POST /v1/quotes"]);
  });

  it("N-07 an accepted credential whose principal is on no list is denied principal_not_allowed", async () => {
    const s = session();
    const { result } = await s.run(book, { key: "other" });
    expect(result.isError).toBe(true);
    expect(reasonOf(result._meta)).toBe("principal_not_allowed");
    expect(s.spy.apiCalls()).toEqual(["POST /v1/quotes"]);
  });

  it("N-07 a caller whose identity could not be established is denied policy_unevaluatable, even with an allowed key", async () => {
    const s = session();
    const quote = await s.call("wanderlust_quote", row("S-05").arguments!);
    const args = { ...book.arguments, quoteId: (quote.structuredContent as { quote: { quoteId: string } }).quote.quoteId };
    const result = await s.call("wanderlust_book", args, "A", { callerResolutionFailed: true });
    expect(result.isError).toBe(true);
    expect(reasonOf(result._meta)).toBe("policy_unevaluatable");
    expect(s.spy.apiCalls()).toEqual(["POST /v1/quotes"]);
  });

  it("N-07 the allowed principal is the control: it reaches the agency and books", async () => {
    const s = session();
    const { result } = await s.run(row("S-06"));
    expect(result.isError).toBe(false);
    expect(s.spy.apiCalls()).toEqual(["POST /v1/quotes", "POST /v1/bookings"]);
  });
});

describe("N-08 / AC-2.10: cancel is advertised as destructive; approval is declared, not enforced", () => {
  it("N-08 cancel and pay carry destructiveHint true: a hint a client may use, nothing Archstone enforces", () => {
    for (const name of ["wanderlust_cancel", "wanderlust_pay"]) {
      expect(definitions.get(name)!.annotations, name).toEqual({ destructiveHint: true, idempotentHint: false });
    }
  });

  it("N-08 human-approval is declared in the manifest and reported as not enforced by the lint", () => {
    const model = load(MANIFEST_DIR);
    const cancel = registry().ir.tools.find((t) => t.id === "wanderlust.cancel")!;
    expect(cancel.policies).toEqual(["authenticated", "human-approval"]);
    const finding = lintIR(compile(model), model).find((f) => f.capability === "wanderlust.cancel");
    expect(finding).toMatchObject({ code: "irreversible-unenforced-policy", severity: "warning", token: "human-approval" });
    expect(finding!.message).toMatch(/does not enforce/);
  });

  it("N-08 nothing pauses it: with the key, the cancel reaches the agency at once", async () => {
    const s = session();
    const { result } = await s.run(row("S-08"));
    expect(result.isError).toBe(false);
    expect(s.spy.apiCalls()).toEqual(["POST /v1/bookings/B-0000cafe/cancel"]);
    expect(definitions.get("wanderlust_cancel")!.description).toMatch(/does not enforce/);
  });

  it("N-08 no sentence in the example claims Archstone pauses, asks or approves", () => {
    const sources = [readFileSync(resolve(SHOWCASE_DIR, "README.md"), "utf8"), ...rows.map((r) => r.copy.en.ask + " " + r.copy.en.happens + " " + r.copy.en.refused)];
    const claim = /\barchstone\b[^.]{0,60}\b(pauses|asks (a person|you|for (approval|confirmation))|waits for (a person|approval)|requires (a person|approval))/i;
    for (const text of sources) expect(text).not.toMatch(claim);
  });
});

describe("N-09 / AC-2.11: the mis-declared payment warns and does not block; the agency, not Archstone, refuses a wrong quote", () => {
  it("N-09 `archstone apply` on the variant exits 0 with the three irreversible-* warnings", async () => {
    const r = await cliRun(["apply", VARIANT_DIR]);
    expect(r.code).toBe(0);
    const warnings = r.stdout.split("\n").filter((l) => l.includes("⚠"));
    expect(warnings).toHaveLength(3);
    const model = load(VARIANT_DIR);
    const findings = lintIR(compile(model), model);
    expect(findings.map((f) => f.code)).toEqual(["irreversible-no-failures", "irreversible-unauthenticated", "irreversible-unenforced-policy"]);
    // Each reported line is one lint finding, naming the capability, in the same order.
    findings.forEach((f, i) => {
      expect(warnings[i]).toContain(`capability '${f.capability}'`);
      expect(warnings[i]).toContain(f.message);
      expect(f.capability).toBe("wanderlust.pay");
      expect(f.severity).toBe("warning");
    });
    expect(r.stdout).toMatch(/ 0 error\(s\), 3 warning\(s\)/);
  });

  async function payWith(arguments_: (captured: { bookingId: string; total: unknown; paymentQuote: string }) => Record<string, unknown>, advanceMinutes = 0) {
    const s = session();
    const { captured } = await s.run(row("S-09"));
    const c = captured as { bookingId: string; total: unknown; paymentQuote: string };
    s.clock.t += advanceMinutes * 60_000;
    const before = s.spy.apiCalls().length;
    const result = await s.call("wanderlust_pay", arguments_(c), "A");
    return { s, result, payCalls: s.spy.apiCalls().slice(before) };
  }

  it("N-09 live pay: a missing payment quote is refused by the agency", async () => {
    const { result, payCalls } = await payWith((c) => ({ bookingId: c.bookingId, amount: c.total }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("backend returned 422");
    expect(payCalls).toEqual(["POST /v1/payments"]); // the refusal came from the backend, after the call left
    expect(result._meta).toBeUndefined(); // no Archstone gate refused it
  });

  it("N-09 live pay: an expired payment quote is refused by the agency", async () => {
    const { result, payCalls } = await payWith((c) => ({ bookingId: c.bookingId, amount: c.total, paymentQuote: c.paymentQuote }), 16);
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("backend returned 422");
    expect(payCalls).toEqual(["POST /v1/payments"]);
    expect(result._meta).toBeUndefined();
  });

  it("N-09 live pay: a payment quote issued for another booking is refused by the agency", async () => {
    const { result, payCalls } = await payWith((c) => ({ bookingId: "B-0000cafe", amount: c.total, paymentQuote: c.paymentQuote }));
    expect(result.isError).toBe(true);
    expect(textOf(result)).toContain("backend returned 422");
    expect(payCalls).toEqual(["POST /v1/payments"]);
    expect(result._meta).toBeUndefined();
  });

  it("N-09 the genuine quote is the control: the same call is accepted", async () => {
    const { result } = await payWith((c) => ({ bookingId: c.bookingId, amount: c.total, paymentQuote: c.paymentQuote }));
    expect(result.isError).toBe(false);
  });

  it("N-09 the agency's own answers name the quote problem; the docs attribute the refusal to the agency", async () => {
    const asAgency = async (body: Record<string, unknown>, at = 0) => {
      const s = session();
      s.clock.t += at;
      const res = await s.spy.fetchImpl(`http://api.showcase.example/v1/payments`, {
        method: "POST",
        headers: { "content-type": "application/json", authorization: "Bearer demo-public-key-visitor-0000" },
        body: JSON.stringify(body),
      });
      return { status: res.status, body: (await res.json()) as { error: string } };
    };
    expect((await asAgency({ bookingId: "B-0000cafe", amount: { amount: 1, currency: "EUR" } })).body.error).toBe("payment_quote_required");
    expect((await asAgency({ bookingId: "B-0000cafe", amount: { amount: 1, currency: "EUR" }, paymentQuote: "PQ-0-00000000" })).status).toBe(422);

    const readme = readFileSync(resolve(SHOWCASE_DIR, "README.md"), "utf8");
    expect(readme).toMatch(/the agency checks that, not Archstone/);
    expect(readme).toMatch(/warns about a payment declared without\s+safeguards, it does not block/);
    expect(definitions.get("wanderlust_pay")!.description).toMatch(/the agency, not Archstone, checks it/);
    expect(row("S-09").copy.en.refused).toMatch(/the agency checks that, not Archstone/);
    expect(row("S-09").copy.en.refused).toMatch(/warn and do not block/);
  });
});

describe("N-11 / AC-2.12: the fourth availability call in a minute is denied", () => {
  it("N-11 calls 1-3 succeed, call 4 is denied rate_limit_exceeded, another capability still answers", async () => {
    const s = session();
    const availability = row("S-11");
    for (let i = 1; i <= 3; i++) expect((await s.run(availability)).result.isError, `call ${i}`).toBe(false);
    const fourth = await s.run(availability);
    expect(fourth.result.isError).toBe(true);
    expect(reasonOf(fourth.result._meta)).toBe("rate_limit_exceeded");
    expect(s.spy.apiCalls().filter((c) => c.includes("availability"))).toHaveLength(3); // the fourth never left
    // The same window, another capability:
    expect((await s.run(row("S-01"))).result.isError).toBe(false);
    // The window is a minute: on a fake clock, a minute on, the limit has reset.
    s.clock.t += 60_000;
    expect((await s.run(availability)).result.isError).toBe(false);
  });

  it("N-11 the limit is the manifest's: 3 per 60 seconds, on availability only", () => {
    const limited = registry().ir.tools.filter((t) => (t.policyRules ?? []).some((r) => r.rateLimit !== undefined));
    expect(limited.map((t) => t.id)).toEqual(["wanderlust.availability"]);
    expect(limited[0].policyRules![0].rateLimit).toEqual({ maxInvocations: 3, windowSeconds: 60 });
  });
});

describe("N-12 / AC-2.13: deprecated still works with a note; retired is refused and never listed", () => {
  it("N-12 the deprecated search succeeds and its tool description carries the phasing-out note", async () => {
    const s = session();
    const { result } = await s.run(row("S-12"));
    expect(result.isError).toBe(false);
    expect(definitions.get("tourism_search")!.description).toMatch(/deprecated: it is being phased out/i);
  });

  it("N-12 the retired search is denied lifecycle_blocked and the agency receives nothing", async () => {
    const s = session();
    const retired = row("S-12").negative!;
    const result = await s.call(retired.tool!, row("S-12").arguments!);
    expect(result.isError).toBe(true);
    expect(reasonOf(result._meta)).toBe("lifecycle_blocked");
    expect(result._meta?.[LIFECYCLE]).toMatchObject({ capability: "tourism.search-classic", lifecycle: "retired" });
    expect(s.spy.requests).toEqual([]);
    const embedded = await s.execute(retired.capability!, row("S-12").arguments!);
    expect(embedded).toMatchObject({ status: "error", denial: { reason: "lifecycle_blocked", capability: "tourism.search-classic" } });
    expect(s.spy.requests).toEqual([]);
  });

  it("N-12 the retired tool is absent from the tool list a client receives", async () => {
    const s = session();
    await s.withClient("none", async (client) => {
      const names = (await client.listTools()).tools.map((t) => t.name);
      expect(names).not.toContain(row("S-12").negative!.tool);
      expect(names).toContain("tourism_search");
    });
  });

  it("N-12 `apply --exposure` reports fields per DECLARED capability: it lists the retired one, which the tool list does not", async () => {
    // Pinned as observed in this version: the exposure report answers "what would a model see of
    // each declared capability", not "which tools are served". Whether a client can call a
    // capability is the tool list's and the lifecycle gate's job (both asserted above).
    const r = await cliRun(["apply", MANIFEST_DIR, "--exposure", "--json"]);
    expect(r.code).toBe(0);
    const ids = (JSON.parse(r.stdout) as { exposure: { capabilityId: string }[] }).exposure.map((e) => e.capabilityId);
    expect(ids).toContain("tourism.search-classic");
    expect(ids).toHaveLength(13);
  });
});

describe("N-13 / AC-2.14, AC-2.15: a failing backend is an error, a wrong-typed price is a violation", () => {
  it("N-13 a 503 is reported as an error with the status, through neither degraded nor violation", async () => {
    // Observed in this version: `onError` maps error ROWS inside a 2xx answer. A non-2xx answer
    // never reaches the response mapping, so a 503 is an error result, not `degraded`.
    const s = session({ intercept: () => new Response("{}", { status: 503 }) });
    const embedded = await s.execute("wanderlust.room-status", row("S-13").arguments!);
    expect(embedded).toEqual({ status: "error", error: "backend returned 503" });
    const tool = await s.call("wanderlust_room-status", row("S-13").arguments!);
    expect(tool.isError).toBe(true);
    expect(textOf(tool)).toBe("backend returned 503");
    expect(tool.structuredContent).toBeUndefined();
    expect(tool._meta).toBeUndefined();
  });

  it("N-13 an error row inside a 2xx answer goes through onError and is returned as a row, not as degraded", async () => {
    const s = session();
    const embedded = await s.execute("wanderlust.room-status", row("S-13").arguments!);
    expect(embedded.status).toBe("ok");
    const rowsOut = (embedded.data as { rooms: Record<string, unknown>[] }).rooms;
    expect(rowsOut.map((x) => x.$row)).toEqual(["ok", "error"]);
    expect(rowsOut[1]).toMatchObject({ code: "agency-busy" });
    expect(embedded.degraded).toBeUndefined();
  });

  it("N-13 a price of the wrong type is a violation with reason contract_violation, and the bad value is not passed on", async () => {
    const bad = row("S-13").negative!.arguments!;
    const s = session();
    const result = await s.call("wanderlust_room-status", bad);
    expect(result.isError).toBe(true);
    expect(reasonOf(result._meta)).toBe("contract_violation");
    expect(result._meta?.[CONTRACT]).toMatchObject({ error: "contract_violation", capability: "wanderlust.room-status", missing: ["pricePerNight"] });
    expect(result.structuredContent).toBeUndefined();
    expect(textOf(result)).toMatch(/raw body withheld/);
    // The agency's wrong-typed price (a formatted string for this property) appears nowhere.
    const raw = (await rawPassthrough(`/v1/room-status?propertyId=${String(bad.propertyId)}&date=${String(bad.date)}`)) as { rows: { pricePerNight: { amount: string } }[] };
    expect(typeof raw.rows[0].pricePerNight).toBe("object"); // the agency really sends an object where a number is promised
    expect(JSON.stringify(result)).not.toContain(raw.rows[0].pricePerNight.amount);
    expect(await s.execute("wanderlust.room-status", bad)).toEqual({ status: "violation", missing: ["pricePerNight"] });
  });

  it("N-13 over the wire the client still reads the violation from _meta, not from structured content", async () => {
    const s = session();
    await s.withClient("none", async (client) => {
      const r = await client.callTool({ name: "wanderlust_room-status", arguments: row("S-13").negative!.arguments! });
      expect(r.isError).toBe(true);
      expect(r.structuredContent).toBeUndefined();
      expect(reasonOf(r._meta as Record<string, unknown>)).toBe("contract_violation");
    });
  });
});

describe("N-14 / AC-2.16: deletion is not a tool", () => {
  it("N-14 calling a tool named for deletion is answered unknown tool, and nothing reaches the agency", async () => {
    const s = session();
    for (const name of [row("S-14").tool!, "wanderlust_delete-booking", "wanderlust_delete-bookings"]) {
      const result = await s.call(name, { name: "Ana Pop" });
      expect(result.isError, name).toBe(true);
      expect(textOf(result), name).toContain("unknown tool");
    }
    const embedded = await s.execute("wanderlust.delete-guest-bookings", { name: "Ana Pop" });
    expect(embedded.status).toBe("error");
    expect(embedded.error).toContain("unknown capability");
    await s.withClient("A", async (client) => {
      const wire = await client.callTool({ name: "wanderlust_delete-booking", arguments: { name: "Ana Pop" } }).catch((e: Error) => e);
      const text = wire instanceof Error ? wire.message : JSON.stringify(wire);
      expect(text).toMatch(/unknown tool|not found|Unknown/i);
    });
    expect(s.spy.requests).toEqual([]);
  });
});

describe("AC-2.17: the list of negative ids covered is complete", () => {
  const source = readFileSync(resolve(SHOWCASE_DIR, "test/negatives.test.ts"), "utf8");
  const covered = new Set([...source.matchAll(/\bit\("(N-\d\d)\b/g)].map((m) => m[1]));
  const declared = rows.filter((r) => r.negative !== null).map((r) => r.negative!.id);

  it("every live scenario's negative is asserted in this file", () => {
    const live = rows.filter((r) => r.mode === "live").map((r) => r.negative!.id);
    expect(live).toEqual(Array.from({ length: 14 }, (_, i) => `N-${String(i + 1).padStart(2, "0")}`).filter((id) => id !== "N-10"));
    // N-10 does not exist (S-10 is the locked approval row); the other thirteen are covered here.
    expect([...covered].sort()).toEqual(live.slice().sort());
  });

  it("the recorded scenarios (fifteen to twenty-one) are deferred to the recorded-scenarios increment, and nothing else is missing", () => {
    const recorded = rows.filter((r) => r.mode === "recorded").map((r) => r.negative!.id);
    expect(recorded).toEqual(["N-15", "N-16", "N-17", "N-18", "N-19", "N-20", "N-21"]);
    const accounted = new Set([...covered, ...recorded]);
    expect([...accounted].sort()).toEqual(declared.slice().sort());
    for (const id of recorded) expect(covered.has(id), id).toBe(false);
    // Locked rows run nothing and carry no negative.
    expect(rows.filter((r) => r.mode === "locked").every((r) => r.negative === null)).toBe(true);
  });
});

describe("AC-2.19: the positive control: a raw passthrough leaks what the runtime withholds", () => {
  it("the raw search answer leaks the margin, and the same check that passes the runtime fails it", async () => {
    const raw = await rawPassthrough("/v1/stays/search", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ destination: "Lisbon" }),
    });
    const leaks = findLeaks(raw);
    expect(leaks.filter((l) => l.matched === "margin").length).toBeGreaterThan(0);
    expect(leaks.filter((l) => l.matched === "commission").length).toBeGreaterThan(0);
    expect(leaks.filter((l) => l.matched === "net").length).toBeGreaterThan(0);
    // The runtime's answer to the same kind of request, through the very same function:
    const { result } = await session().run(row("S-01"));
    expect(findLeaks(modelFacing(result))).toEqual([]);
  });

  it("the raw details answer leaks passport and phone at three or more nesting levels", async () => {
    const raw = await rawPassthrough("/v1/stays/ws-1001");
    const leaks = findLeaks(raw);
    for (const field of ["passport", "phone"]) {
      const depths = new Set(leaks.filter((l) => l.matched === field).map((l) => l.depth));
      expect(depths.size, field).toBeGreaterThanOrEqual(3);
    }
    expect(leaks.some((l) => l.kind === "value" && l.matched.includes("DEMO-PASS"))).toBe(true);
    expect(leaks.some((l) => l.matched === "description_html")).toBe(true);
    const { result } = await session().run(row("S-02"));
    expect(findLeaks(modelFacing(result))).toEqual([]);
  });

  it("the raw photo and page answers carry the undeclared hosts the runtime withholds", async () => {
    const photos = JSON.stringify(await rawPassthrough("/v1/stays/ws-1001/photos"));
    const pages = JSON.stringify(await rawPassthrough("/v1/stays/ws-1001/pages"));
    expect(photos).toContain("partner-photos.example");
    expect(pages).toContain("partner-hotels.example");
  });

  it("the DELETE endpoint still works on the backend, and no capability reaches it", async () => {
    // Called here through the raw double, not the runtime, and on a spy-less path: this is the only
    // DELETE in the suite, so the suite-wide "no DELETE" invariant (which watches the spy) stays meaningful.
    const response = await rawDelete("Ana Pop");
    expect(response.status).toBe(200);
    expect(registry().ir.tools.every((t) => t.connector?.rest?.method !== "DELETE")).toBe(true);
    expect(allRequests().filter((r) => r.method === "DELETE")).toEqual([]);
  });
});

function rawDelete(name: string): Promise<Response> {
  return handle(new Request(`http://api.showcase.example/v1/guests/${encodeURIComponent(name)}/bookings`, { method: "DELETE", headers: { authorization: `Bearer ${DEMO_KEY_A}` } }), { now: Date.now() });
}

describe("AC-2.20: hygiene of this increment's own files", () => {
  const files = ["negatives.test.ts", "denial-reasons.test.ts", "tool-list.test.ts", "negatives-support.ts"].map((f) => resolve(SHOWCASE_DIR, "test", f));
  // Generic shapes only: a planning-docs path, or a phrase that points at a non-public code host.
  const nonPublic = /docs\/(product|research|reviews|commercial)\/|\b(private|internal) (repo|repository)\b/i;
  const comparison = new RegExp(
    `\\b(${[["compe", "titor"], ["ver", "sus"], ["bet", "ter than"], ["cheap", "er than"], ["out", "perform"]].map((p) => p.join("")).join("|")})`,
    "i",
  );

  it("names no non-public repository or document, and compares with nobody", () => {
    for (const f of files) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(nonPublic);
      expect(src, f).not.toMatch(comparison);
    }
  });
});
