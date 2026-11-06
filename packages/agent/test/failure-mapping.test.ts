// RFC-0011 D-8/D-9 in the embedded SDK: a mapped 4xx is the `"failure"` outcome, carrying the token
// and its description and nothing from the body; an unmapped one stays `"error"`.

import { describe, it, expect } from "vitest";
import type { IR, IRTool } from "@archstone/compiler";
import type { ExecutionRecord } from "@archstone/emitter-support";
import { fromIR, type FetchLike } from "../src/index";

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
  failures: [{ status: 404, body: { path: "$.error.code", equals: "game_not_found" }, failure: "game-not-found", description: "The game id does not exist." }],
};
const ir: IR = { version: "0", company: { id: "acme" }, tools: [tool], resources: {} };
const reply = (status: number, body: unknown): FetchLike => async () => new Response(JSON.stringify(body), { status });

describe("execute() and a binding failure mapping", () => {
  it("a mapped 4xx is status 'failure' with the token and description, audited as the token", async () => {
    const records: ExecutionRecord[] = [];
    const r = await fromIR(ir).execute(
      "games.prices",
      {},
      { fetchImpl: reply(404, { error: { code: "game_not_found", message: "SECRET-BODY-TEXT" } }), auditSink: (rec) => void records.push(rec) },
    );
    expect(r).toEqual({ status: "failure", failure: "game-not-found", description: "The game id does not exist." });
    expect(JSON.stringify(r)).not.toContain("SECRET-BODY-TEXT");
    expect(records[0]!.status).toMatchObject({ phase: "failed", message: "game-not-found", reachedConnector: true });
  });

  it("an unmapped 4xx and a 5xx stay status 'error'", async () => {
    for (const [status, body] of [[404, { error: { code: "other" } }], [500, { error: { code: "game_not_found" } }]] as const) {
      const r = await fromIR(ir).execute("games.prices", {}, { fetchImpl: reply(status, body) });
      expect(r).toEqual({ status: "error", error: `backend returned ${status}` });
    }
  });
});
