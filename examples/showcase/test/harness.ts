// Shared test harness for the Showcase: opens the real manifest, wires the synthetic API in as the
// backend (no network), and runs a scenario row exactly as its fixed arguments describe it,
// through the real runtime (`buildRegistry` + `callTool`), never a mock of it.
//
// Kept free of assertions so the negative-scenario suites that come later can reuse it as is.

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry, callTool, type CallResult } from "@archstone/runtime";
import { InMemoryRateLimitCounter, type Registry, type RateLimitCounter } from "@archstone/emitter-support";
import type { CallerContext } from "@archstone/emitter-support";
import { handle } from "../api/wanderlust-api.mjs";
import { DEMO_KEY_A, callerFor } from "../credentials.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SHOWCASE_DIR = resolve(here, "..");
export const REPO_ROOT = resolve(SHOWCASE_DIR, "../..");
export const MANIFEST_DIR = resolve(SHOWCASE_DIR, "manifest");
export const VARIANT_DIR = resolve(SHOWCASE_DIR, "manifest-variants/misdeclared-pay");

export type KeyLabel = "none" | "A" | "B" | "other";

export interface Step {
  tool: string;
  key: KeyLabel;
  arguments: Record<string, unknown>;
  capture?: Record<string, string>;
}

export interface ScenarioRow {
  id: string;
  negative: { id: string; key?: KeyLabel; arguments?: Record<string, unknown>; tool?: string; capability?: string; [k: string]: unknown } | null;
  group: string;
  mode: "live" | "recorded" | "locked";
  tool: string | null;
  capability: string | null;
  arguments: Record<string, unknown> | null;
  key: KeyLabel;
  setup?: Step[];
  outcome: "success" | "refused" | "unknown-tool" | "recorded" | "locked";
  /** Only on a `refused` row the input contract refuses (S-23); every other refused row is a policy denial. */
  refusal?: "input_invalid";
  /** More fixed calls the live run makes after the main one (S-13). */
  alsoRun?: { label: string; tool: string; key: KeyLabel; arguments: Record<string, unknown> }[];
  /** A fact the card relies on that lives in the tool list (S-12). */
  evidence?: { kind: "tool-description"; tool: string; where: string; phrase: string };
  absent?: true;
  command?: string;
  parent?: string;
  anchor: string;
  test: { file: string; name: string } | null;
  issue: number | null;
  issueUrl: string | null;
  copy: Record<"en" | "ro", { ask: string; happens: string; refused: string }>;
  /** Only on a keyed row: what a visitor's own AI app, connected without a key, will see. */
  ownAi?: Record<"en" | "ro", string>;
}

export interface ScenarioDoc {
  version: number;
  clock: string;
  keys: Record<string, string>;
  scenarios: ScenarioRow[];
}

export function loadScenarios(): ScenarioDoc {
  return JSON.parse(readFileSync(resolve(SHOWCASE_DIR, "scenarios.json"), "utf8")) as ScenarioDoc;
}

/** The fixed clock every scenario is recorded against. */
export const CLOCK_MS = Date.parse(loadScenarios().clock);

export interface BackendSpy {
  /** `METHOD /path` of every request the synthetic API received, in order. */
  calls: string[];
  fetchImpl: typeof fetch;
}

/** A `fetch` that answers from the synthetic API in-process and records what it was asked. */
export function backend(now: number | (() => number) = CLOCK_MS): BackendSpy {
  const calls: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input as string | URL, init);
    calls.push(`${request.method} ${new URL(request.url).pathname}`);
    return handle(request, { now });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

export function openRegistry(dir: string = MANIFEST_DIR): Registry {
  const built = buildRegistry(dir);
  const errors = built.diagnostics.filter((d) => d.severity === "error");
  if (!built.registry || errors.length > 0) {
    throw new Error(`showcase manifest did not build: ${JSON.stringify([...built.issues, ...errors])}`);
  }
  return built.registry;
}

/** The caller a key label stands for. "other" is an accepted credential whose principal is on no list. */
export function callerForLabel(label: KeyLabel): CallerContext | undefined {
  if (label === "other") return { accessToken: DEMO_KEY_A, principal: "demo:stranger" };
  return callerFor(label);
}

export interface RunContext {
  registry: Registry;
  spy: BackendSpy;
  counter?: RateLimitCounter;
}

export function newContext(opts: { now?: number | (() => number); registry?: Registry } = {}): RunContext {
  const now = opts.now ?? CLOCK_MS;
  const clock = typeof now === "function" ? now : () => now;
  return {
    registry: opts.registry ?? openRegistry(),
    spy: backend(now),
    counter: new InMemoryRateLimitCounter(clock),
  };
}

export function call(ctx: RunContext, tool: string, args: Record<string, unknown>, key: KeyLabel = "none"): Promise<CallResult> {
  return callTool(ctx.registry, tool, args, {
    env: { SHOWCASE_API_URL: "http://api.showcase.example" },
    fetchImpl: ctx.spy.fetchImpl,
    caller: callerForLabel(key),
    rateLimitCounter: ctx.counter,
  });
}

function atPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), value);
}

/** Replace a whole-value `"{{name}}"` with the captured JSON value, anywhere in `value`. */
export function fill(value: unknown, captured: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const m = /^\{\{(\w+)\}\}$/.exec(value);
    return m ? captured[m[1]] : value;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, captured));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, captured)]));
  }
  return value;
}

/** Run a row's setup steps, then its own call. Returns the final result and everything captured. */
export async function runRow(
  ctx: RunContext,
  row: ScenarioRow,
  overrides: { key?: KeyLabel; arguments?: Record<string, unknown>; tool?: string } = {},
): Promise<{ result: CallResult; captured: Record<string, unknown>; arguments: Record<string, unknown> }> {
  const captured: Record<string, unknown> = {};
  for (const step of row.setup ?? []) {
    const r = await call(ctx, step.tool, fill(step.arguments, captured) as Record<string, unknown>, step.key);
    if (r.isError) throw new Error(`setup step ${step.tool} of ${row.id} failed: ${JSON.stringify(r)}`);
    for (const [name, path] of Object.entries(step.capture ?? {})) captured[name] = atPath(r.structuredContent, path);
  }
  const args = fill(overrides.arguments ?? row.arguments ?? {}, captured) as Record<string, unknown>;
  const result = await call(ctx, overrides.tool ?? row.tool ?? "", args, overrides.key ?? row.key);
  return { result, captured, arguments: args };
}

export const textOf = (r: CallResult): string => r.content.map((c) => c.text).join("\n");
