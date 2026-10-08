// `image` in the embedded SDK (issue #152): S-B14 (`execute()` withholds the same values as MCP and
// `verify`, and exposes `withheld`), the envelopes' indifference to an output field's type, and the
// extraction refusal.

import { describe, it, expect } from "vitest";
import type { IR, IRResourceRegistry, IRTool } from "@archstone/compiler";
import { ExtractionSchemaError } from "@archstone/emitter-support";
import { fromIR, type FetchLike, type ToolFormat } from "../src/index";

const IMG = "https://img.example.com";
const EVIL = "https://evil.example.net/a.jpg";

type PhotosKind = "image" | "string";

function ir(kind: PhotosKind, photosRequired = false): IR {
  const resources: IRResourceRegistry = {
    "shop.Stay": [
      { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "cover", required: false, type: { kind: "scalar", semantic: kind } },
      { name: "photos", required: photosRequired, type: { kind: "list", items: kind } },
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
        { name: "cover", path: "$.cover" },
        { name: "photos", path: "$.photos" },
      ],
    },
    ...(kind === "image" ? { origins: { images: [IMG] } } : {}),
  };
  return { version: "0", company: { id: "acme" }, tools: [tool], resources };
}

const respond = (row: Record<string, unknown>): FetchLike => async () => new Response(JSON.stringify({ results: [{ name: "Hotel", ...row }] }), { status: 200 });
const env = { API_URL: "https://api.example.com" };
const run = (i: IR, row: Record<string, unknown>) => fromIR(i).execute("shop.search", { q: "x" }, { env, fetchImpl: respond(row) });

describe("S-B14 (embedded): execute() withholds per item and exposes withheld", () => {
  it("degraded; the list is shortened in order; withheld names photos[1]; no member carries the value", async () => {
    const r = await run(ir("image"), { cover: `${IMG}/c.jpg`, photos: [`${IMG}/1.jpg`, EVIL, "https://IMG.example.com:443/3 x.jpg"] });
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ stays: [{ name: "Hotel", cover: `${IMG}/c.jpg`, photos: [`${IMG}/1.jpg`, `${IMG}/3%20x.jpg`] }] });
    expect(r.withheld).toEqual(["photos[1]"]);
    expect(r.degraded).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("a scalar cover and a list withhold together, each by its own name", async () => {
    const r = await run(ir("image"), { cover: EVIL, photos: [EVIL] });
    expect(r.status).toBe("degraded");
    expect(r.withheld).toEqual(["cover", "photos[0]"]);
    expect(r.data).toEqual({ stays: [{ name: "Hotel", photos: [] }] });
    expect(r.degraded).toEqual([]);
  });

  it("a required list with every item withheld is degraded and present, not a violation", async () => {
    const r = await run(ir("image", true), { cover: `${IMG}/c.jpg`, photos: [EVIL, EVIL] });
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ stays: [{ name: "Hotel", cover: `${IMG}/c.jpg`, photos: [] }] });
    expect(r.withheld).toEqual(["photos[0]", "photos[1]"]);
  });

  it("a clean result has no withheld member", async () => {
    const r = await run(ir("image"), { cover: `${IMG}/c.jpg`, photos: [`${IMG}/1.jpg`] });
    expect(r).toEqual({ status: "ok", data: { stays: [{ name: "Hotel", cover: `${IMG}/c.jpg`, photos: [`${IMG}/1.jpg`] }] } });
  });

  it("the same field typed string is forwarded untouched (the type is what makes it checked)", async () => {
    const r = await run(ir("string"), { cover: EVIL, photos: [EVIL] });
    expect(r.status).toBe("ok");
    expect(r.withheld).toBeUndefined();
  });

  it("a hand-written IR with an unmapped list: image output is refused, not passed through", async () => {
    const raw = ir("image");
    delete raw.tools[0].response;
    raw.tools[0].output = [{ name: "photos", required: false, type: { kind: "list", items: "image" } }];
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify({ photos: [EVIL] }), { status: 200 });
    const r = await fromIR(raw).execute("shop.search", { q: "x" }, { env, fetchImpl });
    expect(r.status).toBe("error");
    expect(r.data).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });
});

describe("the tool-definition envelopes are unchanged by an output image field", () => {
  const FORMATS: ToolFormat[] = ["anthropic", "openai-chat", "openai", "openai-responses", "gemini", "json-schema"];
  for (const format of FORMATS) {
    it(`${format}: byte-identical to the same tool with the fields typed string`, () => {
      expect(JSON.stringify(fromIR(ir("image")).tools(format))).toBe(JSON.stringify(fromIR(ir("string")).tools(format)));
    });
  }
});

describe("S-A9 (embedded surface): a resource containing image is not an extraction target", () => {
  it("extractor() refuses it with ExtractionSchemaError naming the field", () => {
    const archstone = fromIR(ir("image"));
    expect(() => archstone.extractor("shop.Stay", "anthropic")).toThrow(ExtractionSchemaError);
    expect(() => archstone.extractor("shop.Stay", "anthropic")).toThrow(/cover|photos/);
  });
});
