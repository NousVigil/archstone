// `web-page` in the embedded SDK (issue #141): S-B.18 (`execute()` exposes `withheld`) and S-C.4
// (the tool-definition envelopes carry an input schema only, so they are unchanged by an output
// field's type — while `execute()` still enforces the origin check).

import { describe, it, expect } from "vitest";
import type { IR, IRResourceRegistry, IRTool, SemanticType } from "@archstone/compiler";
import { ExtractionSchemaError } from "@archstone/emitter-support";
import { fromIR, type FetchLike, type ToolFormat } from "../src/index";

const EVIL = "https://evil.example.net/x";

function ir(listingType: SemanticType, listingRequired = false): IR {
  const resources: IRResourceRegistry = {
    "shop.Stay": [
      { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "listingUrl", required: listingRequired, type: { kind: "scalar", semantic: listingType } },
    ],
  };
  const tool: IRTool = {
    id: "shop.search",
    description: "Find stays.",
    effect: "read",
    provider: "store",
    policies: [],
    lifecycle: "stable",
    input: [{ name: "q", required: true, type: { kind: "scalar", semantic: "string" } }],
    output: [{ name: "stays", required: true, type: { kind: "collection", of: "shop.Stay" } }],
    connector: { type: "rest", rest: { baseUrl: "${API_URL}", method: "GET", path: "/search" } },
    response: {
      resource: "shop.Stay",
      field: "stays",
      collection: "$.results[*]",
      fields: [
        { name: "name", path: "$.name" },
        { name: "listingUrl", path: "$.url" },
      ],
    },
    ...(listingType === "web-page" ? { origins: { pages: ["https://www.example.com"] } } : {}),
  };
  return { version: "0", company: { id: "acme" }, tools: [tool], resources };
}

const respond = (...urls: unknown[]): FetchLike => async () =>
  new Response(JSON.stringify({ results: urls.map((url, i) => ({ name: `Hotel ${i}`, url })) }), { status: 200 });
const env = { API_URL: "https://api.example.com" };

describe("S-B.18: the embedded result exposes withheld", () => {
  it("degraded, data without the field, withheld names it — and no member carries the value", async () => {
    const archstone = fromIR(ir("web-page"));
    const r = await archstone.execute("shop.search", { q: "x" }, { env, fetchImpl: respond(EVIL) });
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ stays: [{ name: "Hotel 0" }] });
    expect(r.withheld).toEqual(["listingUrl"]);
    expect(r.degraded).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("a required withheld value is a violation carrying withheld, not a missing field", async () => {
    const r = await fromIR(ir("web-page", true)).execute("shop.search", { q: "x" }, { env, fetchImpl: respond(EVIL) });
    expect(r).toEqual({ status: "violation", missing: [], withheld: ["listingUrl"] });
  });

  it("a clean result has no withheld member, and carries the normalised href", async () => {
    const r = await fromIR(ir("web-page")).execute("shop.search", { q: "x" }, { env, fetchImpl: respond("https://WWW.example.com:443/s/1") });
    expect(r).toEqual({ status: "ok", data: { stays: [{ name: "Hotel 0", listingUrl: "https://www.example.com/s/1" }] } });
  });

  it("a hand-written IR with an unmapped web-page output is refused, not passed through", async () => {
    const raw = ir("web-page");
    delete raw.tools[0].response;
    raw.tools[0].output = [{ name: "listingUrl", required: false, type: { kind: "scalar", semantic: "web-page" } }];
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ listingUrl: EVIL }), { status: 200 });
    const r = await fromIR(raw).execute("shop.search", { q: "x" }, { env, fetchImpl });
    expect(r.status).toBe("error");
    expect(r.data).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });
});

describe("S-C.4: the tool-definition envelopes are unchanged by an output web-page field", () => {
  const FORMATS: ToolFormat[] = ["anthropic", "openai-chat", "openai", "openai-responses", "gemini", "json-schema"];

  for (const format of FORMATS) {
    it(`${format}: byte-identical to the same tool with the field typed string`, () => {
      const asWebPage = JSON.stringify(fromIR(ir("web-page")).tools(format));
      const asString = JSON.stringify(fromIR(ir("string")).tools(format));
      expect(asWebPage).toBe(asString);
      expect(asWebPage).not.toContain("listingUrl"); // an input schema only: the output is not there at all
    });
  }

  it("…while execute() still returns the checked, normalised data", async () => {
    const r = await fromIR(ir("web-page")).execute("shop.search", { q: "x" }, { env, fetchImpl: respond("https://www.example.com/a b", EVIL) });
    expect(r.data).toEqual({ stays: [{ name: "Hotel 0", listingUrl: "https://www.example.com/a%20b" }, { name: "Hotel 1" }] });
    expect(r.withheld).toEqual(["listingUrl"]);
  });
});

describe("S-C.6 (embedded surface): a resource containing web-page is not an extraction target", () => {
  it("extractor() refuses it with ExtractionSchemaError naming the field", () => {
    const archstone = fromIR(ir("web-page"));
    expect(() => archstone.extractor("shop.Stay", "anthropic")).toThrow(ExtractionSchemaError);
    expect(() => archstone.extractor("shop.Stay", "anthropic")).toThrow(/listingUrl/);
  });
});
