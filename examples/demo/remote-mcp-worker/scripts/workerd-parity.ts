// Runs the Worker under workerd (`wrangler dev --local`, spawned, polled until ready, killed) and
// checks that nothing Node-specific crept into the shared code:
//   1. the wrangler-free live battery passes over real HTTP, and
//   2. every `live` scenario's /run result equals the in-process Node result after normalisation
//      (S-11 is excluded: it is the one approximate scenario, and the battery covers it).
// Needs no credentials: --local never talks to Cloudflare.
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createWorker } from "../src/worker";
import { runBattery } from "./battery";
import scenarioDoc from "../../../showcase/scenarios.json";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.listen(0, "127.0.0.1", () => {
      const port = (s.address() as { port: number }).port;
      s.close(() => ok(port));
    });
    s.on("error", fail);
  });
}

/** Ids derived from the issue time (quotes, payment quotes, and the bookings made from them), and the timestamps the API stamps, are not part of the comparison. */
function normalise(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value).replace(/\b(?:PQ|[QBP])-[0-9a-z]+(-[0-9a-f]{8})?\b/g, "<id>").replace(/\d{4}-\d\d-\d\dT[\d:.]+Z/g, "<ts>"));
}

const port = await freePort();
const base = `http://127.0.0.1:${port}`;
const child = spawn("pnpm", ["exec", "wrangler", "dev", "--local", "--port", String(port), "--ip", "127.0.0.1"], {
  cwd: root,
  stdio: ["ignore", "pipe", "pipe"],
  env: { ...process.env, WRANGLER_SEND_METRICS: "false", CI: "1" },
});
let log = "";
child.stdout.on("data", (d) => (log += d));
child.stderr.on("data", (d) => (log += d));
const stop = () => {
  if (!child.killed) child.kill("SIGTERM");
};
process.on("exit", stop);

let failures = 0;
try {
  const deadline = Date.now() + 120_000;
  for (;;) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited early:\n${log}`);
    try {
      const r = await fetch(`${base}/nope`);
      if (r.status === 404) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline) throw new Error(`wrangler dev did not become ready in 120s:\n${log}`);
    await new Promise((r) => setTimeout(r, 500));
  }

  // 1. the battery over HTTP
  const checks = await runBattery((path, init) => fetch(`${base}${path}`, init));
  for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok || !c.detail ? "" : `  [${c.detail}]`}`);
  failures += checks.filter((c) => !c.ok).length;

  // 2. parity with the in-process Node result, on a fresh counter
  const node = createWorker();
  const rows = (scenarioDoc as unknown as { scenarios: { id: string; mode: string; tool: string | null }[] }).scenarios;
  for (const row of rows.filter((r) => r.mode === "live" && r.tool && r.id !== "S-11")) {
    const [theirs, ours] = await Promise.all([
      fetch(`${base}/run/${row.id}`, { method: "POST" }).then((r) => r.json()),
      node.fetch(new Request(`${base}/run/${row.id}`, { method: "POST" })).then((r) => r.json()),
    ]);
    const same = JSON.stringify(normalise(theirs)) === JSON.stringify(normalise(ours));
    console.log(`${same ? "ok  " : "FAIL"} parity ${row.id} (${row.tool}): workerd equals node`);
    if (!same) failures += 1;
  }
} catch (e) {
  console.error(e instanceof Error ? e.message : e);
  failures += 1;
} finally {
  stop();
}
console.log(failures === 0 ? "\nworkerd parity: all green" : `\nworkerd parity: ${failures} failure(s)`);
process.exit(failures === 0 ? 0 : 1);
