#!/usr/bin/env node
// The Showcase recorder (#170): runs scenarios S-15 .. S-21 for real and writes one transcript each.
//
//   node examples/showcase/record/record.mjs            write examples/showcase/transcripts/s-NN.json
//   node examples/showcase/record/record.mjs --check    regenerate into a temp dir; fail on any difference
//   node examples/showcase/record/record.mjs --out DIR  write there instead (used by the determinism test)
//   node examples/showcase/record/record.mjs --only S-17,S-18   a subset
//
// It drives the WORKSPACE build (packages/cli/dist, @archstone/agent, @archstone/runtime), so run
// `pnpm build` first. Every scenario states what it expects AND its negative; a false claim stops the
// scenario, names it, and the recorder exits 1 without writing anything.
//
// S-15 needs a Postgres admin URL in ARCHSTONE_TEST_PG_URL (the same variable the repository's
// real-Postgres suites use). Locally, without it, S-15 is skipped with a message and its committed
// transcript is left alone. Under CI (CI=true) a missing URL is a failure, never a skip.
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLI_JS, CLI_VERSION, RECORDED_DATE, SHOWCASE_DIR, ScenarioFailure, newContext } from "./lib.mjs";
import * as s15 from "./s15.mjs";
import * as s16 from "./s16.mjs";
import * as s17 from "./s17.mjs";
import * as s18 from "./s18.mjs";
import * as s19 from "./s19.mjs";
import * as s20 from "./s20.mjs";
import * as s21 from "./s21.mjs";

export const TRANSCRIPT_DIR = join(SHOWCASE_DIR, "transcripts");
const SCENARIOS = [s15, s16, s17, s18, s19, s20, s21];

/** Run one scenario; return its transcript as an object with a fixed key order. */
async function record(scenario) {
  const { meta } = scenario;
  const ctx = newContext(meta.id);
  try {
    await scenario.run(ctx);
  } finally {
    await ctx.end();
  }
  return {
    scenario: meta.id,
    title: meta.title,
    kind: meta.kind,
    recorded: { date: RECORDED_DATE, cli: CLI_VERSION },
    steps: ctx.steps,
    asserts: ctx.asserts,
    normalisation: ctx.norm.report(),
  };
}

/** Stable JSON: the key order above, two-space indent, one trailing newline. */
export const serialise = (transcript) => `${JSON.stringify(transcript, null, 2)}\n`;

/**
 * Two transcripts that differ ONLY in `recorded.cli`. A release stamps new version numbers into the
 * package files, which would otherwise turn every transcript stale on the release commit even though
 * nothing a reader sees changed. The stamp therefore says "recorded with" - the CLI version at which
 * the content last changed - and moves the next time the content does. `--check` still fails on any
 * other byte, and says when it let the stamp pass.
 */
function differsOnlyInStamp(committedText, freshText) {
  try {
    const a = JSON.parse(committedText);
    const b = JSON.parse(freshText);
    if (a?.recorded?.cli === b?.recorded?.cli) return false;
    a.recorded.cli = b.recorded.cli;
    return serialise(a) === freshText;
  } catch {
    return false;
  }
}

function parseArgs(argv) {
  const opts = { check: false, out: undefined, only: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--check") opts.check = true;
    else if (a === "--out") opts.out = argv[++i];
    else if (a === "--only") opts.only = new Set((argv[++i] ?? "").split(",").map((s) => s.trim().toUpperCase()));
    else throw new Error(`unknown argument: ${a}`);
  }
  if (opts.check && opts.out) throw new Error("--check and --out cannot be combined");
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!existsSync(CLI_JS)) {
    console.error(`record: ${CLI_JS} does not exist. Build the workspace first: pnpm build`);
    return 2;
  }

  const wanted = SCENARIOS.filter((s) => !opts.only || opts.only.has(s.meta.id));
  const staging = opts.out ? opts.out : mkdtempSync(join(tmpdir(), "archstone-showcase-transcripts-"));
  mkdirSync(staging, { recursive: true });

  const failed = [];
  const skipped = [];
  const produced = [];
  for (const scenario of wanted) {
    const { meta } = scenario;
    if (scenario.skipReason) {
      const reason = scenario.skipReason(process.env);
      if (reason) {
        if (process.env.CI) {
          failed.push(`${meta.id}: ${reason} Under CI this is a failure, never a skip.`);
        } else {
          skipped.push(`${meta.id} skipped: ${reason}`);
        }
        continue;
      }
    }
    try {
      const transcript = await record(scenario);
      writeFileSync(join(staging, meta.file), serialise(transcript));
      produced.push(meta);
      console.log(`  recorded ${meta.id}  ${meta.title}  (${transcript.asserts.length} claims held)`);
    } catch (err) {
      failed.push(err instanceof ScenarioFailure ? err.message : `${meta.id}: ${err?.stack ?? err}`);
    }
  }

  for (const line of skipped) console.warn(`  ${line}`);
  if (failed.length > 0) {
    console.error("\nrecord: FAILED\n" + failed.map((f) => `  - ${f}`).join("\n"));
    if (!opts.out) rmSync(staging, { recursive: true, force: true });
    return 1;
  }

  if (opts.check) {
    const problems = [];
    for (const meta of produced) {
      const committedPath = join(TRANSCRIPT_DIR, meta.file);
      const fresh = readFileSync(join(staging, meta.file), "utf8");
      if (!existsSync(committedPath)) {
        problems.push(`examples/showcase/transcripts/${meta.file} is missing (run: pnpm showcase:record)`);
        continue;
      }
      const committed = readFileSync(committedPath, "utf8");
      if (committed === fresh) continue;
      if (differsOnlyInStamp(committed, fresh)) {
        console.log(`  note: ${meta.file} was recorded with CLI ${JSON.parse(committed).recorded.cli}; this build is ${CLI_VERSION}. Content identical; the stamp moves the next time the content does.`);
        continue;
      }
      problems.push(`examples/showcase/transcripts/${meta.file} differs from a fresh recording (run: pnpm showcase:record, review the diff, commit it)`);
    }
    rmSync(staging, { recursive: true, force: true });
    if (problems.length > 0) {
      console.error("\nrecord --check: FAILED\n" + problems.map((p) => `  - ${p}`).join("\n"));
      return 1;
    }
    console.log(`record --check: ${produced.length} transcript(s) match a fresh recording${skipped.length ? `, ${skipped.length} skipped` : ""}.`);
    return 0;
  }

  if (!opts.out) {
    mkdirSync(TRANSCRIPT_DIR, { recursive: true });
    for (const meta of produced) cpSync(join(staging, meta.file), join(TRANSCRIPT_DIR, meta.file));
    rmSync(staging, { recursive: true, force: true });
    console.log(`record: wrote ${produced.length} transcript(s) to examples/showcase/transcripts/`);
  } else {
    console.log(`record: wrote ${produced.length} transcript(s) to ${opts.out}`);
  }
  return 0;
}

process.exit(await main());
