import { describe, it, expect } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { IRTool } from "@archstone/compiler";
import type { DecisionRecord } from "@archstone/init";
import { runInit } from "@archstone/init/loop";
import { probeGate } from "../src/probe";
import { reportingDraft } from "./pg-catalog";

// ADR-0012 D-8 / D-10 — the probe gate for a database capability, and the whole loop over a fake
// pool that behaves like a row-level-security policy: a SELECT returns the rows of whichever tenant
// the transaction's session setting names. The strong claim, as for REST, is "no connection was
// opened" — counted on the pool, not read off the gate's return value.

const sqlTool = (params: string[]): IRTool => ({
  id: "reporting.get-position",
  description: "Positions.",
  effect: "read",
  provider: "harborline-db",
  policies: [],
  lifecycle: "stable",
  input: params.map((name) => ({ name, required: true, type: { kind: "scalar", semantic: "quantity" } })),
  output: [],
  connector: { type: "sql", sql: { engine: "postgres", dsn: "${REPORTING_DSN}", statementKind: "select", query: "SELECT 1", params } },
});

type Kept = Extract<DecisionRecord["decisions"][number], { keep: true }>;
const kept = (over: Partial<Kept> = {}): Kept => ({
  operation: "SELECT app.positions_v",
  keep: true,
  capabilityId: "reporting.get-position",
  effect: "read",
  probe: true,
  sampleInput: { id: 1 },
  lookupColumn: "id",
  ...over,
});

const claims: Record<string, Record<string, string>> = { "acme-analyst": { tenant_id: "acme" }, "globex-analyst": { tenant_id: "globex" } };
const resolves = (p: string) => p in claims;
const both = { principal: "acme-analyst", negativePrincipal: "globex-analyst" };

describe("probeGate — a database capability", () => {
  it("allows a lookup with two resolvable principals, with no method rule and no human", () => {
    const result = probeGate(kept(), sqlTool(["id"]), { interactive: false, identities: both, resolves });
    expect(result).toEqual({ allowed: true, input: { id: 1 }, identities: both });
  });

  const refusals: Array<[string, Parameters<typeof probeGate>[2], string, string]> = [
    ["a list", { interactive: false, identities: both, resolves }, "list-has-no-isolation-test", "[]"],
    ["no positive principal", { interactive: false, resolves }, "no-positive-identity", '["id"]'],
    ["a positive principal the map does not resolve", { interactive: false, identities: { principal: "nobody", negativePrincipal: "globex-analyst" }, resolves }, "no-positive-identity", '["id"]'],
    ["no negative principal", { interactive: false, identities: { principal: "acme-analyst" }, resolves }, "no-negative-identity", '["id"]'],
    ["the same principal twice", { interactive: false, identities: { principal: "acme-analyst", negativePrincipal: "acme-analyst" }, resolves }, "no-negative-identity", '["id"]'],
    ["a negative principal the map does not resolve", { interactive: false, identities: { principal: "acme-analyst", negativePrincipal: "ghost" }, resolves }, "negative-identity-unresolved", '["id"]'],
    ["no identity map at all", { interactive: false, identities: both }, "no-positive-identity", '["id"]'],
  ];
  for (const [name, ctx, refusal, params] of refusals) {
    it(`refuses ${name}`, () => {
      const result = probeGate(kept(), sqlTool(JSON.parse(params) as string[]), ctx);
      expect(result).toMatchObject({ allowed: false, refusal });
    });
  }

  it("still requires consent and a confirmed read, ahead of everything database-specific", () => {
    const ctx = { interactive: false, identities: both, resolves };
    expect(probeGate(kept({ probe: false }), sqlTool(["id"]), ctx)).toMatchObject({ refusal: "no-consent" });
    expect(probeGate(kept({ effect: "write" }), sqlTool(["id"]), ctx)).toMatchObject({ refusal: "effect-not-read" });
  });

  it("still needs the sample value for the lookup column", () => {
    const { sampleInput: _s, ...noSample } = kept();
    expect(probeGate(noSample, sqlTool(["id"]), { interactive: false, identities: both, resolves })).toMatchObject({ refusal: "probe-input-unavailable" });
  });
});

// -------------------------------------------------------------------------------- the loop

const TABLE = [
  { tenant_id: "acme", id: 1, label: "ACME-BOND-2031", qty: 120 },
  { tenant_id: "acme", id: 2, label: "ACME-ETF", qty: 45 },
  { tenant_id: "globex", id: 3, label: "GLOBEX-TREASURY", qty: 300 },
];

/** A pool that is a row-level-security policy: it answers the declared query with the rows of the
 *  tenant the transaction's `set_config` named, and counts every checkout. */
function rlsPool(table = TABLE) {
  let connections = 0;
  const queries: string[] = [];
  const pool = {
    async connect() {
      connections += 1;
      let tenant: string | undefined;
      return {
        async query(text: string, params?: unknown[]) {
          queries.push(text.split("\n")[0]!.trim());
          if (text.includes("pg_postmaster_start_time")) return { rows: [{ rolsuper: false, rolbypassrls: false, server_started: "2026-10-12T00:00:00.000000", database_oid: 1 }] };
          if (text.includes("role_table_grants")) return { rows: [] };
          if (text.startsWith("SELECT set_config")) {
            tenant = String(params![1]);
            return { rows: [] };
          }
          if (text.startsWith('SELECT "tenant_id"')) {
            return { rows: table.filter((r) => r.tenant_id === tenant && r.id === params![0]).map((r) => ({ ...r })) };
          }
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  // Structurally a `pg.Pool` for the one thing the provider asks of it; `init` never imports the type.
  return { factory: (() => pool) as never, connections: () => connections, queries };
}

function work(): string {
  return mkdtempSync(join(tmpdir(), "archstone-pg-probe-"));
}

async function run(record: DecisionRecord, opts: { rows?: typeof TABLE; map?: Record<string, Record<string, string>> } = {}) {
  const dir = work();
  const fake = rlsPool(opts.rows);
  const map = opts.map ?? claims;
  try {
    const result = await runInit(reportingDraft(), record, {
      targetDir: join(dir, "out"),
      probe: true,
      interactive: false,
      invoke: {
        env: { REPORTING_DSN: "postgres://runtime@db.test/app" },
        identityAdapter: (p) => (p !== undefined && Object.hasOwn(map, p) ? map[p] : undefined),
        pgPoolFactory: fake.factory,
        connectionRegistry: new Map(),
      },
    });
    const read = (path: string) => (existsSync(join(dir, "out", path)) ? readFileSync(join(dir, "out", path), "utf8") : undefined);
    return { result, fake, read };
  } finally {
    // The files are read before cleanup by the caller through `read`, so cleanup is deferred.
    process.nextTick(() => rmSync(dir, { recursive: true, force: true }));
  }
}

const record = (over: Partial<DecisionRecord> = {}, decision = kept()): DecisionRecord => ({
  version: "0",
  company: { id: "harborline" },
  identities: both,
  decisions: [{ ...decision, resourceName: "Position" }],
  ...over,
});

describe("runInit over a database source — contracts", () => {
  it("records a lookup with identity, negativeIdentity and a non-empty positive leg, and the replay is green", async () => {
    const { result, read } = await run(record());
    expect(result.ok).toBe(true);
    expect(result.probes).toEqual([expect.objectContaining({ capabilityId: "reporting.get-position", outcome: "green" })]);
    expect(result.verifications).toEqual([expect.objectContaining({ capabilityId: "reporting.get-position", status: "green" })]);
    expect(JSON.parse(read("fixtures/reporting.get-position.golden.json")!)).toMatchObject({
      capabilityId: "reporting.get-position",
      request: { id: 1 },
      identity: { principal: "acme-analyst" },
      negativeIdentity: { principal: "globex-analyst" },
      expects: { collectionNonEmpty: true },
    });
    expect(read("bindings/reporting.get-position.binding.yaml")).toMatch(/contract:\n\s+source: recorded/);
  });

  it("records nothing for a lookup whose positive leg returns zero rows (the isolation test would pass vacuously)", async () => {
    const { result, read } = await run(record(undefined, kept({ sampleInput: { id: 99 } })));
    expect(result.ok).toBe(true);
    expect(read("fixtures/reporting.get-position.golden.json")).toBeUndefined();
    expect(read("bindings/reporting.get-position.binding.yaml")).not.toContain("contract:");
    expect(result.verifications).toEqual([expect.objectContaining({ status: "red", detail: expect.stringMatching(/non-empty/) })]);
  });

  it("records nothing when the sample row is not the positive principal's own", async () => {
    // Swapped, the positive principal (globex) owns no row with id 1: the positive leg is empty.
    const { result } = await run(record({ identities: { principal: "globex-analyst", negativePrincipal: "acme-analyst" } }));
    expect(result.verifications.map((v) => v.status)).toEqual(["red"]);
    expect(result.written.some((f) => f.endsWith(".golden.json"))).toBe(false);
  });

  const noContract: Array<[string, Partial<DecisionRecord>, string, Record<string, Record<string, string>>?]> = [
    ["no identities", { identities: undefined }, "no-positive-identity"],
    ["no negative principal", { identities: { principal: "acme-analyst" } }, "no-negative-identity"],
    ["a negative principal missing from the identity map", { identities: { principal: "acme-analyst", negativePrincipal: "initech-analyst" } }, "negative-identity-unresolved"],
    ["an empty identity map", {}, "no-positive-identity", {}],
  ];
  for (const [name, over, refusal, map] of noContract) {
    it(`${name}: the manifest is written, with no contract and no fixture, and no connection was opened`, async () => {
      const { result, fake, read } = await run(record(over), map === undefined ? {} : { map });
      expect(result.ok).toBe(true);
      expect(result.probes).toEqual([expect.objectContaining({ outcome: "refused", refusal })]);
      expect(fake.connections()).toBe(0);
      expect(read("capabilities.yaml")).toBeDefined();
      expect(read("fixtures/reporting.get-position.golden.json")).toBeUndefined();
      expect(read("bindings/reporting.get-position.binding.yaml")).not.toContain("contract:");
    });
  }

  it("a list never gets a contract, whatever else is supplied, and opens no connection", async () => {
    const { lookupColumn: _lookup, ...list } = kept();
    const { result, fake, read } = await run(record(undefined, list));
    expect(result.probes).toEqual([expect.objectContaining({ outcome: "refused", refusal: "list-has-no-isolation-test" })]);
    expect(fake.connections()).toBe(0);
    expect(read("bindings/reporting.get-position.binding.yaml")).not.toContain("contract:");
    expect(read("bindings/reporting.get-position.binding.yaml")).toContain("LIMIT 100");
    expect(result.emitted.notes.some((n) => n.code === "list-has-no-isolation-test")).toBe(true);
  });

  it("without --probe no connection is opened at all, and no tenant row is read", async () => {
    const dir = work();
    try {
      const fake = rlsPool();
      const result = await runInit(reportingDraft(), record(), {
        targetDir: join(dir, "out"),
        interactive: false,
        invoke: { env: { REPORTING_DSN: "postgres://x" }, identityAdapter: (p) => claims[p ?? ""], pgPoolFactory: fake.factory, connectionRegistry: new Map() },
      });
      expect(result.ok).toBe(true);
      expect(fake.connections()).toBe(0);
      expect(existsSync(join(dir, "out", "fixtures"))).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
