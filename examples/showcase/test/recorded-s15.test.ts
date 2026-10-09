// S-15 (AC-5.1): a table from a local database; the live manifest's tool list has no sql capability.
// Asserted from the committed transcript. Rerunning it needs a Postgres (ARCHSTONE_TEST_PG_URL): the
// determinism test and `pnpm showcase:record:check` do that, in CI as well.

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { toolDefinitions } from "@archstone/runtime";
import { MANIFEST_DIR, REPO_ROOT, openRegistry } from "./harness";
import { calls, expectWellFormed, stepWith } from "./recorded";

const t = expectWellFormed("S-15", "mcp");
const asked = calls(t).map((c) => ({ as: c.result.as, isError: c.result.isError, rows: (c.result.structuredContent as { cities: unknown[] } | undefined)?.cities }));

describe("recorded S-15: sql reporting, local only", () => {
  it("compiles the local manifest offline and verifies it against the database: contract holds, isolation replayed", () => {
    expect(stepWith(t, "archstone apply examples/showcase/local/reporting").exit).toBe(0);
    const verify = stepWith(t, "archstone verify examples/showcase/local/reporting");
    expect(verify.exit).toBe(0);
    expect(verify.command).toContain("--identity-map");
    expect(verify.stdout).toContain("🟢 wanderlust.bookings-by-city — fingerprint unchanged, mapping OK");
  });

  it("produces the table: bookings per city for the month, from the database", () => {
    const analyst = asked.find((a) => a.as === "demo:analyst")!;
    expect(analyst.isError).toBe(false);
    expect(analyst.rows).toEqual([
      { bookings: 5, city: "Lisbon" },
      { bookings: 3, city: "Porto" },
      { bookings: 2, city: "Seville" },
    ]);
  });

  it("another agency's analyst gets no rows, and a call with no identity is refused (the database decides, not the binding)", () => {
    expect(asked.find((a) => a.as === "demo:outsider")).toMatchObject({ isError: false, rows: [] });
    expect(asked.find((a) => a.as === "(no caller)")!.isError).toBe(true);
  });

  it("negative: the live manifest's tool list has no sql capability (N-15)", () => {
    const registry = openRegistry();
    const names = toolDefinitions(registry).map((d) => d.name);
    expect(names.some((n) => /bookings-by-city|report/.test(n))).toBe(false);
    expect(registry.ir.tools.filter((x) => x.connector?.type === "sql")).toEqual([]);
    // and the reporting manifest sits next to it, not in it
    expect(existsSync(resolve(REPO_ROOT, "examples/showcase/local/reporting/capabilities.yaml"))).toBe(true);
    expect(resolve(REPO_ROOT, "examples/showcase/local/reporting").startsWith(MANIFEST_DIR)).toBe(false);
    expect(t.asserts.filter((a) => a.negative && /live manifest/.test(a.claim)).length).toBeGreaterThanOrEqual(3);
  });
});
