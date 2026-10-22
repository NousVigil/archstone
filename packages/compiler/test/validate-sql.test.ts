import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { load } from "@archstone/schema";
import { validateSemantics, compile, type Diagnostic } from "../src/index";

// ADR-0012 — the `sql` connector's static, offline validation (D-1, D-9 layer 1) and the
// pre-existing `connector-type-not-implemented` gap this ADR's dispatch work closes (D-2/BR-9).

const codes = (d: Diagnostic[]) => d.map((x) => x.code);
const errors = (d: Diagnostic[]) => d.filter((x) => x.severity === "error");

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-sql-validate-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const CAPABILITIES = "company:\n  id: acme\ncapabilities:\n  - reporting.portfolio-summary\nproviders:\n  - warehouse\n";
const CAPABILITY =
  "capability:\n  id: reporting.portfolio-summary\n  description: summary\n  effect: read\n  provider: warehouse\n  input:\n    id:\n      type: identifier\n";

function bindingYaml(sql: Record<string, unknown>): string {
  const lines = [
    "binding:",
    "  capabilityId: reporting.portfolio-summary",
    "  connector:",
    "    type: sql",
    "    sql:",
    `      engine: ${sql.engine ?? "postgres"}`,
    `      dsn: "${sql.dsn ?? "${DATABASE_URL}"}"`,
    `      statementKind: ${sql.statementKind ?? "select"}`,
    `      query: |`,
    `        ${(sql.query as string) ?? "SELECT id FROM reporting.portfolio_summary_v WHERE id = $1"}`,
    "      params:",
    ...((sql.params as string[] | undefined) ?? ["id"]).map((p) => `        - ${p}`),
  ];
  return `${lines.join("\n")}\n`;
}

function run(sql: Record<string, unknown>): Diagnostic[] {
  const dir = fixture({
    "capabilities.yaml": CAPABILITIES,
    "reporting.portfolio-summary.capability.yaml": CAPABILITY,
    "bindings/reporting.portfolio-summary.binding.yaml": bindingYaml(sql),
  });
  const d = validateSemantics(load(dir));
  rmSync(dir, { recursive: true, force: true });
  return d;
}

describe("validateSemantics — sql connector (ADR-0012)", () => {
  it("a valid sql binding compiles with zero errors", () => {
    expect(errors(run({}))).toHaveLength(0);
  });

  it("BR-4/D-9 layer 1: a query not beginning with SELECT/WITH is refused", () => {
    const d = run({ query: "UPDATE reporting.portfolio_summary_v SET id = $1" });
    expect(codes(errors(d))).toContain("sql-statement-not-read-only");
  });

  it("a WITH that never SELECTs is refused", () => {
    const d = run({ query: "WITH x AS (INSERT INTO t DEFAULT VALUES RETURNING id) TABLE x" });
    expect(codes(errors(d))).toContain("sql-statement-not-read-only");
  });

  it("BR-5: a params entry not a declared CDL input field is refused (EC-1)", () => {
    const d = run({ params: ["ghost"], query: "SELECT id FROM t WHERE id = $1" });
    expect(codes(errors(d))).toContain("sql-param-unresolved");
  });

  it("BR-5: a query referencing $2 with only one params entry is refused (EC-2)", () => {
    const d = run({ query: "SELECT id FROM t WHERE id = $1 AND x = $2" });
    expect(codes(errors(d))).toContain("sql-param-count-mismatch");
  });

  it("BR-5: a declared params entry with no corresponding placeholder is refused", () => {
    // capability declares only `id`; add a second declared field to exercise this path cleanly.
    const dir = fixture({
      "capabilities.yaml": CAPABILITIES,
      "reporting.portfolio-summary.capability.yaml":
        "capability:\n  id: reporting.portfolio-summary\n  description: summary\n  effect: read\n  provider: warehouse\n  input:\n    id:\n      type: identifier\n    extra:\n      type: string\n",
      "bindings/reporting.portfolio-summary.binding.yaml": bindingYaml({ query: "SELECT id FROM t WHERE id = $1", params: ["id", "extra"] }),
    });
    const d = validateSemantics(load(dir));
    rmSync(dir, { recursive: true, force: true });
    expect(codes(errors(d))).toContain("sql-param-count-mismatch");
  });

  it("EC-3: engine other than postgres fails shape validation (schema-closed enum)", () => {
    const dir = fixture({
      "capabilities.yaml": CAPABILITIES,
      "reporting.portfolio-summary.capability.yaml": CAPABILITY,
      "bindings/reporting.portfolio-summary.binding.yaml": bindingYaml({ engine: "snowflake" }),
    });
    const res = load(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(res.ok).toBe(false);
  });

  it("US-2.3 / BR-2: a literal DSN (not a ${VAR} placeholder) is refused at shape-validation", () => {
    // connector.schema.json's `dsn` pattern already refuses this before the binding ever
    // reaches the semantic pass (`validateSemantics`'s `sql-dsn-not-env-placeholder` check below
    // is the defense-in-depth restatement for a hand-built IR/bypassed schema, not the primary
    // gate a YAML author hits).
    const dir = fixture({
      "capabilities.yaml": CAPABILITIES,
      "reporting.portfolio-summary.capability.yaml": CAPABILITY,
      "bindings/reporting.portfolio-summary.binding.yaml": bindingYaml({ dsn: "postgres://user:pass@host/db" }),
    });
    const res = load(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(res.ok).toBe(false);
  });

  it("EC-4: connector.type sql with a rest block alongside is refused at shape-validation", () => {
    const dir = fixture({
      "capabilities.yaml": CAPABILITIES,
      "reporting.portfolio-summary.capability.yaml": CAPABILITY,
      "bindings/reporting.portfolio-summary.binding.yaml":
        'binding:\n  capabilityId: reporting.portfolio-summary\n  connector:\n    type: sql\n    sql:\n      engine: postgres\n      dsn: "${DATABASE_URL}"\n      statementKind: select\n      query: "SELECT id FROM t WHERE id = $1"\n      params:\n        - id\n    rest:\n      method: GET\n      path: /x\n',
    });
    const res = load(dir);
    rmSync(dir, { recursive: true, force: true });
    expect(res.ok).toBe(false);
  });
});

describe("validateSemantics — sql-query-changes-session (#218)", () => {
  // The query runs in the transaction where the provider set the caller's identity; one that
  // changes a session setting could run as somebody else. `run` writes the query as a YAML block
  // scalar on one line, so each case here is a single line.
  const refused = (query: string) => codes(errors(run({ query }))).includes("sql-query-changes-session");

  it("refuses a set_config call in a CTE (the #218 shape)", () => {
    expect(refused("WITH s AS MATERIALIZED (SELECT set_config('app.tenant_id', $1, true)) SELECT id FROM reporting.portfolio_summary_v")).toBe(true);
  });

  it("refuses a schema-qualified, uppercase, or commented-apart set_config call", () => {
    expect(refused("SELECT pg_catalog.set_config('app.tenant_id', $1, true)")).toBe(true);
    expect(refused("SELECT PG_CATALOG . SET_CONFIG ('app.tenant_id', $1, true)")).toBe(true);
    expect(refused("SELECT set_config /* hidden */ ('app.tenant_id', $1, true)")).toBe(true);
  });

  it('refuses a quoted-identifier call: "set_config"( still calls the function', () => {
    expect(refused(`SELECT "set_config"('app.tenant_id', $1, true)`)).toBe(true);
    expect(refused(`SELECT "pg_catalog"."set_config"('app.tenant_id', $1, true)`)).toBe(true);
  });

  it("refuses a SET LOCAL, SET SESSION, SET or RESET statement after the SELECT", () => {
    expect(refused("SELECT id FROM t WHERE id = $1; SET LOCAL app.tenant_id = 'other';")).toBe(true);
    expect(refused("SELECT id FROM t WHERE id = $1; SET SESSION app.tenant_id = 'other'")).toBe(true);
    expect(refused("SELECT id FROM t WHERE id = $1; set app.tenant_id to 'other'")).toBe(true);
    expect(refused("SELECT id FROM t WHERE id = $1; RESET app.tenant_id")).toBe(true);
    expect(refused("SELECT id FROM t WHERE id = $1; /* x */ reset all")).toBe(true);
  });

  it("accepts set_config inside a string literal, an E'' or dollar-quoted string, or a comment", () => {
    expect(refused("SELECT id, 'set_config(' AS note FROM t WHERE id = $1")).toBe(false);
    expect(refused("SELECT id, E'it\\'s set_config(' AS note FROM t WHERE id = $1")).toBe(false);
    expect(refused("SELECT id, $q$ set_config( ; SET LOCAL x = 1 $q$ AS note FROM t WHERE id = $1")).toBe(false);
    expect(refused("SELECT id /* set_config('app.tenant_id', 'x', true) */ FROM t WHERE id = $1")).toBe(false);
  });

  it("accepts reading a setting with current_setting", () => {
    expect(refused("SELECT id, current_setting('app.tenant_id', true) AS tenant FROM t WHERE id = $1")).toBe(false);
  });

  it("does not refuse identifiers that merely contain set, reset or set_config", () => {
    expect(refused("SELECT id, reset_at, settings, offset_config, my_set_config FROM t WHERE id = $1")).toBe(false);
    expect(refused('SELECT id, "reset", "set" FROM t WHERE id = $1')).toBe(false);
  });

  it("names neither the query nor any value in its message", () => {
    const d = errors(run({ query: "SELECT set_config('app.tenant_id', 'tenant-b-secret', true), id FROM t WHERE id = $1" }));
    const msg = d.find((x) => x.code === "sql-query-changes-session")?.message ?? "";
    expect(msg).toMatch(/may not change session settings/);
    expect(msg).not.toContain("tenant-b-secret");
  });
});

describe("validateSemantics — sql-dsn-not-env-placeholder (defense-in-depth, BR-2)", () => {
  it("fires against a hand-built model whose dsn is a literal connection string (bypassing schema validation)", () => {
    const model = {
      ok: true,
      dir: "/tmp",
      capabilityDocs: [{ file: "reporting.portfolio-summary.capability.yaml", capability: { id: "reporting.portfolio-summary", description: "", effect: "read" as const, provider: "warehouse", input: { id: { type: "identifier" } } } }],
      bindings: [
        {
          file: "bindings/reporting.portfolio-summary.binding.yaml",
          binding: {
            capabilityId: "reporting.portfolio-summary",
            connector: {
              type: "sql",
              sql: { engine: "postgres", dsn: "postgres://user:pass@host/db", statementKind: "select", query: "SELECT id FROM t WHERE id = $1", params: ["id"] },
            },
          },
        },
      ],
      resourceDocs: [],
      policyDocs: [],
      issues: [],
    };
    const d = validateSemantics(model as unknown as Parameters<typeof validateSemantics>[0]);
    expect(codes(errors(d))).toContain("sql-dsn-not-env-placeholder");
  });
});

describe("validateSemantics — connector-type-not-implemented (D-2/BR-9)", () => {
  it("refuses graphql/grpc/soap connector types at apply, not at invocation", () => {
    for (const type of ["graphql", "grpc", "soap"]) {
      const dir = fixture({
        "capabilities.yaml": CAPABILITIES,
        "reporting.portfolio-summary.capability.yaml": CAPABILITY,
        "bindings/reporting.portfolio-summary.binding.yaml": `binding:\n  capabilityId: reporting.portfolio-summary\n  connector:\n    type: ${type}\n`,
      });
      const d = validateSemantics(load(dir));
      rmSync(dir, { recursive: true, force: true });
      expect(codes(errors(d))).toContain("connector-type-not-implemented");
    }
  });
});

describe("compile — sql connector lowers to IRConnector.sql (S-US1.1)", () => {
  it("populates IRConnector.sql and no rest field; IR.version stays \"0\"", () => {
    const dir = fixture({
      "capabilities.yaml": CAPABILITIES,
      "reporting.portfolio-summary.capability.yaml": CAPABILITY,
      "bindings/reporting.portfolio-summary.binding.yaml": bindingYaml({}),
    });
    const model = load(dir);
    const ir = compile(model);
    rmSync(dir, { recursive: true, force: true });
    expect(ir.version).toBe("0");
    const tool = ir.tools.find((t) => t.id === "reporting.portfolio-summary");
    expect(tool?.connector?.type).toBe("sql");
    expect(tool?.connector?.sql).toEqual({
      engine: "postgres",
      dsn: "${DATABASE_URL}",
      statementKind: "select",
      query: "SELECT id FROM reporting.portfolio_summary_v WHERE id = $1\n",
      params: ["id"],
    });
    expect(tool?.connector?.rest).toBeUndefined();
  });
});
