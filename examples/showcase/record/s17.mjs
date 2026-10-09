// S-17: the backend gains a field. `verify` notices and names it; the field stays out of what a
// model sees until a PERSON declares it with `adopt`.
//
// The synthetic API has no such switch and never will. The recorder WRAPS its handler (`api.transform`)
// to add a `guestEmail` to the stay-details response, which is exactly what "the agency's
// developers added a field" looks like from outside.
//
// Order: verify green -> the field appears -> verify names it (yellow, exit 0) -> the exposure does not
// list it -> `adopt` with nobody at the keyboard writes nothing and fails -> `adopt` with a person's
// answers declares it -> the exposure lists it -> verify is green again.
//
// The capability is wanderlust.stay-details, not wanderlust.search, because `adopt` resolves a
// resource by bare name and the manifest has two resources called Stay (tourism.Stay and
// wanderlust.Stay): adopting into search would edit the wrong file. That is a known bug, #177.
//
// The "person" is scripted: their answers are in the transcript under `typed`, and each is sent
// only after the question it answers has been printed. Archstone does not judge whether that email
// field SHOULD reach a model; declaring it is the person's decision, and it is made here only to
// show where the decision lives.
/* global URL, Headers, Response */
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { MANIFEST_DIR, copyTree, startApi } from "./lib.mjs";

export const meta = { id: "S-17", file: "s-17.json", kind: "cli", title: "The agency added a guest email field (verify, adopt)" };

const FIELD = "guestEmail";
const DESCRIPTION = "The lead guest's email address, as the agency holds it.";

/** A fingerprint of every file in a directory tree, to prove a command wrote nothing. */
function snapshot(dir) {
  const h = createHash("sha256");
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const p = join(d, entry.name);
      if (entry.isDirectory()) walk(p);
      else h.update(p).update(readFileSync(p));
    }
  };
  walk(dir);
  return h.digest("hex");
}

export async function run(ctx) {
  const work = ctx.temp("work");
  const manifest = join(work, "manifest");
  copyTree(MANIFEST_DIR, manifest);
  ctx.norm.path(manifest, "<manifest>", "temporary copy of the live manifest (adopt writes to it)");

  const api = await startApi();
  ctx.onEnd(api.close);
  ctx.registerApi(api);
  const env = { SHOWCASE_API_URL: api.url };

  const exposedFor = async (id) => {
    const r = await ctx.cli(["apply", manifest, "--exposure", "--json"], { env, record: false });
    const entry = JSON.parse(r.stdout).exposure.find((c) => c.capabilityId === id);
    return entry.exposes.map((f) => f.path);
  };

  // 1. baseline
  const baseline = await ctx.cli(["verify", manifest], { env });
  ctx.check("before the change, `verify` exits 0 (the contract holds)", baseline.exit === 0);

  // 2. the backend gains a field
  api.transform = async (request, response) => {
    if (request.method !== "GET" || !/^\/v1\/stays\/[^/]+$/.test(new URL(request.url).pathname)) return undefined;
    const body = await response.json();
    body[FIELD] = "ana.pop@guest.example";
    const headers = new Headers(response.headers);
    headers.delete("content-length");
    return new Response(JSON.stringify(body), { status: response.status, headers });
  };

  const untouched = snapshot(manifest);
  const drifted = await ctx.cli(["verify", manifest], { env });
  // In this version a GAINED field is a yellow reading (ADR-0008: the contract still holds, there is
  // simply more than was recorded), so `verify` names it and exits 0. Only a lost field, a changed
  // type or a missing required value turn it red and exit 1. A strict `verify` that exits non-zero on
  // a gained field is not available in this version; it is tracked in #178, and the claim below puts
  // that pointer in the rendered transcript.
  ctx.check("strict verify (exit non-zero on a gained field): not available in this version - #178", drifted.exit === 0);
  ctx.check(`after the change, \`verify\` names the new field: a yellow reading on wanderlust.stay-details, "gained 1 field(s): $.${FIELD}"`, /🟡 wanderlust\.stay-details — .*gained 1 field\(s\): \$\.guestEmail \(string\)/.test(drifted.stdout));
  ctx.check("and the other capabilities' readings did not change (no other line is yellow or red)", (drifted.stdout.match(/🟡|🔴/g) ?? []).length === 1);
  ctx.check("`verify` is a read-only check: the manifest is byte-identical after it", snapshot(manifest) === untouched, { negative: true });

  // 3. not exposed until declared
  const before = await exposedFor("wanderlust.stay-details");
  ctx.check(`the field is absent from the exposure while undeclared`, !before.some((p) => p.includes(FIELD)), { negative: true });

  // 4. adopt with nobody there
  const frozen = snapshot(manifest);
  const nobody = await ctx.cli(["adopt", manifest], { env, typed: [] });
  ctx.check("`adopt` with nobody at the keyboard exits non-zero", nobody.exit !== 0);
  ctx.check("`adopt` with nobody at the keyboard writes nothing", snapshot(manifest) === frozen, { negative: true });
  ctx.check("the field is still absent from the exposure", !(await exposedFor("wanderlust.stay-details")).some((p) => p.includes(FIELD)), { negative: true });

  // 5. adopt, by a person
  const adopted = await ctx.cli(["adopt", manifest], {
    env,
    typed: [
      { prompt: "[y/N] ", send: "y" },
      { prompt: "  > ", send: DESCRIPTION },
    ],
  });
  ctx.check("`adopt` with a person's answers exits 0", adopted.exit === 0);
  ctx.check("it reports the field declared and the contract re-recorded", /declared guestEmail; contract re-recorded/.test(adopted.stdout));
  ctx.check("the field is in the exposure now that a person declared it", (await exposedFor("wanderlust.stay-details")).some((p) => p.includes(FIELD)));

  // 6. converged
  const after = await ctx.cli(["verify", manifest], { env });
  ctx.check("`verify` exits 0 again once the field is declared", after.exit === 0);
}
