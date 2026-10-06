// #146 — the mapping boundary holds at every nesting level.
//
// `applyResponseMapping` projects every found value against its declared type: a nested resource
// value becomes a new object holding only that resource's declared fields (recursively, through
// `collection:` rows too), a composite semantic value keeps only its declared keys, a `ref:` slot
// takes a bare primitive id, and a value of the wrong shape is absent. Required-ness is evaluated at
// each level; a failure bubbles to the nearest optional slot, which is dropped, and with no optional
// slot on the way up the row fails. MCP, the embedded `execute()` and `verify` all reach this
// through `applyResponseMapping`, which is why the scenarios are tested here, once.

import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import type { IRField, IRResourceRegistry, IRTool, IRType, SemanticType } from "@archstone/compiler";
import { applyResponseMapping, type MappingResult } from "../src/mapping";
import { objectJsonSchema, extractionJsonSchema } from "../src/lowering";

const text: IRType = { kind: "scalar", semantic: "text" };
const field = (name: string, type: IRType, required = true): IRField => ({ name, required, type });
const res = (name: string): IRType => ({ kind: "resource", name });
const coll = (of: string): IRType => ({ kind: "collection", of });

/** A `stays` collection tool over `Stay`, mapping the named fields by same-named key. */
function staysTool(fields: string[], onError?: string): IRTool {
  const t: IRTool = {
    id: "tourism.search",
    description: "",
    effect: "read",
    provider: "stays",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [field("stays", coll("Stay"))],
    connector: { type: "rest", rest: { method: "GET", path: "/stays" } },
    response: { resource: "Stay", field: "stays", collection: "$.stays[*]", fields: fields.map((name) => ({ name, path: `$.${name}` })) },
  };
  if (onError) t.response!.onError = { errorResource: onError, when: { path: "$.error", exists: true } };
  return t;
}

/** A single-object tool over `Stay` (no collection). */
function stayTool(fields: string[]): IRTool {
  const t = staysTool(fields);
  t.output = [field("stay", res("Stay"))];
  t.response = { resource: "Stay", field: "stay", fields: fields.map((name) => ({ name, path: `$.${name}` })) };
  return t;
}

/** The issue's example: Stay{name, host: Host}, Host declares only `name`. */
const issueResources = (hostRequired = true): IRResourceRegistry => ({
  Stay: [field("name", text), field("host", res("Host"), hostRequired)],
  Host: [field("name", text)],
});
const leakyHost = { name: "Ana", phone: "+40 700 000 000", internalNote: "do not show" };

/** The mapped data must also be valid against the outputSchema the tool advertises. */
function expectSchemaAgrees(tool: IRTool, resources: IRResourceRegistry, r: MappingResult): void {
  const onError = tool.response?.onError ? { field: tool.response.field, errorResource: tool.response.onError.errorResource } : undefined;
  const schema = objectJsonSchema(tool.output, resources, new Set(), onError);
  const ajv = new Ajv2020({ strict: false });
  const validate = ajv.compile(schema);
  expect(validate(r.data), JSON.stringify(validate.errors)).toBe(true);
}

const leaks = (r: MappingResult, ...needles: string[]): void => {
  const s = JSON.stringify(r.data ?? {});
  for (const n of needles) expect(s).not.toContain(n);
};

describe("the issue's example: undeclared keys inside a nested resource are dropped", () => {
  it("collection: data.stays[0].host is exactly the declared shape; status ok", () => {
    const tool = staysTool(["name", "host"]);
    const resources = issueResources();
    const r = applyResponseMapping(tool, { stays: [{ name: "Casa", host: leakyHost }] }, resources);
    expect(r.status).toBe("ok");
    expect((r.data?.stays as { host: unknown }[])[0].host).toEqual({ name: "Ana" });
    leaks(r, "phone", "internalNote", "+40", "do not show");
    expectSchemaAgrees(tool, resources, r);
  });

  it("a single object (no collection)", () => {
    const tool = stayTool(["name", "host"]);
    const r = applyResponseMapping(tool, { name: "Casa", host: leakyHost }, issueResources());
    expect(r).toEqual({ status: "ok", data: { stay: { name: "Casa", host: { name: "Ana" } } } });
  });

  it("an onError mapping: the ok row is projected, the error row too", () => {
    const resources: IRResourceRegistry = { ...issueResources(), RowError: [field("error", text), field("host", res("Host"), false)] };
    const tool = staysTool(["name", "host"], "RowError");
    const r = applyResponseMapping(tool, { stays: [{ name: "Casa", host: leakyHost }, { error: "sold out", host: leakyHost }] }, resources);
    expect(r.status).toBe("ok");
    expect(r.data?.stays).toEqual([
      { $row: "ok", name: "Casa", host: { name: "Ana" } },
      { $row: "error", error: "sold out", host: { name: "Ana" } },
    ]);
    leaks(r, "phone", "internalNote");
    expectSchemaAgrees(tool, resources, r);
  });

  it("two levels deep: undeclared keys are dropped at both levels", () => {
    const resources: IRResourceRegistry = {
      Stay: [field("name", text), field("host", res("Host"))],
      Host: [field("name", text), field("agency", res("Agency"), false)],
      Agency: [field("name", text)],
    };
    const tool = stayTool(["name", "host"]);
    const body = { name: "Casa", host: { name: "Ana", phone: "1", agency: { name: "Ag", iban: "RO49" } } };
    const r = applyResponseMapping(tool, body, resources);
    expect(r).toEqual({ status: "ok", data: { stay: { name: "Casa", host: { name: "Ana", agency: { name: "Ag" } } } } });
    expectSchemaAgrees(tool, resources, r);
  });
});

describe("collection: nested inside a resource", () => {
  const resources = (roomsRequired: boolean): IRResourceRegistry => ({
    Stay: [field("name", text), field("rooms", coll("Room"), roomsRequired)],
    Room: [field("label", text), field("price", { kind: "scalar", semantic: "quantity" })],
  });
  const tool = stayTool(["name", "rooms"]);

  it("each row is projected; an empty array is OK", () => {
    const r = applyResponseMapping(tool, { name: "Casa", rooms: [{ label: "1", price: 10, net: 7 }, { label: "2", price: 12, net: 9 }] }, resources(true));
    expect(r).toEqual({ status: "ok", data: { stay: { name: "Casa", rooms: [{ label: "1", price: 10 }, { label: "2", price: 12 }] } } });
    expectSchemaAgrees(tool, resources(true), r);
    expect(applyResponseMapping(tool, { name: "Casa", rooms: [] }, resources(true))).toEqual({ status: "ok", data: { stay: { name: "Casa", rooms: [] } } });
  });

  it("one row missing a required field makes the whole slot absent — optional: degraded, never a shortened list", () => {
    const r = applyResponseMapping(tool, { name: "Casa", rooms: [{ label: "1", price: 10 }, { label: "2" }] }, resources(false));
    expect(r).toEqual({ status: "degraded", data: { stay: { name: "Casa" } }, degraded: ["rooms"] });
  });

  it("required slot: a violation naming the nested field, dotted, no index", () => {
    const r = applyResponseMapping(tool, { name: "Casa", rooms: [{ label: "1", price: 10 }, { label: "2" }] }, resources(true));
    expect(r).toEqual({ status: "violation", missing: ["rooms.price"] });
  });
});

describe("a required miss at a nested level bubbles to the nearest optional ancestor", () => {
  it("optional nested resource missing its required field → parent omitted, degraded", () => {
    const tool = stayTool(["name", "host"]);
    const resources = issueResources(false);
    const r = applyResponseMapping(tool, { name: "Casa", host: { phone: "1" } }, resources);
    expect(r).toEqual({ status: "degraded", data: { stay: { name: "Casa" } }, degraded: ["host"] });
    expectSchemaAgrees(tool, resources, r);
  });

  it("required nested resource missing its required field → violation naming host.name", () => {
    const r = applyResponseMapping(stayTool(["name", "host"]), { name: "Casa", host: { phone: "1" } }, issueResources(true));
    expect(r).toEqual({ status: "violation", missing: ["host.name"] });
  });

  it("the absorbing slot is the nearest optional one, not the top", () => {
    const resources: IRResourceRegistry = {
      Stay: [field("name", text), field("host", res("Host"))],
      Host: [field("name", text), field("agency", res("Agency"), false)],
      Agency: [field("owner", res("Owner"))],
      Owner: [field("name", text)],
    };
    const r = applyResponseMapping(stayTool(["name", "host"]), { name: "Casa", host: { name: "Ana", agency: { owner: { phone: "1" } } } }, resources);
    expect(r).toEqual({ status: "degraded", data: { stay: { name: "Casa", host: { name: "Ana" } } }, degraded: ["host.agency"] });
    // With no optional ancestor on the way up, the response fails, naming the deepest field.
    resources.Host[1] = { ...resources.Host[1], required: true };
    expect(applyResponseMapping(stayTool(["name", "host"]), { name: "Casa", host: { name: "Ana", agency: { owner: {} } } }, resources)).toEqual({
      status: "violation",
      missing: ["host.agency.owner.name"],
    });
  });

  it("a nested optional field the provider simply did not send is not reported (as before)", () => {
    const resources: IRResourceRegistry = { Stay: [field("name", text), field("host", res("Host"))], Host: [field("name", text), field("bio", text, false)] };
    expect(applyResponseMapping(stayTool(["name", "host"]), { name: "Casa", host: { name: "Ana" } }, resources)).toEqual({ status: "ok", data: { stay: { name: "Casa", host: { name: "Ana" } } } });
  });

  it("inside an onError mapping: a per-row violation, other rows unaffected", () => {
    const resources: IRResourceRegistry = { ...issueResources(true), RowError: [field("error", text)] };
    const tool = staysTool(["name", "host"], "RowError");
    const r = applyResponseMapping(tool, { stays: [{ name: "A", host: { name: "Ana", phone: "1" } }, { name: "B", host: { phone: "2" } }] }, resources);
    expect(r.status).toBe("ok");
    expect(r.data?.stays).toEqual([{ $row: "ok", name: "A", host: { name: "Ana" } }]);
    expect(r.rowViolations).toEqual([{ index: 1, missing: ["host.name"] }]);
    leaks(r, "phone");
  });
});

describe("ref: slots take a bare id only", () => {
  const resources = (required: boolean): IRResourceRegistry => ({
    Stay: [field("name", text), field("host", { kind: "resource", name: "Host", identity: true }, required)],
    Host: [field("name", text)],
  });
  const tool = stayTool(["name", "host"]);

  it("a primitive id passes", () => {
    expect(applyResponseMapping(tool, { name: "Casa", host: "h_1" }, resources(true))).toEqual({ status: "ok", data: { stay: { name: "Casa", host: "h_1" } } });
    expect(applyResponseMapping(tool, { name: "Casa", host: 42 }, resources(true)).data).toEqual({ stay: { name: "Casa", host: 42 } });
  });

  it("an object or array in the id's place is absent — never reduced to an id, never forwarded", () => {
    for (const host of [{ id: "h_1", secret: "s3cret" }, [{ id: "h_1", secret: "s3cret" }]]) {
      const optional = applyResponseMapping(tool, { name: "Casa", host }, resources(false));
      expect(optional).toEqual({ status: "degraded", data: { stay: { name: "Casa" } }, degraded: ["host"] });
      const required = applyResponseMapping(tool, { name: "Casa", host }, resources(true));
      expect(required).toEqual({ status: "violation", missing: ["host"] });
      expect(JSON.stringify([optional, required])).not.toContain("s3cret");
    }
  });
});

describe("a value of the wrong shape for its declared type is absent, at every level including the top", () => {
  const resources: IRResourceRegistry = {
    Stay: [
      field("name", text),
      field("tags", { kind: "list", items: "text" }, false),
      field("host", res("Host"), false),
      field("note", text, false),
    ],
    Host: [field("name", text), field("bio", text, false)],
  };
  const tool = stayTool(["name", "tags", "host", "note"]);
  // Top-level optional fields the body does not send also degrade (the long-standing top-level
  // rule), so assert the data exactly and that each named slot is among the degraded ones.
  const expectDropped = (r: MappingResult, data: unknown, names: string[]): void => {
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual(data);
    expect(r.degraded).toEqual(expect.arrayContaining(names));
    leaks(r, "s3cret", "secret");
  };

  it("a string where a resource is declared; an object where a list is declared", () => {
    const r = applyResponseMapping(tool, { name: "Casa", host: "Ana", tags: { a: "x", secret: 1 } }, resources);
    expectDropped(r, { stay: { name: "Casa" } }, ["tags", "host"]);
  });

  it("a list with one non-primitive item is absent whole, never shortened", () => {
    const r = applyResponseMapping(tool, { name: "Casa", tags: ["a", { secret: 1 }] }, resources);
    expectDropped(r, { stay: { name: "Casa" } }, ["tags"]);
  });

  it("a scalar-declared field receiving an object or array — top level", () => {
    for (const note of [{ first: "x", secret: "s3cret" }, ["s3cret"]]) {
      const r = applyResponseMapping(tool, { name: "Casa", note }, resources);
      expectDropped(r, { stay: { name: "Casa" } }, ["note"]);
    }
    // Required: a violation, the field named.
    expect(applyResponseMapping(tool, { name: { first: "C", secret: "s3cret" } }, resources)).toEqual({ status: "violation", missing: ["name"] });
  });

  it("a scalar-declared field receiving an object — nested: optional dropped (degraded, dotted), required bubbles", () => {
    const r = applyResponseMapping(tool, { name: "Casa", host: { name: "Ana", bio: { secret: "s3cret" } } }, resources);
    expectDropped(r, { stay: { name: "Casa", host: { name: "Ana" } } }, ["host.bio"]);
    const bubbled = applyResponseMapping(tool, { name: "Casa", host: { name: { secret: "s3cret" } } }, resources);
    expectDropped(bubbled, { stay: { name: "Casa" } }, ["host"]);
  });

  it("an extract: scalar receiving an object is absent too", () => {
    const t: IRTool = { ...stayTool([]), response: undefined, output: [field("total", { kind: "scalar", semantic: "quantity" }, false)], extract: [{ name: "total", path: "$.total" }] };
    expect(applyResponseMapping(t, { total: { value: 3, secret: "s3cret" } }, {})).toEqual({ status: "degraded", data: {}, degraded: ["total"] });
    expect(applyResponseMapping(t, { total: 3 }, {})).toEqual({ status: "ok", data: { total: 3 } });
  });
});

describe("composite semantic scalars keep only their declared keys", () => {
  const composite = (semantic: SemanticType): IRResourceRegistry => ({ Stay: [field("name", text), field("v", { kind: "scalar", semantic }, false)] });
  const tool = stayTool(["name", "v"]);
  const map = (semantic: SemanticType, v: unknown) => applyResponseMapping(tool, { name: "Casa", v }, composite(semantic));

  it("money: {amount, currency, costPrice} → {amount, currency}", () => {
    expect(map("money", { amount: 120, currency: "EUR", costPrice: 80 }).data).toEqual({ stay: { name: "Casa", v: { amount: 120, currency: "EUR" } } });
  });

  it("party and date-range", () => {
    expect(map("party", { adults: 2, children: 1, passport: "X1" }).data).toEqual({ stay: { name: "Casa", v: { adults: 2, children: 1 } } });
    expect(map("party", { adults: 2 }).data).toEqual({ stay: { name: "Casa", v: { adults: 2 } } });
    expect(map("date-range", { from: "2026-01-01", to: "2026-01-03", internal: "x" }).data).toEqual({ stay: { name: "Casa", v: { from: "2026-01-01", to: "2026-01-03" } } });
  });

  it("a primitive in a composite slot carries no keys and passes as before (`price: 120`)", () => {
    expect(map("money", 120)).toEqual({ status: "ok", data: { stay: { name: "Casa", v: 120 } } });
  });

  it("missing a required sub-key, or a non-primitive sub-value, is absent", () => {
    expect(map("money", { amount: 120 })).toEqual({ status: "degraded", data: { stay: { name: "Casa" } }, degraded: ["v"] });
    expect(map("money", { amount: { secret: 1 }, currency: "EUR" })).toEqual({ status: "degraded", data: { stay: { name: "Casa" } }, degraded: ["v"] });
  });

  it("a declared optional sub-key of the wrong shape is a mis-shape (degraded), not an undeclared key", () => {
    const r = applyResponseMapping(tool, { name: "Casa", v: { adults: 2, children: { secret: "s3cret" }, pet: "dog" } }, composite("party"), { collectUndeclared: true });
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ stay: { name: "Casa", v: { adults: 2 } } });
    expect(r.degraded).toEqual(["v.children"]);
    expect(r.undeclaredNested).toEqual(["v.pet"]);
    expect(JSON.stringify(r)).not.toContain("s3cret");
  });

  it("the projected keys are exactly the keys the closed lowering declares — the table cannot drift", () => {
    for (const semantic of ["money", "party", "date-range"] as SemanticType[]) {
      const props = (extractionJsonSchema([field("v", { kind: "scalar", semantic })]).properties as Record<string, { properties: Record<string, unknown> }>).v.properties;
      const every = Object.fromEntries(Object.keys(props).map((k) => [k, k === "adults" || k === "children" || k === "amount" ? 1 : "x"]));
      const out = (map(semantic, { ...every, extra: "x" }).data?.stay as { v: Record<string, unknown> }).v;
      expect(Object.keys(out).sort()).toEqual(Object.keys(props).sort());
    }
  });
});

describe("non-JSON objects are absent — a provider must hand the mapper JSON (pg Dates are normalised in provider-sql)", () => {
  const resources = (required: boolean): IRResourceRegistry => ({
    Stay: [field("name", text), field("day", { kind: "scalar", semantic: "date" }, required), field("at", { kind: "scalar", semantic: "datetime" }, false)],
  });
  const tool = stayTool(["name", "day", "at"]);

  it("a Date or a Buffer in a scalar slot is absent: optional → degraded, required → violation", () => {
    for (const odd of [new Date("2026-10-03T00:00:00Z"), Buffer.from("s3cret")]) {
      const optional = applyResponseMapping(tool, { name: "Casa", day: "2026-10-03", at: odd }, resources(true));
      expect(optional).toEqual({ status: "degraded", data: { stay: { name: "Casa", day: "2026-10-03" } }, degraded: ["at"] });
      expect(applyResponseMapping(tool, { name: "Casa", day: odd }, resources(true))).toEqual({ status: "violation", missing: ["day"] });
    }
  });

  it("the JSON strings provider-sql now returns pass", () => {
    expect(applyResponseMapping(tool, { name: "Casa", day: "2026-10-03", at: "2026-10-03T12:34:56.789Z" }, resources(true))).toEqual({
      status: "ok",
      data: { stay: { name: "Casa", day: "2026-10-03", at: "2026-10-03T12:34:56.789Z" } },
    });
  });
});

describe("self-referential resources and the depth cap", () => {
  const resources: IRResourceRegistry = { Category: [field("name", text), field("parent", res("Category"), false)] };
  const tool: IRTool = { ...stayTool(["name", "parent"]), output: [field("stay", res("Category"))] };
  tool.response = { resource: "Category", field: "stay", fields: [{ name: "name", path: "$.name" }, { name: "parent", path: "$.parent" }] };

  const chain = (levels: number): Record<string, unknown> => {
    let node: Record<string, unknown> = { name: `c${levels}`, secret: "s3cret" };
    for (let i = levels - 1; i >= 0; i--) node = { name: `c${i}`, secret: "s3cret", parent: node };
    return node;
  };

  it("projected at every level the provider sends", () => {
    const r = applyResponseMapping(tool, chain(3), resources);
    expect(r).toEqual({ status: "ok", data: { stay: { name: "c0", parent: { name: "c1", parent: { name: "c2", parent: { name: "c3" } } } } } });
  });

  it("data deeper than the cap is absent (required-ness decides), never forwarded, never a throw", () => {
    const r = applyResponseMapping(tool, chain(40), resources);
    expect(r.status).toBe("degraded");
    expect(r.degraded).toHaveLength(1);
    expect(r.degraded![0].split(".")).toHaveLength(33); // the slot at nested depth 33
    leaks(r, "s3cret", "c33");
    let node = (r.data?.stay as Record<string, unknown>).parent as Record<string, unknown> | undefined;
    let depth = 0;
    while (node) {
      depth++;
      node = node.parent as Record<string, unknown> | undefined;
    }
    expect(depth).toBe(32);
  });

  it("a hostile, very deep body does not exhaust the stack", () => {
    let deep: unknown = { name: "leaf" };
    for (let i = 0; i < 100_000; i++) deep = { name: "n", parent: deep };
    expect(() => applyResponseMapping(tool, deep, resources)).not.toThrow();
  });
});

describe("#145 interaction: the origin check runs inside the same walk", () => {
  it("an off-origin web-page inside a nested resource is withheld AND its undeclared siblings are dropped", () => {
    const resources: IRResourceRegistry = {
      Stay: [field("name", text), field("host", res("Host"))],
      Host: [field("name", text), field("profileUrl", { kind: "scalar", semantic: "web-page" }, false)],
    };
    const tool = { ...stayTool(["name", "host"]), origins: { pages: ["https://www.example.com"] } };
    const r = applyResponseMapping(tool, { name: "Casa", host: { name: "Ana", profileUrl: "https://evil.example.net/x", phone: "1" } }, resources);
    expect(r).toEqual({ status: "degraded", data: { stay: { name: "Casa", host: { name: "Ana" } } }, withheld: ["host.profileUrl"] });
    const on = applyResponseMapping(tool, { name: "Casa", host: { name: "Ana", profileUrl: "https://WWW.example.com/u", phone: "1" } }, resources);
    expect(on).toEqual({ status: "ok", data: { stay: { name: "Casa", host: { name: "Ana", profileUrl: "https://www.example.com/u" } } } });
  });
});

describe("undeclaredNested: names of dropped nested keys, only when asked, never values", () => {
  const tool = staysTool(["name", "host"]);
  const body = { stays: [{ name: "Casa", net: 1, host: leakyHost }, { name: "Vila", host: { name: "Bo", phone: "2" } }] };

  it("absent by default — the result shape is unchanged", () => {
    expect("undeclaredNested" in applyResponseMapping(tool, body, issueResources())).toBe(false);
  });

  it("deduped names across rows, no index; top-level unmapped keys are not listed; status unchanged", () => {
    const r = applyResponseMapping(tool, body, issueResources(), { collectUndeclared: true });
    expect(r.status).toBe("ok");
    expect(r.undeclaredNested).toEqual(["host.phone", "host.internalNote"]);
    expect(JSON.stringify(r.undeclaredNested)).not.toContain("+40");
  });

  it("composite sub-keys are named too", () => {
    const resources: IRResourceRegistry = { Stay: [field("name", text), field("price", { kind: "scalar", semantic: "money" })] };
    const r = applyResponseMapping(stayTool(["name", "price"]), { name: "Casa", price: { amount: 1, currency: "EUR", costPrice: 0.5 } }, resources, { collectUndeclared: true });
    expect(r.undeclaredNested).toEqual(["price.costPrice"]);
  });

  it("present on a violation too", () => {
    const r = applyResponseMapping(stayTool(["name", "host"]), { host: leakyHost }, issueResources(), { collectUndeclared: true });
    expect(r.status).toBe("violation");
    expect(r.undeclaredNested).toEqual(["host.phone", "host.internalNote"]);
  });
});
