// S-20 (AC-5.6): `init` from the synthetic OpenAPI: no delete action, no passport/phone, nothing published.

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { REPO_ROOT } from "./harness";
import { expectWellFormed, stepWith } from "./recorded";

const t = expectWellFormed("S-20", "cli");
const init = stepWith(t, "archstone init");
const decisions = JSON.parse(readFileSync(resolve(REPO_ROOT, "examples/showcase/record/s20-decisions.json"), "utf8")) as { decisions: { operation: string; keep: boolean; capabilityId?: string }[] };

describe("recorded S-20: init from the synthetic OpenAPI", () => {
  it("proposes every operation of the document and emits only what a person confirmed", () => {
    expect(init.exit).toBe(0);
    expect(init.command).toContain("--non-interactive");
    expect(init.stdout).toContain("Candidates: 16 proposed, 3 emitted");
    const kept = decisions.decisions.filter((d) => d.keep).map((d) => d.capabilityId);
    expect(kept).toEqual(["wanderlust.search", "wanderlust.stay-details", "wanderlust.availability"]);
    const emitted = [...init.stdout!.matchAll(/^ {2}✓ (\S+)/gm)].map((m) => m[1]);
    expect(emitted).toEqual(kept);
  });

  it("negative: no delete action in the draft; the DELETE was proposed and declined", () => {
    expect(init.stdout).toContain("Declined by you (1)");
    expect(init.stdout).toContain("DELETE /v1/guests/{name}/bookings");
    expect([...init.stdout!.matchAll(/^ {2}✓ .*$/gm)].map((m) => m[0]).join("\n")).not.toMatch(/delete|DELETE/);
  });

  it("negative: no passport or phone anywhere in the draft's output, and nothing published", () => {
    expect(init.stdout!.toLowerCase()).not.toMatch(/passport|phone|margin/);
    const negatives = t.asserts.filter((a) => a.negative).map((a) => a.claim);
    expect(negatives.some((c) => /mentions no 'passport'/.test(c))).toBe(true);
    expect(negatives.some((c) => /mentions no 'phone'/.test(c))).toBe(true);
    expect(negatives).toContain("nothing was published: `init` made no outbound connection of any kind");
  });
});
