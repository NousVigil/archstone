// The embedded SDK, end to end, against the Showcase: no MCP server process, no AI app.
//
//   archstone build examples/showcase/manifest --out ir.json
//   SHOWCASE_API_URL=http://localhost:8788 node examples/showcase/sdk/embedded.mjs --ir ir.json
//
// It loads the compiled IR with `fromIR`, hands the SAME capabilities to three vendors' tool-calling
// formats with `tools()`, and runs two of them with `execute()`:
//
//   S-02  the stay-details tool returns the declared fields and none of what the backend also sends
//         (margin, passport, phone, raw HTML, the guest list);
//   S-14  there is no tool that deletes, and asking `execute()` for one is refused before any request.
//
// It prints one JSON report on stdout, and exits 1 (naming what failed on stderr) if any of that does
// not hold. `tools()` is a lowering of the IR and `execute()` a call through the same projection the
// MCP server uses; neither makes the synthetic backend safe, they only decline to forward what the
// manifest does not name.
import { readFileSync } from "node:fs";
import { fromIR } from "@archstone/agent";

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const irPath = flag("--ir");
if (!irPath) {
  console.error("usage: node embedded.mjs --ir <ir.json> [--api <url>]  (SHOWCASE_API_URL is used when --api is absent)");
  process.exit(2);
}
const api = flag("--api") ?? process.env.SHOWCASE_API_URL;

const sdk = fromIR(JSON.parse(readFileSync(irPath, "utf8")));

const failures = [];
const expect = (claim, ok) => {
  if (!ok) failures.push(claim);
};

// --- three vendor shapes, one set of tools
const nameOf = {
  anthropic: (t) => t.name,
  "openai-chat": (t) => t.function.name,
  gemini: (t) => t.name,
};
const vendorShapes = {};
const names = {};
for (const format of Object.keys(nameOf)) {
  const defs = sdk.tools(format);
  names[format] = defs.map(nameOf[format]).sort();
  vendorShapes[format] = { tools: defs.length, envelopeKeys: Object.keys(defs[0]).sort() };
}
const toolNames = names.anthropic;
expect("the three vendor shapes expose the same tools", Object.values(names).every((n) => JSON.stringify(n) === JSON.stringify(toolNames)));
expect("every shape lists at least ten tools", toolNames.length >= 10);
expect("no shape lists a tool that deletes", !toolNames.some((n) => /delete|remove|erase/i.test(n)));
expect("the shapes differ in envelope, not in content", new Set(Object.values(vendorShapes).map((v) => v.envelopeKeys.join())).size === 3);

// --- S-02: withholding still holds
const FORBIDDEN = ["margin", "passport", "phone", "description_html", "net", "commission", "guests"];
const keysOf = (value, out = new Set()) => {
  if (Array.isArray(value)) value.forEach((v) => keysOf(v, out));
  else if (value && typeof value === "object") {
    for (const [k, v] of Object.entries(value)) {
      out.add(k);
      keysOf(v, out);
    }
  }
  return out;
};
const stay = await sdk.execute("wanderlust.stay-details", { stayId: "ws-1001" }, { env: { SHOWCASE_API_URL: api } });
expect("stay-details returns status ok", stay.status === "ok");
const seen = keysOf(stay.data);
expect("stay-details returns the declared fields (stay.name, stay.rooms)", seen.has("name") && seen.has("rooms"));
const leaked = FORBIDDEN.filter((k) => seen.has(k));
expect(`stay-details returns none of ${FORBIDDEN.join(", ")} at any depth`, leaked.length === 0);

// --- S-14: the refusal still holds
const gone = await sdk.execute("wanderlust.delete-guest-bookings", { name: "Ana Pop" }, { env: { SHOWCASE_API_URL: api } });
expect("asking for a delete capability is refused as unknown", gone.status === "error" && /unknown capability/.test(gone.error ?? ""));

const report = {
  vendorShapes,
  toolNames,
  stayDetails: { status: stay.status, topLevelKeys: Object.keys(stay.data ?? {}), forbiddenKeysFound: leaked },
  deleteRequest: { status: gone.status, error: gone.error },
  failures,
};
console.log(JSON.stringify(report, null, 2));
if (failures.length > 0) {
  console.error(`embedded.mjs: ${failures.length} expectation(s) failed:\n  - ${failures.join("\n  - ")}`);
  process.exit(1);
}
