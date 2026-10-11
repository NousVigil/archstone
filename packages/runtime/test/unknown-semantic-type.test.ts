// #214: the MCP runtime's IR entry points refuse an unknown semantic type at load. The runtime
// builds its Registry through the same constructor `serve` uses; it must throw the named error
// before any tool is listed, and the error is the one this package re-exports.

import { describe, it, expect } from "vitest";
import type { IR, SemanticType } from "@archstone/compiler";
import { Registry, UnknownSemanticTypeError, buildRegistry } from "../src/registry";
import { toolDefinitions } from "../src/mcp";
import { resolve } from "node:path";

const ir = (semantic: string): IR => ({
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
      input: [{ name: "flag", required: true, type: { kind: "scalar", semantic: semantic as SemanticType } }],
      output: [],
      connector: { type: "rest", rest: { method: "GET", path: "/x" } },
    },
  ],
});

describe("runtime IR load: unknown semantic type (#214)", () => {
  it("refuses at Registry construction with a named error carrying type and path", () => {
    expect(() => new Registry(ir("future-type"))).toThrow(UnknownSemanticTypeError);
    try {
      new Registry(ir("future-type"));
    } catch (e) {
      expect((e as UnknownSemanticTypeError).type).toBe("future-type");
      expect((e as UnknownSemanticTypeError).path).toBe("tools[shop.get].input.flag");
    }
  });

  it("lists tools normally when every type is known", () => {
    expect(toolDefinitions(new Registry(ir("boolean")))).toHaveLength(1);
  });

  it("buildRegistry still builds a real manifest (known types only)", () => {
    const built = buildRegistry(resolve(__dirname, "../../../examples/manifests/booking"));
    expect(built.diagnostics.some((d) => d.code === "unknown-semantic-type")).toBe(false);
  });
});
