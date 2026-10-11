// The `boolean` semantic type (#212): a JSON true or false and nothing else, with no coercion on
// either side. The three views of that one rule — the lowering, the input validator and the response
// mapper — are tested together here, in the order of the decision table: every row is an `it`, and
// rows 1-7 run at four locations (a top-level resource field, a field of a nested resource, a field
// of a collection row, and an `extract:` field).

import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import type { IRField, IRResourceRegistry, IRTool, IRType } from "@archstone/compiler";
import { applyResponseMapping, contractViolationMessage, type MappingResult } from "../src/mapping";
import { objectJsonSchema, inputJsonSchema } from "../src/lowering";
import { validateInput } from "../src/input";

const bool: IRType = { kind: "scalar", semantic: "boolean" };
const text: IRType = { kind: "scalar", semantic: "text" };
const field = (name: string, type: IRType, required = true): IRField => ({ name, required, type });

const ABSENT = Symbol("absent");
type Loc = "resource" | "nested" | "collection" | "extract";
const LOCATIONS: Loc[] = ["resource", "nested", "collection", "extract"];

function base(output: IRField[], response?: IRTool["response"], extract?: IRTool["extract"]): IRTool {
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
    ...(response ? { response } : {}),
    ...(extract ? { extract } : {}),
  };
}

/** Map `value` (or an absent key) placed in a `boolean` field at the given location. */
function run(loc: Loc, value: unknown, required: boolean): { r: MappingResult; tool: IRTool; resources: IRResourceRegistry } {
  const put = (v: unknown): Record<string, unknown> => (v === ABSENT ? {} : { flag: v });
  const flagMap = [{ name: "flag", path: "$.flag" }];
  if (loc === "resource") {
    const resources = { Stay: [field("name", text), field("flag", bool, required)] };
    const tool = base([field("stay", { kind: "resource", name: "Stay" })], { resource: "Stay", field: "stay", fields: [{ name: "name", path: "$.name" }, ...flagMap] });
    return { r: applyResponseMapping(tool, { name: "A", ...put(value) }, resources), tool, resources };
  }
  if (loc === "nested") {
    const resources = { Stay: [field("name", text), field("host", { kind: "resource", name: "Host" })], Host: [field("name", text), field("flag", bool, required)] };
    const tool = base([field("stay", { kind: "resource", name: "Stay" })], {
      resource: "Stay", field: "stay", fields: [{ name: "name", path: "$.name" }, { name: "host", path: "$.host" }],
    });
    return { r: applyResponseMapping(tool, { name: "A", host: { name: "H", ...put(value) } }, resources), tool, resources };
  }
  if (loc === "collection") {
    const resources = { Stay: [field("name", text), field("flag", bool, required)] };
    const tool = base([field("stays", { kind: "collection", of: "Stay" })], {
      resource: "Stay", field: "stays", collection: "$.stays[*]", fields: [{ name: "name", path: "$.name" }, ...flagMap],
    });
    return { r: applyResponseMapping(tool, { stays: [{ name: "A", ...put(value) }] }, resources), tool, resources };
  }
  const tool = base([field("flag", bool, required)], undefined, flagMap);
  return { r: applyResponseMapping(tool, put(value), {}), tool, resources: {} };
}

/** Where the (single) fact about the flag shows up in `invalid`/`missing`, per location. */
const FIELD: Record<Loc, string> = { resource: "flag", nested: "host.flag", collection: "flag", extract: "flag" };

function dataFlag(loc: Loc, r: MappingResult): unknown {
  const d = r.data ?? {};
  if (loc === "resource") return (d.stay as { flag?: unknown } | undefined)?.flag;
  if (loc === "nested") return (d.stay as { host?: { flag?: unknown } } | undefined)?.host?.flag;
  if (loc === "collection") return (d.stays as { flag?: unknown }[] | undefined)?.[0]?.flag;
  return d.flag;
}

describe("rows 1-2: a real JSON boolean passes, false included", () => {
  for (const loc of LOCATIONS) {
    for (const v of [true, false]) {
      for (const required of [true, false]) {
        it(`${loc}: ${v} (${required ? "required" : "optional"}) is returned unchanged; status ok`, () => {
          const { r, tool, resources } = run(loc, v, required);
          expect(r.status).toBe("ok");
          expect(dataFlag(loc, r)).toBe(v);
          expect(r.invalid).toBeUndefined();
          // The mapped data satisfies the outputSchema the tool advertises.
          const validate = new Ajv2020({ strict: false }).compile(objectJsonSchema(tool.output, resources));
          expect(validate(r.data), JSON.stringify(validate.errors)).toBe(true);
        });
      }
    }
  }
});

describe("rows 3-4, 7: anything present that is not a JSON boolean is the wrong-shape outcome", () => {
  const wrong: [string, unknown][] = [
    ["number 0", 0], ["number 1", 1], ["number -1", -1], ["number 1.5", 1.5],
    ["string 'true'", "true"], ["string 'false'", "false"], ["string 'TRUE'", "TRUE"], ["string 't'", "t"], ["string 'f'", "f"],
    ["string 'yes'", "yes"], ["empty string", ""],
    ["object", {}], ["array", [true]],
  ];
  for (const loc of LOCATIONS) {
    for (const [label, v] of wrong) {
      it(`${loc}: ${label}, required -> violation naming boolean, never the value`, () => {
        const { r } = run(loc, v, true);
        expect(r.status).toBe("violation");
        expect(r.data).toBeUndefined();
        expect(r.invalid).toBeDefined();
        expect(r.invalid?.length).toBeGreaterThan(0);
        expect(r.invalid).toEqual([{ field: FIELD[loc], expected: "boolean" }]);
        const msg = contractViolationMessage("shop.get", r.missing ?? [], r.withheld ?? [], r.invalid ?? []);
        expect(msg).toContain("boolean");
        if (typeof v === "string" && v !== "") expect(msg).not.toContain(`'${v}'`);
      });
      it(`${loc}: ${label}, optional -> field omitted, degraded, named in degraded and invalid`, () => {
        const { r } = run(loc, v, false);
        expect(r.status).toBe("degraded");
        expect(dataFlag(loc, r)).toBeUndefined();
        expect(r.invalid?.map((i) => i.expected)).toContain("boolean");
        expect(r.degraded).toBeDefined();
      });
    }
  }
});

describe("rows 5-6: null and an absent key are absent, not invalid", () => {
  for (const loc of LOCATIONS) {
    for (const [label, v] of [["null", null], ["absent key", ABSENT]] as const) {
      it(`${loc}: ${label}, required -> violation in missing, not in invalid`, () => {
        const { r } = run(loc, v, true);
        expect(r.status).toBe("violation");
        expect(r.missing?.length).toBeGreaterThan(0);
        expect(r.invalid).toBeUndefined();
      });
      it(`${loc}: ${label}, optional -> omitted, not in invalid`, () => {
        const { r } = run(loc, v, false);
        // Only a top-level optional slot is listed in `degraded`; an absent optional field inside a
        // nested resource is simply omitted (existing behaviour, not changed by this type).
        expect(r.status).toBe(loc === "nested" ? "ok" : "degraded");
        expect(r.invalid).toBeUndefined();
        expect(dataFlag(loc, r)).toBeUndefined();
      });
    }
  }
});

describe("rows 8-10: list: boolean", () => {
  // A list field of a resource: the provider's array is projected whole, all or nothing.
  const map = (value: unknown, required: boolean): MappingResult => {
    const resources = { Stay: [field("name", text), field("flags", { kind: "list", items: "boolean" }, required)] };
    const tool = base([field("stay", { kind: "resource", name: "Stay" })], {
      resource: "Stay", field: "stay", fields: [{ name: "name", path: "$.name" }, { name: "flags", path: "$.flags" }],
    });
    return applyResponseMapping(tool, { name: "A", ...(value === ABSENT ? {} : { flags: value }) }, resources);
  };

  it("row 8: [] and [true,false] are returned unchanged", () => {
    for (const v of [[], [true, false]]) {
      const r = map(v, true);
      expect(r.status).toBe("ok");
      expect(r.data).toEqual({ stay: { name: "A", flags: v } });
    }
  });
  it("row 9: any non-boolean item makes the list invalid, all or nothing (required)", () => {
    for (const v of [[true, "x"], [1], ["true"]]) {
      const r = map(v, true);
      expect(r.status).toBe("violation");
      expect(r.invalid).toHaveLength(1);
      expect(r.invalid?.[0].field).toBe("flags");
      expect(JSON.stringify(r.invalid)).not.toContain('"x"');
    }
  });
  it("row 9: ... and the optional list is omitted and degraded", () => {
    const r = map([true, 1], false);
    expect(r.status).toBe("degraded");
    expect(r.data).toEqual({ stay: { name: "A" } });
    expect(r.invalid?.[0].field).toBe("flags");
  });
  it("row 10: null or a non-array", () => {
    expect(map(null, true).status).toBe("violation");
    expect(map(null, true).missing).toEqual(["flags"]);
    expect(map(true, true).status).toBe("violation");
    expect(map(true, true).invalid?.[0].field).toBe("flags");
    expect(map(null, false).status).toBe("degraded");
    expect(map(true, false).status).toBe("degraded");
  });
});

describe("lowering: boolean is {type:'boolean'} in the input, open and output schemas (AC-1, AC-2)", () => {
  it("scalar", () => {
    const f = [field("f", bool)];
    expect((inputJsonSchema(f) as { properties: Record<string, unknown> }).properties.f).toEqual({ type: "boolean" });
    expect((objectJsonSchema(f) as { properties: Record<string, unknown> }).properties.f).toEqual({ type: "boolean" });
  });
  it("list lowers to an array of boolean", () => {
    const f = [field("f", { kind: "list", items: "boolean" })];
    expect((objectJsonSchema(f) as { properties: Record<string, unknown> }).properties.f).toEqual({ type: "array", items: { type: "boolean" } });
  });
  it("the authored description is kept and none is invented", () => {
    const withDesc: IRField = { name: "f", required: true, description: "Is breakfast included", type: bool };
    const s = objectJsonSchema([withDesc]) as { properties: Record<string, Record<string, unknown>> };
    expect(s.properties.f).toEqual({ type: "boolean", description: "Is breakfast included" });
    const bare = objectJsonSchema([field("f", bool)]) as { properties: Record<string, Record<string, unknown>> };
    expect(bare.properties.f.description).toBeUndefined();
  });
});

describe("validateInput: strict (AC-2)", () => {
  const f = [field("flag", bool)];
  it("true and false pass", () => {
    expect(validateInput(f, { flag: true }).ok).toBe(true);
    expect(validateInput(f, { flag: false }).ok).toBe(true);
  });
  for (const bad of ["true", "false", 1, 0, "yes", {}, []]) {
    it(`${JSON.stringify(bad)} fails naming the field and the type`, () => {
      const v = validateInput(f, { flag: bad });
      expect(v).toMatchObject({ ok: false, problems: [{ path: "flag", expected: "boolean" }] });
      expect(JSON.stringify(v)).not.toContain('"yes"');
    });
  }
  it("null on a required field fails as required; on an optional field it passes", () => {
    expect(validateInput(f, { flag: null })).toMatchObject({ ok: false, problems: [{ path: "flag", expected: "required" }] });
    expect(validateInput([field("flag", bool, false)], { flag: null }).ok).toBe(true);
    expect(validateInput([field("flag", bool, false)], {}).ok).toBe(true);
  });
  it("a list item names its index", () => {
    const l = [field("flags", { kind: "list", items: "boolean" })];
    expect(validateInput(l, { flags: [true, false] }).ok).toBe(true);
    expect(validateInput(l, { flags: [true, "x"] })).toMatchObject({ ok: false, problems: [{ path: "flags[1]", expected: "boolean" }] });
  });
});
