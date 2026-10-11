// @archstone/init — the report (ADD-37 §6 step 7, product §11.2).
//
// PURE, and in this package rather than in `cli`, for the same reason `emit` is: a hosted
// "point us at your spec" flow needs the identical report and must not reimplement it.
//
// WHY THE REPORT IS A PRODUCT SURFACE AND NOT LOGGING. R-9 is the risk automation cannot
// close: a mapping that is structurally right and semantically wrong (`price` mapped to a
// per-night rate when the backend returns a total) compiles, verifies green, and misleads an
// agent in production. Nothing detects that. What can beat it is a two-column diff a developer
// who already knows their own API can skim in a minute — which is why the report goes to a
// COMMITTABLE FILE as well as to stdout: the file is the pull-request review surface, and a
// reviewer who was not at the terminal is the second pair of eyes.

import type { EmitResult, SkippedCandidate } from "./emit";
import { reasonSummary, type Note } from "./reasons";

/** What a probe did, flattened to the shape the report needs — so this module does not import
 *  `./probe`, which lives in the fs-touching entry. */
export interface ReportedProbe {
  capabilityId: string;
  outcome: string;
  detail: string;
}

export interface ReportInput {
  origin: string;
  adapter: string;
  targetDir: string;
  emitted: EmitResult;
  written: string[];
  failures: { code: string; message: string; file?: string }[];
  probes?: ReportedProbe[];
  verifications?: { capabilityId: string; status: string; detail: string }[];
  /** Total candidates the adapter proposed, so the decline ratio is visible. */
  candidates: number;
}

/** A target worth printing on one line: a name with a control character or a line separator (a
 *  quoted Postgres identifier may contain one) is shown as a JSON string instead of breaking the
 *  report. Everything else is printed as it always was. */
function printable(target: string): string {
  for (const ch of target) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return JSON.stringify(target);
  }
  return target;
}

const SCOPE_ORDER = ["manifest", "operation", "field"] as const;

/**
 * Group by `(code, scope)`, not by `code` alone.
 *
 * One code can be raised at two scopes for two genuinely different phenomena — a field nested
 * beyond depth 1 versus an operation whose chosen locus left root scalars behind — and folding
 * them into one bucket puts a single summary line over both. That is how this report came to
 * print "nested property beyond depth 1 was not mapped" above `total`, `page` and `limit`,
 * which are depth-1 and nested inside nothing.
 *
 * The summary is now true at both scopes, so this grouping is no longer load-bearing for
 * CORRECTNESS — it is here because the two are different things, and a reader who has been
 * told to "read these before committing" is owed them apart.
 */
function groupNotes(notes: Note[]): Map<string, Note[]> {
  const byCodeAndScope = new Map<string, Note[]>();
  for (const n of notes) {
    const key = `${n.code}\u0000${n.scope}`;
    const bucket = byCodeAndScope.get(key) ?? [];
    bucket.push(n);
    byCodeAndScope.set(key, bucket);
  }
  return byCodeAndScope;
}

function skippedLine(s: SkippedCandidate): string {
  const who = s.capabilityId ?? s.operation;
  return `    - ${who}: ${reasonSummary(s.code as never)}${s.detail ? ` — ${s.detail}` : ""}`;
}

/**
 * The human report, as one string.
 *
 * Ordered by what a reader needs first: did anything get written, what is in it, what was
 * refused and why, and only then the per-field degradations — which are numerous by design
 * (every bare `type: string` is a place a human knows something the document does not) and
 * would bury the rest if they came first.
 */
export function formatReport(input: ReportInput): string {
  const lines: string[] = [];
  const { emitted } = input;

  lines.push(`archstone init — ${input.origin} (${input.adapter} adapter)`);
  lines.push("");

  if (input.written.length === 0) {
    // D-7's second terminal state, stated as such. "Nothing was written" is a RESULT, not an
    // error condition to apologise for — a tool that writes files it cannot defend is the
    // thing the integrating developer is most afraid of.
    lines.push("NOTHING WAS WRITTEN.");
    lines.push("");
    for (const f of input.failures) lines.push(`  ✗ ${f.code}${f.file ? ` (${f.file})` : ""}: ${f.message}`);
    if (input.failures.length === 0) lines.push("  ✗ the emitter refused — see the refusals below");
  } else {
    lines.push(`Wrote ${input.written.length} file(s) to ${input.targetDir}, and the shipped compiler compiled them.`);
  }

  lines.push("");
  lines.push(`Candidates: ${input.candidates} proposed, ${emitted.capabilities.length} emitted, ${emitted.skipped.length} not emitted.`);
  for (const c of emitted.capabilities) {
    const resource = c.resource ? ` → ${c.resource}` : " (no resource — untyped output)";
    lines.push(`  ✓ ${c.capabilityId}  [${c.effect}]  ${c.operation}${resource}`);
  }

  const declined = emitted.skipped.filter((s) => s.code === "declined");
  const refused = emitted.skipped.filter((s) => s.code !== "declined");
  if (declined.length > 0) {
    lines.push("");
    lines.push(`  Declined by you (${declined.length}) — most operations in a spec are not capabilities:`);
    for (const s of declined) lines.push(`    - ${s.operation}${s.detail ? ` — ${s.detail}` : ""}`);
  }
  if (refused.length > 0) {
    lines.push("");
    lines.push(`  Refused by \`init\` (${refused.length}) — each one names why, and emitted nothing:`);
    for (const s of refused) lines.push(skippedLine(s));
  }

  if (input.probes && input.probes.length > 0) {
    lines.push("");
    lines.push("Probes (read-only, opt-in, one live request per consented capability):");
    for (const p of input.probes) {
      // `not-attempted` reads differently from `red` ON PURPOSE (§A-5): red says the backend
      // disagreed with the manifest; not-attempted says no request was ever sent.
      const icon = p.outcome === "green" ? "🟢" : p.outcome === "yellow" ? "🟡" : p.outcome === "red" ? "🔴" : "⚪";
      lines.push(`  ${icon} ${p.capabilityId} — ${p.detail}`);
    }
  }
  if (input.verifications && input.verifications.length > 0) {
    lines.push("");
    lines.push("Replay of what was recorded, through the shipped `archstone verify`:");
    for (const v of input.verifications) lines.push(`  ${v.status === "green" ? "🟢" : v.status === "yellow" ? "🟡" : "🔴"} ${v.capabilityId} — ${v.detail}`);
  }

  const notes = emitted.notes.filter((n) => n.code !== "declined");
  if (notes.length > 0) {
    lines.push("");
    lines.push("What did not survive the trip — read these before committing:");
    const byCode = groupNotes(notes);
    const sorted = [...byCode].sort(([, a], [, b]) => SCOPE_ORDER.indexOf(a[0]!.scope) - SCOPE_ORDER.indexOf(b[0]!.scope));
    for (const [key, group] of sorted) {
      const code = key.split("\u0000")[0]!;
      lines.push(`  ${code} [${group[0]!.scope}] (${group.length}) — ${reasonSummary(code as never)}`);
      for (const n of group.slice(0, 12)) {
        lines.push(`    - ${n.target !== undefined ? printable(n.target) : "(manifest)"}${n.detail ? `: ${n.detail}` : ""}`);
      }
      if (group.length > 12) lines.push(`    … and ${group.length - 12} more`);
    }
  }

  lines.push("");
  lines.push("What no tool could infer for you, and what to check by hand:");
  lines.push("  - Every `description:` is the source's own words. An agent reads them to decide");
  lines.push("    whether to call you. They are the highest-leverage thing to rewrite.");
  lines.push("  - Every `response.map` line carries the field it came from and a real example.");
  lines.push("    A mapping can be structurally right and semantically wrong; only you can see that.");
  lines.push("  - An input typed `identifier` may really be a `ref:` to a resource another");
  lines.push("    capability returns. No source construct says so — only you know.");
  lines.push("");

  return lines.join("\n");
}
