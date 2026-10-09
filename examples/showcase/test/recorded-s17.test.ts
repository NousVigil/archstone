// S-17 (AC-5.3): the backend gains a field; `verify` names it; it stays out of the exposure until a
// person declares it with `adopt`.
//
// In this version a gained field is a YELLOW reading and `verify` exits 0 (only a lost field, a changed
// type or a missing required value turn it red and exit 1), so the AC's "exits non-zero" is recorded as
// what actually happens: named, yellow, exit 0. The test pins that so a change in either direction is
// noticed. A strict `verify` that exits non-zero on a gained field is not in this version (#178); the
// transcript carries that as a claim. `adopt` runs on stay-details because of #177.

import { describe, it, expect } from "vitest";
import { commands, expectWellFormed } from "./recorded";

const t = expectWellFormed("S-17", "cli");
const steps = commands(t);
const [baseline, drifted, nobody, person, converged] = steps;

describe("recorded S-17: a gained guest email field", () => {
  it("runs the five steps in order: verify, verify, adopt (nobody), adopt (a person), verify", () => {
    expect(steps.map((s) => s.command.split(" ")[1])).toEqual(["verify", "verify", "adopt", "adopt", "verify"]);
    expect(steps.every((s) => s.command.includes("<manifest>"))).toBe(true);
  });

  it("verify is green before, and after the change names the new field as drift on wanderlust.stay-details", () => {
    expect(baseline.exit).toBe(0);
    expect(baseline.stdout).not.toMatch(/🟡|🔴/);
    expect(drifted.stdout).toContain("🟡 wanderlust.stay-details — mapping still resolves; response shape gained 1 field(s): $.guestEmail (string)");
    expect(drifted.exit, "yellow, not red: the contract still holds").toBe(0);
    expect(drifted.stdout?.match(/🟡|🔴/g)).toHaveLength(1);
  });

  it("negative: adopt with nobody at the keyboard writes nothing and fails", () => {
    expect(nobody.typed).toEqual([]);
    expect(nobody.exit).not.toBe(0);
    expect(nobody.stderr).toContain("nothing written");
    expect(nobody.stderr).toContain("Adoption needs a person");
  });

  it("a person's answers (recorded under `typed`) declare the field, and verify is green again", () => {
    expect(person.typed).toHaveLength(2);
    expect(person.typed![0]).toBe("y");
    expect(person.exit).toBe(0);
    expect(person.stdout).toContain("wanderlust.stay-details — declared guestEmail; contract re-recorded.");
    expect(converged.exit).toBe(0);
    expect(converged.stdout).not.toMatch(/🟡|🔴/);
  });

  it("negative: the field is absent from the exposure until declared (checked before and after the failed adopt)", () => {
    const claims = t.asserts.filter((a) => a.negative).map((a) => a.claim);
    expect(claims.filter((c) => /absent from the exposure/.test(c))).toHaveLength(2);
    expect(t.asserts.some((a) => /in the exposure now that a person declared it/.test(a.claim))).toBe(true);
  });
});
