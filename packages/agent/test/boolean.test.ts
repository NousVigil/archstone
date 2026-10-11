// `boolean` in the embedded SDK (#212): the type is carried through unchanged by `tools()` and
// `execute()`, input and output.

import { describe, it, expect } from "vitest";
import type { IR, IRTool } from "@archstone/compiler";
import { fromIR, type AnthropicToolDef, type OpenAIChatToolDef, type FetchLike } from "../src/index";

function ir(required: boolean): IR {
  const tool: IRTool = {
    id: "rooms.check",
    description: "Is a room available.",
    effect: "read",
    provider: "booking",
    policies: [],
    lifecycle: "stable",
    input: [{ name: "flag", required: true, type: { kind: "scalar", semantic: "boolean" } }],
    output: [{ name: "available", required, type: { kind: "scalar", semantic: "boolean" } }],
    connector: { type: "rest", rest: { baseUrl: "https://rooms.example", method: "GET", path: "/check" } },
    extract: [{ name: "available", path: "$.available" }],
  };
  return { version: "0", company: { id: "acme" }, tools: [tool], resources: {} };
}

function spy(body: unknown): { fetchImpl: FetchLike; urls: string[] } {
  const urls: string[] = [];
  return { urls, fetchImpl: async (url) => (urls.push(String(url)), new Response(JSON.stringify(body), { status: 200 })) };
}

describe("tools() carries {type: boolean}", () => {
  it("in the input schema of the anthropic and openai-chat formats", () => {
    const a = fromIR(ir(true));
    const anthropic = a.tools("anthropic") as AnthropicToolDef[];
    expect((anthropic[0]!.input_schema as { properties: Record<string, unknown> }).properties.flag).toEqual({ type: "boolean" });
    const openai = a.tools("openai-chat") as OpenAIChatToolDef[];
    expect((openai[0]!.function.parameters as { properties: Record<string, unknown> }).properties.flag).toEqual({ type: "boolean" });
  });
});

describe("execute()", () => {
  for (const v of [true, false]) {
    it(`boolean in, boolean out: ${v} is returned unchanged; status ok`, async () => {
      const s = spy({ available: v });
      const r = await fromIR(ir(true)).execute("rooms.check", { flag: v }, { fetchImpl: s.fetchImpl });
      expect(r.status).toBe("ok");
      expect(r.data).toEqual({ available: v });
      expect(s.urls[0]).toContain(`flag=${v}`);
    });
  }

  it('"true" as input is input_invalid with the field path, and nothing is dispatched', async () => {
    const s = spy({ available: true });
    const r = await fromIR(ir(true)).execute("rooms.check", { flag: "true" }, { fetchImpl: s.fetchImpl });
    expect(r.status).toBe("error");
    expect(r.denial).toEqual({ reason: "input_invalid", capability: "rooms.check", problems: [{ path: "flag", expected: "boolean" }] });
    expect(s.urls).toHaveLength(0);
  });

  it('a provider that returns "t" is a violation naming the field and boolean', async () => {
    const r = await fromIR(ir(true)).execute("rooms.check", { flag: true }, { fetchImpl: spy({ available: "t" }).fetchImpl });
    expect(r.status).toBe("violation");
    expect(r.invalid).toEqual([{ field: "available", expected: "boolean" }]);
    expect(r.data).toBeUndefined();
  });

  it("an optional field the provider sends as 1 is omitted and degraded", async () => {
    const r = await fromIR(ir(false)).execute("rooms.check", { flag: true }, { fetchImpl: spy({ available: 1 }).fetchImpl });
    expect(r.status).toBe("degraded");
    expect(r.invalid).toEqual([{ field: "available", expected: "boolean" }]);
    expect(r.data).toEqual({});
  });
});
