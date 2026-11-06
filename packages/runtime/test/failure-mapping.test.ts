// RFC-0011 D-8/D-9 over MCP: a mapped 4xx becomes the token and its description, with the
// business-failure `_meta` object and nothing from the provider's body; everything else is
// unchanged.

import { describe, it, expect } from "vitest";
import type { IR, IRTool } from "@archstone/compiler";
import { Registry, type ExecutionRecord } from "@archstone/emitter-support";
import type { FetchLike } from "@archstone/provider-rest";
import { callTool, BUSINESS_FAILURE_META_KEY } from "../src/server";

const tool: IRTool = {
  id: "games.prices",
  description: "Look up prices.",
  effect: "read",
  provider: "store",
  policies: [],
  lifecycle: "stable",
  input: [],
  output: [{ name: "price", required: true, type: { kind: "scalar", semantic: "text" } }],
  connector: { type: "rest", rest: { baseUrl: "https://store.example", method: "GET", path: "/prices" } },
  extract: [{ name: "price", path: "$.price" }],
  failures: [
    { status: 404, body: { path: "$.error.code", equals: "game_not_found" }, failure: "game-not-found", description: "The game id does not exist." },
    { status: 409, failure: "already-refunded", description: "The purchase was already refunded." },
  ],
};

const registry = new Registry({ version: "0", company: { id: "acme" }, tools: [tool], resources: {} } satisfies IR);
const reply = (status: number, body: unknown): FetchLike => async () =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

async function call(status: number, body: unknown) {
  const records: ExecutionRecord[] = [];
  const result = await callTool(registry, "games_prices", {}, { fetchImpl: reply(status, body), auditSink: (r) => void records.push(r) });
  return { result, records };
}

describe("a mapped 4xx", () => {
  it("is the token and its description, with the business-failure _meta and nothing from the body", async () => {
    const { result, records } = await call(404, { error: { code: "game_not_found", message: "SECRET-BODY-TEXT" } });
    expect(result).toEqual({
      content: [{ type: "text", text: "game-not-found: The game id does not exist." }],
      _meta: { [BUSINESS_FAILURE_META_KEY]: { error: "business_failure", capability: "games.prices", failure: "game-not-found" } },
      isError: true,
    });
    expect(BUSINESS_FAILURE_META_KEY).toBe("dev.archstone/business_failure");
    const json = JSON.stringify(result);
    expect(json).not.toContain("SECRET-BODY-TEXT");
    expect(json).not.toContain("game_not_found");
    expect(json).not.toContain("404");
    expect("structuredContent" in result).toBe(false);
    expect(records).toHaveLength(1);
    expect(records[0]!.status).toMatchObject({ phase: "failed", message: "game-not-found", reachedConnector: true });
    expect(JSON.stringify(records[0])).not.toContain("SECRET-BODY-TEXT");
  });

  it("a body-less entry matches a non-JSON body", async () => {
    const { result } = await call(409, "conflict: SECRET-BODY-TEXT");
    expect(result.content).toEqual([{ type: "text", text: "already-refunded: The purchase was already refunded." }]);
    expect(JSON.stringify(result)).not.toContain("SECRET-BODY-TEXT");
  });
});

describe("everything else is unchanged", () => {
  it.each([
    ["a 404 whose body test does not match", 404, { error: { code: "other" } }],
    ["an unmapped 4xx", 400, { error: { code: "game_not_found" } }],
    ["a 5xx", 500, { error: { code: "game_not_found" } }],
  ])("%s stays 'backend returned N', with no _meta", async (_label, status, body) => {
    const { result, records } = await call(status, body);
    expect(result).toEqual({ content: [{ type: "text", text: `backend returned ${status}` }], isError: true });
    expect(records[0]!.status).toMatchObject({ phase: "failed", message: `backend returned ${status}`, reachedConnector: true });
  });
});
