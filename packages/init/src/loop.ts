// @archstone/init/loop — the closed loop (ADD-37 §6 step 3).
//
// THE PRODUCT IS THE LOOP, NOT THE GENERATOR. Generation alone loses to "paste your spec into
// an assistant and ask for CDL"; generation that the REAL compiler immediately compiles does
// not. So this module's whole job is to stand between the emitted bytes and the developer's
// directory, and to have exactly two terminal states (D-7):
//
//     a compiling manifest was written   |   nothing was written, and here is why
//
// There is no "mostly works, fix the errors yourself" mode. That is an invariant with a test,
// not a quality goal — a tool that writes files it cannot defend is the thing the integrating
// developer is most afraid of (product §2).
//
// WHY A TEMP DIRECTORY (O-8): `load()` is fs-only — there is no in-memory entry point — and
// this increment deliberately does NOT refactor it for one caller's convenience. The emitted
// file set is materialized to a temp dir, compiled there, and only COPIED FROM THERE on
// success, so the bytes that land in the target are byte-for-byte the bytes that compiled.
//
// This is the only module in the package that touches a filesystem. The root export
// (`@archstone/init`) is pure and stays that way; that split is what lets a hosted flow reuse
// the inference core verbatim (§9's forward constraint).

import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, normalize, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { load, type LoadIssue } from "@archstone/schema";
import { compile, validateSemantics, type IR } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";
import type { RecordContractOptions } from "@archstone/runtime/verify";
import { emit, type EmitResult, type RecordedContract } from "./emit";
import { keptDecisions, type DecisionRecord } from "./decisions";
import type { DraftModel } from "./model";
import { runProbes, verifyRecorded, type ProbeReport } from "./probe";

/**
 * Why nothing was written.
 *
 * A SEPARATE vocabulary from `ReasonCode` (reasons.ts) on purpose: a skip is per-candidate and
 * informational — the run still succeeds — while every code here is terminal for the whole
 * manifest. One shared enum would let those two very different states share a word.
 */
export type LoopFailureCode =
  /** The emitter produced no files at all (e.g. an empty confirmed set). Already a refusal
   *  upstream; re-checked here because this module must never write an empty manifest. */
  | "empty-file-set"
  /** A relative path escaping the target directory. Never expected from the shipped emitter —
   *  present because this function writes to a path a caller supplied. */
  | "unsafe-path"
  /** `load()` rejected a shape. */
  | "shape-invalid"
  /** `validateSemantics` reported an error (an unresolvable resource, an unknown provider). */
  | "semantic-error"
  /** Two capability ids sanitize to the same advertised tool name. `apply` and `build` both
   *  refuse such a manifest (ADD-30 D-2); `init` must refuse the identical one, or it becomes
   *  the one tool in the toolchain that writes something the rest will not accept. */
  | "tool-name-collision"
  /** The target directory already has content and `--force` was not given. */
  | "target-not-empty"
  /** The filesystem refused. */
  | "write-failed";

export interface LoopFailure {
  code: LoopFailureCode;
  message: string;
  /** The manifest file the failure is about, when it is about one. */
  file?: string;
}

export interface LoopResult {
  ok: boolean;
  /** Absolute paths written. ALWAYS empty when `ok` is false — there is no partial write. */
  written: string[];
  failures: LoopFailure[];
  /** The compiled IR of the manifest that was written. Present only on success — the harness
   *  and the report both read it, and neither should ever see a half-compiled one. */
  ir?: IR;
}

export interface CommitOptions {
  /** Where the manifest should end up. Created if missing. */
  targetDir: string;
  /** Write into a non-empty target. The only escape from "strictly fresh". */
  force?: boolean;
  /** Parent for the temp directory. Defaults to the OS temp dir. */
  tmpRoot?: string;
}

/** Reject anything that would escape the directory it is written into. */
function isSafeRelativePath(path: string): boolean {
  if (path === "" || isAbsolute(path)) return false;
  const normalized = normalize(path);
  return !normalized.startsWith(`..${sep}`) && normalized !== ".." && !normalized.split(/[\\/]/).includes("..");
}

function writeFileSet(dir: string, files: ReadonlyMap<string, string>): void {
  for (const [relative, content] of files) {
    const target = join(dir, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

function isNonEmptyDirectory(path: string): boolean {
  if (!existsSync(path)) return false;
  const stat = statSync(path);
  if (!stat.isDirectory()) return true; // a FILE at the target path is certainly "not empty"
  return readdirSync(path).length > 0;
}

/**
 * Compile a manifest directory exactly the way the rest of the toolchain does — `load` →
 * `validateSemantics` → `compile` → `new Registry()` — and report the first stage that
 * refused.
 *
 * The tool-name-collision check reads `Registry.toolNameCollisions`, the same computed value
 * `apply`, `build` and `serve` all gate on, rather than re-deriving "which ids sanitize to the
 * same name" here. Two implementations of that question is exactly the drift the shared
 * registry exists to remove.
 */
export function compileManifest(dir: string): { ok: boolean; ir?: IR; failures: LoopFailure[]; issues: LoadIssue[] } {
  const failures: LoopFailure[] = [];
  const model = load(dir);
  for (const issue of model.issues) {
    failures.push({ code: "shape-invalid", message: issue.message, file: issue.file });
  }

  const diagnostics = validateSemantics(model);
  for (const d of diagnostics) {
    if (d.severity === "error") failures.push({ code: "semantic-error", message: d.message });
  }

  if (failures.length > 0) return { ok: false, failures, issues: model.issues };

  const ir = compile(model);
  const registry = new Registry(ir);
  for (const collision of registry.toolNameCollisions) {
    failures.push({
      code: "tool-name-collision",
      message: `tool name '${collision.name}' is ambiguous — capabilities ${collision.ids.join(", ")} all sanitize to it`,
    });
  }
  if (failures.length > 0) return { ok: false, failures, issues: model.issues };

  return { ok: true, ir, failures, issues: model.issues };
}

/**
 * Materialize an emitted file set, compile it, and commit it to the target ONLY if it compiled.
 *
 * On any failure the temp directory is removed and the target is left exactly as it was —
 * including "does not exist". A caller can therefore treat `ok === false` as "the developer's
 * directory is untouched", with no cleanup of its own.
 */
export function commitFileSet(files: ReadonlyMap<string, string>, opts: CommitOptions): LoopResult {
  const failures: LoopFailure[] = [];

  if (files.size === 0) {
    return { ok: false, written: [], failures: [{ code: "empty-file-set", message: "nothing to write" }] };
  }
  for (const relative of files.keys()) {
    if (!isSafeRelativePath(relative)) {
      failures.push({ code: "unsafe-path", message: `refusing to write outside the target directory`, file: relative });
    }
  }
  if (failures.length > 0) return { ok: false, written: [], failures };

  const target = resolve(opts.targetDir);
  if (isNonEmptyDirectory(target) && opts.force !== true) {
    return {
      ok: false,
      written: [],
      failures: [{ code: "target-not-empty", message: `${target} is not empty — re-run with force to overwrite` }],
    };
  }

  const temp = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "archstone-init-"));
  try {
    try {
      // FORCE MERGES, and a merge is not what was compiled unless it is compiled.
      //
      // Committing into a non-empty target leaves behind whatever the previous run wrote and
      // this one does not — a capability file for a candidate the human has since declined, a
      // resource nothing references any more. Those files are still `load()`ed, so the manifest
      // that ends up on disk is the UNION, and validating only the emitted half would report
      // "a compiling manifest was written" about a directory that does not compile (verified:
      // a stale capability referencing a deleted resource does exactly this).
      //
      // So the temp dir is seeded with the target's current contents and the emitted files are
      // overlaid on top: what gets compiled below is byte-for-byte what the target will become.
      // If the union does not compile, nothing is written and the developer is told which
      // leftover file broke it.
      if (opts.force === true && existsSync(target) && statSync(target).isDirectory()) {
        cpSync(target, temp, { recursive: true });
      }
      writeFileSet(temp, files);
    } catch (err) {
      return { ok: false, written: [], failures: [{ code: "write-failed", message: (err as Error).message }] };
    }

    const compiled = compileManifest(temp);
    if (!compiled.ok || !compiled.ir) {
      return { ok: false, written: [], failures: compiled.failures };
    }

    // Commit: copy the VALIDATED bytes out of the temp dir, never re-render them.
    try {
      mkdirSync(target, { recursive: true });
      cpSync(temp, target, { recursive: true, force: true });
    } catch (err) {
      return { ok: false, written: [], failures: [{ code: "write-failed", message: (err as Error).message }] };
    }

    return { ok: true, written: [...files.keys()].map((relative) => join(target, relative)).sort(), failures: [], ir: compiled.ir };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Compile two manifest directories and diff their IRs — the fs-facing half of the harness.
 *  The comparison itself is pure and lives in the root export (`diffIR`). */
export function compileForDiff(dir: string): IR {
  const compiled = compileManifest(dir);
  if (!compiled.ok || !compiled.ir) {
    const detail = compiled.failures.map((f) => `${f.file ? `${f.file}: ` : ""}${f.message}`).join("; ");
    throw new Error(`cannot compile '${dir}' for comparison — ${detail}`);
  }
  return compiled.ir;
}

// ---------------------------------------------------------------------------------------
// The whole loop, including the probe leg (ADD-37 §6 step 6)
// ---------------------------------------------------------------------------------------

export interface RunInitOptions extends CommitOptions {
  /** The `--probe` opt-in. Absent/false ⇒ NO request is made, under any circumstances, for
   *  any capability, whatever the Decision Record says. Opt-in at the top level, then gated
   *  again per capability (R-8). */
  probe?: boolean;
  /** False for CI and for a Decision Record file. Governs only the non-`GET`/`HEAD` second
   *  confirmation, which is a human act. */
  interactive?: boolean;
  /** Threaded to `invokeRest` for env resolution and, in tests, a stub fetch. */
  invoke?: RecordContractOptions;
}

export interface InitResult extends LoopResult {
  emitted: EmitResult;
  /** One entry per kept decision when probing, empty otherwise. */
  probes: ProbeReport[];
  /** What the real `runVerify` said about the contracts that were written. */
  verifications: { capabilityId: string; status: string; detail: string }[];
}

/**
 * Draft Model + Decision Record → a compiling manifest on disk, or nothing at all.
 *
 * The sequence, and why it is this shape:
 *
 *   1. emit WITHOUT contracts, materialize, compile. The probe needs a compiled `IRTool` — it
 *      calls the backend the way the manifest says to, not the way the draft implies.
 *   2. probe (gated per capability), producing recordings.
 *   3. re-emit WITH the recordings, materialize again, compile again, and run the REAL
 *      `runVerify` over that directory. A contract that cannot be replayed is dropped here,
 *      before anything reaches the developer.
 *   4. emit a final time with only the surviving contracts, and commit.
 *
 * Three materializations rather than one, deliberately: each stage compiles the exact bytes
 * the next stage acts on, so "a compiling manifest was written" is never inferred from a
 * different set of bytes than the ones that landed.
 */
export async function runInit(draft: DraftModel, record: DecisionRecord, opts: RunInitOptions): Promise<InitResult> {
  const kept = keptDecisions(record);
  const emptyResult = (emitted: EmitResult, failures: LoopFailure[]): InitResult => ({
    ok: false,
    written: [],
    failures,
    emitted,
    probes: [],
    verifications: [],
  });

  const firstPass = emit(draft, record);
  if (firstPass.files.size === 0) {
    // D-7's manifest-level refusal, already decided by the emitter (an empty confirmed set, an
    // invalid company id). Nothing is written and the notes say why.
    return emptyResult(firstPass, [{ code: "empty-file-set", message: "the emitter refused — see the report's notes" }]);
  }

  if (opts.probe !== true) {
    const committed = commitFileSet(firstPass.files, opts);
    return { ...committed, emitted: firstPass, probes: [], verifications: [] };
  }

  const staging = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "archstone-init-probe-"));
  try {
    writeFileSet(staging, firstPass.files);
    const compiled = compileManifest(staging);
    if (!compiled.ok || !compiled.ir) return emptyResult(firstPass, compiled.failures);

    const probes = await runProbes(compiled.ir, kept, {
      ...opts.invoke,
      interactive: opts.interactive === true,
      ...(record.identities ? { identities: record.identities } : {}),
    });

    const recorded = new Map<string, RecordedContract>();
    for (const probe of probes) if (probe.contract) recorded.set(probe.capabilityId, probe.contract);

    if (recorded.size === 0) {
      const committed = commitFileSet(firstPass.files, opts);
      return { ...committed, emitted: firstPass, probes, verifications: [] };
    }

    // Re-emit with the recordings and REPLAY them, in a second staging directory, before any
    // of it is offered to the developer (R-1).
    const replayDir = mkdtempSync(join(opts.tmpRoot ?? tmpdir(), "archstone-init-replay-"));
    try {
      const withContracts = emit(draft, record, recorded);
      writeFileSet(replayDir, withContracts.files);
      const recompiled = compileManifest(replayDir);
      if (!recompiled.ok || !recompiled.ir) return emptyResult(withContracts, recompiled.failures);

      const { green, reports } = await verifyRecorded(recompiled.ir, replayDir, opts.invoke);
      const survivors = new Map([...recorded].filter(([id]) => green.has(id)));

      // A contract that recorded green and then failed its own replay is dropped, not shipped.
      // The manifest still lands; only the safety net that could not be trusted is withheld.
      const finalPass = survivors.size === recorded.size ? withContracts : emit(draft, record, survivors);
      const committed = commitFileSet(finalPass.files, opts);
      return { ...committed, emitted: finalPass, probes, verifications: reports };
    } finally {
      rmSync(replayDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}
