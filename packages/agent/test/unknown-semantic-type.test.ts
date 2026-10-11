// #214: fromIR refuses an artifact that names a semantic type this build does not know, at load,
// with a named error carrying the type and the field path (instead of advertising it as a string).

import { describe, it, expect } from "vitest";
import { fromIR, UnknownSemanticTypeError } from "../src/index";

const artifact = (semantic: string) => ({
  version: "0",
  company: { id: "acme" },
  resources: {},
  tools: [
    {
      id: "shop.get",
      description: "",
      effect: "read",
      provider: "store",
      policies: [],
      lifecycle: "stable",
      input: [{ name: "flag", required: true, type: { kind: "scalar", semantic } }],
      output: [],
      connector: { type: "rest", rest: { method: "GET", path: "/x" } },
    },
  ],
});

describe("fromIR: unknown semantic type (#214)", () => {
  it("throws UnknownSemanticTypeError naming the type and the path", () => {
    let caught: unknown;
    try {
      fromIR(artifact("future-type"));
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(UnknownSemanticTypeError);
    const e = caught as UnknownSemanticTypeError;
    expect(e.type).toBe("future-type");
    expect(e.path).toBe("tools[shop.get].input.flag");
  });

  it("still loads an artifact whose types are all known", () => {
    expect(() => fromIR(artifact("boolean"))).not.toThrow();
  });
});
