// @archstone/compiler — business-semantic lint, slice 1: the irreversible checklist (ADD-311).
//
// `validateSemantics` asks whether a manifest RESOLVES. This asks what an `irreversible`
// capability's declaration still lacks: a way to say how it fails, an authenticated caller, an
// enforced policy. Every finding is a `warning` over the declaration — a statement about what the
// manifest says and what this version enforces, never about the backend (`archstone verify` is
// the check against the provider) — and none changes an exit code.
//
// Pure: no I/O, no clock. `effect`, `policies`, `policyRules` and `lifecycle` come from the IR;
// `failures`, the one fact the IR does not carry (ADD-311 D-1), from the loaded capability docs.

import type { LoadResult } from "@archstone/schema";
import type { IR } from "./ir";
import { UNENFORCED_POLICY_TOKENS } from "./unenforced-tokens";

/** Closed set. A code once shipped is never renamed; a new one arrives only by amendment to ADD-311 §4. */
export const LINT_CODES = Object.freeze([
  "irreversible-no-failures",
  "irreversible-unauthenticated",
  "irreversible-unenforced-policy",
] as const);

export type LintCode = (typeof LINT_CODES)[number];

export interface LintFinding {
  code: LintCode;
  severity: "warning";
  /** `IRTool.id`. */
  capability: string;
  /** `irreversible-unenforced-policy` only: the unenforced CDL token. */
  token?: string;
  /** The first sentence, without the `capability '<id>'` prefix a renderer adds. */
  message: string;
  /** The rest: what it means and what to change. */
  because: string;
}

/**
 * Precondition: `ir` is `compile(model)` of a manifest with no shape or semantic error. Findings
 * follow `ir.tools` order (manifest load order); within a capability, no-failures, then
 * unauthenticated, then unenforced-policy per distinct token in declared order. A `retired`
 * capability is neither listed nor invocable, so none of these statements is true of it and it
 * is not linted (ADD-311 D-10).
 */
export function lintIR(ir: IR, model: Pick<LoadResult, "capabilityDocs">): LintFinding[] {
  const docs = new Map<string, LoadResult["capabilityDocs"][number]>();
  for (const d of model.capabilityDocs) if (!docs.has(d.capability.id)) docs.set(d.capability.id, d);

  const findings: LintFinding[] = [];
  for (const tool of ir.tools) {
    if (tool.effect !== "irreversible" || tool.lifecycle === "retired") continue;
    const capability = tool.id;
    const rules = tool.policyRules ?? [];

    // Absence is read off the document; a tool with no document (impossible under the
    // precondition) is never reported — absence of `failures` is not inferred from absence of the file.
    const doc = docs.get(tool.id);
    if (doc && doc.capability.failures == null) {
      findings.push({
        code: "irreversible-no-failures",
        severity: "warning",
        capability,
        message: "is irreversible and declares no failures.",
        because:
          "When it fails, an agent can say only that it failed, not why, and must not retry. Name the business outcomes that stop it under failures: (for example insufficient-funds, already-refunded).",
      });
    }

    // A non-empty `allow` already refuses an absent principal (`evaluatePolicy`), so "any caller
    // can invoke it" would be false there (D-11). A deny-only rule does not: an absent principal matches nothing in `deny`.
    if (!tool.policies.includes("authenticated") && !rules.some((r) => (r.allow?.length ?? 0) > 0)) {
      findings.push({
        code: "irreversible-unauthenticated",
        severity: "warning",
        capability,
        message: "is irreversible and does not declare policies:[authenticated].",
        because:
          "Any caller that can reach this server can invoke it. If that is intended, nothing to change; this line stays so the decision stays visible. Otherwise add authenticated to policies:.",
      });
    }

    // The IR's `policies` is not deduplicated, so dedupe here (first-declared order).
    for (const token of new Set(tool.policies)) {
      const entry = UNENFORCED_POLICY_TOKENS[token];
      if (!entry) continue;
      // An attached `spec.rateLimit` makes the call counted or denied fail-closed, so the
      // consequence and action below would be false (D-12). The token IS still unenforced:
      // BR-40 keeps that one pair.
      if (token === "rate-limited" && rules.some((r) => r.rateLimit !== undefined)) continue;
      findings.push({
        code: "irreversible-unenforced-policy",
        severity: "warning",
        capability,
        token,
        message: `is irreversible and declares policies:[${token}], which this version does not enforce: ${entry.why}.`,
        because: `${entry.consequence} ${entry.action}`,
      });
    }
  }
  return findings;
}
