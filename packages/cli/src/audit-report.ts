// `archstone audit` — read a JSON Lines audit trail, filter it, and render it for someone who
// has to answer a question about it (#44's records; see docs/ONBOARDING.md).
//
// The records are the deployer's own files, written by `rotatingFileAuditSink` or any sink they
// wrote themselves. Archstone never receives them, so this is a local reader over local files —
// no service, no index, no daemon.
//
// Everything here is pure and takes lines in, strings out: the CLI does the I/O.

import type { ExecutionRecord } from "@archstone/emitter-support";

export interface AuditFilter {
  since?: string;
  until?: string;
  capability?: string;
  /** Exact match. Anonymous invocations are selected with `anonymous`, not with `""` — see
   *  `applyFilter`. */
  principal?: string;
  /** Select only invocations that carried no principal at all. The absence of the field is a
   *  real distinction (ADD-42 D-4: anonymous is not denied, but never privileged), so it gets
   *  its own selector rather than being spelled as an empty principal. */
  anonymous?: boolean;
  phase?: string;
}

export interface ParseOutcome {
  records: ExecutionRecord[];
  /** Lines that were not a parseable Execution record, with their 1-based position. */
  skipped: { line: number; reason: string }[];
}

/**
 * Parse JSON Lines into records, keeping what could not be read rather than discarding it.
 *
 * A silent skip is the wrong behaviour for an audit tool specifically: an unreadable line is
 * either corruption or a record written by a version this reader does not understand, and both
 * are things the person running the report needs told. Blank lines are not "skipped" — a
 * trailing newline is normal, not a defect.
 */
export function parseAuditLines(text: string): ParseOutcome {
  const records: ExecutionRecord[] = [];
  const skipped: { line: number; reason: string }[] = [];

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skipped.push({ line: i + 1, reason: "not valid JSON" });
      return;
    }
    const rec = parsed as Partial<ExecutionRecord>;
    if (rec?.kind !== "Execution" || !rec.metadata || !rec.status) {
      skipped.push({ line: i + 1, reason: "not an Execution record" });
      return;
    }
    records.push(rec as ExecutionRecord);
  });

  return { records, skipped };
}

/** Inclusive on `since`, exclusive on `until` — the convention that makes adjacent day ranges
 *  tile without double-counting the boundary record. */
export function applyFilter(records: readonly ExecutionRecord[], f: AuditFilter): ExecutionRecord[] {
  return records.filter((r) => {
    if (f.since && r.metadata.startedAt < f.since) return false;
    if (f.until && r.metadata.startedAt >= f.until) return false;
    if (f.capability && r.metadata.capabilityId !== f.capability) return false;
    if (f.phase && r.status.phase !== f.phase) return false;
    // Two different questions, deliberately not one. `principal: ""` means "the caller supplied
    // an empty string as its principal", which is a present-but-empty value and a real thing a
    // host can do; `anonymous` means the field was absent. Conflating them — the shape this
    // filter shipped with in v0.12.0 — makes the more common question the harder one to ask,
    // and makes a plausible typo (`--principal ""`) silently answer the other one.
    if (f.anonymous && r.spec.principal !== undefined) return false;
    if (f.principal !== undefined && r.spec.principal !== f.principal) return false;
    return true;
  });
}

const CSV_COLUMNS = [
  "startedAt",
  "completedAt",
  "capabilityId",
  "provider",
  "phase",
  "denialReason",
  "principal",
  "consumer",
  "policyRuleIds",
  "sessionId",
  "id",
] as const;

function csvCell(value: string | undefined): string {
  const v = value ?? "";
  // Quote when the value could otherwise change the shape of the row. Doubling the quote is the
  // RFC 4180 escape, and it is what every spreadsheet expects.
  return /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/**
 * CSV, because the person who asks for an audit export opens it in a spreadsheet.
 *
 * The `input` field is deliberately absent: it is per-capability shaped, frequently large, and
 * carries whatever the caller sent — flattening it into a column would both break the row shape
 * and put payloads in a file that gets emailed around. `--format jsonl` keeps the full record
 * for anyone who needs it.
 */
export function toCsv(records: readonly ExecutionRecord[]): string {
  const rows = records.map((r) =>
    [
      r.metadata.startedAt,
      r.metadata.completedAt,
      r.metadata.capabilityId,
      r.metadata.provider,
      r.status.phase,
      r.status.denialReason,
      r.spec.principal,
      r.spec.consumer,
      r.spec.policyRuleIds?.join(" "),
      r.metadata.sessionId,
      r.metadata.id,
    ]
      .map(csvCell)
      .join(","),
  );
  return [CSV_COLUMNS.join(","), ...rows].join("\n");
}

function countBy<T>(items: readonly T[], key: (item: T) => string | undefined): [string, number][] {
  const counts = new Map<string, number>();
  for (const item of items) {
    const k = key(item);
    if (k === undefined) continue;
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  // Descending by count, then by name — deterministic output, because a report that reorders
  // between runs on equal counts cannot be diffed against last month's.
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function table(title: string, rows: [string, number][], limit = 20): string[] {
  if (rows.length === 0) return [];
  const shown = rows.slice(0, limit);
  const width = Math.max(...shown.map(([name]) => name.length));
  const out = [``, title, ...shown.map(([name, n]) => `  ${name.padEnd(width)}  ${String(n).padStart(6)}`)];
  if (rows.length > shown.length) out.push(`  … and ${rows.length - shown.length} more`);
  return out;
}

/** One `human-approval` approval id that appears on more than one executed record. */
export interface ApprovalReuse {
  approvalId: string;
  /** The executed records carrying it, in the order read. */
  records: { id: string; capabilityId: string; startedAt: string; phase: string; reference?: string }[];
}

/**
 * ADD-393 D-7 — detection after the fact, never prevention: a `human-approval` approval id on
 * more than one EXECUTED record (`succeeded` or `failed` — a `denied` attempt never ran). Keyed
 * on the id the agent presented, with the endpoint's `reference` beside it as secondary evidence.
 *
 * It finds what the records show and nothing else. The endpoint contract asks the deployer's
 * endpoint to consume an `irreversible` approval in the operation that answers `allowed`;
 * Archstone cannot observe that, and this is how an auditor sees it afterwards. It needs records,
 * so it exists only where an audit sink is wired — `archstone serve` wires none. Not applied to
 * consents, which are commonly durable.
 */
export function findApprovalReuse(records: readonly ExecutionRecord[]): ApprovalReuse[] {
  const byId = new Map<string, ApprovalReuse["records"]>();
  for (const r of records) {
    if (r.status.phase !== "succeeded" && r.status.phase !== "failed") continue;
    const entry = r.status.decisionReferences?.["human-approval"];
    if (!entry || typeof entry.approvalId !== "string") continue;
    const list = byId.get(entry.approvalId) ?? [];
    list.push({
      id: r.metadata.id,
      capabilityId: r.metadata.capabilityId,
      startedAt: r.metadata.startedAt,
      phase: r.status.phase,
      ...(entry.reference !== undefined ? { reference: entry.reference } : {}),
    });
    byId.set(entry.approvalId, list);
  }
  return [...byId.entries()]
    .filter(([, list]) => list.length > 1)
    .map(([approvalId, list]) => ({ approvalId, records: list }))
    .sort((a, b) => a.approvalId.localeCompare(b.approvalId));
}

/**
 * The default rendering: what happened, to what, and what was refused.
 *
 * Denials are reported separately from failures rather than folded into one "not succeeded"
 * bucket, because they answer different questions. A failure is the backend or the contract
 * going wrong; a denial is governance doing its job, and an auditor asking "show me what was
 * refused and why" is asking about the second one.
 */
export function summarize(records: readonly ExecutionRecord[]): string {
  if (records.length === 0) return "No records matched.";

  const times = records.map((r) => r.metadata.startedAt).sort();
  const denied = records.filter((r) => r.status.phase === "denied");
  const lines: string[] = [
    `${records.length} record${records.length === 1 ? "" : "s"}`,
    `  from  ${times[0]}`,
    `  to    ${times[times.length - 1]}`,
  ];

  lines.push(...table("By outcome", countBy(records, (r) => r.status.phase)));
  lines.push(...table("By capability", countBy(records, (r) => r.metadata.capabilityId)));
  lines.push(...table("Denials by reason", countBy(denied, (r) => r.status.denialReason ?? "(unstated)")));
  lines.push(
    ...table(
      "By principal",
      countBy(records, (r) => r.spec.principal ?? "(anonymous)"),
    ),
  );

  const reuse = findApprovalReuse(records);
  if (reuse.length > 0) {
    lines.push("", "Approval ids on more than one executed record (the endpoint should have consumed them)");
    for (const r of reuse) {
      lines.push(`  ${r.approvalId}`);
      for (const rec of r.records) {
        lines.push(`    ${rec.startedAt}  ${rec.capabilityId}  ${rec.phase}${rec.reference ? `  reference ${rec.reference}` : ""}  ${rec.id}`);
      }
    }
  }

  return lines.join("\n");
}
