// #214: an IR naming a semantic type this build does not know is refused when it is LOADED, with
// a named error carrying the type and the field path; and no lowering, validator or mapper
// treats an unknown type as a string (defence in depth, for a caller that skips the Registry).

import { describe, it, expect } from "vitest";
import type { IR, IRField, IRTool, SemanticType } from "@archstone/compiler";
import { Registry } from "../src/registry";
import { UnknownSemanticTypeError, assertKnownSemanticTypes } from "../src/semantic-types";
import { objectJsonSchema, inputJsonSchema, extractionJsonSchema } from "../src/lowering";
import { validateInput } from "../src/input";
import { applyResponseMapping } from "../src/mapping";

// A type a newer compiler could emit. The cast is the point of the test: it is not in this build's set.
const FUTURE = "future-type" as SemanticType;

const scalar = (name: string, semantic: SemanticType): IRField => ({ name, required: true, type: { kind: "scalar", semantic } });
const list = (name: string, items: SemanticType): IRField => ({ name, required: true, type: { kind: "list", items } });

function tool(overrides: Partial<IRTool>): IRTool {
  return {
    id: "shop.get",
    description: "",
    effect: "read",
    provider: "store",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [],
    connector: { type: "rest", rest: { method: "GET", path: "/x" } },
    ...overrides,
  };
}
const ir = (tools: IRTool[], resources: IR["resources"] = {}): IR => ({ version: "0", company: { id: "acme" }, tools, resources });

function thrown(fn: () => unknown): UnknownSemanticTypeError {
  try {
    fn();
  } catch (e) {
    expect(e).toBeInstanceOf(UnknownSemanticTypeError);
    return e as UnknownSemanticTypeError;
  }
  throw new Error("expected UnknownSemanticTypeError");
}

describe("load-time check (Registry)", () => {
  it("refuses an unknown input field type, naming the type and the path", () => {
    const e = thrown(() => new Registry(ir([tool({ input: [scalar("flag", FUTURE)] })])));
    expect(e.name).toBe("UnknownSemanticTypeError");
    expect(e.type).toBe("future-type");
    expect(e.path).toBe("tools[shop.get].input.flag");
    expect(e.message).toContain("'future-type'");
    expect(e.message).toContain("tools[shop.get].input.flag");
  });

  it("refuses an unknown output field type", () => {
    const e = thrown(() => new Registry(ir([tool({ output: [scalar("out", FUTURE)] })])));
    expect(e.path).toBe("tools[shop.get].output.out");
  });

  it("refuses an unknown list element type", () => {
    const e = thrown(() => new Registry(ir([tool({ input: [list("tags", FUTURE)] })])));
    expect(e.path).toBe("tools[shop.get].input.tags[]");
  });

  it("refuses an unknown type inside a resource", () => {
    const e = thrown(() => new Registry(ir([tool({})], { room: [scalar("size", FUTURE)] })));
    expect(e.path).toBe("resources[room].size");
  });

  it("accepts every type this build knows", () => {
    expect(() => assertKnownSemanticTypes(ir([tool({ input: [scalar("a", "boolean"), scalar("b", "image"), list("c", "enum")] })]))).not.toThrow();
  });
});

describe("no lowering, validator or mapper treats an unknown type as a string", () => {
  const fields = [scalar("flag", FUTURE)];

  it("the three lowerings throw", () => {
    for (const lower of [objectJsonSchema, inputJsonSchema, extractionJsonSchema]) {
      expect(thrown(() => lower(fields)).type).toBe("future-type");
    }
    expect(thrown(() => objectJsonSchema([list("tags", FUTURE)])).type).toBe("future-type");
  });

  it("the input validator throws rather than answering 'expected string'", () => {
    const e = thrown(() => validateInput(fields, { flag: true }, {}));
    expect(e.path).toBe("flag");
  });

  it("the response mapper throws", () => {
    const t = tool({ output: fields });
    const mapping = { resource: "r", field: "flag", fields: [{ name: "flag", path: "$.flag" }] };
    expect(() => applyResponseMapping({ ...t, response: mapping }, { flag: "x" }, { r: fields })).toThrow(UnknownSemanticTypeError);
  });
});
