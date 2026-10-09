// S-16: `archstone apply <manifest> --exposure` - everything a model is shown, in one list.
//
// Expected: the list of what each capability exposes names none of the agency's margin, a guest's
// passport or phone, the raw HTML description, and no capability that deletes. Negative control:
// the same report's `withholds` lists show that the backend DOES return them, so their absence from
// `exposes` is the manifest's doing and not an accident of what the backend sends.
import { MANIFEST_REL, emptyNetLog, readNetLog } from "./lib.mjs";
import { join } from "node:path";
import { readFileSync } from "node:fs";

export const meta = { id: "S-16", file: "s-16.json", kind: "cli", title: "What exactly can the AI see? (apply --exposure)" };

const HIDDEN = ["margin", "passport", "phone", "description_html"];
const DELETE_LIKE = /delete|remove|erase|destroy|purge/i;

export async function run(ctx) {
  const dir = ctx.temp("work");
  const netLog = emptyNetLog(dir);
  const offline = { offline: true, netLog };

  const human = await ctx.cli(["apply", MANIFEST_REL, "--exposure"], offline);
  ctx.check("`apply --exposure` exits 0 on the live manifest", human.exit === 0);

  const json = await ctx.cli(["apply", MANIFEST_REL, "--exposure", "--json"], { ...offline, record: false });
  ctx.check("the same report as JSON exits 0", json.exit === 0);
  const report = JSON.parse(json.stdout).exposure;
  ctx.check("the report covers all 13 capabilities", report.length === 13);

  const exposed = report.flatMap((c) => c.exposes.map((f) => f.path));
  ctx.check("the exposed list is not empty (the check below is not vacuous)", exposed.length > 40);
  for (const word of HIDDEN) {
    ctx.check(`no exposed field is named or nested under '${word}'`, !exposed.some((p) => p.toLowerCase().includes(word)), { negative: true });
  }

  const ids = report.map((c) => c.capabilityId);
  ctx.check("no capability in the list deletes anything", !ids.some((id) => DELETE_LIKE.test(id)), { negative: true });

  // The resources a capability points at (Room, Amenity, ...) are not expanded in `exposes`, so
  // read their declared fields from the compiled IR as well.
  const irPath = join(dir, "ir.json");
  const built = await ctx.cli(["build", MANIFEST_REL, "--out", irPath], { ...offline, record: false });
  ctx.check("`build` exits 0 on the live manifest", built.exit === 0);
  const ir = JSON.parse(readFileSync(irPath, "utf8"));
  const declared = Object.values(ir.resources).flatMap((fields) => fields.map((f) => f.name));
  ctx.check("the manifest declares at least 30 resource fields in total", declared.length >= 30);
  for (const word of HIDDEN) {
    ctx.check(`no resource declares a field named '${word}'`, !declared.some((n) => n.toLowerCase().includes(word)), { negative: true });
  }

  // Negative control: the backend returns every one of these, and the report says so by name.
  const withheld = report.flatMap((c) => (Array.isArray(c.withholds) ? c.withholds.map((w) => w.path.toLowerCase()) : []));
  for (const word of HIDDEN) {
    ctx.check(`the backend was observed returning '${word}' (listed under withholds, never exposed)`, withheld.some((p) => p.includes(word)));
  }

  ctx.check("no outbound connection was attempted", readNetLog(netLog).length === 0, { negative: true });
}
