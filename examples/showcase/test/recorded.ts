// Shared by recorded-s15.test.ts .. recorded-s21.test.ts: load a committed transcript and check what
// every transcript must satisfy (AC-5.8), whatever its scenario.
//
// The scenario tests read the COMMITTED files and assert their outcomes and negatives from the
// recorded bytes, not from a rerun. The recorder (`pnpm showcase:record:check`, and the determinism
// test) is what proves those files are what a fresh run produces.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect } from "vitest";
import { SHOWCASE_DIR, loadScenarios } from "./harness";

export interface CommandStep {
  command: string;
  typed?: string[];
  exit: number;
  stdout?: string;
  stderr?: string;
}
export interface CallStep {
  call: { tool: string; arguments: Record<string, unknown> };
  result: Record<string, unknown>;
}
export type TranscriptStep = CommandStep | CallStep;

export interface Transcript {
  scenario: string;
  title: string;
  kind: "cli" | "sdk" | "mcp";
  recorded: { date: string; cli: string };
  steps: TranscriptStep[];
  asserts: { claim: string; negative: boolean }[];
  normalisation: { what: string; as: string }[];
}

export const TRANSCRIPT_DIR = resolve(SHOWCASE_DIR, "transcripts");

export function transcriptPath(id: string): string {
  return resolve(TRANSCRIPT_DIR, `${id.toLowerCase()}.json`);
}

export function loadTranscript(id: string): { transcript: Transcript; text: string } {
  const text = readFileSync(transcriptPath(id), "utf8");
  return { transcript: JSON.parse(text) as Transcript, text };
}

export const commands = (t: Transcript): CommandStep[] => t.steps.filter((s): s is CommandStep => "command" in s);
export const calls = (t: Transcript): CallStep[] => t.steps.filter((s): s is CallStep => "call" in s);
export const stepWith = (t: Transcript, prefix: string, nth = 0): CommandStep => {
  const found = commands(t).filter((s) => s.command.startsWith(prefix));
  if (!found[nth]) throw new Error(`${t.scenario}: no step #${nth} starting with ${JSON.stringify(prefix)}`);
  return found[nth];
};

/** Every transcript, whatever it records: the stable format, the stamp, nothing machine-specific. */
export function expectWellFormed(id: string, kind: Transcript["kind"]): Transcript {
  const { transcript: t, text } = loadTranscript(id);
  const clock = loadScenarios().clock;

  expect(text.endsWith("\n"), "one trailing newline").toBe(true);
  expect(text.endsWith("\n\n"), "and only one").toBe(false);
  expect(`${JSON.stringify(t, null, 2)}\n`, "stable serialisation: two-space JSON in the recorder's key order").toBe(text);
  expect(Object.keys(t)).toEqual(["scenario", "title", "kind", "recorded", "steps", "asserts", "normalisation"]);

  expect(t.scenario).toBe(id);
  expect(t.kind).toBe(kind);
  expect(t.recorded.date, "the date is the fixed clock's, not wall time").toBe(clock.slice(0, 10));
  expect(t.recorded.cli).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);

  expect(t.steps.length).toBeGreaterThan(0);
  for (const s of t.steps) expect("command" in s || "call" in s).toBe(true);
  for (const s of commands(t)) {
    expect(Number.isInteger(s.exit)).toBe(true);
    expect(s.command.startsWith("archstone ") || s.command.startsWith("node "), s.command).toBe(true);
  }
  expect(t.asserts.length).toBeGreaterThan(0);
  expect(t.asserts.some((a) => a.negative), "every scenario states at least one negative").toBe(true);

  // Nothing that differs between machines or runs.
  expect(text, "no absolute local path").not.toMatch(/\/Users\/|\/home\/|\/private\/|\/var\/folders|\/tmp\/|[A-Z]:\\/);
  expect(text, "no port of the synthetic API").not.toMatch(/127\.0\.0\.1:\d|localhost:\d/);
  expect(text, "no database URL or password").not.toMatch(/postgres(ql)?:\/\//);
  expect(text, "no timestamp other than the fixed clock's").not.toMatch(/20(?!27-05-01T10:0)\d\d-\d\d-\d\dT\d\d:\d\d/);
  expect(text, "no duration").not.toMatch(/\b\d+(\.\d+)?\s?(ms|seconds)\b/);

  return t;
}
