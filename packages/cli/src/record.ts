// @archstone/cli — `archstone record`.
//
// Records a `contract:` for an EXISTING manifest's bindings. Until this verb, the only way to get
// one was `archstone init --probe`, and only while `init` was writing a brand-new manifest: a
// manifest written by hand, or one whose contract was never recorded, had no path to a contract
// short of calling `recordContract` from a one-off script and pasting `fingerprint` and `shape`
// into each binding.
//
// A VERB, not `verify --record` — for the reason `adopt` is one (ADD-117 D-1). `verify` is a
// read-only CI gate; a mutating flag on it invites someone to put it in a pipeline, and then a
// pipeline re-records the contract every time the backend drifts, which turns the drift check
// into a rubber stamp. There is no `--yes` either: every request and every write is a y/N a
// person answers, and `terminalAsk` throws when stdin ends with a question pending, so a piped or
// CI invocation sends nothing, writes nothing and exits non-zero by construction.
//
// What it will never do, whatever is answered:
//   · issue a request for a `write` or `irreversible` capability. Recording is a live call, and
//     `effect` is the human-confirmed statement of what a call does.
//   · record a `sql` binding. Its contract is only meaningful with the two isolation identities
//     ADR-0012 D-8 requires, which is `init --probe`'s gate, not this one.
//   · touch the fixture. It is the human's statement of the input to replay; the recording's
//     timestamp goes into `verifiedAt`, not back into their file.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { load } from "@archstone/schema";
import { compile, validateSemantics, type IRTool } from "@archstone/compiler";
import { Registry } from "@archstone/emitter-support";
import { recordContract, type GoldenFixture } from "@archstone/runtime/verify";
import { terminalAsk, type Ask } from "./init";
import { compilesClean, confirm, readFixture } from "./adopt";
import { applyContractRecording, insertContract, stampVerifiedAt } from "./adopt-edit";

const USAGE = "usage: archstone record <manifest-dir> [--rerecord <capabilityId>]...";

interface RecordArgs {
  dir: string;
  rerecord: Set<string>;
}

function parseArgs(argv: string[]): RecordArgs | { problem: string } {
  const rerecord = new Set<string>();
  const positional: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--rerecord") {
      const id = argv[i + 1];
      if (id === undefined || id.startsWith("-")) return { problem: "--rerecord needs a capability id" };
      rerecord.add(id);
      i++;
    } else if (a.startsWith("-")) {
      // Refused rather than ignored: a verb that sends live requests and writes a manifest must
      // not quietly accept a `--yes` someone assumed it had.
      return { problem: `unknown option ${a} (there is no --yes: every request and write is confirmed by a person)` };
    } else {
      positional.push(a);
    }
  }
  if (positional.length !== 1) return { problem: positional.length === 0 ? "a manifest directory is required" : `unexpected argument ${positional[1]}` };
  return { dir: positional[0], rerecord };
}

/** `init`'s convention for a fixture it writes (`fixturePath` in `@archstone/init`'s emit). */
function conventionalFixture(capabilityId: string): string {
  return `fixtures/${capabilityId}.golden.json`;
}

/** The fixture, or the reason it cannot be used — phrased as what the person should create. */
function usableFixture(dir: string, path: string, id: string): GoldenFixture | { problem: string } {
  const what = `a JSON file with "capabilityId": "${id}" and "request": { … } — the capability's INPUT (as an agent would pass it), not an HTTP request`;
  if (!existsSync(join(dir, path))) return { problem: `no fixture at ${path}; create ${what}` };
  const fixture = readFixture(dir, path);
  if (!fixture || typeof fixture !== "object") return { problem: `${path} is not readable JSON; it should be ${what}` };
  if (typeof fixture.request !== "object" || fixture.request === null || Array.isArray(fixture.request)) {
    return { problem: `${path} has no "request" object; it should be ${what}` };
  }
  if (fixture.capabilityId !== id) {
    return { problem: `${path} names capabilityId ${JSON.stringify(fixture.capabilityId)}, not "${id}"; it should be ${what}` };
  }
  return fixture;
}

/** Why this capability is not recorded, or `undefined` when it is a candidate. */
function skipReason(tool: IRTool, rerecord: Set<string>): string | undefined {
  if (!tool.connector) return "no binding — nothing to call";
  if (tool.effect !== "read") {
    return `effect is ${tool.effect} — never recorded: recording sends a live request, and only a read is a request that changes nothing`;
  }
  if (tool.connector.type === "sql") {
    return "sql binding — a sql contract needs the two isolation identities (ADR-0012 D-8); record it with 'archstone init --probe'";
  }
  if (tool.connector.type !== "rest" || !tool.connector.rest) return `${tool.connector.type} connector — only rest bindings can be recorded`;
  if (tool.contract && !rerecord.has(tool.id)) return `already recorded — pass --rerecord ${tool.id} to replace it`;
  return undefined;
}

async function recordOne(dir: string, tool: IRTool, bindingFile: string, ask: Ask): Promise<number> {
  const rest = tool.connector!.rest!;
  const method = rest.method.toUpperCase();
  const replacing = tool.contract !== undefined;
  const fixturePath = tool.contract?.probeFixture ?? conventionalFixture(tool.id);

  const fixture = usableFixture(dir, fixturePath, tool.id);
  if ("problem" in fixture) {
    console.log(`  ${tool.id}: skipped — ${fixture.problem}`);
    return 0;
  }

  console.log(`\n  ${tool.id} — ${method} ${rest.path}, input from ${fixturePath}${replacing ? " (replacing the recorded contract)" : ""}`);
  if (!(await confirm(ask, `  Record a contract for ${tool.id} with ONE live ${method} to the real backend?`))) {
    console.log(`  ${tool.id}: not recorded.`);
    return 0;
  }
  if (method !== "GET" && method !== "HEAD") {
    // R-8's second, SEPARATE confirmation, worded as `init`'s is: the thing confirmed is the
    // method, not the effect again — a re-phrasing of the same question is not a second condition.
    if (!(await confirm(ask, `  ${method} is not a GET. Confirm again that this request changes nothing on the backend:`))) {
      console.log(`  ${tool.id}: not recorded.`);
      return 0;
    }
  }

  // ONE request, called exactly as `adopt` calls it: the manifest's own resources, so an
  // origin-checked field is checked here as on every other path.
  const resources = new Registry(compile(load(dir))).ir.resources;
  const recording = await recordContract(tool, fixture.request, resources, {});
  if (recording.outcome === "red" || recording.outcome === "not-attempted" || !recording.fingerprint) {
    console.error(`  ${tool.id}: ${recording.outcome} — ${recording.detail}. Nothing written.`);
    return 1;
  }
  if (recording.outcome === "yellow") console.log(`  ${tool.id}: yellow — ${recording.detail}`);

  const shape = recording.shape as Record<string, string> | undefined;
  const verifiedAt = recording.fixture?.recordedAt ?? new Date().toISOString();
  console.log(`  fingerprint ${recording.fingerprint}`);
  console.log(`  shape       ${Object.keys(shape ?? {}).length} path(s)`);
  if (!(await confirm(ask, `  Write this contract into ${bindingFile}?`))) {
    console.log(`  ${tool.id}: not written.`);
    return 0;
  }

  const before = readFileSync(bindingFile, "utf8");
  let rewritten;
  if (replacing) {
    rewritten = applyContractRecording(before, recording.fingerprint, shape ?? {});
    if (rewritten.ok) rewritten = stampVerifiedAt(rewritten.binding, verifiedAt);
  } else {
    rewritten = insertContract(before, { fingerprint: recording.fingerprint, ...(shape ? { shape } : {}), verifiedAt, fixture: fixturePath });
  }
  if (!rewritten.ok) {
    console.error(`  ${tool.id}: ${rewritten.problem} — nothing written.`);
    return 1;
  }
  const problem = compilesClean(dir, [{ file: bindingFile, yaml: rewritten.binding }]);
  if (problem) {
    console.error(`\n  ${tool.id}: the edit does not compile — nothing written.\n    ${problem}`);
    return 1;
  }
  writeFileSync(bindingFile, rewritten.binding);
  console.log(`  ${tool.id} — contract ${replacing ? "re-recorded" : "recorded"} in ${bindingFile}.`);
  return 0;
}

export async function runRecordCmd(argv: string[]): Promise<number> {
  const args = parseArgs(argv);
  if ("problem" in args) {
    console.error(`archstone record: ${args.problem}\n${USAGE}`);
    return 2;
  }
  const { dir, rerecord } = args;

  const res = load(dir);
  const errors = validateSemantics(res).filter((d) => d.severity === "error");
  if (!res.ok || errors.length > 0) {
    console.error(`archstone record ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    return 2;
  }

  const tools = new Registry(compile(res)).listCapabilities();
  // Before any prompt or request: a typo in --rerecord must not leave the run half-done.
  const known = new Set(tools.map((t) => t.id));
  const unknown = [...rerecord].filter((id) => !known.has(id));
  if (unknown.length > 0) {
    console.error(`archstone record: --rerecord names no capability in ${dir}: ${unknown.join(", ")}\n${USAGE}`);
    return 2;
  }

  console.log(`\narchstone record ${dir}`);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ask = terminalAsk(rl);
  let worst = 0;
  try {
    for (const tool of tools) {
      const reason = skipReason(tool, rerecord);
      if (reason) {
        console.log(`  ${tool.id}: skipped — ${reason}`);
        continue;
      }
      const binding = res.bindings.find((b) => b.binding.capabilityId === tool.id);
      if (!binding) {
        console.error(`  ${tool.id}: could not find its binding file`);
        worst = Math.max(worst, 1);
        continue;
      }
      worst = Math.max(worst, await recordOne(dir, tool, join(dir, binding.file), ask));
    }
  } catch (err) {
    // `terminalAsk` throws its sentinel when stdin ends with a question pending — the piped/CI
    // case. Nothing has been written for the capability being asked about: its write happens
    // only after its last prompt. Anything else is a real bug and keeps its stack trace.
    if ((err as Error).name !== "PromptUnavailable") throw err;
    console.error(`\narchstone record: no more input — nothing written for the capability being asked about. Recording needs a person (${(err as Error).name}).`);
    return 1;
  } finally {
    rl.close();
  }
  console.log("");
  return worst;
}
