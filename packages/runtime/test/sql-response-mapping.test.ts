import { describe, it, expect, vi } from "vitest";
import { Registry } from "@archstone/emitter-support";
import type { IR } from "@archstone/compiler";
import type { PgPool, PgPoolClient, ConnectionEntry } from "@archstone/provider-sql";
import { callTool } from "../src/server";
import { invokeConnector, type ConnectorInvokeOptions } from "../src/connector";
import type { InvokeOptions as EdgeSafeInvokeOptions } from "../src/connector-rest";

// NF-3 (US-3/BR-7) — a `sql`-bound capability's undeclared column is dropped by the SAME
// `applyResponseMapping` machinery a `rest`-bound capability already uses, proven directly at
// the `callTool` level rather than only by composition of separately-tested pieces.

const ir: IR = {
  version: "0",
  company: { id: "acme" },
  tools: [
    {
      id: "reporting.portfolio-summary",
      description: "Portfolio summary.",
      effect: "read",
      provider: "warehouse",
      policies: [],
      lifecycle: "stable",
      input: [{ name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } }],
      output: [{ name: "summary", required: true, type: { kind: "collection", of: "reporting.PortfolioSummary" } }],
      connector: {
        type: "sql",
        sql: {
          engine: "postgres",
          dsn: "${DATABASE_URL}",
          statementKind: "select",
          query: "SELECT * FROM reporting.portfolio_summary_v WHERE id = $1",
          params: ["id"],
        },
      },
      response: {
        resource: "reporting.PortfolioSummary",
        field: "summary",
        collection: "$[*]",
        fields: [
          { name: "id", path: "id" },
          { name: "headline", path: "headline" },
        ],
      },
    },
  ],
  resources: {
    "reporting.PortfolioSummary": [
      { name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } },
      { name: "headline", required: true, type: { kind: "scalar", semantic: "text" } },
    ],
  },
};

function fakePool(rows: Array<Record<string, unknown>>): PgPool {
  const client: PgPoolClient = {
    query: vi.fn(async (text: string) => {
      if (text.includes("rolsuper")) return { rows: [{ rolsuper: false, rolbypassrls: false, server_started: "2026-10-05T08:00:00.123456", database_oid: 16384 }] };
      if (text.includes("role_table_grants")) return { rows: [] };
      if (text.includes("FROM reporting.portfolio_summary_v")) return { rows };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) };
}

describe("callTool — sql-bound capability, SELECT * gains the binding author nothing (S-US3.2)", () => {
  it("drops a column the query selects but the response mapping never declares", async () => {
    const registry = new Registry(ir);
    const pool = fakePool([{ id: "1", headline: "Q1 results", internal_notes: "do not ship this" }]);
    // Typed as the FULL options bag (not a fresh literal at the call site) so the SQL-specific
    // test-injection knobs (`pgPoolFactory`/`connectionRegistry`) pass TS's excess-property
    // check — `callTool` itself only requires the edge-safe subset plus the `connector`
    // override, which is exactly what a Node-only caller (like `@archstone/cli`) supplies.
    const opts: EdgeSafeInvokeOptions & ConnectorInvokeOptions = {
      connector: invokeConnector,
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
      identityAdapter: () => ({ tenantId: "acme" }),
      caller: { principal: "tenant-a" },
    };
    const result = await callTool(registry, "reporting_portfolio-summary", { id: "1" }, opts);

    expect(result.isError).toBeFalsy();
    const structured = result.structuredContent as { summary: Array<{ id: string; headline: string }> };
    expect(structured.summary).toEqual([{ id: "1", headline: "Q1 results" }]);
    expect(JSON.stringify(result)).not.toMatch(/internal_notes|do not ship this/);
  });
});
