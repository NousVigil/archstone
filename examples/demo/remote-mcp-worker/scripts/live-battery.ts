// Runs the wrangler-free live battery against a deployed (or any reachable) Worker URL.
//   tsx scripts/live-battery.ts https://demo.archstone.dev
// Exits 1 if any check fails. Nothing is rolled back automatically; a red result is a signal to
// look, then `wrangler rollback` and revert by hand.
import { runBattery } from "./battery";

const base = (process.argv[2] ?? process.env.DEMO_WORKER_URL ?? "").replace(/\/+$/, "");
if (!/^https?:\/\//.test(base)) {
  console.error("usage: live-battery.ts <base url>   (or DEMO_WORKER_URL)");
  process.exit(2);
}

const checks = await runBattery((path, init) => fetch(`${base}${path}`, init));
for (const c of checks) console.log(`${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok || !c.detail ? "" : `  [${c.detail}]`}`);
const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed against ${base}`);
process.exit(failed.length === 0 ? 0 : 1);
