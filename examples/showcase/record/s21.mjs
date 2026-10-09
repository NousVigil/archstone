// S-21: the embedded SDK (`@archstone/agent`): the same capabilities, ready for three AI vendors,
// with the same withholding and refusals as the MCP path.
//
// The runnable script is ../sdk/embedded.mjs. This scenario builds the IR with the CLI, runs the
// script against the synthetic API, and states the outcome again from its output so a script that
// stopped checking would be caught here. Negative: no request for a delete ever reached the backend.
import { join } from "node:path";
import { MANIFEST_REL, startApi } from "./lib.mjs";

export const meta = { id: "S-21", file: "s-21.json", kind: "sdk", title: "Use it inside my own app (embedded SDK: tools() and execute())" };

export async function run(ctx) {
  const work = ctx.temp("work");
  const api = await startApi();
  ctx.onEnd(api.close);
  ctx.registerApi(api);
  const ir = join(work, "ir.json");

  const built = await ctx.cli(["build", MANIFEST_REL, "--out", ir]);
  ctx.check("`build` exits 0 and writes the IR the SDK loads", built.exit === 0);

  const script = await ctx.node("examples/showcase/sdk/embedded.mjs", ["--ir", ir, "--api", api.url]);
  ctx.check("the embedded script exits 0 (it exits 1 when any of its own expectations fails)", script.exit === 0);
  const report = JSON.parse(script.stdout);

  ctx.check("the same tools are offered in three vendor shapes (anthropic, openai-chat, gemini)", Object.keys(report.vendorShapes).sort().join() === "anthropic,gemini,openai-chat" && Object.values(report.vendorShapes).every((v) => v.tools === report.toolNames.length));
  ctx.check("the three envelopes differ from each other, the tool list does not", new Set(Object.values(report.vendorShapes).map((v) => v.envelopeKeys.join())).size === 3);
  ctx.check("S-02 holds: stay-details ran (ok) and returned none of margin, passport, phone, description_html, net, commission or the guest list", report.stayDetails.status === "ok" && report.stayDetails.forbiddenKeysFound.length === 0, { negative: true });
  ctx.check("S-14 holds: no tool deletes, and asking for one is refused as an unknown capability", !report.toolNames.some((n) => /delete|remove|erase/i.test(n)) && report.deleteRequest.status === "error" && /unknown capability/.test(report.deleteRequest.error), { negative: true });
  ctx.check("the refused request never reached the backend: the only request it saw was the stay lookup", api.requests.length === 1 && api.requests[0] === "GET /v1/stays/ws-1001", { negative: true });
}
