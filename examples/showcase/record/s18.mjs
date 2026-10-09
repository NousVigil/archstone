// S-18: `archstone diff <before> <after>` - what changed for an agent between two declarations.
//
// "Last week" is the live manifest minus one field and one action, built here from a copy: the
// `rating` field of a stay (and the line of the search binding that maps it) and the
// `wanderlust.quote` capability. "Today" is the live manifest. Expected: the diff names the added
// field and the added capability. Negative: it runs with the backend stopped - no server is
// started, the address it is given refuses connections, and no connection attempt is made at all.
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_DIR, MANIFEST_REL, copyTree, deadUrl, emptyNetLog, readNetLog } from "./lib.mjs";

export const meta = { id: "S-18", file: "s-18.json", kind: "cli", title: "What changed between last week and today? (diff)" };

function edit(path, from, to) {
  const text = readFileSync(path, "utf8");
  if (!text.includes(from)) throw new Error(`S-18 setup: expected to find ${JSON.stringify(from)} in ${path}`);
  writeFileSync(path, text.replace(from, to));
}

export async function run(ctx) {
  const work = ctx.temp("work");
  const before = join(work, "last-week");
  copyTree(MANIFEST_DIR, before);
  ctx.norm.path(before, "<before>", "temporary directory standing in for the earlier declaration");

  rmSync(join(before, "wanderlust.quote.capability.yaml"));
  rmSync(join(before, "bindings", "wanderlust.quote.binding.yaml"));
  edit(join(before, "capabilities.yaml"), "  - wanderlust.quote\n", "");
  // `rating` is the last field of the stay resource: drop it and everything after it.
  const stayFile = join(before, "wanderlust.Stay.resource.yaml");
  const stay = readFileSync(stayFile, "utf8");
  if (!stay.includes("\n    rating:")) throw new Error("S-18 setup: expected a rating field in the stay resource");
  writeFileSync(stayFile, `${stay.slice(0, stay.indexOf("\n    rating:"))}\n`);
  edit(join(before, "bindings", "wanderlust.search.binding.yaml"), '      rating: "$.rating"\n', "");

  const netLog = emptyNetLog(work);
  const env = { SHOWCASE_API_URL: await deadUrl() };
  const offline = { env, offline: true, netLog };

  const sanity = await ctx.cli(["apply", before], { ...offline, record: false });
  ctx.check("the earlier declaration is itself a valid manifest", sanity.exit === 0);

  const listed = await ctx.cli(["diff", before, MANIFEST_REL, "--all"], offline);
  ctx.check("`diff` exits 0: nothing in the change is breaking", listed.exit === 0);

  const json = await ctx.cli(["diff", before, MANIFEST_REL, "--all", "--json"], { ...offline, record: false });
  const report = JSON.parse(json.stdout);
  const fields = report.entries.filter((e) => e.kind === "resource-field-changed" && /added/.test(e.detail));
  const actions = report.entries.filter((e) => e.kind === "capability-added");
  ctx.check("it names exactly one added visible field: wanderlust.Stay.rating", fields.length === 1 && fields[0].resource === "wanderlust.Stay" && fields[0].path === "rating");
  ctx.check("it names exactly one added action: wanderlust.quote", actions.length === 1 && actions[0].capabilityId === "wanderlust.quote");
  ctx.check("it reports no breaking change", report.summary.breaking === 0, { negative: true });

  const refused = await fetch(`${env.SHOWCASE_API_URL}/health`).then(() => false, () => true);
  ctx.check("the backend is stopped: the address the commands were given refuses a connection", refused, { negative: true });
  ctx.check("no outbound connection was attempted by `diff`", readNetLog(netLog).length === 0, { negative: true });
}
