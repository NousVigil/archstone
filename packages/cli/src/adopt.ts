// @archstone/cli — `archstone adopt` (ADD-117 / ADR-0008).
//
// ADD-114 made `verify` NAME the fields a provider gained. This is the only way one of them
// becomes a field a model can use — and it is deliberately a human act. ADR-0008 forbids
// forwarding an undeclared field; adoption is the sanctioned crossing, with a person at the
// gate typing a description for each one.
//
// A VERB, not `verify --adopt` (D-1). `verify` is a read-only CI gate; a mutating flag on it
// invites someone to put `--adopt` in a pipeline, which is exactly how ADR-0008 R-1 says this
// feature fails. There is no `--yes` either (D-2) — `terminalAsk` already aborts cleanly when
// stdin ends with a question pending, so a piped or CI invocation writes nothing and exits
// non-zero by construction. That is a property of the shipped gate, not a new guard.

import { readFileSync, writeFileSync, mkdtempSync, cpSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { load } from "@archstone/schema";
import { compile, diffShape, validateSemantics, type IRTool, type ShapeMap } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";
import { adoptable, planAdoption } from "@archstone/runtime";
// ADR-0012 D-5: `recordContract`/`GoldenFixture` now come from the dedicated `/verify` subpath,
// not the package root — see `packages/runtime/src/index.ts`'s header comment.
import { recordContract, type GoldenFixture } from "@archstone/runtime/verify";
import { terminalAsk, type Ask } from "./init";
import { applyAdoption, applyContractRecording, type AdoptionEdit } from "./adopt-edit";

interface Target {
  tool: IRTool;
  resourceFile: string;
  bindingFile: string;
  /** #82: an `"output-array"` edit is written into the CAPABILITY document's `output:`, not
   *  the resource file — located alongside the other two so `adoptOne` never has to guess it. */
  capabilityFile: string;
}

/** Which files hold this capability's resource, its binding, and its own capability document.
 *  All three come from the loader, never from guessing a filename off a resource name. */
export function locateFiles(dir: string, tool: IRTool): Target | { problem: string } {
  const res = load(dir);
  const wanted = tool.response?.resource;
  if (!wanted) return { problem: `${tool.id}: no response mapping — nothing to adopt into` };

  // #177: an exact name wins outright. `find` over three OR-ed predicates returned whichever
  // document came first, so `wanderlust.Stay` could resolve to `tourism.Stay`'s file. The bare-name
  // fallback (a resource referenced without its namespace) is used only when it is unambiguous.
  const bare = wanted.includes(".") ? wanted.slice(wanted.lastIndexOf(".") + 1) : wanted;
  let doc = res.resourceDocs.find((d) => d.resource.name === wanted);
  if (!doc) {
    const candidates = res.resourceDocs.filter((d) => d.resource.name === bare || d.resource.name.endsWith(`.${bare}`));
    if (candidates.length > 1) {
      const names = candidates.map((d) => `'${d.resource.name}' (${d.file})`).join(", ");
      return { problem: `${tool.id}: resource '${wanted}' is ambiguous — it could be ${names}; nothing to adopt into until the reference is qualified` };
    }
    doc = candidates[0];
  }
  if (!doc) return { problem: `${tool.id}: could not find the file declaring resource '${wanted}'` };

  const binding = res.bindings.find((b) => b.binding.capabilityId === tool.id);
  if (!binding) return { problem: `${tool.id}: could not find its binding file` };

  const capabilityDoc = res.capabilityDocs.find((d) => d.capability.id === tool.id);
  if (!capabilityDoc) return { problem: `${tool.id}: could not find its capability file` };

  return { tool, resourceFile: join(dir, doc.file), bindingFile: join(dir, binding.file), capabilityFile: join(dir, capabilityDoc.file) };
}

function readFixture(dir: string, path: string): GoldenFixture | undefined {
  try {
    return JSON.parse(readFileSync(resolve(dir, path), "utf8")) as GoldenFixture;
  } catch {
    return undefined;
  }
}

/** y/N. Anything but an explicit yes is no — the default must never be "declare it". */
async function confirm(ask: Ask, question: string): Promise<boolean> {
  const answer = (await ask.question(`${question} [y/N] `)).trim().toLowerCase();
  return answer === "y" || answer === "yes";
}

/**
 * Prove the edit before keeping it.
 *
 * The modified documents are written into a COPY of the manifest and run through the real
 * loader and compiler — the same pipeline `apply` runs. Nothing reaches the user's files until
 * that passes, so a bug in the surgical append is a refused run rather than a corrupted
 * manifest (ADD-117 Challenge).
 */
function compilesClean(
  dir: string,
  resourceFile: string,
  resourceYaml: string,
  bindingFile: string,
  bindingYaml: string,
  capabilityFile: string,
  capabilityYaml: string,
): string | undefined {
  const scratch = mkdtempSync(join(tmpdir(), "archstone-adopt-"));
  try {
    cpSync(dir, scratch, { recursive: true });
    writeFileSync(join(scratch, resourceFile.slice(dir.length + 1)), resourceYaml);
    writeFileSync(join(scratch, bindingFile.slice(dir.length + 1)), bindingYaml);
    writeFileSync(join(scratch, capabilityFile.slice(dir.length + 1)), capabilityYaml);
    const res = load(scratch);
    if (!res.ok) return res.issues.map((i) => `${i.file}: ${i.message}`).join("; ");
    const errors = validateSemantics(res).filter((d) => d.severity === "error");
    if (errors.length > 0) return errors.map((e) => e.message).join("; ");
    compile(res);
    return undefined;
  } catch (err) {
    return (err as Error).message;
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

async function adoptOne(dir: string, target: Target, contractShape: ShapeMap | undefined, ask: Ask): Promise<number> {
  const { tool } = target;
  const fixture = readFixture(dir, tool.contract!.probeFixture);
  if (!fixture) {
    console.error(`  ${tool.id}: fixture not found or unreadable — nothing to replay`);
    return 1;
  }

  // ONE request (R-4). The drift and the contract that may be written both describe this
  // response; a second probe could describe a backend that changed in between.
  // The manifest's own resources, so the recording maps with each field's declared type — an
  // origin-checked field is then checked here as it is on every other path, and a withheld value
  // stops the adoption (red, names only) instead of being recorded.
  const resources = new Registry(compile(load(dir))).ir.resources;
  const recording = await recordContract(tool, fixture.request, resources, {});
  if (recording.outcome !== "green" && recording.outcome !== "yellow") {
    console.error(`  ${tool.id}: ${recording.detail}`);
    return 1;
  }
  const liveShape = recording.shape ?? {};

  // A contract with no recorded shape (one written before ADD-114) still works: every path
  // reads as added, and the planner refuses the ones already declared. That is exactly the
  // right answer, and it means adoption does not require a re-record first.
  const drift = diffShape(contractShape ?? {}, liveShape);
  const plan = planAdoption(tool, drift, resources);

  const offers = adoptable(plan);
  const refused = plan.candidates.filter((c) => !c.adoptable);
  if (refused.length > 0) {
    console.log(`\n  ${tool.id} — not adoptable:`);
    for (const c of refused) if (!c.adoptable) console.log(`    · ${c.path} (${c.observed}) — ${c.detail}`);
  }
  if (offers.length === 0) {
    console.log(`\n  ${tool.id} — nothing to adopt.`);
    return 0;
  }

  console.log(`\n  ${tool.id} — ${offers.length} field(s) the backend returns and the manifest does not declare:`);
  for (const o of offers) console.log(`    · ${o.path} (${o.observed}) → ${o.field}: ${o.semantic}`);
  console.log("");

  const edits: AdoptionEdit[] = [];
  for (const o of offers) {
    if (!(await confirm(ask, `  Declare ${o.field} (${o.semantic})?`))) continue;
    const description = (await ask.question(`  Describe ${o.field} — an agent reads this to decide whether to use it:\n  > `)).trim();
    if (description === "") {
      // D-4: a field with no description is declared but not discoverable, which is Rule #6's
      // letter against its purpose. Refusing is better than shipping a placeholder.
      console.log(`  ${o.field}: no description given — not adopted.`);
      continue;
    }
    edits.push({ field: o.field, itemPath: o.itemPath, semantic: o.semantic, description, kind: o.kind });
  }
  if (edits.length === 0) {
    console.log(`\n  ${tool.id} — nothing adopted.`);
    return 0;
  }

  const resourceYaml = readFileSync(target.resourceFile, "utf8");
  const bindingYaml = readFileSync(target.bindingFile, "utf8");
  const capabilityYaml = readFileSync(target.capabilityFile, "utf8");
  const applied = applyAdoption(resourceYaml, bindingYaml, capabilityYaml, edits);
  if (!applied.ok) {
    console.error(`  ${tool.id}: ${applied.problem}`);
    return 1;
  }
  const rewritten = applyContractRecording(applied.binding, recording.fingerprint!, liveShape as Record<string, string>);
  if (!rewritten.ok) {
    console.error(`  ${tool.id}: ${rewritten.problem}`);
    return 1;
  }

  const problem = compilesClean(
    dir,
    target.resourceFile,
    applied.resource,
    target.bindingFile,
    rewritten.binding,
    target.capabilityFile,
    applied.capability,
  );
  if (problem) {
    console.error(`\n  ${tool.id}: the edit does not compile — nothing written.\n    ${problem}`);
    return 1;
  }

  writeFileSync(target.resourceFile, applied.resource);
  writeFileSync(target.bindingFile, rewritten.binding);
  if (applied.capability !== capabilityYaml) writeFileSync(target.capabilityFile, applied.capability);
  console.log(`\n  ${tool.id} — declared ${edits.map((e) => e.field).join(", ")}; contract re-recorded.`);
  return 0;
}

export async function runAdoptCmd(argv: string[]): Promise<number> {
  const dir = argv.find((a, i) => i > 0 && !a.startsWith("-"));
  if (!dir) {
    console.error("usage: archstone adopt <manifest-dir>");
    return 2;
  }

  const res = load(dir);
  const errors = validateSemantics(res).filter((d) => d.severity === "error");
  if (!res.ok || errors.length > 0) {
    console.error(`archstone adopt ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    return 2;
  }

  const registry = new Registry(compile(res));
  const targets = registry.listCapabilities().filter((t) => t.contract);
  if (targets.length === 0) {
    console.log(`\narchstone adopt ${dir}\n\n  (no bindings declare a contract: — nothing to probe)\n`);
    return 0;
  }

  console.log(`\narchstone adopt ${dir}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = terminalAsk(rl);
  let worst = 0;
  try {
    for (const tool of targets) {
      const located = locateFiles(dir, tool);
      if ("problem" in located) {
        console.error(`  ${located.problem}`);
        worst = Math.max(worst, 1);
        continue;
      }
      worst = Math.max(worst, await adoptOne(dir, located, tool.contract!.shape, ask));
    }
  } catch (err) {
    // `terminalAsk` throws when stdin ends with a question pending — the piped/CI case. Nothing
    // has been written by then: every write happens after the last prompt for that capability.
    console.error(`\narchstone adopt: no more input — nothing written. Adoption needs a person (${(err as Error).name}).`);
    return 1;
  } finally {
    rl.close();
  }
  console.log("");
  return worst;
}
