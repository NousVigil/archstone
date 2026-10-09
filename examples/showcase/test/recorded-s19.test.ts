// S-19 (AC-5.5): `audit` lists the irreversible actions, `doctor` reports health, zero outbound
// requests. `audit` here reads the Execution records of a real embedded run; the irreversible
// capabilities are named by `doctor` and by the trail, and the exposed fields by `apply --exposure`.

import { describe, it, expect } from "vitest";
import { calls, commands, expectWellFormed, stepWith } from "./recorded";

const t = expectWellFormed("S-19", "cli");

describe("recorded S-19: audit and doctor, sending nothing anywhere", () => {
  it("builds the trail from five real executions, two of them irreversible", () => {
    expect(calls(t).map((c) => c.call.tool)).toEqual(["wanderlust.search", "wanderlust.quote", "wanderlust.book", "wanderlust.cancel", "wanderlust.pay"]);
    expect(calls(t).every((c) => c.result.status === "ok")).toBe(true);
  });

  it("audit lists the irreversible actions that ran", () => {
    const summary = stepWith(t, "archstone audit <work>/trail.jsonl", 0);
    expect(summary.exit).toBe(0);
    expect(summary.stdout).toContain("5 records");
    expect(summary.stdout).toMatch(/wanderlust\.cancel\s+1/);
    expect(summary.stdout).toMatch(/wanderlust\.pay\s+1/);
    const csv = commands(t).find((s) => s.command.endsWith("--format csv"))!;
    expect(csv.stdout!.split("\n").filter((l) => /,wanderlust\.(cancel|pay),/.test(l))).toHaveLength(2);
  });

  it("doctor reports health: 13 capabilities, no error, and names the two irreversible ones", () => {
    const doctor = stepWith(t, "archstone doctor examples/showcase/manifest");
    expect(doctor.exit).toBe(0);
    expect(doctor.stdout).toMatch(/13 capabilities checked — 0 error/);
    expect(doctor.stdout).toContain("wanderlust.cancel — is irreversible and declares policies:[human-approval], which this version does not enforce");
    expect(doctor.stdout).toContain("wanderlust.pay — is irreversible and declares policies:[human-approval], which this version does not enforce");
  });

  it("lists the exposed fields", () => {
    const exposure = stepWith(t, "archstone apply examples/showcase/manifest --exposure");
    expect(exposure.exit).toBe(0);
    expect(exposure.stdout).toContain("exposes    stays[].id (identifier)");
  });

  it("negative: zero outbound requests, proved by the backend's counter and by a process that cannot connect", () => {
    const negatives = t.asserts.filter((a) => a.negative).map((a) => a.claim);
    expect(negatives).toContain("the backend received zero requests while these commands ran");
    expect(negatives).toContain("no command attempted any outbound connection (socket, DNS or fetch)");
  });
});
