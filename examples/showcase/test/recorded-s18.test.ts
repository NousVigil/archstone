// S-18 (AC-5.4): `diff` on two IRs names one new visible field and one new action, with the backend stopped.

import { describe, it, expect } from "vitest";
import { commands, expectWellFormed } from "./recorded";

const t = expectWellFormed("S-18", "cli");
const [diff] = commands(t);

describe("recorded S-18: what changed between two declarations", () => {
  it("is a single `diff` between an earlier copy and the live manifest", () => {
    expect(commands(t)).toHaveLength(1);
    expect(diff.command).toBe("archstone diff <before> examples/showcase/manifest --all");
    expect(diff.exit).toBe(0);
  });

  it("names exactly one added visible field and exactly one added action", () => {
    const lines = diff.stdout!.split("\n");
    expect(lines.filter((l) => /field '.*' added/.test(l))).toEqual(["  compatible wanderlust.Stay — field 'rating' added (optional, quantity) (reaches wanderlust.search)"]);
    expect(lines.filter((l) => /capability added/.test(l))).toEqual(["  compatible wanderlust.quote — capability added (write)"]);
    expect(diff.stdout).toContain("0 breaking");
  });

  it("negative: it ran with the backend stopped and made no connection", () => {
    const negatives = t.asserts.filter((a) => a.negative).map((a) => a.claim);
    expect(negatives).toContain("the backend is stopped: the address the commands were given refuses a connection");
    expect(negatives).toContain("no outbound connection was attempted by `diff`");
  });
});
