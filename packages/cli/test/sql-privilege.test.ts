import { describe, it, expect, vi } from "vitest";
import type { IRTool } from "@archstone/compiler";
import type { PgPool, PgPoolClient, ConnectionEntry } from "@archstone/provider-sql";
import { checkSqlOverPrivilege, dsnEnvVarName } from "../src/sql-privilege";

// ADR-0012 D-9 (BF-3) — the eager over-privileged-connection check `runServeHttp`/the stdio
// `serve` path/`runVerifyCmd` all call BEFORE accepting a connection or reporting a result.

function sqlTool(id: string, dsn = "${DATABASE_URL}"): IRTool {
  return {
    id,
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [],
    connector: { type: "sql", sql: { engine: "postgres", dsn, statementKind: "select", query: "SELECT 1", params: [] } },
  };
}

function fakePool(roleRow: Record<string, unknown>, ownershipRows: Array<Record<string, unknown>> = []): PgPool {
  const client: PgPoolClient = {
    query: vi.fn(async (text: string) => {
      if (text.includes("rolsuper")) return { rows: [roleRow] };
      if (text.includes("role_table_grants")) return { rows: ownershipRows };
      return { rows: [] };
    }),
    release: vi.fn(),
  };
  return { connect: vi.fn(async () => client) };
}

describe("dsnEnvVarName", () => {
  it("extracts the env var name from a ${VAR}-shaped dsn", () => {
    expect(dsnEnvVarName("${DATABASE_URL}")).toBe("DATABASE_URL");
  });

  it("returns undefined for anything else (defensive — unreachable via a compiled manifest)", () => {
    expect(dsnEnvVarName("postgres://literal")).toBeUndefined();
  });
});

describe("checkSqlOverPrivilege", () => {
  it("returns no errors for a correctly-privileged connection", async () => {
    const pool = fakePool({ rolsuper: false, rolbypassrls: false });
    const errors = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(errors).toEqual([]);
  });

  it("reports a superuser connection, naming rolsuper", async () => {
    const pool = fakePool({ rolsuper: true, rolbypassrls: false });
    const errors = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toMatch(/rolsuper/);
  });

  it("reports an owns-and-granted relation, naming the exact schema.relation", async () => {
    const pool = fakePool({ rolsuper: false, rolbypassrls: false }, [{ schema_name: "reporting", relation_name: "portfolio_summary_v" }]);
    const errors = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(errors[0]).toMatch(/reporting\.portfolio_summary_v/);
  });

  it("checks each DISTINCT dsn once, even across many sql-bound tools sharing one DSN (EC-14)", async () => {
    const pool = fakePool({ rolsuper: false, rolbypassrls: false });
    const connectSpy = pool.connect as ReturnType<typeof vi.fn>;
    await checkSqlOverPrivilege([sqlTool("a"), sqlTool("b"), sqlTool("c")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    // One connect() for the role check, one for the ownership check — both against the SAME
    // cached connection entry, never once per tool.
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable database as an error (fail closed), and a later check against the same registry retries rather than replaying it", async () => {
    const healthy = fakePool({ rolsuper: false, rolbypassrls: false });
    const connect = vi
      .fn<() => Promise<PgPoolClient>>()
      .mockRejectedValueOnce(Object.assign(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { code: "ECONNREFUSED" }))
      .mockImplementation(() => healthy.connect());
    const opts = {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => ({ connect }),
      connectionRegistry: new Map<string, ConnectionEntry>(),
    };
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await checkSqlOverPrivilege([sqlTool("reporting.summary")], opts)).toEqual([
        "pool checkout failed while checking connection privileges (ECONNREFUSED)",
      ]);
    } finally {
      stderr.mockRestore();
    }
    expect(await checkSqlOverPrivilege([sqlTool("reporting.summary")], opts)).toEqual([]);
    expect(connect).toHaveBeenCalledTimes(2);
  });

  it("reports a pool that cannot be created as a failed check — resolved, not rejected, with the DSN and its password kept out of both the error and stderr", async () => {
    const dsn = "postgres://app_runtime:s3cret@db.internal:5432/app";
    const opts = {
      env: { DATABASE_URL: dsn },
      pgPoolFactory: (): PgPool => {
        throw new Error(`invalid connection string ${dsn}`);
      },
      connectionRegistry: new Map<string, ConnectionEntry>(),
    };
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    let errors: string[];
    let lines: string[];
    try {
      errors = await checkSqlOverPrivilege([sqlTool("reporting.summary")], opts);
      lines = stderr.mock.calls.map((c) => c.join(" "));
    } finally {
      stderr.mockRestore();
    }
    expect(errors).toEqual(["pool creation failed (error code unknown)"]);
    for (const secret of [dsn, "s3cret"]) expect(errors.join("\n")).not.toContain(secret);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[dsn]");
    expect(lines[0]).not.toContain("s3cret");
    expect(opts.connectionRegistry.size).toBe(0);
  });

  it("skips a tool whose dsn env var is unset — a configuration gap, not a privilege question", async () => {
    const pool = fakePool({ rolsuper: true, rolbypassrls: false });
    const errors = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: {},
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(errors).toEqual([]);
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("ignores rest-bound tools entirely", async () => {
    const restTool: IRTool = { ...sqlTool("x"), connector: { type: "rest", rest: { method: "GET", path: "/x" } } };
    const errors = await checkSqlOverPrivilege([restTool], {});
    expect(errors).toEqual([]);
  });
});
