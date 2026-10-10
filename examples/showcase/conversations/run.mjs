#!/usr/bin/env node
// Local conversation check: a real model (the `claude` CLI, headless, Haiku) drives the Showcase's
// MCP endpoint with the prompts a visitor would type, and this script reads the tool traffic back
// and flags what a visitor would call a bug.
//
//   pnpm showcase:conversations [--url <mcp url>] [--report <path>] [--only <text>] [--model <m>]
//
// NOT a CI gate: the model's phrasing varies from run to run. It is a smoke check to run before a
// demo change goes out. The deterministic counterpart that CI runs is test/conversations.test.ts.
//
// Strictly serial. Each prompt makes a handful of POSTs to the endpoint (initialize, tools/list and
// one per tool call), and the hosted demo sits behind a per-IP edge limit, so the script keeps the
// estimated POSTs per 10 seconds under 15 (the same budget as the Worker's live battery) by
// spacing the prompts out.
//
// Exit code: 0 clean, 1 if anything was flagged, 2 on a usage or environment error.

/* global clearTimeout */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CATALOGUE } from "../api/wanderlust-api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const SERVER = "archstone-demo";
const DEFAULT_URL = "https://demo.archstone.dev/mcp";
const POST_BUDGET = 15; // per WINDOW_MS, below the edge limit
const WINDOW_MS = 10_000;
const MIN_GAP_MS = 2_000;
const PROMPT_TIMEOUT_MS = 240_000;

// ---------------------------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------------------------

function parseArgs(argv) {
  const opts = { url: process.env.DEMO_MCP_URL || DEFAULT_URL, model: "haiku", report: undefined, only: undefined, out: undefined };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const value = () => {
      const v = argv[++i];
      if (v === undefined) usage(`${a} needs a value`);
      return v;
    };
    if (a === "--url") opts.url = value();
    else if (a === "--report") opts.report = resolve(value());
    else if (a === "--only") opts.only = value().toLowerCase();
    else if (a === "--model") opts.model = value();
    else if (a === "--out") opts.out = resolve(value());
    else if (a === "-h" || a === "--help") usage();
    else usage(`unknown argument ${a}`);
  }
  if (!/^https?:\/\//.test(opts.url)) usage(`--url must be an http(s) URL, got ${opts.url}`);
  return opts;
}

function usage(problem) {
  if (problem) console.error(`conversations: ${problem}\n`);
  console.error(
    "usage: pnpm showcase:conversations [--url <mcp url>] [--report <path>] [--only <text>] [--model <model>] [--out <dir>]\n" +
      `  --url     the MCP endpoint (default ${DEFAULT_URL}; or DEMO_MCP_URL)\n` +
      "  --report  write report.md here instead of into the run directory\n" +
      "  --only    run only the prompts whose id or text contains this (case-insensitive)\n" +
      "  --model   the claude model alias (default haiku)\n" +
      "  --out     the run directory (default conversations/runs/<timestamp>/)",
  );
  process.exit(problem ? 2 : 0);
}

// ---------------------------------------------------------------------------------------------
// The prompts
// ---------------------------------------------------------------------------------------------

/**
 * @typedef {object} Prompt
 * @property {string} id
 * @property {string} text
 * @property {number} [maxNightly]  A per-night ceiling the prompt states, in EUR.
 * @property {boolean} [tolerateErrors]  Tool errors are part of what this prompt is about.
 * @property {string} [why]  Why errors are tolerated.
 */

/** @returns {Prompt[]} */
function scenarioPrompts() {
  const doc = JSON.parse(readFileSync(resolve(here, "../scenarios.json"), "utf8"));
  return doc.scenarios
    .filter((s) => s.mode === "live" && s.copy?.en?.ask)
    .map((s) => {
      /** @type {Prompt} */
      const p = { id: s.id, text: s.copy.en.ask };
      if (s.id === "S-01") p.maxNightly = 150;
      if (s.outcome === "refused" || s.outcome === "unknown-tool") {
        p.tolerateErrors = true;
        p.why = `the scenario's outcome is "${s.outcome}"`;
      } else if (s.key !== "none" || (s.setup ?? []).length > 0) {
        p.tolerateErrors = true;
        p.why = "needs a demo key or an earlier quote that a single prompt cannot carry";
      } else if (s.id === "S-11") {
        p.tolerateErrors = true;
        p.why = "availability is rate-limited to 3 calls a minute by design";
      } else if (s.id === "S-13") {
        p.tolerateErrors = true;
        p.why = "ws-1002 and ws-1003 are deliberately unwell";
      }
      return p;
    });
}

/** @type {Prompt[]} */
const VARIANTS = [
  { id: "V-lisbon-portugal", text: "Find me a stay in Lisbon, Portugal for two, 12-15 May 2027, under 150 EUR a night.", maxNightly: 150 },
  { id: "V-cat", text: "Find me a stay in Lisbon for two, 12-15 May 2027, under 150 EUR a night. We travel with my cat.", maxNightly: 150 },
  { id: "V-next-weekend", text: "Find me a stay in Lisbon for two next weekend." },
  { id: "V-romanian", text: "Caut un loc de cazare în Lisabona pentru doi, 12-15 mai 2027, sub 150 de euro pe noapte.", maxNightly: 150 },
  { id: "V-unknown-city", text: "Find me a stay in Atlantis for two, 12-15 May 2027." },
  { id: "V-total-budget", text: "Find me a stay in Lisbon for two, 12-15 May 2027. My total budget for the whole stay is 400 EUR." },
];

// ---------------------------------------------------------------------------------------------
// Running one prompt
// ---------------------------------------------------------------------------------------------

function runClaude(prompt, { configPath, model, cwd, timeoutMs }) {
  const args = [
    "-p", prompt,
    "--model", model,
    "--output-format", "stream-json",
    "--verbose",
    "--mcp-config", configPath,
    "--strict-mcp-config",
    "--allowedTools", `mcp__${SERVER}__*`,
    "--tools", "", // no built-ins: the only things the model can reach are the demo's tools
    "--no-session-persistence",
    "--max-budget-usd", "0.50",
  ];
  return new Promise((resolveRun) => {
    const child = spawn("claude", args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGKILL");
    }, timeoutMs);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr: `${stderr}${e.message}`, code: -1, timedOut });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolveRun({ stdout, stderr, code: code ?? -1, timedOut });
    });
  });
}

const textOfContent = (content) =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((c) => (typeof c?.text === "string" ? c.text : "")).join("\n") : "";

/** Read the stream-json lines back into tool calls, results and the model's final answer. */
function readStream(raw) {
  const calls = new Map(); // tool_use id -> { name, input, result?, isError? }
  let answer = "";
  let mcpStatus;
  let streamError;
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let ev;
    try {
      ev = JSON.parse(line);
    } catch {
      continue;
    }
    if (ev.type === "system" && Array.isArray(ev.mcp_servers)) {
      mcpStatus = ev.mcp_servers.find((s) => s.name === SERVER)?.status ?? "missing";
    }
    const blocks = Array.isArray(ev.message?.content) ? ev.message.content : [];
    for (const b of blocks) {
      if (ev.type === "assistant" && b.type === "tool_use") calls.set(b.id, { name: String(b.name).replace(`mcp__${SERVER}__`, ""), input: b.input ?? {} });
      if (ev.type === "user" && b.type === "tool_result") {
        const c = calls.get(b.tool_use_id);
        if (c) {
          c.result = textOfContent(b.content);
          c.isError = b.is_error === true;
        }
      }
    }
    if (ev.type === "result") {
      answer = typeof ev.result === "string" ? ev.result : answer;
      if (ev.is_error) streamError = String(ev.result ?? ev.subtype ?? "error");
    }
  }
  return { calls: [...calls.values()], answer, mcpStatus, streamError };
}

/** Every stay row the endpoint returned in a tool result. */
function staysIn(resultText) {
  try {
    const stays = JSON.parse(resultText)?.stays;
    return Array.isArray(stays) ? stays.filter((s) => s && typeof s === "object") : [];
  } catch {
    return [];
  }
}

const catalogueNames = new Set(CATALOGUE.map((s) => s.name));
const catalogueIds = new Set(CATALOGUE.map((s) => s.id));

function analyse(prompt, parsed, run) {
  const flags = [];
  if (run.timedOut) flags.push(`the claude run timed out after ${PROMPT_TIMEOUT_MS / 1000}s`);
  else if (run.code !== 0) flags.push(`claude exited with code ${run.code}: ${(parsed.answer || run.stderr || "no output").trim().slice(0, 200)}`);
  if (parsed.mcpStatus !== undefined && parsed.mcpStatus !== "connected") flags.push(`the MCP server was "${parsed.mcpStatus}", not connected`);
  if (parsed.streamError && !run.timedOut && run.code === 0) flags.push(`claude reported an error result: ${parsed.streamError.slice(0, 200)}`);

  for (const c of parsed.calls) {
    if (c.result === undefined) {
      flags.push(`${c.name}: no result came back`);
      continue;
    }
    if (c.isError && !prompt.tolerateErrors) flags.push(`${c.name}: tool error not intended by this prompt: ${c.result.replace(/\s+/g, " ").slice(0, 160)}`);
    for (const s of staysIn(c.result)) {
      if (typeof s.name === "string" && !catalogueNames.has(s.name)) flags.push(`${c.name}: stay name not in the catalogue: ${JSON.stringify(s.name)}`);
      if (typeof s.id === "string" && !catalogueIds.has(s.id)) flags.push(`${c.name}: stay id not in the catalogue: ${s.id}`);
      if (prompt.maxNightly !== undefined && typeof s.pricePerNight === "number" && s.pricePerNight > prompt.maxNightly) {
        flags.push(`${c.name}: ${s.name} is ${s.pricePerNight} EUR a night, over the stated ${prompt.maxNightly}`);
      }
    }
    const usedId = c.input.stayId ?? c.input.propertyId;
    if (typeof usedId === "string" && c.isError && !catalogueIds.has(usedId)) flags.push(`${c.name}: unresolvable id ${usedId}`);
  }
  return flags;
}

// ---------------------------------------------------------------------------------------------
// Pacing
// ---------------------------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** POSTs one prompt made, estimated: initialize, initialized, tools/list, then one per tool call. */
const estimatePosts = (toolCalls) => 3 + toolCalls;
const gapAfter = (posts) => Math.max(MIN_GAP_MS, Math.ceil((posts / POST_BUDGET) * WINDOW_MS));

// ---------------------------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------------------------

const opts = parseArgs(process.argv.slice(2));
const prompts = [...scenarioPrompts(), ...VARIANTS].filter((p) => !opts.only || p.id.toLowerCase().includes(opts.only) || p.text.toLowerCase().includes(opts.only));
if (prompts.length === 0) usage("--only matched no prompt");

const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const runDir = opts.out ?? resolve(here, "runs", stamp);
mkdirSync(runDir, { recursive: true });
const work = mkdtempSync(join(tmpdir(), "archstone-conversations-")); // empty cwd: no repo CLAUDE.md leaks in
const configPath = join(work, "mcp.json");
writeFileSync(configPath, JSON.stringify({ mcpServers: { [SERVER]: { type: "http", url: opts.url } } }));
const cwd = join(work, "cwd");
mkdirSync(cwd);

console.error(`conversations: ${prompts.length} prompt(s) against ${opts.url}, model ${opts.model}, serial; raw streams in ${runDir}`);

const results = [];
try {
  for (const [i, prompt] of prompts.entries()) {
    console.error(`[${i + 1}/${prompts.length}] ${prompt.id}: ${prompt.text}`);
    const run = await runClaude(prompt.text, { configPath, model: opts.model, cwd, timeoutMs: PROMPT_TIMEOUT_MS });
    writeFileSync(join(runDir, `${prompt.id}.stream.jsonl`), run.stdout);
    const parsed = readStream(run.stdout);
    const flags = analyse(prompt, parsed, run);
    results.push({ prompt, parsed, flags });
    console.error(`    ${parsed.calls.length} tool call(s), ${flags.length} flag(s)`);
    if (i < prompts.length - 1) await sleep(gapAfter(estimatePosts(parsed.calls.length)));
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------------------------

const one = (s, n = 140) => String(s).replace(/\s+/g, " ").trim().slice(0, n).replace(/\|/g, "\\|");
const flagged = results.filter((r) => r.flags.length > 0);
const lines = [
  "# Showcase conversation check",
  "",
  `- Endpoint: ${opts.url}`,
  `- Model: ${opts.model}`,
  `- Run: ${stamp}`,
  `- Prompts: ${results.length}, flagged: ${flagged.length}`,
  `- Raw streams: ${runDir}`,
  "",
  "A smoke check, not a gate: a model's phrasing varies. A flag is a reason to look, not proof of a bug.",
  "",
  "| Prompt | Tool calls | Stays returned | Flags |",
  "|---|---|---|---|",
  ...results.map((r) => {
    const stays = r.parsed.calls.reduce((n, c) => n + staysIn(c.result ?? "").length, 0);
    return `| ${r.prompt.id} | ${r.parsed.calls.map((c) => c.name).join(", ") || "none"} | ${stays} | ${r.flags.length} |`;
  }),
  "",
];
if (flagged.length > 0) {
  lines.push("## Flags", "");
  for (const r of flagged) {
    lines.push(`### ${r.prompt.id}`, "", `> ${r.prompt.text}`, "", ...r.flags.map((f) => `- ${f}`), "");
  }
}
lines.push("## Conversations", "");
for (const r of results) {
  lines.push(`### ${r.prompt.id}`, "", `> ${r.prompt.text}`, "");
  if (r.prompt.tolerateErrors) lines.push(`Tool errors tolerated: ${r.prompt.why}.`, "");
  for (const c of r.parsed.calls) {
    lines.push(`- \`${c.name}\` ${one(JSON.stringify(c.input), 200)} -> ${c.isError ? "ERROR " : ""}${one(c.result ?? "(no result)")}`);
  }
  lines.push("", `Answer: ${one(r.parsed.answer || "(none)", 400)}`, "");
}
const reportPath = opts.report ?? join(runDir, "report.md");
mkdirSync(dirname(reportPath), { recursive: true });
writeFileSync(reportPath, `${lines.join("\n")}\n`);
console.error(`conversations: report at ${reportPath}`);
console.error(flagged.length === 0 ? "conversations: clean" : `conversations: ${flagged.length} prompt(s) flagged`);
process.exit(flagged.length === 0 ? 0 : 1);
