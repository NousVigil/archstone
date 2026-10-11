import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { emit, validateDecisionRecord, type RecordedContract } from "@archstone/init";
import { commitFileSet } from "@archstone/init/loop";
import { REPORTING_CATALOG, reportingDecisions, reportingDraft } from "./pg-catalog";

// ADR-0012 D-10 — the emitter's `sql` branch, tested with a hand-built Decision Record over the
// adapter's draft: what is written, what is never written, and that a literal DSN cannot appear.

const here = dirname(fileURLToPath(import.meta.url));
const GOLDEN = resolve(here, "fixtures/postgres/golden");

function filesUnder(dir: string, base = dir): string[] {
  return readdirSync(dir)
    .flatMap((name) => {
      const path = join(dir, name);
      return statSync(path).isDirectory() ? filesUnder(path, base) : [relative(base, path)];
    })
    .sort();
}

/** Compare the emitted set with the golden directory. `UPDATE_GOLDEN=1` rewrites it. */
function expectGolden(name: string, files: ReadonlyMap<string, string>): void {
  const dir = join(GOLDEN, name);
  if (process.env["UPDATE_GOLDEN"] === "1") {
    rmSync(dir, { recursive: true, force: true });
    for (const [path, content] of files) {
      mkdirSync(dirname(join(dir, path)), { recursive: true });
      writeFileSync(join(dir, path), content);
    }
  }
  expect(existsSync(dir), `no golden directory ${dir} — run with UPDATE_GOLDEN=1`).toBe(true);
  expect(filesUnder(dir)).toEqual([...files.keys()].sort());
  for (const [path, content] of files) expect(readFileSync(join(dir, path), "utf8"), path).toBe(content);
}

const CONTRACT: RecordedContract = {
  fingerprint: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  shape: { $: "array", "$[]": "object", "$[].id": "number" },
  recordedAt: "2026-10-12T00:00:00.000Z",
  fixture: {
    capabilityId: "reporting.get-position",
    recordedAt: "2026-10-12T00:00:00.000Z",
    request: { id: 1 },
    identity: { principal: "acme-analyst" },
    negativeIdentity: { principal: "globex-analyst" },
    expects: { collectionNonEmpty: true },
  },
};

describe("golden output", () => {
  it("a lookup and a list, no contract", () => {
    const result = emit(reportingDraft(), reportingDecisions());
    expect(result.skipped).toEqual([]);
    expectGolden("no-contract", result.files);
  });

  it("a lookup carrying the contract the probe leg recorded", () => {
    const result = emit(reportingDraft(), reportingDecisions(), new Map([["reporting.get-position", CONTRACT]]));
    expectGolden("with-contract", result.files);
  });

  it("the written set compiles through the shipped pipeline", () => {
    const work = mkdtempSync(join(tmpdir(), "archstone-pg-emit-"));
    try {
      const committed = commitFileSet(emit(reportingDraft(), reportingDecisions(), new Map([["reporting.get-position", CONTRACT]])).files, { targetDir: join(work, "out") });
      expect(committed.failures).toEqual([]);
      expect(committed.ok).toBe(true);
      const tools = Object.fromEntries(committed.ir!.tools.map((t) => [t.id, t]));
      expect(tools["reporting.get-position"]!.connector).toMatchObject({ type: "sql", sql: { engine: "postgres", dsn: "${REPORTING_DSN}", statementKind: "select", params: ["id"] } });
      expect(tools["reporting.list-accounts"]!.connector!.sql!.params).toEqual([]);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });
});

describe("the sql connector", () => {
  const binding = (id: string, decisions = reportingDecisions(), contracts?: ReadonlyMap<string, RecordedContract>): string =>
    emit(reportingDraft(), decisions, contracts).files.get(`bindings/${id}.binding.yaml`)!;

  it("a list is the adapter's select plus a literal LIMIT 100, with no parameter", () => {
    const text = binding("reporting.list-accounts");
    expect(text).toContain('      query: |\n        SELECT "id", "name", "balance", "active", "opened_at"\n        FROM "app"."accounts"\n        LIMIT 100\n');
    expect(text).toContain("      params: []\n");
  });

  it("a lookup is the adapter's select plus WHERE <column> = $1, bound to the column's input", () => {
    const text = binding("reporting.get-position");
    expect(text).toContain('        FROM "app"."positions_v"\n        WHERE "id" = $1\n');
    expect(text).toContain("      params:\n        - id\n");
  });

  it("never writes a literal DSN: the variable is named, in quotes, and nothing else is", () => {
    const files = emit(reportingDraft(), reportingDecisions()).files;
    for (const [path, content] of files) {
      expect(content, path).not.toMatch(/postgres(ql)?:\/\//);
      if (path.startsWith("bindings/")) expect(content).toContain('dsn: "${REPORTING_DSN}"');
    }
  });

  it("names the provider <company>-db unless the record says otherwise", () => {
    expect(emit(reportingDraft(), reportingDecisions()).files.get("capabilities.yaml")).toContain("providers:\n  - harborline-db\n");
    expect(emit(reportingDraft(), reportingDecisions({ provider: "warehouse" })).files.get("capabilities.yaml")).toContain("providers:\n  - warehouse\n");
  });

  it("writes no rest connector, no auth header and no base URL", () => {
    for (const [path, content] of emit(reportingDraft(), reportingDecisions()).files) {
      if (!path.startsWith("bindings/")) continue;
      expect(content).not.toMatch(/\brest:|baseUrl|headers|method:/);
    }
  });

  it("the lookup input carries the column's type; a list has no input", () => {
    const files = emit(reportingDraft(), reportingDecisions()).files;
    expect(files.get("reporting.get-position.capability.yaml")).toMatch(/input:\n {4}id:\n {6}type: quantity\n/);
    expect(files.get("reporting.list-accounts.capability.yaml")).not.toContain("input:");
  });
});

describe("contracts only arrive through the recorded path", () => {
  it("emits no contract block, and no fixture, without a recording", () => {
    const files = emit(reportingDraft(), reportingDecisions()).files;
    for (const [path, content] of files) {
      expect(path.startsWith("fixtures/"), path).toBe(false);
      expect(content, path).not.toMatch(/^\s*contract:/m);
    }
  });

  it("writes the fixture verbatim, with identity, negativeIdentity and the non-empty expectation", () => {
    const files = emit(reportingDraft(), reportingDecisions(), new Map([["reporting.get-position", CONTRACT]])).files;
    expect(JSON.parse(files.get("fixtures/reporting.get-position.golden.json")!)).toEqual(CONTRACT.fixture);
  });
});

describe("the Decision Record's lookup column", () => {
  it("a list never claims an isolation test: it is said so, as a note on the capability", () => {
    const notes = emit(reportingDraft(), reportingDecisions()).notes.filter((n) => n.code === "list-has-no-isolation-test");
    expect(notes.map((n) => n.target)).toEqual(["reporting.list-accounts"]);
  });

  it("an unknown lookup column refuses that candidate and withholds its files", () => {
    const decisions = reportingDecisions({
      decisions: [
        { operation: "SELECT app.positions_v", keep: true, capabilityId: "reporting.get-position", effect: "read", lookupColumn: "nope", resourceName: "Position" },
        { operation: "SELECT app.accounts", keep: true, capabilityId: "reporting.list-accounts", effect: "read", resourceName: "Account" },
      ],
    });
    const result = emit(reportingDraft(), decisions);
    expect(result.skipped).toEqual([expect.objectContaining({ operation: "SELECT app.positions_v", code: "unknown-lookup-column" })]);
    expect([...result.files.keys()].filter((p) => p.includes("get-position"))).toEqual([]);
    expect(result.capabilities.map((c) => c.capabilityId)).toEqual(["reporting.list-accounts"]);
  });

  it("a column that is selected but not a legal field name is not a lookup column", () => {
    const decisions = reportingDecisions({
      decisions: [
        { operation: 'SELECT Odd"Schema.we"ird', keep: true, capabilityId: "reporting.weird", effect: "read", lookupColumn: "has space", resourceName: "Weird" },
        { operation: "SELECT app.accounts", keep: true, capabilityId: "reporting.list-accounts", effect: "read", resourceName: "Account" },
      ],
    });
    expect(emit(reportingDraft(), decisions).skipped.map((s) => s.code)).toEqual(["unknown-lookup-column"]);
  });

  it("a relation with no expressible column is skipped by the adapter's own note, files withheld", () => {
    const decisions = reportingDecisions({
      decisions: [
        { operation: "SELECT app.blobs", keep: true, capabilityId: "reporting.blobs", effect: "read" },
        { operation: "SELECT app.accounts", keep: true, capabilityId: "reporting.list-accounts", effect: "read", resourceName: "Account" },
      ],
    });
    const result = emit(reportingDraft(), decisions);
    expect(result.skipped).toEqual([expect.objectContaining({ operation: "SELECT app.blobs", code: "no-expressible-columns" })]);
    expect([...result.files.keys()].filter((p) => p.includes("blobs"))).toEqual([]);
  });

  it("the effect is the record's, never the adapter's hint", () => {
    const decisions = reportingDecisions({
      decisions: [{ operation: "SELECT app.accounts", keep: true, capabilityId: "reporting.list-accounts", effect: "write", resourceName: "Account" }],
    });
    expect(emit(reportingDraft(), decisions).files.get("reporting.list-accounts.capability.yaml")).toContain("effect: write");
  });
});

describe("the field-scope notes survive to the report", () => {
  it("column-type-not-expressible and foreign-table-deferred reach the emit result", () => {
    const codes = emit(reportingDraft(), reportingDecisions()).notes.map((n) => n.code);
    expect(codes).toContain("column-type-not-expressible");
    expect(codes).toContain("foreign-table-deferred");
  });
});

describe("Decision Record validation: lookupColumn and identities", () => {
  const base = reportingDecisions();
  it("accepts both", () => {
    const ok = validateDecisionRecord({ ...base, identities: { principal: "acme-analyst", negativePrincipal: "globex-analyst" } });
    expect(ok.ok).toBe(true);
  });

  it("rejects a malformed lookupColumn", () => {
    for (const bad of [1, "", {}]) {
      const result = validateDecisionRecord({ ...base, decisions: [{ operation: "x", keep: true, capabilityId: "a.b", effect: "read", lookupColumn: bad }] });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("rejects malformed identities", () => {
    for (const bad of ["acme", [], { principal: 1 }, { principal: "" }, { negativePrincipal: {} }, { principal: "a", extra: "b" }]) {
      const result = validateDecisionRecord({ ...base, identities: bad });
      expect(result.ok, JSON.stringify(bad)).toBe(false);
    }
  });

  it("allows a record naming only one principal: the probe gate is what refuses, with a reason", () => {
    expect(validateDecisionRecord({ ...base, identities: { principal: "acme-analyst" } }).ok).toBe(true);
  });
});

describe("the catalog fixture's sanity", () => {
  it("is what the other tests assume", () => {
    expect(REPORTING_CATALOG.relations.map((r) => r.name)).toEqual(["positions_v", "accounts", "blobs", 'we"ird']);
  });
});
