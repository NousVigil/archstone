// @archstone/init — the probe leg (ADD-37 §6 step 6, D-6, R-1, R-8).
//
// THE ONE FAILURE THE BUSINESS OWNER ACTUALLY FEARS is that a scaffolding tool pointed at
// their production API writes something. So the gate below has two independent conditions and
// both are required, and neither of them lives in this file's callee:
//
//   1. a CONFIRMED `effect: read` — a human said so, at a gate, per capability; and
//   2. the METHOD rule — `GET`/`HEAD` ride on that confirmation alone, anything else needs a
//      SECOND, separate explicit confirmation, and in non-interactive mode a non-`GET`/`HEAD`
//      probe is refused outright, with no flag that enables one.
//
// `GET`-only would be the wrong gate and is worth saying why: `tourism.search` is a
// `POST /v1/search` with `effect: read`, the canonical search shape. The method rule is a
// second condition ON TOP of the confirmed read, never a substitute for it.
//
// This module lives in the `/loop` entry, not the root: it reaches the network (through
// `@archstone/runtime/verify`, never through an HTTP client of its own) and the root export is
// pure. `init` opens no socket — it asks the module that already owns record-and-replay to do
// it, so the fixture written here is by construction the artifact `verify` will replay (R-1).

import { recordContract, runVerify, type ContractRecording, type ProbeOutcome, type RecordContractOptions } from "@archstone/runtime/verify";
import type { IR, IRTool } from "@archstone/compiler";
import type { CapabilityDecision } from "./decisions";
import type { RecordedContract } from "./emit";

/** Why a probe did not happen. Distinct from `ProbeOutcome`, which is why one that DID happen
 *  ended the way it did — conflating them would let "we chose not to call" and "we called and
 *  it failed" share a word, and those are opposite facts about a backend. */
export type ProbeRefusal =
  /** The human did not consent. The default, and the common case. */
  | "no-consent"
  /** The confirmed effect is not `read`. No flag overrides this. */
  | "effect-not-read"
  /** A non-`GET`/`HEAD` method with no second explicit confirmation. */
  | "method-not-confirmed"
  /** A non-`GET`/`HEAD` method in non-interactive mode. Refused outright — there is
   *  deliberately no flag, because the second confirmation is a HUMAN act and CI has no human. */
  | "non-interactive-non-read-method"
  /** §1.3: the fixture's `request` is capability input, and none was supplied. */
  | "probe-input-unavailable"
  /** The compiled manifest has no such tool, or the tool has no connector to call. */
  | "not-invocable";

export interface ProbeReport {
  capabilityId: string;
  /** `refused` means no request was issued. Everything else is an outcome of a real attempt —
   *  except `not-attempted`, which means `invokeRest` declined to send one. */
  outcome: ProbeOutcome | "refused";
  refusal?: ProbeRefusal;
  detail: string;
  /** Present iff the recording survived a real `runVerify` replay. */
  contract?: RecordedContract;
  degraded?: string[];
  missing?: string[];
  /** Origin-checked fields whose recorded value was outside the declared origins — names only. */
  withheld?: string[];
}

const FREE_METHODS = new Set(["GET", "HEAD"]);

export interface GateContext {
  /** False for CI and for a Decision Record file. The distinction is not cosmetic: the
   *  non-`GET` second confirmation is a human act, and there is no human here. */
  interactive: boolean;
}

export type GateResult = { allowed: true; input: Record<string, unknown> } | { allowed: false; refusal: ProbeRefusal; detail: string };

/**
 * R-8's gate, as a pure function so it can be tested exhaustively without a backend.
 *
 * Every refusal path returns BEFORE any caller could reach `recordContract`, and the tests
 * assert the strong form of that — "no request is issued for any non-confirmed-read
 * capability, under any flag" — by counting calls to an injected fetch, not by inspecting
 * this function's return value.
 */
export function probeGate(decision: Extract<CapabilityDecision, { keep: true }>, tool: IRTool | undefined, ctx: GateContext): GateResult {
  if (!tool || !tool.connector) {
    return { allowed: false, refusal: "not-invocable", detail: "the compiled manifest has no invocable tool for this capability" };
  }
  if (decision.probe !== true) {
    return { allowed: false, refusal: "no-consent", detail: "no probe was requested for this capability" };
  }
  if (decision.effect !== "read") {
    return { allowed: false, refusal: "effect-not-read", detail: `confirmed effect is '${decision.effect}' — \`init\` never issues a write` };
  }

  const method = (tool.connector.rest?.method ?? "").toUpperCase();
  if (!FREE_METHODS.has(method)) {
    if (!ctx.interactive) {
      return {
        allowed: false,
        refusal: "non-interactive-non-read-method",
        detail: `${method} needs a second, explicit human confirmation, and there is no human here`,
      };
    }
    if (decision.probeNonReadMethodConfirmed !== true) {
      return { allowed: false, refusal: "method-not-confirmed", detail: `${method} needs a second, separate confirmation beyond \`effect: read\`` };
    }
  }

  const input = decision.sampleInput;
  const missing = tool.input.filter((f) => f.required && (input === undefined || input[f.name] === undefined)).map((f) => f.name);
  if (missing.length > 0) {
    // §1.3, and the sharpest unglamorous constraint in the increment: the fixture's `request`
    // is CAPABILITY input, not an HTTP request, and a document usually cannot supply it. A
    // report line, never a fallback — and never the adapter's `example`, which may name a real
    // customer's record (D-13).
    return { allowed: false, refusal: "probe-input-unavailable", detail: `no sample value for required input(s): ${missing.join(", ")}` };
  }
  return { allowed: true, input: input ?? {} };
}

/** A recording promoted to an emittable contract — or `undefined` when nothing may be written. */
function contractOf(recording: ContractRecording): RecordedContract | undefined {
  if (recording.fingerprint === undefined || recording.fixture === undefined) return undefined;
  return {
    fingerprint: recording.fingerprint,
    ...(recording.shape ? { shape: recording.shape } : {}),
    recordedAt: recording.fixture.recordedAt ?? new Date(0).toISOString(),
    fixture: recording.fixture,
  };
}

export interface RunProbesOptions extends RecordContractOptions {
  interactive: boolean;
}

/**
 * Probe every consented capability against the compiled manifest, once.
 *
 * Returns reports only — writing is the caller's job, and keeping it that way is what lets the
 * loop drop a contract after a failed replay without this function knowing about files.
 */
export async function runProbes(
  ir: IR,
  decisions: Extract<CapabilityDecision, { keep: true }>[],
  opts: RunProbesOptions,
): Promise<ProbeReport[]> {
  const byId = new Map(ir.tools.map((t) => [t.id, t]));
  const reports: ProbeReport[] = [];

  // Sequential, not `Promise.all`: these are live calls to somebody's production backend, made
  // by a scaffolding tool the user is running for the first time. A burst is a worse first
  // impression than a wait, and nothing here is latency-sensitive.
  for (const decision of decisions) {
    const tool = byId.get(decision.capabilityId);
    const gate = probeGate(decision, tool, { interactive: opts.interactive });
    if (!gate.allowed) {
      reports.push({ capabilityId: decision.capabilityId, outcome: "refused", refusal: gate.refusal, detail: gate.detail });
      continue;
    }
    const recording = await recordContract(tool!, gate.input, ir.resources, opts);
    const contract = contractOf(recording);
    reports.push({
      capabilityId: decision.capabilityId,
      outcome: recording.outcome,
      detail: recording.detail,
      ...(contract ? { contract } : {}),
      ...(recording.degraded ? { degraded: recording.degraded } : {}),
      ...(recording.missing ? { missing: recording.missing } : {}),
      ...(recording.withheld ? { withheld: recording.withheld } : {}),
    });
  }
  return reports;
}

/**
 * R-1's mitigation, made real: replay every just-written contract through the SHIPPED
 * `runVerify`, over the directory the files were written into, and report which ones survived.
 *
 * Not belt-and-braces. `recordContract` and `verifyTool` share a module and an `invokeRest`
 * call, which is what makes the artifact replayable in principle; this proves it in fact, on
 * this manifest, against this backend, before the developer's directory is touched. A fixture
 * that looks green at record time and cannot be replayed afterwards turns the safety net into
 * a liability, silently, for the manifest's lifetime.
 */
export async function verifyRecorded(
  ir: IR,
  dir: string,
  opts?: RecordContractOptions,
): Promise<{ green: Set<string>; reports: { capabilityId: string; status: string; detail: string }[] }> {
  // #124 (ADD-124 D-8/D-9): `runVerify` now returns `{results, skipped}`, and it declines to
  // replay a `write`/`irreversible` contract by default. NO `--sandbox`-equivalent opt-in is
  // threaded through here, deliberately — uniform behaviour, no per-caller carve-out.
  //
  // In practice this is a no-op against `init`'s own output: `recordContract` is reachable only
  // through the probe gate, which refuses any non-`read` effect before recording (R-8), so every
  // fixture `init` can produce is for a `read` capability and `skipped` is always empty. The one
  // case it does bite — a manifest hand-edited to carry a `contract:` on a non-`read` capability
  // between `init` runs — is exactly the risk #124 exists to close. Such a contract lands outside
  // `green` and is dropped from the final emit, which is the correct, conservative outcome: `init`
  // commits a contract only when it has watched the shipped verifier replay it.
  const { results: reports } = await runVerify(ir.tools, dir, ir.resources, opts);
  const green = new Set(reports.filter((r) => r.status !== "red").map((r) => r.capabilityId));
  return { green, reports: reports.map((r) => ({ capabilityId: r.capabilityId, status: r.status, detail: r.detail })) };
}
