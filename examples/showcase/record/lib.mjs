// Shared plumbing for the recorded Showcase scenarios (S-15 .. S-21).
//
// What lives here: the synthetic API served over a real socket (with a request counter), a runner
// that spawns the WORKSPACE CLI the way an operator would, the normaliser that turns machine
// specifics into placeholders, and the assertion helper that makes a scenario fail loudly.
//
// Nothing here knows what a scenario is about. A scenario is one module in this folder that gets a
// `ctx`, runs real commands and real calls through it, and states what it expects.

/* global Request, Buffer, URL, clearTimeout */
import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { handle } from "../api/wanderlust-api.mjs";

const here = dirname(fileURLToPath(import.meta.url));
export const SHOWCASE_DIR = resolve(here, "..");
export const REPO_ROOT = resolve(SHOWCASE_DIR, "../..");
export const MANIFEST_DIR = join(SHOWCASE_DIR, "manifest");
export const MANIFEST_REL = "examples/showcase/manifest";
export const CLI_JS = join(REPO_ROOT, "packages/cli/dist/index.js");
export const NO_NETWORK = join(here, "no-network.mjs");

/** The fixed clock every scenario runs against: the same one `scenarios.json` pins. */
export const CLOCK_ISO = JSON.parse(readFileSync(join(SHOWCASE_DIR, "scenarios.json"), "utf8")).clock;
export const CLOCK_MS = Date.parse(CLOCK_ISO);
/** The date a transcript is stamped with. Never the wall clock: a rerun must give the same bytes. */
export const RECORDED_DATE = CLOCK_ISO.slice(0, 10);

export const CLI_VERSION = JSON.parse(readFileSync(join(REPO_ROOT, "packages/cli/package.json"), "utf8")).version;

// ------------------------------------------------------------------------------ assertions

export class ScenarioFailure extends Error {
  constructor(claim) {
    super(claim);
    this.name = "ScenarioFailure";
  }
}

// ------------------------------------------------------------------------------ normaliser

/**
 * Turns what differs between machines and runs into a placeholder, and remembers which rules
 * actually fired so a transcript lists only the normalisation it needed.
 */
export class Normaliser {
  constructor() {
    /** @type {{ find: string | RegExp, to: string, what: string }[]} */
    this.rules = [];
    this.fired = new Map();
  }

  /** A directory (and its resolved twin: macOS spells a temp directory two ways). */
  path(abs, placeholder, what) {
    const forms = new Set([abs]);
    try {
      forms.add(realpathSync(abs));
    } catch {
      /* not created yet: only the given form */
    }
    for (const f of forms) this.rules.push({ find: f, to: placeholder, what });
    this.rules.sort((a, b) => lengthOf(b.find) - lengthOf(a.find));
  }

  literal(find, to, what) {
    this.rules.push({ find, to, what });
    this.rules.sort((a, b) => lengthOf(b.find) - lengthOf(a.find));
  }

  pattern(re, to, what) {
    this.rules.push({ find: re, to, what });
  }

  apply(text) {
    let out = text;
    for (const rule of this.rules) {
      const before = out;
      out = typeof rule.find === "string" ? out.split(rule.find).join(rule.to) : out.replace(rule.find, rule.to);
      if (out !== before) this.fired.set(rule.what, rule.to);
    }
    return out;
  }

  /** What was applied, in a fixed order. */
  report() {
    return [...this.fired.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([what, as]) => ({ what, as }));
  }
}

const lengthOf = (find) => (typeof find === "string" ? find.length : 0);

// ------------------------------------------------------------------------------ the synthetic API

/**
 * The synthetic API over a real socket on an ephemeral port, serving the same `handle` the tests
 * and a Workers runtime use. `transform(request, response)` lets a scenario wrap the handler (S-17
 * adds a guest email field this way): the API itself has no such switch and never will.
 *
 * `requests` counts every request that reached it, which is how S-19 proves an offline command
 * made none.
 */
export async function startApi() {
  const api = {
    url: "",
    port: 0,
    /** @type {string[]} */
    requests: [],
    /** @type {((request: Request, response: Response) => Promise<Response | undefined> | Response | undefined) | undefined} */
    transform: undefined,
    close: async () => {},
  };
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
        method,
        headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")),
        body: method === "GET" || method === "HEAD" ? undefined : Buffer.concat(chunks),
      });
      api.requests.push(`${method} ${new URL(request.url).pathname}`);
      (async () => {
        let response = await handle(request.clone(), { now: CLOCK_MS });
        if (api.transform) response = (await api.transform(request, response)) ?? response;
        res.writeHead(response.status, Object.fromEntries(response.headers));
        res.end(Buffer.from(await response.arrayBuffer()));
      })().catch(() => {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "internal" }));
      });
    });
  });
  await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
  api.port = server.address().port;
  api.url = `http://127.0.0.1:${api.port}`;
  api.close = () =>
    new Promise((ok) => {
      server.closeAllConnections?.();
      server.close(() => ok());
    });
  return api;
}

/** A URL on a port nothing listens on: "the backend is stopped" made concrete. */
export async function deadUrl() {
  const probe = createServer();
  await new Promise((ok) => probe.listen(0, "127.0.0.1", ok));
  const port = probe.address().port;
  await new Promise((ok) => probe.close(() => ok()));
  return `http://127.0.0.1:${port}`;
}

// ------------------------------------------------------------------------------ the scenario context

/** Rewrite every object's keys in sorted order, so a recorded `result` is byte-stable. */
export function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((k) => [k, sortKeys(value[k])]),
    );
  }
  return value;
}

const quoteArg = (a) => (/^[A-Za-z0-9_@%+=:,./<>{}-]+$/.test(a) ? a : JSON.stringify(a));

export function newContext(id) {
  const norm = new Normaliser();
  norm.path(REPO_ROOT, "<repo>", "absolute path of the checkout");
  norm.pattern(new RegExp(`\\b${CLI_VERSION.replace(/\./g, "\\.")}\\b`, "g"), "{cli}", "the CLI's own version string");
  norm.pattern(/archstone_it_[0-9a-f]{8}_/g, "", "run-unique prefix of throwaway database role names");

  const temps = [];
  const closers = [];
  const ctx = {
    id,
    norm,
    steps: [],
    asserts: [],
    /** Run a cleanup when the scenario ends, pass or fail. */
    onEnd: (fn) => closers.push(fn),
    async end() {
      for (const fn of closers.reverse()) await fn().catch(() => undefined);
    },
    /** A fresh temp directory known to the normaliser as `<name>`. */
    temp(name) {
      const dir = mkdtempSync(join(tmpdir(), `archstone-showcase-${id}-`));
      temps.push(dir);
      norm.path(dir, `<${name}>`, `temporary directory standing in for ${name}`);
      return dir;
    },
    /** Known backend: the placeholder for its address. */
    registerApi(api) {
      norm.literal(api.url, "<api>", "address of the synthetic API on an ephemeral port");
      norm.literal(`127.0.0.1:${api.port}`, "<api>", "address of the synthetic API on an ephemeral port");
    },
    /**
     * State what the scenario expects. A false claim stops the scenario and the whole recorder
     * exits non-zero (AC-5.9). `negative` marks a claim about something that must NOT happen.
     */
    check(claim, ok, { negative = false } = {}) {
      if (!ok) throw new ScenarioFailure(`${id}: expected: ${claim}`);
      ctx.asserts.push({ claim, negative });
    },
    /** Record a tool call that was made in process (not a command). */
    callStep(tool, args, result) {
      ctx.steps.push({ call: { tool, arguments: sortKeys(args) }, result: sortKeys(result) });
    },
    /** Run a script from the repository with Node, recorded as `node <script> <args>`. */
    async node(script, args, { env = {} } = {}) {
      const childEnv = { PATH: process.env.PATH ?? "", NO_COLOR: "1", TZ: "UTC", ...env };
      const run = await spawnCapture(process.execPath, [join(REPO_ROOT, script), ...args], { env: childEnv, cwd: REPO_ROOT });
      if (process.env.RECORD_DEBUG) {
        process.stderr.write(`\n--- ${id}: node ${script} -> exit ${run.exit}\n${run.stdout}${run.stderr ? `[stderr]\n${run.stderr}` : ""}`);
      }
      const step = { command: norm.apply(["node", script, ...args].map(quoteArg).join(" ")), exit: run.exit };
      const out = norm.apply(run.stdout);
      const err = norm.apply(run.stderr);
      if (out !== "") step.stdout = out;
      if (err !== "") step.stderr = err;
      ctx.steps.push(step);
      return run;
    },
    /**
     * Run the workspace CLI. `typed` lists what a person types, in order, each sent when the
     * given prompt text appears (a pipe delivers all lines at once and readline would drop all
     * but the first, so answers have to follow the questions). `offline` runs it under
     * no-network.mjs, which turns any outbound connection attempt into a recorded failure.
     */
    async cli(args, { env = {}, typed, offline = false, record = true, netLog } = {}) {
      const childEnv = { PATH: process.env.PATH ?? "", NO_COLOR: "1", TZ: "UTC", ...env };
      if (offline) {
        if (!netLog) throw new Error("offline runs need a netLog path");
        childEnv.ARCHSTONE_RECORD_NET_LOG = netLog;
      }
      const argv = [...(offline ? ["--import", NO_NETWORK] : []), CLI_JS, ...args];
      const run = await spawnCapture(process.execPath, argv, { env: childEnv, cwd: REPO_ROOT, typed });
      if (process.env.RECORD_DEBUG) {
        process.stderr.write(`\n--- ${id}: archstone ${args.join(" ")} -> exit ${run.exit}\n${run.stdout}${run.stderr ? `[stderr]\n${run.stderr}` : ""}`);
      }
      if (record) {
        const step = { command: norm.apply(["archstone", ...args].map(quoteArg).join(" ")) };
        if (typed) step.typed = typed.map((t) => norm.apply(t.send));
        step.exit = run.exit;
        const out = norm.apply(run.stdout);
        const err = norm.apply(run.stderr);
        if (out !== "") step.stdout = out;
        if (err !== "") step.stderr = err;
        ctx.steps.push(step);
      }
      return run;
    },
  };
  return ctx;
}

/**
 * Spawn a process, capture stdout and stderr as text. With `typed`, stdin is a scripted person:
 * each answer is written when its prompt has shown up in what the process printed since the last
 * answer, and stdin is closed after the last one. Without it, stdin is closed at once, which is
 * exactly what a CI job or a pipe looks like to a command that wants a person.
 */
export function spawnCapture(cmd, argv, { env, cwd, typed, timeoutMs = 120_000 }) {
  return new Promise((done, fail) => {
    const child = spawn(cmd, argv, { env, cwd, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let pending = [...(typed ?? [])];
    let since = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      fail(new Error(`timed out after ${timeoutMs} ms: ${argv.join(" ")}`));
    }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => {
      stderr += c;
    });
    child.stdout.on("data", (c) => {
      stdout += c;
      since += c;
      while (pending.length > 0 && since.includes(pending[0].prompt)) {
        const next = pending.shift();
        since = since.slice(since.indexOf(next.prompt) + next.prompt.length);
        child.stdin.write(`${next.send}\n`);
        if (pending.length === 0) child.stdin.end();
      }
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      fail(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      done({ exit: code ?? -1, stdout, stderr, unanswered: pending.length });
    });
    if (!typed || typed.length === 0) child.stdin.end();
  });
}

// ------------------------------------------------------------------------------ files

export function readNetLog(path) {
  return existsSync(path) ? readFileSync(path, "utf8").split("\n").filter(Boolean) : [];
}

export function emptyNetLog(dir) {
  const path = join(dir, "net.log");
  writeFileSync(path, "");
  return path;
}

export const copyTree = (from, to) => cpSync(from, to, { recursive: true });
