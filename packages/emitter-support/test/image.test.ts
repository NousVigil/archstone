// `image` in the shared response mapper (issue #152, S-B*), its MCP lowering (S-C1..C3) and its
// refusal as an extraction target (S-A9).
//
// `image` is the second origin-bound type: checked against `origins.images`, never against
// `origins.pages`. The one behavioural difference from `web-page` is the `list:` form, which
// withholds per item (`photos[2]`). MCP, the embedded `execute()` and `verify` all reach this
// through `applyResponseMapping`, which is why the scenarios are tested here, once.

import { describe, it, expect, vi, afterEach } from "vitest";
import http from "node:http";
import https from "node:https";
import { ORIGIN_BOUND_TYPES, type IRField, type IRResourceRegistry, type IRTool, type SemanticType } from "@archstone/compiler";
import { applyResponseMapping, contractViolationMessage, withheldNote } from "../src/mapping";
import { objectJsonSchema, extractionJsonSchema, ExtractionSchemaError } from "../src/lowering";
import { checkOrigin, allowedOrigins } from "../src/origins";

const IMG = "https://img.example.com";
const EVIL = "https://evil.example.net/a.jpg";
const ok = (n: number) => `${IMG}/h/${n}.jpg`;

const text = (name: string, required = true): IRField => ({ name, required, type: { kind: "scalar", semantic: "text" } });

/** A tool whose `extract:` fills the given output fields straight off the body root. */
function extractTool(output: IRField[], origins: IRTool["origins"] | null = { images: [IMG] }): IRTool {
  return {
    id: "shop.get",
    description: "",
    effect: "read",
    provider: "store",
    policies: [],
    lifecycle: "stable",
    input: [],
    output,
    connector: { type: "rest", rest: { method: "GET", path: "/x" } },
    extract: output.map((f) => ({ name: f.name, path: f.type.kind === "list" ? `$.${f.name}[*]` : `$.${f.name}` })),
    ...(origins ? { origins } : {}),
  };
}

const photosField = (required: boolean): IRField => ({ name: "photos", required, type: { kind: "list", items: "image" } });
const coverField = (required: boolean): IRField => ({ name: "cover", required, type: { kind: "scalar", semantic: "image" } });
const mapPhotos = (photos: unknown, required = false) => applyResponseMapping(extractTool([photosField(required)]), { photos }, {});
const mapCover = (cover: unknown, required = false) => applyResponseMapping(extractTool([coverField(required)]), { cover }, {});

describe("S-B1 / S-B2 / S-B3: scalar image", () => {
  it("S-B1: an on-origin value is returned, status ok", () => {
    const r = mapCover(ok(1));
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ cover: ok(1) });
  });

  it("S-B2: optional + off-origin → omitted, degraded, named in withheld, never the value", () => {
    const r = mapCover(EVIL);
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({});
    expect(r.withheld).toEqual(["cover"]);
    expect(r.degraded).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("S-B3: required + off-origin → violation, naming the field and never the value", () => {
    const r = mapCover(EVIL, true);
    expect(r.status).toBe("violation");
    expect(r.withheld).toEqual(["cover"]);
    const msg = contractViolationMessage("shop.get", r.missing ?? [], r.withheld);
    expect(msg).toContain("cover");
    expect(msg).not.toContain("evil.example.net");
  });
});

describe("S-B4 – S-B8: list: image withholds per item", () => {
  it("S-B4: [ok, ok, off, ok] → three items in original order, degraded, photos[2] named, no URL", () => {
    const r = mapPhotos([ok(0), ok(1), EVIL, ok(3)]);
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ photos: [ok(0), ok(1), ok(3)] });
    expect(r.withheld).toEqual(["photos[2]"]);
    expect(r.degraded).toBeUndefined();
    expect(JSON.stringify(r.withheld)).not.toContain("evil");
  });

  it("S-B4: kept items are the normalised hrefs", () => {
    expect(mapPhotos(["https://IMG.Example.com:443/a b.jpg"]).data).toEqual({ photos: ["https://img.example.com/a%20b.jpg"] });
  });

  it("S-B5: every item on-origin → all returned, ok", () => {
    const r = mapPhotos([ok(0), ok(1), ok(2)]);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ photos: [ok(0), ok(1), ok(2)] });
    expect(r.withheld).toBeUndefined();
  });

  it("S-B6: an optional list with every item off-origin → present, empty, degraded, each index named", () => {
    const r = mapPhotos([EVIL, EVIL, EVIL]);
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ photos: [] });
    expect(r.withheld).toEqual(["photos[0]", "photos[1]", "photos[2]"]);
  });

  it("S-B7: a required list the backend returns empty → present, empty, ok", () => {
    const r = mapPhotos([], true);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ photos: [] });
  });

  it("S-B8: a required list with every item off-origin → present, empty, degraded; not a violation", () => {
    const r = mapPhotos([EVIL, EVIL], true);
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ photos: [] });
    expect(r.withheld).toEqual(["photos[0]", "photos[1]"]);
    expect(r.missing).toBeUndefined();
  });

  it("item names never enter degraded, and the index is the original position", () => {
    const r = mapPhotos([EVIL, ok(1), EVIL]);
    expect(r.withheld).toEqual(["photos[0]", "photos[2]"]);
    expect(r.degraded).toBeUndefined();
  });
});

describe("S-B9 / S-B15: nesting", () => {
  const resources: IRResourceRegistry = {
    Room: [text("name"), { name: "cover", required: false, type: { kind: "scalar", semantic: "image" } }, { name: "photos", required: true, type: { kind: "list", items: "image" } }],
    Host: [text("name"), { name: "avatar", required: false, type: { kind: "scalar", semantic: "image" } }],
    Stay: [text("name"), { name: "host", required: false, type: { kind: "resource", name: "Host" } }, { name: "rooms", required: false, type: { kind: "collection", of: "Room" } }],
  };
  const tool = (resource: string, field: string, kind: "resource" | "collection", collection?: string): IRTool => ({
    ...extractTool([{ name: field, required: true, type: kind === "resource" ? { kind: "resource", name: resource } : { kind: "collection", of: resource } }]),
    extract: undefined,
    response: { resource, field, ...(collection ? { collection } : {}), fields: resources[resource].map((f) => ({ name: f.name, path: `$.${f.name}` })) },
  });

  it("S-B9: an image in a list of objects (collection rows) is withheld at that level", () => {
    const body = { results: [{ name: "A", cover: EVIL, photos: [ok(0)] }, { name: "B", cover: ok(2), photos: [ok(1)] }] };
    const r = applyResponseMapping(tool("Room", "rooms", "collection", "$.results[*]"), body, resources);
    expect(r.status).toBe("degraded");
    expect(r.withheld).toEqual(["cover"]);
    expect(r.data).toEqual({ rooms: [{ name: "A", photos: [ok(0)] }, { name: "B", cover: ok(2), photos: [ok(1)] }] });
  });

  it("the note names the ORIGINAL index and says the list was shortened, so it cannot be read as a returned position", () => {
    const r = mapPhotos([ok(1), ok(2), ok(3), EVIL, ok(5)]);
    expect(r.data).toEqual({ photos: [ok(1), ok(2), ok(3), ok(5)] });
    expect(r.withheldAt).toEqual([{ path: "photos[3]", list: "photos", kept: 4 }]);
    expect(withheldNote(r.withheldAt ?? [])).toBe(
      "note: withheld — value(s) outside the declared origins, at these places in this result (a number is the item's position in the provider's list, before any removal): photos[3] (removed; the list now has 4 items). Every other link and image returned passed the origin check.",
    );
  });

  it("several removed items of one list share one clause; a list inside a collection row carries the row index", () => {
    expect(withheldNote([{ path: "photos[0]", list: "photos", kept: 1 }, { path: "photos[2]", list: "photos", kept: 1 }])).toContain(
      "photos[0], photos[2] (removed; the list now has 1 item)",
    );
    const body = { results: [{ name: "A", photos: [ok(0), ok(1)] }, { name: "B", photos: [ok(0), EVIL] }] };
    const r = applyResponseMapping(tool("Room", "rooms", "collection", "$.results[*]"), body, resources);
    expect(r.withheldAt).toEqual([{ path: "rooms[1].photos[1]", list: "rooms[1].photos", kept: 1 }]);
  });

  it("a list inside a nested collection is located with the nested row's index too", () => {
    const body = { name: "S", rooms: [{ name: "R0", photos: [ok(0)] }, { name: "R1", photos: [EVIL, ok(1)] }] };
    const r = applyResponseMapping(tool("Stay", "stay", "resource"), body, resources);
    expect(r.withheldAt).toEqual([{ path: "stay.rooms[1].photos[0]", list: "stay.rooms[1].photos", kept: 1 }]);
  });

  it("S-B9: an image in a nested object is withheld at that level (optional → the field only)", () => {
    const r = applyResponseMapping(tool("Stay", "stay", "resource"), { name: "S", host: { name: "H", avatar: EVIL } }, resources);
    expect(r.status).toBe("degraded");
    expect(r.withheld).toEqual(["host.avatar"]);
    expect(r.data).toEqual({ stay: { name: "S", host: { name: "H" } } });
  });

  it("S-B9: a list inside a nested resource names the item with its dotted path", () => {
    const body = { name: "S", rooms: [{ name: "R", photos: [ok(0), EVIL] }] };
    const r = applyResponseMapping(tool("Stay", "stay", "resource"), body, resources);
    expect(r.status).toBe("degraded");
    expect(r.withheld).toEqual(["rooms.photos[1]"]);
    expect(r.data).toEqual({ stay: { name: "S", rooms: [{ name: "R", photos: [ok(0)] }] } });
  });

  it("S-B15: a list inside a collection row is named without a row index, once however many rows", () => {
    const body = { results: [{ name: "A", photos: [ok(0), ok(1), EVIL] }, { name: "B", photos: [ok(0), ok(1), EVIL] }] };
    const r = applyResponseMapping(tool("Room", "rooms", "collection", "$.results[*]"), body, resources);
    expect(r.withheld).toEqual(["photos[2]"]);
    expect((r.data?.rooms as { photos: string[] }[]).map((row) => row.photos)).toEqual([[ok(0), ok(1)], [ok(0), ok(1)]]);
  });

  it("a required list inside a collection never fails a row on an off-origin item", () => {
    const body = { results: [{ name: "A", photos: [EVIL] }] };
    const r = applyResponseMapping(tool("Room", "rooms", "collection", "$.results[*]"), body, resources);
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ rooms: [{ name: "A", photos: [] }] });
  });
});

describe("S-B10 – S-B12: origin matching, over every origin-bound type", () => {
  // The battery runs over the table, so a third origin-bound type is a row, not a new test file.
  for (const [semantic, list] of Object.entries(ORIGIN_BOUND_TYPES) as [SemanticType, "pages" | "images"][]) {
    describe(`${semantic} (origins.${list})`, () => {
      const allowed = allowedOrigins({ [list]: ["https://img.example.com"] }, list);
      const rejected = (v: unknown) => expect(checkOrigin(v, allowed)).toEqual({ ok: false });

      it("S-B10: http:, data:, relative, empty, userinfo and non-string values are off-origin", () => {
        for (const v of ["http://img.example.com/a.jpg", "data:image/png;base64,AAAA", "/img/1.jpg", "", "//img.example.com/a.jpg", 42, null, undefined, {}, ["https://img.example.com/a.jpg"], true]) rejected(v);
        rejected("https://user:pw@img.example.com/a.jpg");
      });

      it("S-B11: a lookalike host is compared on the parsed origin, not a prefix", () => {
        rejected("https://img.example.com.evil.net/a.jpg");
        rejected("https://img.example.com@evil.net/a.jpg");
        rejected("https://img.example.com:8443/a.jpg");
      });

      it("S-B12: the host is case-insensitive and the default port elided", () => {
        expect(checkOrigin("https://IMG.EXAMPLE.com/a.jpg", allowed)).toEqual({ ok: true, href: "https://img.example.com/a.jpg" });
        expect(checkOrigin("https://img.example.com:443/a.jpg", allowed)).toEqual({ ok: true, href: "https://img.example.com/a.jpg" });
      });
    });
  }

  it("S-B10 / S-B11 / S-B12 through the mapper: list items are judged by the same check", () => {
    const r = mapPhotos(["http://img.example.com/1.jpg", "https://img.example.com.evil.net/a.jpg", "https://img.example.com@evil.net/a.jpg", 7, "", "/rel.jpg", "https://IMG.EXAMPLE.com/a.jpg"]);
    expect(r.data).toEqual({ photos: ["https://img.example.com/a.jpg"] });
    expect(r.withheld).toEqual(["photos[0]", "photos[1]", "photos[2]", "photos[3]", "photos[4]", "photos[5]"]);
  });
});

describe("S-B13: the mapper performs no I/O", () => {
  afterEach(() => vi.restoreAllMocks());

  it("no request is made to any image URL", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const spies = [vi.spyOn(http, "request"), vi.spyOn(http, "get"), vi.spyOn(https, "request"), vi.spyOn(https, "get")];
    mapPhotos([ok(0), EVIL]);
    mapCover(ok(1));
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const s of spies) expect(s).not.toHaveBeenCalled();
  });
});

describe("S-B16: names are bounded", () => {
  it("thousands of off-origin items name at most 25 indices plus one overflow entry, and no value", () => {
    const r = mapPhotos(Array.from({ length: 5000 }, (_, i) => `https://evil.example.net/${i}.jpg`));
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ photos: [] });
    expect(r.withheld).toHaveLength(26);
    expect(r.withheld?.slice(0, 2)).toEqual(["photos[0]", "photos[1]"]);
    expect(r.withheld?.[24]).toBe("photos[24]");
    expect(r.withheld?.[25]).toBe("photos[…]");
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("exactly 25 off-origin items produce no overflow entry", () => {
    expect(mapPhotos(Array.from({ length: 25 }, () => EVIL)).withheld).toHaveLength(25);
  });
});

describe("S-B17: the two origin lists never substitute for each other", () => {
  const output: IRField[] = [
    { name: "cover", required: false, type: { kind: "scalar", semantic: "image" } },
    { name: "page", required: false, type: { kind: "scalar", semantic: "web-page" } },
  ];
  const origins = { pages: ["https://www.example.com"], images: [IMG] };
  const run = (body: unknown, o: IRTool["origins"] = origins) => applyResponseMapping(extractTool(output, o), body, {});

  it("a page-host URL in an image field and an image-CDN URL in a web-page field are both withheld", () => {
    const r = run({ cover: "https://www.example.com/a.jpg", page: `${IMG}/p` });
    expect(r.withheld).toEqual(["cover", "page"]);
    expect(r.data).toEqual({});
  });

  it("each URL on its own list passes", () => {
    const r = run({ cover: `${IMG}/a.jpg`, page: "https://www.example.com/p" });
    expect(r.status).toBe("ok");
  });

  it("with only the other list declared, every value is withheld (no fallback, no sharing)", () => {
    expect(run({ cover: `${IMG}/a.jpg` }, { pages: ["https://www.example.com"] }).withheld).toEqual(["cover"]);
    expect(run({ page: "https://www.example.com/p" }, { images: [IMG] }).withheld).toEqual(["page"]);
  });

  it("a hand-written IR with an image field and no origins at all withholds everything (fail closed)", () => {
    const r = applyResponseMapping(extractTool([photosField(false)], null), { photos: [ok(0), ok(1)] }, {});
    expect(r.withheld).toEqual(["photos[0]", "photos[1]"]);
    expect(r.data).toEqual({ photos: [] });
  });
});

describe("S-B18: a non-array where list: image is declared", () => {
  // Through a resource, so the provider's value reaches the mapper as sent (an `extract:` list
  // field gathers matches into an array itself).
  const resources = (required: boolean): IRResourceRegistry => ({ Room: [text("name"), photosField(required)] });
  const mapRoom = (photos: unknown, required: boolean) =>
    applyResponseMapping(
      {
        ...extractTool([{ name: "room", required: true, type: { kind: "resource", name: "Room" } }]),
        extract: undefined,
        response: { resource: "Room", field: "room", fields: [{ name: "name", path: "$.name" }, { name: "photos", path: "$.photos" }] },
      },
      { name: "R", photos },
      resources(required),
    );

  it("is withheld whole; an optional field is omitted", () => {
    for (const bad of ["https://img.example.com/a.jpg", { 0: ok(0) }, 5, true]) {
      const r = mapRoom(bad, false);
      expect(r.status).toBe("degraded");
      expect(r.data).toEqual({ room: { name: "R" } });
      expect(r.withheld).toEqual(["photos"]);
    }
  });

  it("a required one is a violation", () => {
    const r = mapRoom("https://img.example.com/a.jpg", true);
    expect(r.status).toBe("violation");
    expect(r.withheld).toEqual(["photos"]);
  });
});

describe("S-B19: a list of a non-origin type is unchanged (all or nothing)", () => {
  const stringList = (items: unknown, required = false) =>
    applyResponseMapping(extractTool([{ name: "tags", required, type: { kind: "list", items: "string" } }], null), { tags: items }, {});

  it("a non-string item makes the whole optional list absent, degraded", () => {
    const r = stringList(["a", { x: 1 }, "c"]);
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({});
    expect(r.withheld).toBeUndefined();
  });

  it("and a required one a violation", () => {
    expect(stringList(["a", { x: 1 }], true).status).toBe("violation");
  });

  it("a clean list passes untouched", () => {
    expect(stringList(["a", "b"]).data).toEqual({ tags: ["a", "b"] });
  });
});

describe("S-C1 / S-C2 / S-C3: MCP lowering", () => {
  const props = (fields: IRField[]) => objectJsonSchema(fields).properties as Record<string, Record<string, unknown>>;

  it("S-C1: a scalar image is a uri-format string with no pattern", () => {
    const p = props([{ ...coverField(true), description: "Front picture" }]).cover;
    expect(p).toMatchObject({ type: "string", format: "uri" });
    expect(p).not.toHaveProperty("pattern");
  });

  it("S-C2: a list: image is an array of uri strings, no pattern, no minItems", () => {
    const p = props([photosField(true)]).photos;
    expect(p.type).toBe("array");
    expect(p.items).toEqual({ type: "string", format: "uri" });
    expect(p).not.toHaveProperty("minItems");
    expect(JSON.stringify(p)).not.toContain("pattern");
  });

  it("S-C3: with no authored description the property says it is an image URL to show, not to fetch; on the array, never on items", () => {
    const scalar = props([coverField(false)]).cover;
    expect(scalar.description).toMatch(/image URL/);
    expect(scalar.description).toMatch(/not|Do not/i);
    expect(scalar.description).toMatch(/fetch/);
    const list = props([photosField(false)]).photos;
    expect(list.description).toBe(scalar.description);
    expect(list.items).not.toHaveProperty("description");
  });

  it("S-C3: an authored description wins", () => {
    expect(props([{ ...coverField(false), description: "Hero shot" }]).cover.description).toBe("Hero shot");
    expect(props([{ ...photosField(false), description: "Gallery" }]).photos.description).toBe("Gallery");
  });

  it("a collection resource's image fields lower the same way", () => {
    const resources: IRResourceRegistry = { Room: [text("name"), photosField(false)] };
    const schema = objectJsonSchema([{ name: "rooms", required: true, type: { kind: "collection", of: "Room" } }], resources);
    const items = (schema.properties as Record<string, { items: { properties: Record<string, Record<string, unknown>> } }>).rooms.items;
    expect(items.properties.photos.items).toEqual({ type: "string", format: "uri" });
  });
});

describe("S-A9: image is not an extraction target", () => {
  it("an image or list: image field makes the extraction schema throw, naming the field", () => {
    for (const f of [coverField(true), photosField(true)]) {
      expect(() => extractionJsonSchema([f])).toThrow(ExtractionSchemaError);
      expect(() => extractionJsonSchema([f])).toThrow(new RegExp(`field '${f.name}' is of type image`));
    }
  });

  it("the check reaches a field inside a resource", () => {
    const resources: IRResourceRegistry = { Room: [photosField(false)] };
    expect(() => extractionJsonSchema([{ name: "room", required: true, type: { kind: "resource", name: "Room" } }], resources)).toThrow(ExtractionSchemaError);
  });
});
