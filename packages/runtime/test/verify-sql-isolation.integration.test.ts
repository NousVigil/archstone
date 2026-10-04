// ADR-0012 D-8 — `verifyTool`'s negative isolation test against a REAL Postgres. The unit suite
// (verify-sql-isolation.test.ts) fakes the pool and decides which rows "the database" returns;
// here RLS decides. Skipped unless ARCHSTONE_TEST_PG_URL is set — see CONTRIBUTING.md.
//
// The positive leg's principal is supplied explicitly as `opts.caller`, the path that exists on
// main today; the fixture-`identity` fallback (D-8, 2026-10-02 amendment) is covered with its
// own change.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { IRTool } from "@archstone/compiler";
import { fingerprintShape } from "@archstone/compiler";
import type { ConnectionEntry } from "@archstone/provider-sql";
import { verifyTool } from "../src/verify";
// Test-only, by relative path: the fixture owns `pg`, which @archstone/runtime does not depend on.
import { createPgFixture, describePostgres, endPools, DSN_VARS, type PgFixture } from "../../../providers/sql/test/support/postgres";

function sqlTool(table: string): IRTool {
  return {
    id: "reporting.holding",
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    lifecycle: "stable",
    input: [{ name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } }],
    output: [],
    connector: {
      type: "sql",
      sql: { engine: "postgres", dsn: `\${${DSN_VARS.runtime}}`, statementKind: "select", query: `SELECT id, label FROM ${table} WHERE id = $1`, params: ["id"] },
    },
    // Recorded from tenant A's own row: int4 → number, text → string.
    contract: { fingerprint: fingerprintShape([{ id: 1, label: "acme-alpha" }]), probeFixture: "fixture.json" },
  };
}

const identityAdapter = (principal: string | undefined) =>
  principal === "tenant-a" ? { tenant_id: "acme" } : principal === "tenant-b" ? { tenant_id: "beta" } : undefined;

describePostgres("verifyTool negative isolation against a real Postgres (D-8)", () => {
  let fx: PgFixture;
  let dir: string;
  const registry = new Map<string, ConnectionEntry>();
  const opts = () => ({ env: fx.env, identityAdapter, caller: { principal: "tenant-a" }, connectionRegistry: registry });

  beforeAll(async () => {
    fx = await createPgFixture();
    dir = mkdtempSync(join(tmpdir(), "archstone-verify-pg-"));
    // Tenant A's row 1, replayed for tenant B as the negative leg.
    writeFileSync(join(dir, "fixture.json"), JSON.stringify({ capabilityId: "reporting.holding", request: { id: 1 }, negativeIdentity: { principal: "tenant-b" } }));
  }, 60_000);

  afterAll(async () => {
    await endPools(registry);
    await fx?.teardown();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("green when RLS holds: tenant B's replay of tenant A's request returns zero rows", async () => {
    const result = await verifyTool(sqlTool("app.holdings"), dir, {}, opts());
    expect(result).toMatchObject({ capabilityId: "reporting.holding", status: "green", detail: "fingerprint unchanged" });
  });

  it("red, counting the foreign rows, when the table has no row-level security", async () => {
    const result = await verifyTool(sqlTool("app.holdings_open"), dir, {}, opts());
    expect(result).toEqual({
      capabilityId: "reporting.holding",
      status: "red",
      detail: "isolation test failed: 1 foreign row returned for capability 'reporting.holding'",
    });
  });

  it("a dropped policy (RLS still enabled + forced) fails closed: isolation holds, and the empty positive leg surfaces as shape drift (yellow), not green", async () => {
    // With RLS forced and no policy, Postgres applies default-deny: zero rows for EVERY tenant.
    // The negative leg is therefore satisfied; the positive leg is what catches it — its empty
    // result fingerprints differently from the recorded contract. Pinned so nobody reads a
    // dropped policy as a silent green.
    await fx.admin("CREATE TABLE app.holdings_nopolicy (LIKE app.holdings INCLUDING ALL)");
    await fx.admin("INSERT INTO app.holdings_nopolicy SELECT * FROM app.holdings_open");
    await fx.admin("ALTER TABLE app.holdings_nopolicy ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY");
    const runtimeRole = new URL(fx.env[DSN_VARS.runtime]).username;
    await fx.admin(`GRANT SELECT ON app.holdings_nopolicy TO ${runtimeRole}`);
    const result = await verifyTool(sqlTool("app.holdings_nopolicy"), dir, {}, opts());
    expect(result.status).toBe("yellow");
    expect(result.detail).toMatch(/^response shape changed/);
  });
});
