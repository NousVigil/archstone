import { describe, it, expect, vi } from "vitest";
import type { IRTool } from "@archstone/compiler";
import type { PgPool, PgPoolClient, ConnectionEntry } from "@archstone/provider-sql";
import { checkSqlOverPrivilege, dsnEnvVarName, formatSqlPrivilegeFindings, sqlPrivilegeBlocksStartup, sqlPrivilegeJson, type SqlPrivilegeFindings } from "../src/sql-privilege";

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

/** The server and database half of ADR-0012 D-9 ruling 1's read, which the startup check reads too. */
const SERVER = { server_started: "2026-10-05T08:00:00.123456", database_oid: 16384 };

function fakePool(roleRow: Record<string, unknown>, ownershipRows: Array<Record<string, unknown>> = []): PgPool {
  const client: PgPoolClient = {
    query: vi.fn(async (text: string) => {
      if (text.includes("rolsuper")) return { rows: [{ ...SERVER, ...roleRow }] };
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
    const findings = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(findings).toEqual({ refused: [], incomplete: [] });
    expect(sqlPrivilegeBlocksStartup(findings)).toBe(false);
  });

  it("reports a superuser connection as refused, naming rolsuper", async () => {
    const pool = fakePool({ rolsuper: true, rolbypassrls: false });
    const findings = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(findings.incomplete).toEqual([]);
    expect(findings.refused).toHaveLength(1);
    expect(findings.refused[0]).toMatch(/rolsuper/);
    expect(sqlPrivilegeBlocksStartup(findings)).toBe(true);
  });

  it("reports an owns-and-granted relation, naming the exact schema.relation", async () => {
    const pool = fakePool({ rolsuper: false, rolbypassrls: false }, [{ schema_name: "reporting", relation_name: "portfolio_summary_v" }]);
    const findings = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(findings.incomplete).toEqual([]);
    expect(findings.refused[0]).toMatch(/reporting\.portfolio_summary_v/);
  });

  it("checks each DISTINCT dsn once, even across many sql-bound tools sharing one DSN (EC-14)", async () => {
    const pool = fakePool({ rolsuper: false, rolbypassrls: false });
    const connectSpy = pool.connect as ReturnType<typeof vi.fn>;
    await checkSqlOverPrivilege([sqlTool("a"), sqlTool("b"), sqlTool("c")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    // One connect(): the role read and the ownership check run in one transaction on it, against
    // the SAME cached connection entry, never once per tool.
    expect(connectSpy).toHaveBeenCalledTimes(1);
  });

  it("reports an unreachable database as incomplete (fail closed, no verdict), and a later check against the same registry retries rather than replaying it", async () => {
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
      expect(await checkSqlOverPrivilege([sqlTool("reporting.summary")], opts)).toEqual({
        refused: [],
        incomplete: ["pool checkout failed while checking connection privileges (ECONNREFUSED)"],
      });
    } finally {
      stderr.mockRestore();
    }
    expect(await checkSqlOverPrivilege([sqlTool("reporting.summary")], opts)).toEqual({ refused: [], incomplete: [] });
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
    let findings: SqlPrivilegeFindings;
    let lines: string[];
    try {
      findings = await checkSqlOverPrivilege([sqlTool("reporting.summary")], opts);
      lines = stderr.mock.calls.map((c) => c.join(" "));
    } finally {
      stderr.mockRestore();
    }
    expect(findings).toEqual({ refused: [], incomplete: ["pool creation failed (error code unknown)"] });
    for (const secret of [dsn, "s3cret"]) expect(findings.incomplete.join("\n")).not.toContain(secret);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("[dsn]");
    expect(lines[0]).not.toContain("s3cret");
    expect(opts.connectionRegistry.size).toBe(0);
  });

  it("fails closed when the D-9 read cannot complete — pg_postmaster_start_time() not executable (R-9) — and caches nothing", async () => {
    const connect = vi.fn(async (): Promise<PgPoolClient> => ({
      query: vi.fn(async (text: string) => {
        if (text.includes("pg_postmaster_start_time")) {
          throw Object.assign(new Error("permission denied for function pg_postmaster_start_time"), { code: "42501" });
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    }));
    const opts = {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => ({ connect }),
      connectionRegistry: new Map<string, ConnectionEntry>(),
    };
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      expect(await checkSqlOverPrivilege([sqlTool("reporting.summary")], opts)).toEqual({
        refused: [],
        incomplete: ["connection privilege check failed (SQLSTATE 42501)"],
      });
    } finally {
      stderr.mockRestore();
    }
    const entry = opts.connectionRegistry.get("postgres://runtime@localhost/app")!;
    expect(entry.refusal).toBeUndefined();
    expect(entry.ownership.size).toBe(0);
  });

  it("skips a tool whose dsn env var is unset — a configuration gap, not a privilege question", async () => {
    const pool = fakePool({ rolsuper: true, rolbypassrls: false });
    const findings = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: {},
      pgPoolFactory: () => pool,
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(findings).toEqual({ refused: [], incomplete: [] });
    expect(pool.connect).not.toHaveBeenCalled();
  });

  it("ignores rest-bound tools entirely", async () => {
    const restTool: IRTool = { ...sqlTool("x"), connector: { type: "rest", rest: { method: "GET", path: "/x" } } };
    expect(await checkSqlOverPrivilege([restTool], {})).toEqual({ refused: [], incomplete: [] });
  });
});

// #133: a check that reached no verdict must not be reported as an over-privileged connection.
describe("formatSqlPrivilegeFindings — refusal vs. a check that could not complete (#133)", () => {
  const PREFIX = "archstone serve: refusing to start";
  const unreachable = () => Object.assign(new Error("connect ECONNREFUSED 10.0.3.7:5432 (password s3cret)"), { code: "ECONNREFUSED" });
  /** Driver text that must never reach the formatted lines: host, port, the password, the message. */
  const LEAKS = ["10.0.3.7", "5432", "s3cret", "connect ECONNREFUSED", "permission denied", "postgres://"];

  async function quietly<T>(fn: () => Promise<T>): Promise<T> {
    const stderr = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      return await fn();
    } finally {
      stderr.mockRestore();
    }
  }

  it("an unreachable database lands in incomplete, and its lines say the check could not complete — never over-privileged", async () => {
    const findings = await quietly(() =>
      checkSqlOverPrivilege([sqlTool("reporting.summary")], {
        env: { DATABASE_URL: "postgres://runtime:s3cret@10.0.3.7:5432/app" },
        pgPoolFactory: () => ({ connect: vi.fn(async () => Promise.reject(unreachable())) }),
        connectionRegistry: new Map<string, ConnectionEntry>(),
      }),
    );
    expect(findings).toEqual({ refused: [], incomplete: ["pool checkout failed while checking connection privileges (ECONNREFUSED)"] });
    expect(sqlPrivilegeBlocksStartup(findings)).toBe(true);
    const lines = formatSqlPrivilegeFindings(PREFIX, findings);
    expect(lines).toEqual([
      "archstone serve: refusing to start — sql connection privilege check(s) could not complete:",
      "  - pool checkout failed while checking connection privileges (ECONNREFUSED)",
    ]);
    const text = lines.join("\n");
    expect(text).not.toContain("over-privileged");
    for (const leak of LEAKS) expect(text).not.toContain(leak);
  });

  it("the D-9 read failing (R-9) lands in incomplete too, with no driver text in its lines", async () => {
    const client: PgPoolClient = {
      query: vi.fn(async (text: string) => {
        if (text.includes("pg_postmaster_start_time")) {
          throw Object.assign(new Error("permission denied for function pg_postmaster_start_time (10.0.3.7:5432)"), { code: "42501" });
        }
        return { rows: [] };
      }),
      release: vi.fn(),
    };
    const findings = await quietly(() =>
      checkSqlOverPrivilege([sqlTool("reporting.summary")], {
        env: { DATABASE_URL: "postgres://runtime:s3cret@10.0.3.7:5432/app" },
        pgPoolFactory: () => ({ connect: vi.fn(async () => client) }),
        connectionRegistry: new Map<string, ConnectionEntry>(),
      }),
    );
    expect(findings).toEqual({ refused: [], incomplete: ["connection privilege check failed (SQLSTATE 42501)"] });
    const text = formatSqlPrivilegeFindings(PREFIX, findings).join("\n");
    expect(text).toContain("could not complete");
    expect(text).not.toContain("over-privileged");
    for (const leak of LEAKS) expect(text).not.toContain(leak);
  });

  it("a genuine refusal (rolsuper) still lands in refused, and its lines say over-privileged", async () => {
    const findings = await checkSqlOverPrivilege([sqlTool("reporting.summary")], {
      env: { DATABASE_URL: "postgres://runtime@localhost/app" },
      pgPoolFactory: () => fakePool({ rolsuper: true, rolbypassrls: false }),
      connectionRegistry: new Map<string, ConnectionEntry>(),
    });
    expect(findings.incomplete).toEqual([]);
    const lines = formatSqlPrivilegeFindings(PREFIX, findings);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toBe("archstone serve: refusing to start — over-privileged sql connection(s):");
    expect(lines[1]).toMatch(/^ {2}- connection for 'DATABASE_URL' uses a role with rolsuper = true/);
    expect(lines.join("\n")).not.toContain("could not complete");
  });

  it("a mixed run across two DSNs reports one of each, each under its own header", async () => {
    const superuser = fakePool({ rolsuper: true, rolbypassrls: false });
    const down: PgPool = { connect: vi.fn(async () => Promise.reject(unreachable())) };
    const pools: Record<string, PgPool> = {
      "postgres://runtime@primary/app": superuser,
      "postgres://runtime:s3cret@10.0.3.7:5432/reports": down,
    };
    const findings = await quietly(() =>
      checkSqlOverPrivilege([sqlTool("reporting.summary", "${PRIMARY_URL}"), sqlTool("reporting.detail", "${REPORTS_URL}")], {
        env: { PRIMARY_URL: "postgres://runtime@primary/app", REPORTS_URL: "postgres://runtime:s3cret@10.0.3.7:5432/reports" },
        pgPoolFactory: (dsn) => pools[dsn],
        connectionRegistry: new Map<string, ConnectionEntry>(),
      }),
    );
    expect(findings.refused).toHaveLength(1);
    expect(findings.refused[0]).toMatch(/^connection for 'PRIMARY_URL' uses a role with rolsuper = true/);
    expect(findings.incomplete).toEqual(["pool checkout failed while checking connection privileges (ECONNREFUSED)"]);
    const lines = formatSqlPrivilegeFindings("archstone verify ./m: refusing", findings);
    expect(lines).toEqual([
      "archstone verify ./m: refusing — over-privileged sql connection(s):",
      `  - ${findings.refused[0]}`,
      "archstone verify ./m: refusing — sql connection privilege check(s) could not complete:",
      "  - pool checkout failed while checking connection privileges (ECONNREFUSED)",
    ]);
    for (const leak of LEAKS) expect(lines.join("\n")).not.toContain(leak);
  });

  it("prints nothing when there is nothing to report", () => {
    expect(formatSqlPrivilegeFindings(PREFIX, { refused: [], incomplete: [] })).toEqual([]);
  });
});

describe("sqlPrivilegeJson — verify --json's payload (#133)", () => {
  const REFUSAL = "connection for 'PRIMARY_URL' uses a role with rolsuper = true; the runtime role must not be a superuser — see the topology guide";
  const NO_VERDICT = "pool checkout failed while checking connection privileges (ECONNREFUSED)";

  it("a refusal only is sql_over_privileged", () => {
    expect(sqlPrivilegeJson({ refused: [REFUSAL], incomplete: [] })).toEqual({
      error: "sql_over_privileged",
      errors: [REFUSAL],
      refused: [REFUSAL],
      incomplete: [],
    });
  });

  it("a check that could not complete, only, is sql_privilege_check_incomplete", () => {
    expect(sqlPrivilegeJson({ refused: [], incomplete: [NO_VERDICT] })).toEqual({
      error: "sql_privilege_check_incomplete",
      errors: [NO_VERDICT],
      refused: [],
      incomplete: [NO_VERDICT],
    });
  });

  it("a mixed run is sql_over_privileged, with errors listing refusals first", () => {
    expect(sqlPrivilegeJson({ refused: [REFUSAL], incomplete: [NO_VERDICT] })).toEqual({
      error: "sql_over_privileged",
      errors: [REFUSAL, NO_VERDICT],
      refused: [REFUSAL],
      incomplete: [NO_VERDICT],
    });
  });
});
