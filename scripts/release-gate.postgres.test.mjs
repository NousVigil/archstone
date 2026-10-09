#!/usr/bin/env node
// #162 — the release gate's verify leg for `sql-reporting`, run by the gate's own `runVerifyProbe`
// against the workspace CLI and a real Postgres: green as shipped, and failing once isolation is
// taken out of the example's fixture.sql. Proves the leg can fail, which a green release run alone
// never shows.
//
// Separate from release-gate.test.mjs because it needs `pnpm install` (for `pg`) and a built CLI,
// and release.yml's build gate runs release-gate.test.mjs before either exists. ci.yml's
// "Release script tests" step (after `pnpm test` has built everything) runs it with the job's
// Postgres.
//
// Same rule as the vitest real-Postgres suites (providers/sql/test/support/postgres.ts): skipped
// locally when ARCHSTONE_TEST_PG_URL is unset, a FAILURE under CI.
//
//   ARCHSTONE_TEST_PG_URL=postgres://… node --test scripts/release-gate.postgres.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync, mkdtempSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { runVerifyProbe, PG_URL_VAR, WORKSPACE_CLI, WORKSPACE_PG_FROM } from "./release-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const SQL_EXAMPLE = join(ROOT, "examples", "manifests", "sql-reporting");

function pgGate() {
  if (process.env[PG_URL_VAR]) return { run: true };
  const ci = process.env.CI?.trim().toLowerCase();
  if (ci && ci !== "0" && ci !== "false") return { run: false, fail: true };
  return { run: false, skip: `set ${PG_URL_VAR} to run against a real Postgres` };
}

function pgTest(name, fn) {
  const gate = pgGate();
  if (gate.skip) return test(name, { skip: gate.skip }, fn);
  if (gate.fail) {
    return test(name, () => {
      assert.fail(`CI is set but ${PG_URL_VAR} is not: the gate's real-Postgres tests are mandatory in CI and are never skipped there.`);
    });
  }
  return test(name, { timeout: 120_000 }, () => {
    assert.ok(existsSync(WORKSPACE_CLI[1]), `workspace CLI not built at ${WORKSPACE_CLI[1]} — run \`pnpm run build\` first`);
    return fn();
  });
}

/** A copy of the example whose fixture.sql has been changed by `edit` — the gate's own probe is
 *  then pointed at it. */
async function verifyWithFixture(edit) {
  const dir = mkdtempSync(join(tmpdir(), "archstone-gate-sql-"));
  try {
    cpSync(SQL_EXAMPLE, dir, { recursive: true });
    const path = join(dir, "fixture.sql");
    const before = readFileSync(path, "utf8");
    const after = edit(before);
    assert.notEqual(after, before, "the edit must actually change the fixture");
    writeFileSync(path, after);
    return await runVerifyProbe({ name: "sql-reporting", manifestDir: dir, cli: WORKSPACE_CLI, mockUrl: "http://127.0.0.1:1", pgFrom: WORKSPACE_PG_FROM });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

pgTest("runVerifyProbe (#162): sql-reporting is verified against a database built from its own fixture.sql", async () => {
  const result = await runVerifyProbe({ name: "sql-reporting", cli: WORKSPACE_CLI, mockUrl: "http://127.0.0.1:1", pgFrom: WORKSPACE_PG_FROM });
  assert.equal(result.status, "pass", result.detail);
  assert.equal(result.exitCode, 0);
  assert.equal(result.inputs, "identity map; fixture.sql as reporting_runtime via REPORTING_DSN");
  assert.match(result.detail, /🟢 reporting\.get-position/);
});

pgTest("runVerifyProbe (#162, negative): with the policy and row-level security removed from the fixture, the leg fails on the leak", async () => {
  const result = await verifyWithFixture((sql) =>
    sql.replace(/^CREATE POLICY .*$/m, "").replace(/^ALTER TABLE app\.positions (ENABLE|FORCE) ROW LEVEL SECURITY;$/gm, ""),
  );
  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, 1);
  assert.match(result.detail, /🔴 reporting\.get-position — isolation test failed: \d+ foreign rows? returned/);
});

pgTest("runVerifyProbe (#162, negative): with only the policy removed (RLS still forced, so default-deny), the leg fails too", async () => {
  const result = await verifyWithFixture((sql) => sql.replace(/^CREATE POLICY .*$/m, ""));
  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, 1);
  assert.match(result.detail, /🔴 reporting\.get-position/);
});
