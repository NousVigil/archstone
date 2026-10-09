// S-20: `archstone init <openapi>` - start from the description of an existing system.
//
// `init` proposes one candidate per operation in the document (16 here) and emits only the ones a
// person confirms, each with an effect the person chose; it never defaults one. The decisions are the
// person's answers in a file (s20-decisions.json): three operations kept, the DELETE declined.
//
// Expected: the draft holds exactly the confirmed capabilities. Negative: it has no delete action;
// it carries no passport, phone, email or margin (the document describes no response shapes, so
// there is nothing to copy them from); it wrote only inside --out; it made no connection and ran no
// probe; and nothing was published (init has no publishing step: it writes files for a person to
// review).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { REPO_ROOT, emptyNetLog, readNetLog } from "./lib.mjs";

export const meta = { id: "S-20", file: "s-20.json", kind: "cli", title: "Start from the description of my existing system (init)" };

const SPEC = "examples/showcase/api/wanderlust.openapi.yaml";
const DECISIONS = "examples/showcase/record/s20-decisions.json";

function filesUnder(dir, prefix = "") {
  return readdirSync(dir, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((e) => (e.isDirectory() ? filesUnder(join(dir, e.name), `${prefix}${e.name}/`) : [`${prefix}${e.name}`]));
}

export async function run(ctx) {
  const work = ctx.temp("work");
  const draft = join(work, "draft");
  ctx.norm.path(draft, "<draft>", "the directory init was told to write to");
  const netLog = emptyNetLog(work);

  const decisions = JSON.parse(readFileSync(join(REPO_ROOT, DECISIONS), "utf8"));
  const kept = decisions.decisions.filter((d) => d.keep);
  const declined = decisions.decisions.filter((d) => !d.keep);

  const init = await ctx.cli(["init", SPEC, "--out", draft, "--decisions", DECISIONS, "--non-interactive"], { offline: true, netLog });
  ctx.check("`init` exits 0", init.exit === 0);
  ctx.check("it proposed 16 candidates, one per operation in the document", /Candidates: 16 proposed/.test(init.stdout));
  ctx.check(`it emitted exactly the ${kept.length} confirmed capabilities`, new RegExp(`${kept.length} emitted`).test(init.stdout));

  // Without a decisions file there is no person to confirm an effect, and `init` never defaults one.
  const refusedDir = join(work, "refused");
  ctx.norm.path(refusedDir, "<refused>", "a directory init was told to write to and did not");
  const refused = await ctx.cli(["init", SPEC, "--out", refusedDir, "--non-interactive"], { offline: true, netLog });
  ctx.check("`init --non-interactive` without --decisions refuses (non-zero): it never defaults an effect", refused.exit !== 0 && /never defaults an `effect`/.test(refused.stderr + refused.stdout));
  ctx.check("and it wrote nothing: the output directory does not exist", !existsSync(refusedDir), { negative: true });

  const files = filesUnder(draft);
  // The manifest the draft IS: everything but INIT-REPORT.md, which by design lists what was declined.
  const manifestFiles = files.filter((f) => f !== "INIT-REPORT.md");
  const everything = manifestFiles.map((f) => readFileSync(join(draft, f), "utf8")).join("\n");

  ctx.check("the draft has a capability file for each confirmed capability and no other", kept.every((d) => files.includes(`${d.capabilityId}.capability.yaml`)) && files.filter((f) => f.endsWith(".capability.yaml")).length === kept.length);
  ctx.check(
    "the DELETE operation is in the document, so it was proposed, and the person declined it",
    /^ {4}delete:/m.test(readFileSync(join(REPO_ROOT, SPEC), "utf8")) && declined.some((d) => d.operation.startsWith("DELETE ")) && /Declined by you \(1\)/.test(init.stdout),
  );
  ctx.check("the draft contains no delete action: no DELETE method, no capability or path that deletes", !/method:\s*DELETE/i.test(everything) && !/\/guests\//.test(everything) && !manifestFiles.some((f) => /delete|remove|erase/i.test(f)), { negative: true });
  for (const word of ["passport", "phone", "email", "margin", "commission", "description_html"]) {
    ctx.check(`the draft mentions no '${word}'`, !everything.toLowerCase().includes(word), { negative: true });
  }
  ctx.check("no capability was drafted with a response mapping or a recorded contract (no probe ran)", !/\n\s+response:\s*\n/.test(everything.replace(/#.*$/gm, "")) && !/\n\s+contract:/.test(everything), { negative: true });

  ctx.check("it wrote only inside --out: capabilities.yaml, the capability and binding files, and its report", files.every((f) => f === "capabilities.yaml" || f === "INIT-REPORT.md" || /^[\w.-]+\.capability\.yaml$/.test(f) || /^bindings\/[\w.-]+\.binding\.yaml$/.test(f)));
  ctx.check("nothing was published: `init` made no outbound connection of any kind", readNetLog(netLog).length === 0, { negative: true });

  const applied = await ctx.cli(["apply", draft], { record: false });
  ctx.check("the draft compiles with the shipped compiler (`apply` exits 0)", applied.exit === 0);
}
