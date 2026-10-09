// `archstone apply --exposure` — the human rendering of ADD-309's exposure report.
//
// Rendering only. What is exposed or withheld is decided once, in `@archstone/compiler`'s
// `exposureOfIR`; this module turns it into lines and adds no judgment of its own (D-7): nothing
// is flagged, nothing is proposed for adoption.

import type { IRType, ToolExposure } from "@archstone/compiler";
import type { Surface } from "@archstone/emitter-support";

/** A capability's field report plus where it stands on the surface a model sees (#173). */
export type ExposureEntry = ToolExposure & Surface;

export interface ExposureTotals {
  declared: number;
  /** Equals the number of tools `tools/list` advertises for the same manifest. */
  exposed: number;
  /** Callable by id, not advertised (`experimental`). */
  unlisted: number;
  /** Neither advertised nor callable (`retired`, unrecognised lifecycle, or unbound). */
  notExposed: number;
}

export function totalsOf(entries: ExposureEntry[]): ExposureTotals {
  const count = (state: Surface["state"]): number => entries.filter((e) => e.state === state).length;
  return { declared: entries.length, exposed: count("exposed"), unlisted: count("unlisted"), notExposed: count("not_exposed") };
}

function stateLabel(e: Surface): string {
  switch (e.state) {
    case "exposed":
      return "exposed";
    case "unlisted":
      return `unlisted (${e.reason}) — callable by id, not advertised`;
    case "not_exposed":
      return `not exposed (${e.reason})`;
  }
}

/** An IR type as a reader would name it: the semantic type, a resource name, or `Name[]`. */
function typeName(t: IRType): string {
  switch (t.kind) {
    case "scalar":
      return t.semantic;
    case "resource":
      return t.identity ? `ref ${t.name}` : t.name;
    case "collection":
      return `${t.of}[]`;
    case "list":
      return `${t.items}[]`;
  }
}

function field(name: string, type: IRType, notes: string[]): string {
  return `${name} (${[typeName(type), ...notes].join(", ")})`;
}

/** `sha256:f5475f16…` → `sha256:f5475f…` — enough to tell two observations apart at a glance;
 *  `--json` carries the whole fingerprint. */
function shortFingerprint(fp: string): string {
  const i = fp.indexOf(":");
  return i === -1 ? `${fp.slice(0, 6)}…` : `${fp.slice(0, i + 7)}…`;
}

const INDENT = "               ";

/** The report as lines, one block per capability, in `exposureOfIR`'s order. */
export function formatExposure(report: ExposureEntry[]): string[] {
  const t = totalsOf(report);
  const lines: string[] = ["", "  exposure   what a model sends, is shown, and never sees — names and types only"];
  lines.push(`  totals     ${t.declared} declared — ${t.exposed} exposed, ${t.unlisted} unlisted, ${t.notExposed} not exposed`);
  for (const e of report) {
    lines.push("", `  ${e.capabilityId}  [${e.effect}]  ${stateLabel(e)}`);

    const receives = e.receives.map((f) => field(f.name, f.type, f.required ? [] : ["optional"]));
    lines.push(`    receives   ${receives.length > 0 ? receives.join(", ") : "nothing"}`);

    if (e.passthrough) {
      lines.push("    exposes    the provider's whole response body — the binding declares no response: or extract:");
    } else {
      const exposes = e.exposes.map((f) => {
        const notes = f.required ? [] : ["optional"];
        if (f.via === "extract") notes.push("extract");
        if (f.via === "unmapped") notes.push("declared, never filled");
        return field(f.path, f.type, notes);
      });
      lines.push(`    exposes    ${exposes.length > 0 ? exposes.join(", ") : "nothing"}`);
    }

    if (e.withholds === "unknown") {
      lines.push("    withholds  unknown — no recorded contract");
      continue;
    }
    const withholds = e.withholds.map((w) => `${w.path} (${w.observed})`);
    lines.push(`    withholds  ${withholds.length > 0 ? withholds.join(", ") : "nothing observed"}`);
    if (e.observation) {
      lines.push(`${INDENT}as observed in ${e.observation.fixture} (${shortFingerprint(e.observation.fingerprint)})`);
    }
  }
  return lines;
}
