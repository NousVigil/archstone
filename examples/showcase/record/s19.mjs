// S-19: `archstone audit` and `archstone doctor` - read your own records, check your own setup,
// send nothing anywhere.
//
// Setup (before the offline window): an embedded run executes a few capabilities against the
// synthetic API with an audit sink, which yields a trail of Execution records. The recorder
// replaces each record's random id and wall-clock times with fixed ones so the transcript is
// stable; nothing else in a record is touched.
//
// Expected: `audit` lists the irreversible actions that ran, `doctor` reports health and names the
// irreversible capabilities, and `apply --exposure` lists what is exposed. Negative: all of them,
// pointed at a live backend address, make zero outbound requests - proved two ways: the backend's
// request counter does not move, and the process cannot open any connection at all (no-network.mjs).
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { fromIR } from "@archstone/agent";
import { readFileSync } from "node:fs";
import { CLOCK_MS, MANIFEST_REL, emptyNetLog, readNetLog, startApi } from "./lib.mjs";
import { callerFor } from "../credentials.mjs";

export const meta = { id: "S-19", file: "s-19.json", kind: "cli", title: "Check my setup (audit and doctor), sending nothing anywhere" };

const DATES = { from: "2027-05-12", to: "2027-05-15" };
const PARTY = { adults: 2 };

export async function run(ctx) {
  const work = ctx.temp("work");
  const api = await startApi();
  ctx.onEnd(api.close);
  ctx.registerApi(api);

  // --- setup: a real trail from a real embedded run
  const irPath = join(work, "ir.json");
  const built = await ctx.cli(["build", MANIFEST_REL, "--out", irPath], { record: false });
  ctx.check("`build` exits 0 (the IR the embedded run loads)", built.exit === 0);
  const sdk = fromIR(JSON.parse(readFileSync(irPath, "utf8")));
  const records = [];
  const caller = callerFor("A");
  const opts = { env: { SHOWCASE_API_URL: api.url }, caller, auditSink: (r) => records.push(r) };
  const run1 = async (id, input, label) => {
    const r = await sdk.execute(id, input, opts);
    ctx.callStep(id, input, { status: r.status });
    ctx.check(`${label} ran (status ok)`, r.status === "ok");
    return r;
  };
  await run1("wanderlust.search", { destination: "Lisbon", dates: DATES, travelers: PARTY }, "search");
  const quote = await run1("wanderlust.quote", { stayId: "ws-1001", dates: DATES, travelers: PARTY }, "quote");
  const book = await run1(
    "wanderlust.book",
    { quoteId: quote.data.quote.quoteId, stayId: "ws-1001", dates: DATES, travelers: PARTY, guestName: "Ana Pop" },
    "book",
  );
  await run1("wanderlust.cancel", { bookingId: "B-0000cafe" }, "cancel (irreversible)");
  await run1(
    "wanderlust.pay",
    { bookingId: book.data.booking.bookingId, amount: book.data.booking.total, paymentQuote: book.data.booking.paymentQuote },
    "pay (irreversible)",
  );
  ctx.check("the trail holds one record per execution", records.length === 5);

  const trail = join(work, "trail.jsonl");
  const stamped = records.map((r, i) => ({
    ...r,
    metadata: {
      ...r.metadata,
      id: `exec-${String(i + 1).padStart(3, "0")}`,
      startedAt: new Date(CLOCK_MS + i * 1000).toISOString(),
      completedAt: new Date(CLOCK_MS + i * 1000 + 1).toISOString(),
    },
  }));
  writeFileSync(trail, `${stamped.map((r) => JSON.stringify(r)).join("\n")}\n`);

  // --- the offline window: nothing below may reach the backend, or anything else
  const netLog = emptyNetLog(work);
  const requestsBefore = api.requests.length;
  const env = { SHOWCASE_API_URL: api.url };
  const offline = { env, offline: true, netLog };

  const doctor = await ctx.cli(["doctor", MANIFEST_REL], offline);
  ctx.check("`doctor` exits 0: it reports health, it found no error", doctor.exit === 0);
  ctx.check("`doctor` reports a summary of what it checked (13 capabilities, 0 errors)", /13 capabilities checked — 0 error/.test(doctor.stdout));
  for (const id of ["wanderlust.cancel", "wanderlust.pay"]) {
    ctx.check(`\`doctor\` names ${id} as irreversible and its approval token as unenforced`, new RegExp(`${id.replace(".", "\\.")} — is irreversible and declares policies:\\[human-approval\\], which this version does not enforce`).test(doctor.stdout));
  }

  const summary = await ctx.cli(["audit", trail], offline);
  ctx.check("`audit` exits 0", summary.exit === 0);
  ctx.check("`audit` counts the five executions", /^5 records/m.test(summary.stdout));

  const csv = await ctx.cli(["audit", trail, "--format", "csv"], offline);
  const rows = csv.stdout.trim().split("\n").slice(1).map((l) => l.split(","));
  const column = csv.stdout.split("\n")[0].split(",").indexOf("capabilityId");
  const ran = rows.map((r) => r[column]);
  ctx.check("`audit` lists the irreversible actions that ran: wanderlust.cancel and wanderlust.pay", ran.includes("wanderlust.cancel") && ran.includes("wanderlust.pay"));

  const exposure = await ctx.cli(["apply", MANIFEST_REL, "--exposure"], offline);
  ctx.check("`apply --exposure` lists the exposed fields (exit 0)", exposure.exit === 0 && /exposes\s+budget|exposes\s+stays\[\]/.test(exposure.stdout));

  ctx.check("the backend received zero requests while these commands ran", api.requests.length === requestsBefore, { negative: true });
  ctx.check("no command attempted any outbound connection (socket, DNS or fetch)", readNetLog(netLog).length === 0, { negative: true });
}
