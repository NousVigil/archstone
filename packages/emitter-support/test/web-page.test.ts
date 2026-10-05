// `web-page` in the shared response mapper (issue #141, S-B.*), plus its MCP `outputSchema`
// lowering (S-C.1) and the fingerprint's indifference to it (S-D.6).
//
// Every value whose declared type is origin-bound is checked against the tool's declared
// `origins.pages`; a passing value leaves as its normalised href, a failing one is absent and the
// existing required-ness rule decides. MCP, the embedded `execute()` and `verify` all reach this
// through `applyResponseMapping`, which is why these scenarios are tested here, once.

import { describe, it, expect } from "vitest";
import { fingerprintShape, type IRField, type IRResourceRegistry, type IRTool } from "@archstone/compiler";
import { applyResponseMapping, contractViolationMessage, withheldNote, passThroughRefusal } from "../src/mapping";
import { objectJsonSchema } from "../src/lowering";
import { checkOrigin, normaliseOrigin, allowedOrigins } from "../src/origins";

const EVIL = "https://evil.example.net/x";

function stayResources(listingRequired: boolean): IRResourceRegistry {
  return {
    Stay: [
      { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "listingUrl", required: listingRequired, type: { kind: "scalar", semantic: "web-page" } },
    ],
  };
}

/** A tool mapping a single Stay object (no collection) at the body root. */
function singleTool(pages: string[] = ["https://www.example.com"]): IRTool {
  return {
    id: "shop.get",
    description: "",
    effect: "read",
    provider: "store",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [{ name: "stay", required: true, type: { kind: "resource", name: "Stay" } }],
    connector: { type: "rest", rest: { method: "GET", path: "/stay" } },
    response: { resource: "Stay", field: "stay", fields: [{ name: "name", path: "$.name" }, { name: "listingUrl", path: "$.url" }] },
    origins: { pages },
  };
}

/** A tool mapping a collection of Stay rows. */
function collectionTool(onError = false): IRTool {
  const t = singleTool();
  t.output = [{ name: "stays", required: true, type: { kind: "collection", of: "Stay" } }];
  t.response = { ...t.response!, field: "stays", collection: "$.results[*]" };
  if (onError) t.response.onError = { errorResource: "RowError", when: { path: "$.error", exists: true } };
  return t;
}

const mapOne = (value: unknown, opts?: { required?: boolean; pages?: string[] }) =>
  applyResponseMapping(singleTool(opts?.pages), { name: "Hotel A", url: value }, stayResources(opts?.required ?? false));

describe("S-B.1 – S-B.3: an on-origin value passes, normalised", () => {
  it("S-B.1: an on-origin value passes; status ok", () => {
    const r = mapOne("https://www.example.com/stays/1234");
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ stay: { name: "Hotel A", listingUrl: "https://www.example.com/stays/1234" } });
  });

  it("S-B.2: the emitted value is the normalised href", () => {
    const r = mapOne("https://WWW.Example.com:443/stays/1234");
    expect(r.status).toBe("ok");
    expect((r.data?.stay as Record<string, unknown>).listingUrl).toBe("https://www.example.com/stays/1234");
  });

  it("S-B.3: any path on the right origin is allowed — the origin is the guarantee, not the path", () => {
    const r = mapOne("https://www.example.com/redirect?to=somewhere-else");
    expect(r.status).toBe("ok");
    expect((r.data?.stay as Record<string, unknown>).listingUrl).toBe("https://www.example.com/redirect?to=somewhere-else");
  });
});

describe("S-B.4 / S-B.5: an off-origin value is withheld; required-ness decides", () => {
  it("S-B.4: optional → degraded, field absent, named in withheld and NOT in degraded", () => {
    const r = mapOne(EVIL);
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ stay: { name: "Hotel A" } });
    expect(r.withheld).toEqual(["listingUrl"]);
    expect(r.degraded).toBeUndefined();
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("S-B.5: required → violation, no data, named in withheld", () => {
    const r = mapOne(EVIL, { required: true });
    expect(r.status).toBe("violation");
    expect(r.data).toBeUndefined();
    expect(r.withheld).toEqual(["listingUrl"]);
    expect(r.missing).toEqual([]);
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("a tool with no declared origins withholds every value (fail closed)", () => {
    const tool = singleTool();
    delete tool.origins;
    const r = applyResponseMapping(tool, { name: "Hotel A", url: "https://www.example.com/x" }, stayResources(false));
    expect(r.withheld).toEqual(["listingUrl"]);
  });

  it("an absent or null optional web-page value is ordinary degradation, not withheld", () => {
    const r = applyResponseMapping(singleTool(), { name: "Hotel A", url: null }, stayResources(false));
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["listingUrl"]);
    expect(r.withheld).toBeUndefined();
  });
});

describe("S-B.9: the violation message names the field, says why, and never echoes the value", () => {
  it("names the field as withheld (outside the declared origins), not as missing", () => {
    const r = mapOne(EVIL, { required: true });
    const msg = contractViolationMessage("shop.get", r.missing ?? [], r.withheld);
    expect(msg).toContain("listingUrl");
    expect(msg).toContain("outside the declared origins");
    expect(msg).toContain("withheld");
    expect(msg).not.toContain("missing required field");
    expect(msg).not.toContain("evil.example.net");
  });

  it("names both, each as what it is, when one field is missing and another withheld", () => {
    expect(contractViolationMessage("shop.get", ["name"], ["listingUrl"])).toBe(
      "contract violation: capability 'shop.get' — provider response is missing required field(s): name; and carries a value outside the declared origins in field(s): listingUrl (withheld). Declared output shape not met; raw body withheld.",
    );
  });

  it("is byte-identical to the shipped text when nothing is withheld", () => {
    expect(contractViolationMessage("shop.get", ["name"])).toBe(
      "contract violation: capability 'shop.get' — provider response is missing required field(s): name. Declared output shape not met; raw body withheld.",
    );
    expect(contractViolationMessage("shop.get", ["name"], [])).toBe(contractViolationMessage("shop.get", ["name"]));
  });

  it("the model-facing note for an optional withheld field names fields only", () => {
    expect(withheldNote(["listingUrl"])).toBe("note: field(s) withheld — value outside the declared origins: listingUrl");
  });
});

describe("S-B.10 – S-B.12: conformance cases", () => {
  const ORIGIN = ["https://www.example-listings.com"];

  it("S-B.10: each conformance case is withheld, and the status is degraded", () => {
    const cases: unknown[] = [
      "https://www.example-listings.com.evil.net/x", // lookalike host
      "https://www.example-listings.com@evil.net/x", // userinfo
      "http://www.example-listings.com/x", // scheme
      "https://www.example-listings.com:8443/x", // port
      "//www.example-listings.com/x", // protocol-relative
      "/stays/1234", // relative
      "javascript:alert(1)",
      "data:text/html,x",
      "", // empty string
      42, // non-string
    ];
    for (const value of cases) {
      const r = mapOne(value, { pages: ORIGIN });
      expect({ value, status: r.status, withheld: r.withheld }).toEqual({ value, status: "degraded", withheld: ["listingUrl"] });
      expect(r.data).toEqual({ stay: { name: "Hotel A" } });
    }
  });

  it("further cases: userinfo on the declared host itself, an object, an array, a boolean", () => {
    for (const value of ["https://user:pw@www.example-listings.com/x", { href: "https://www.example-listings.com/x" }, ["https://www.example-listings.com/x"], true]) {
      expect(mapOne(value, { pages: ORIGIN }).withheld).toEqual(["listingUrl"]);
    }
  });

  it("S-B.11: an upper-case host passes (emitted lower-cased); a trailing-dot host is withheld", () => {
    const upper = mapOne("https://WWW.EXAMPLE-LISTINGS.COM/x", { pages: ORIGIN });
    expect(upper.status).toBe("ok");
    expect((upper.data?.stay as Record<string, unknown>).listingUrl).toBe("https://www.example-listings.com/x");

    const dotted = mapOne("https://www.example-listings.com./x", { pages: ORIGIN });
    expect(dotted.status).toBe("degraded");
    expect(dotted.withheld).toEqual(["listingUrl"]);
  });

  it("S-B.12: an IDN origin compares after normalisation", () => {
    const r = mapOne("https://xn--bcher-kva.example/x", { pages: ["https://bücher.example"] });
    expect(r.status).toBe("ok");
    expect((r.data?.stay as Record<string, unknown>).listingUrl).toBe("https://xn--bcher-kva.example/x");
    // …and the other way round: a Unicode value against a punycode declaration.
    expect(mapOne("https://bücher.example/x", { pages: ["https://xn--bcher-kva.example"] }).status).toBe("ok");
  });
});

describe("S-B.13 – S-B.16: every place a web-page value can be", () => {
  it("S-B.13: a web-page field inside a nested resource value is checked and withheld", () => {
    const resources: IRResourceRegistry = {
      Stay: [
        { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
        { name: "host", required: false, type: { kind: "resource", name: "Host" } },
      ],
      Host: [
        { name: "displayName", required: true, type: { kind: "scalar", semantic: "text" } },
        { name: "profileUrl", required: false, type: { kind: "scalar", semantic: "web-page" } },
      ],
    };
    const tool = singleTool();
    tool.response!.fields = [{ name: "name", path: "$.name" }, { name: "host", path: "$.host" }];
    const off = applyResponseMapping(tool, { name: "A", host: { displayName: "Ana", profileUrl: EVIL } }, resources);
    expect(off.status).toBe("degraded");
    expect(off.withheld).toEqual(["host.profileUrl"]);
    expect(off.data).toEqual({ stay: { name: "A", host: { displayName: "Ana" } } });
    expect(JSON.stringify(off)).not.toContain("evil.example.net");

    const on = applyResponseMapping(tool, { name: "A", host: { displayName: "Ana", profileUrl: "https://WWW.example.com/u/1" } }, resources);
    expect(on.status).toBe("ok");
    expect(on.data).toEqual({ stay: { name: "A", host: { displayName: "Ana", profileUrl: "https://www.example.com/u/1" } } });

    // A required web-page inside a nested value is a violation, as a required one at the top is.
    resources.Host[1] = { ...resources.Host[1], required: true };
    const required = applyResponseMapping(tool, { name: "A", host: { displayName: "Ana", profileUrl: EVIL } }, resources);
    expect(required.status).toBe("violation");
    expect(required.withheld).toEqual(["host.profileUrl"]);
  });

  it("a nested collection inside a resource value is walked row by row, at any depth", () => {
    const resources: IRResourceRegistry = {
      Stay: [
        { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
        { name: "rooms", required: false, type: { kind: "collection", of: "Room" } },
      ],
      Room: [
        { name: "label", required: true, type: { kind: "scalar", semantic: "text" } },
        { name: "page", required: false, type: { kind: "scalar", semantic: "web-page" } },
        { name: "sub", required: false, type: { kind: "resource", name: "Room" } }, // self-referential
      ],
    };
    const tool = singleTool();
    tool.response!.fields = [{ name: "name", path: "$.name" }, { name: "rooms", path: "$.rooms" }];
    const body = {
      name: "A",
      rooms: [
        { label: "1", page: "https://www.example.com/r/1" },
        { label: "2", page: EVIL, sub: { label: "2a", page: "https://evil.example.net/deeper" } },
      ],
    };
    const r = applyResponseMapping(tool, body, resources);
    expect(r.status).toBe("degraded");
    expect(r.withheld?.sort()).toEqual(["rooms.page", "rooms.sub.page"]);
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
    expect((r.data?.stay as { rooms: unknown[] }).rooms).toEqual([
      { label: "1", page: "https://www.example.com/r/1" },
      { label: "2", sub: { label: "2a" } },
    ]);
  });

  it("S-B.14: every row of a collection is checked; only the off-origin row loses the field", () => {
    const body = {
      results: [
        { name: "A", url: "https://www.example.com/a" },
        { name: "B", url: EVIL },
        { name: "C", url: "https://www.example.com/c" },
      ],
    };
    const r = applyResponseMapping(collectionTool(), body, stayResources(false));
    expect(r.status).toBe("degraded");
    expect(r.withheld).toEqual(["listingUrl"]);
    expect(r.data).toEqual({
      stays: [
        { name: "A", listingUrl: "https://www.example.com/a" },
        { name: "B" },
        { name: "C", listingUrl: "https://www.example.com/c" },
      ],
    });
  });

  it("S-B.15: a required off-origin row without onError fails the whole response", () => {
    const body = { results: [{ name: "A", url: "https://www.example.com/a" }, { name: "B", url: EVIL }] };
    const r = applyResponseMapping(collectionTool(), body, stayResources(true));
    expect(r.status).toBe("violation");
    expect(r.data).toBeUndefined();
    expect(r.withheld).toEqual(["listingUrl"]);
  });

  it("with onError, a required off-origin row fails only its own row, and is named per row", () => {
    const resources = { ...stayResources(true), RowError: [{ name: "error", required: true, type: { kind: "scalar", semantic: "text" } } as IRField] };
    const body = { results: [{ name: "A", url: "https://www.example.com/a" }, { name: "B", url: EVIL }] };
    const r = applyResponseMapping(collectionTool(true), body, resources);
    expect(r.status).toBe("degraded");
    expect(r.withheld).toEqual(["listingUrl"]);
    expect(r.rowViolations).toEqual([{ index: 1, missing: [], withheld: ["listingUrl"] }]);
    expect(r.data).toEqual({ stays: [{ $row: "ok", name: "A", listingUrl: "https://www.example.com/a" }] });
  });

  it("an error row's own web-page field is checked against the same origins", () => {
    const resources: IRResourceRegistry = {
      ...stayResources(false),
      RowError: [
        { name: "error", required: true, type: { kind: "scalar", semantic: "text" } },
        { name: "helpUrl", required: false, type: { kind: "scalar", semantic: "web-page" } },
      ],
    };
    const body = { results: [{ error: "sold out", helpUrl: EVIL }] };
    const r = applyResponseMapping(collectionTool(true), body, resources);
    expect(r.withheld).toEqual(["helpUrl"]);
    expect(r.data).toEqual({ stays: [{ $row: "error", error: "sold out" }] });
    expect(JSON.stringify(r)).not.toContain("evil.example.net");
  });

  it("S-B.16: extract: fields are checked — off-origin withheld, on-origin normalised", () => {
    const tool: IRTool = {
      ...singleTool(),
      output: [{ name: "pageUrl", required: false, type: { kind: "scalar", semantic: "web-page" } }],
      response: undefined,
      extract: [{ name: "pageUrl", path: "$.links.page" }],
    };
    const off = applyResponseMapping(tool, { links: { page: EVIL } }, {});
    expect(off.status).toBe("degraded");
    expect(off.withheld).toEqual(["pageUrl"]);
    expect(off.data).toEqual({});

    const on = applyResponseMapping(tool, { links: { page: "https://www.example.com:443/p" } }, {});
    expect(on.status).toBe("ok");
    expect(on.data).toEqual({ pageUrl: "https://www.example.com/p" });

    tool.output[0] = { ...tool.output[0], required: true };
    const required = applyResponseMapping(tool, { links: { page: EVIL } }, {});
    expect(required.status).toBe("violation");
    expect(required.withheld).toEqual(["pageUrl"]);
  });

  it("a hand-written `list` of web-page items is all or nothing", () => {
    const tool: IRTool = {
      ...singleTool(),
      output: [{ name: "pages", required: false, type: { kind: "list", items: "web-page" } }],
      response: undefined,
      extract: [{ name: "pages", path: "$.pages[*]" }],
    };
    expect(applyResponseMapping(tool, { pages: ["https://www.example.com/a", EVIL] }, {}).withheld).toEqual(["pages"]);
    expect(applyResponseMapping(tool, { pages: ["https://WWW.example.com/a"] }, {}).data).toEqual({ pages: ["https://www.example.com/a"] });
  });

  it("S-B.17: the guarantee covers typed fields only — a URL inside a text field is passed through unchanged", () => {
    const resources: IRResourceRegistry = {
      Stay: [
        { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
        { name: "listingUrl", required: false, type: { kind: "scalar", semantic: "web-page" } },
      ],
    };
    const text = "Book at https://evil.example.net today";
    const r = applyResponseMapping(singleTool(), { name: text }, resources);
    expect((r.data?.stay as Record<string, unknown>).name).toBe(text);
  });
});

describe("S-B.19: results without a withheld value gain no member", () => {
  it("an ok mapping and a degraded one have no withheld key at all", () => {
    expect("withheld" in mapOne("https://www.example.com/a")).toBe(false);
    expect("withheld" in applyResponseMapping(singleTool(), { name: "A" }, stayResources(false))).toBe(false);
    expect("withheld" in applyResponseMapping(singleTool(), { url: "https://www.example.com/a" }, stayResources(false))).toBe(false); // violation: name missing
  });

  it("a tool with no origin-bound field maps to the identical result object it always did", () => {
    const resources: IRResourceRegistry = { Stay: [{ name: "name", required: true, type: { kind: "scalar", semantic: "text" } }, { name: "nested", required: false, type: { kind: "resource", name: "Inner" } }], Inner: [{ name: "x", required: false, type: { kind: "scalar", semantic: "text" } }] };
    const tool = singleTool();
    delete tool.origins;
    tool.response!.fields = [{ name: "name", path: "$.name" }, { name: "nested", path: "$.nested" }];
    const nested = { x: "y", undeclared: 1 };
    const r = applyResponseMapping(tool, { name: "A", nested }, resources);
    expect(r).toEqual({ status: "ok", data: { stay: { name: "A", nested } } });
    expect((r.data?.stay as Record<string, unknown>).nested).toBe(nested); // copied by reference, as before
  });
});

describe("passThroughRefusal: the runtime floor for a hand-written IR", () => {
  it("refuses a pass-through tool whose output reaches web-page, naming the capability and no value", () => {
    const tool: IRTool = { ...singleTool(), response: undefined };
    expect(passThroughRefusal(tool, stayResources(false))).toMatch(/capability 'shop.get'/);
  });

  it("allows a mapped tool, and a pass-through tool with no origin-bound output", () => {
    expect(passThroughRefusal(singleTool(), stayResources(false))).toBeUndefined();
    const plain: IRTool = { ...singleTool(), response: undefined, output: [{ name: "n", required: true, type: { kind: "scalar", semantic: "text" } }] };
    expect(passThroughRefusal(plain, {})).toBeUndefined();
  });
});

describe("origins.ts primitives", () => {
  it("normaliseOrigin accepts a bare https origin and nothing else", () => {
    expect(normaliseOrigin("https://WWW.Example.com:443")).toBe("https://www.example.com");
    expect(normaliseOrigin("https://bücher.example")).toBe("https://xn--bcher-kva.example");
    for (const bad of ["http://www.example.com", "https://www.example.com/x", "https://u@www.example.com", "https://www.example.com?q", "www.example.com"]) {
      expect(normaliseOrigin(bad)).toBeUndefined();
    }
  });

  it("checkOrigin never returns the rejected value", () => {
    const allowed = allowedOrigins({ pages: ["https://www.example.com"] }, "pages");
    expect(checkOrigin(EVIL, allowed)).toEqual({ ok: false });
    expect(checkOrigin("https://www.example.com/a b", allowed)).toEqual({ ok: true, href: "https://www.example.com/a%20b" });
  });
});

describe("S-C.1: MCP outputSchema lowers web-page to a URI string, no pattern", () => {
  it("a direct field and a field inside a collection resource", () => {
    const direct = objectJsonSchema([{ name: "listingUrl", required: true, type: { kind: "scalar", semantic: "web-page" } }]);
    expect((direct.properties as Record<string, unknown>).listingUrl).toEqual({ type: "string", format: "uri" });

    const viaCollection = objectJsonSchema([{ name: "stays", required: true, type: { kind: "collection", of: "Stay" } }], stayResources(false));
    const items = ((viaCollection.properties as Record<string, { items: { properties: Record<string, unknown> } }>).stays).items;
    expect(items.properties.listingUrl).toEqual({ type: "string", format: "uri" });
    expect(JSON.stringify(viaCollection)).not.toContain("pattern");
  });
});

describe("S-D.6: the response fingerprint is unaffected by origins", () => {
  it("an on-origin and an off-origin response of the same JSON shape fingerprint equally", () => {
    const on = { results: [{ name: "A", url: "https://www.example.com/a" }] };
    const off = { results: [{ name: "A", url: EVIL }] };
    expect(fingerprintShape(on)).toBe(fingerprintShape(off));
  });
});
