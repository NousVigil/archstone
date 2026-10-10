// AC-2.18: the eight denial reasons are each reached at least once through the real runtime, and
// this file FAILS if one is unreachable. The set is closed: the observed reasons must equal it
// exactly, so a reason that stops being reachable fails here, and a new runtime reason fails the type-level check below.
//
// Each case triggers a refusal on the MCP tool path, reads the named reason from `_meta`, checks
// the embedded SDK path names the same one where it has a `denial`, and checks that the backend
// received nothing the refusal should have stopped.

import { describe, it, expect } from "vitest";
import type { ExecutionDenialReason } from "@archstone/emitter-support";
import type { CallResult } from "@archstone/runtime";
import { loadScenarios, type KeyLabel, type ScenarioRow } from "./harness";
import { installGlobalInvariants, reasonOf, session, type Session } from "./negatives-support";

/** The closed set named by the increment. `contract_violation` is carried under its own `_meta`
 *  key (the output did not meet the declared shape) rather than as a policy denial, but it is a
 *  named refusal all the same. `lifecycle_unevaluatable` (an unrecognised lifecycle value) is
 *  deliberately not here: it can only come from a hand-written artifact, never from a manifest
 *  that compiles, so no live scenario can reach it. */
const CLOSED_SET = [
  "authenticated_no_credential",
  "principal_denied",
  "principal_not_allowed",
  "policy_unevaluatable",
  "rate_limit_exceeded",
  "lifecycle_blocked",
  "contract_violation",
  "input_invalid",
] as const satisfies readonly (ExecutionDenialReason | "contract_violation")[];

/** Type-level exhaustiveness: every runtime reason except the one deliberately excluded must be in
 *  the closed set. A new `ExecutionDenialReason` makes `Unaccounted` non-never and this line fail
 *  to compile (`pnpm typecheck`). */
type Unaccounted = Exclude<ExecutionDenialReason, (typeof CLOSED_SET)[number] | "lifecycle_unevaluatable">;
const _exhaustive: [Unaccounted] extends [never] ? true : never = true;
void _exhaustive;

const rows = loadScenarios().scenarios;
const row = (id: string): ScenarioRow => rows.find((r) => r.id === id)!;

interface Case {
  reason: (typeof CLOSED_SET)[number];
  /** Which scenario drives it, for the reader. */
  scenario: string;
  /** Makes the refused call; returns what the call said and what reached the agency. */
  trigger(s: Session): Promise<{ result: CallResult; reached: boolean }>;
}

/** The book call, with a real quote id from setup, under a chosen key. */
async function book(s: Session, key: KeyLabel, extra?: { callerResolutionFailed?: boolean }) {
  const quote = await s.call("wanderlust_quote", row("S-05").arguments!);
  const quoteId = (quote.structuredContent as { quote: { quoteId: string } }).quote.quoteId;
  const r = await s.call("wanderlust_book", { ...row("S-06").arguments!, quoteId }, key, extra);
  return { result: r, reached: s.spy.apiCalls().includes("POST /v1/bookings") };
}

const cases: Case[] = [
  { reason: "authenticated_no_credential", scenario: "S-06", trigger: (s) => book(s, "none") },
  { reason: "principal_denied", scenario: "S-07", trigger: (s) => book(s, "B") },
  { reason: "principal_not_allowed", scenario: "S-07", trigger: (s) => book(s, "other") },
  { reason: "policy_unevaluatable", scenario: "S-07", trigger: (s) => book(s, "A", { callerResolutionFailed: true }) },
  {
    reason: "rate_limit_exceeded",
    scenario: "S-11",
    trigger: async (s) => {
      for (let i = 0; i < 3; i++) await s.call("wanderlust_availability", row("S-11").arguments!);
      const r = await s.call("wanderlust_availability", row("S-11").arguments!);
      return { result: r, reached: s.spy.apiCalls().filter((c) => c.includes("availability")).length > 3 };
    },
  },
  {
    reason: "lifecycle_blocked",
    scenario: "S-12",
    trigger: async (s) => {
      const r = await s.call(row("S-12").negative!.tool!, row("S-12").arguments!);
      return { result: r, reached: s.spy.requests.length > 0 };
    },
  },
  {
    // #195: arguments that do not match the declared input contract never reach the agency.
    reason: "input_invalid",
    scenario: "S-01",
    trigger: async (s) => {
      const r = await s.call("wanderlust_search", { destination: { $ne: 1 }, dates: "tomorrow", travelers: -1 });
      return { result: r, reached: s.spy.requests.length > 0 };
    },
  },
  {
    reason: "contract_violation",
    scenario: "S-13",
    trigger: async (s) => {
      const r = await s.call("wanderlust_room-status", row("S-13").negative!.arguments!);
      // A violation is detected AFTER the agency answered, so the one request is expected here;
      // what must not happen is the bad answer being passed on (checked below: no structured content).
      return { result: r, reached: false };
    },
  },
];

installGlobalInvariants();

describe("AC-2.18: the eight denial reasons", () => {
  const observed = new Map<string, number>();

  for (const c of cases) {
    it(`reaches ${c.reason} (${c.scenario}) through the real runtime`, async () => {
      const s = session();
      const out = await c.trigger(s);
      expect(out.result.isError).toBe(true);
      expect(reasonOf(out.result._meta)).toBe(c.reason);
      expect(out.reached, "the refusal must not reach the agency endpoint it guards").toBe(false);
      // A refusal carries no structured content a model could mistake for a result.
      expect(out.result.structuredContent).toBeUndefined();
      observed.set(c.reason, (observed.get(c.reason) ?? 0) + 1);
    });
  }

  it("the reasons observed are exactly the closed set: none unreached, none unaccounted for", () => {
    expect([...observed.keys()].sort()).toEqual([...CLOSED_SET].sort());
    expect(new Set(cases.map((c) => c.reason)).size).toBe(CLOSED_SET.length);
  });

  it("each policy and lifecycle reason is named the same way on the embedded path", async () => {
    const embedded: Record<string, string | undefined> = {};
    const s = session();
    const quote = await s.call("wanderlust_quote", row("S-05").arguments!);
    const quoteId = (quote.structuredContent as { quote: { quoteId: string } }).quote.quoteId;
    const bookArgs = { ...row("S-06").arguments!, quoteId };
    embedded.authenticated_no_credential = (await s.execute("wanderlust.book", bookArgs, "none")).denial?.reason;
    embedded.principal_denied = (await s.execute("wanderlust.book", bookArgs, "B")).denial?.reason;
    embedded.principal_not_allowed = (await s.execute("wanderlust.book", bookArgs, "other")).denial?.reason;
    for (let i = 0; i < 3; i++) await s.execute("wanderlust.availability", row("S-11").arguments!);
    embedded.rate_limit_exceeded = (await s.execute("wanderlust.availability", row("S-11").arguments!)).denial?.reason;
    embedded.input_invalid = (await s.execute("wanderlust.search", { destination: { $ne: 1 }, dates: "tomorrow", travelers: -1 })).denial?.reason;
    embedded.lifecycle_blocked = (await s.execute("tourism.search-classic", row("S-12").arguments!)).denial?.reason;
    for (const [reason, got] of Object.entries(embedded)) expect(got, reason).toBe(reason);
    // The violation is a status, not a denial, on this path.
    const violation = await s.execute("wanderlust.room-status", row("S-13").negative!.arguments!);
    expect(violation.status).toBe("violation");
    expect(violation.denial).toBeUndefined();
  });
});
