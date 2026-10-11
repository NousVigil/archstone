import { describe, it, expect } from "vitest";
import type { IRField, IRTool } from "@archstone/compiler";
import { invokeRest, type FetchLike } from "../src/index";

// #212 — the REST provider is transport only: a boolean input, `false` included, reaches the wire.
// Absence is `undefined`/`null`, never falsy, so `false` is not dropped from the path, the query,
// a list's repeated key or the JSON body.

const flag: IRField = { name: "flag", required: true, type: { kind: "scalar", semantic: "boolean" } };
const flags: IRField = { name: "flags", required: false, type: { kind: "list", items: "boolean" } };

function tool(rest: NonNullable<IRTool["connector"]>["rest"], input: IRField[]): IRTool {
  return {
    id: "acme.check",
    description: "d",
    effect: "read",
    provider: "acme-api",
    policies: [],
    output: [],
    input,
    connector: { type: "rest", rest },
  };
}

function capture(): { calls: Array<{ url: string; init: RequestInit }>; fetchImpl: FetchLike } {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  return {
    calls,
    fetchImpl: async (url, init) => {
      calls.push({ url: String(url), init: init ?? {} });
      return new Response("{}", { status: 200 });
    },
  };
}

const ENV = { API: "https://api.acme.example" };

describe("#212: a boolean input on the wire", () => {
  for (const v of [true, false]) {
    it(`query: ?flag=${v}`, async () => {
      const { calls, fetchImpl } = capture();
      await invokeRest(tool({ baseUrl: "${API}", method: "GET", path: "/x" }, [flag]), { flag: v }, { env: ENV, fetchImpl });
      expect(calls[0].url).toBe(`https://api.acme.example/x?flag=${v}`);
    });

    it(`path: /x/${v}`, async () => {
      const { calls, fetchImpl } = capture();
      await invokeRest(tool({ baseUrl: "${API}", method: "GET", path: "/x/{flag}" }, [flag]), { flag: v }, { env: ENV, fetchImpl });
      expect(calls[0].url).toBe(`https://api.acme.example/x/${v}`);
    });

    it(`JSON body: {"flag":${v}} as a boolean, not a string`, async () => {
      const { calls, fetchImpl } = capture();
      await invokeRest(tool({ baseUrl: "${API}", method: "POST", path: "/x" }, [flag]), { flag: v }, { env: ENV, fetchImpl });
      expect(JSON.parse(String(calls[0].init.body))).toEqual({ flag: v });
    });
  }

  it("list: repeated key, false kept", async () => {
    const { calls, fetchImpl } = capture();
    await invokeRest(tool({ baseUrl: "${API}", method: "GET", path: "/x" }, [flags]), { flags: [true, false] }, { env: ENV, fetchImpl });
    expect(calls[0].url).toBe("https://api.acme.example/x?flags=true&flags=false");
  });

  it("list with explode: false joins with commas", async () => {
    const { calls, fetchImpl } = capture();
    await invokeRest(
      tool({ baseUrl: "${API}", method: "GET", path: "/x", query: { flags: { explode: false } } }, [flags]),
      { flags: [false, true] },
      { env: ENV, fetchImpl },
    );
    expect(calls[0].url).toBe("https://api.acme.example/x?flags=false%2Ctrue");
  });
});
