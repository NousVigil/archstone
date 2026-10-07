// The rule that makes the real-Postgres suites trustworthy: locally an unset ARCHSTONE_TEST_PG_URL
// skips them with a message, but in CI it must FAIL them — a skipped suite reports green, and a
// guarantee nobody ran is not one. Runs offline; it tests the decision, not a database.

import { describe, expect, it } from "vitest";
import { gateFor, runsInCi } from "./support/postgres";

const URL = "postgres://postgres:x@127.0.0.1:5432/postgres";

describe("the real-Postgres gate", () => {
  it("runs the suites whenever a URL is configured, in CI or not", () => {
    expect(gateFor({ ARCHSTONE_TEST_PG_URL: URL })).toBe("run");
    expect(gateFor({ ARCHSTONE_TEST_PG_URL: URL, CI: "true" })).toBe("run");
  });

  it("skips locally when no URL is set", () => {
    expect(gateFor({})).toBe("skip");
    expect(gateFor({ ARCHSTONE_TEST_PG_URL: "" })).toBe("skip");
    expect(gateFor({ CI: "" })).toBe("skip");
    expect(gateFor({ CI: "false" })).toBe("skip");
    expect(gateFor({ CI: "0" })).toBe("skip");
  });

  it("FAILS, never skips, in CI when no URL is set", () => {
    expect(gateFor({ CI: "true" })).toBe("fail");
    expect(gateFor({ CI: "1" })).toBe("fail");
    expect(gateFor({ CI: "TRUE", ARCHSTONE_TEST_PG_URL: "" })).toBe("fail");
  });

  it("reads CI the way GitHub Actions sets it", () => {
    expect(runsInCi({ CI: "true" })).toBe(true);
    expect(runsInCi({})).toBe(false);
  });
});
