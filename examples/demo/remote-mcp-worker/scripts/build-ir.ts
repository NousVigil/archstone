// Build-time only (runs on Node, not at the edge). Runs the REAL Archstone pipeline —
// load -> validateSemantics -> compile, from @archstone/schema / @archstone/compiler via
// @archstone/runtime's buildRegistry — against the Showcase manifest, and freezes the result
// as a committed-shape IR JSON asset the Worker imports at cold start. This keeps the edge
// runtime free of the schema loader's fs/path/url dependencies (see README.md).
import { writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";

const here = dirname(fileURLToPath(import.meta.url));
const manifestDir = resolve(here, "../../../showcase/manifest");
const outFile = resolve(here, "../src/ir.generated.json");

const built = buildRegistry(manifestDir);

if (!built.ok || !built.registry) {
  console.error(`build-ir: manifest invalid at ${manifestDir}`);
  for (const issue of built.issues) console.error(`  - ${issue.file}: ${issue.message}`);
  for (const d of built.diagnostics.filter((x) => x.severity === "error")) console.error(`  - ${d.message}`);
  process.exit(1);
}

writeFileSync(outFile, `${JSON.stringify(built.registry.ir, null, 2)}\n`);
console.error(`build-ir: wrote ${outFile} (${built.registry.size} tool(s))`);
