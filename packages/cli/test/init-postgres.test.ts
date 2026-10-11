import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { postgresAdapter, type CatalogSnapshot } from "@archstone/init";
import type { ConnectionEntry, SqlInvokeOptions } from "@archstone/provider-sql";
import { INIT_USAGE, loadCatalogSource, parseInitArgs, readIdentityMap, runGate, runInitCmd, type Ask } from "../src/init";

// `archstone init --source postgres` (ADR-0012 D-10; issue #87): argv, the host half that reads the
// catalog, and the gate's database questions — over a fake pool, no Postgres. The real-database
// acceptance is init-postgres.integration.test.ts.

const here = dirname(fileURLToPath(import.meta.url));
const SPEC = resolve(here, "../../init/test/fixtures/openapi/catalog.yaml");

let logs: string[];
let errors: string[];
beforeEach(() => {
  logs = [];
  errors = [];
  vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => void logs.push(a.join(" ")));
  vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => void errors.push(a.join(" ")));
});
afterEach(() => vi.restoreAllMocks());

const workspace = () => mkdtempSync(join(tmpdir(), "archstone-cli-init-pg-"));

describe("argv", () => {
  it("`init <spec-file>` parses exactly as it did before --source existed (release-gate's own form)", () => {
    expect(parseInitArgs(["init", SPEC, "--out", "manifest", "--decisions", "decisions.json", "--non-interactive"])).toEqual({
      spec: SPEC,
      out: "manifest",
      probe: false,
      decisionsFile: "decisions.json",
      interactive: false,
      force: false,
    });
  });

  it("a spec file still works with `--source openapi`", () => {
    expect(parseInitArgs(["init", "spec.yaml", "--source", "openapi", "--out", "o"])).toMatchObject({ spec: "spec.yaml", source: "openapi" });
  });

  it("reads --source postgres --dsn-env, and a flag's value is never mistaken for a spec", () => {
    expect(parseInitArgs(["init", "--source", "postgres", "--dsn-env", "REPORTING_DSN", "--out", "o", "--probe", "--identity-map", "map.json"])).toEqual({
      spec: "",
      source: "postgres",
      dsnEnv: "REPORTING_DSN",
      identityMap: "map.json",
      out: "o",
      probe: true,
      interactive: true,
      force: false,
    });
  });

  it("refuses --source postgres with a spec file", () => {
    expect(parseInitArgs(["init", SPEC, "--source", "postgres", "--dsn-env", "X", "--out", "o"])).toEqual({
      error: "--source postgres reads a database and takes no <spec-file>",
    });
  });

  it("refuses --source postgres without --dsn-env", () => {
    expect(parseInitArgs(["init", "--source", "postgres", "--out", "o"])).toMatchObject({ error: expect.stringMatching(/requires --dsn-env/) });
  });

  it("takes the NAME of a variable, and never echoes a value that is a connection string", () => {
    const secret = "postgres://role:hunter2@db.internal/app";
    const result = parseInitArgs(["init", "--source", "postgres", "--dsn-env", secret, "--out", "o"]);
    expect(result).toEqual({ error: "--dsn-env takes the NAME of an environment variable, never a connection string" });
    expect(JSON.stringify(result)).not.toContain("hunter2");
  });

  it("refuses --dsn-env and --identity-map for an OpenAPI source, and --identity-map without --probe", () => {
    expect(parseInitArgs(["init", "spec.yaml", "--dsn-env", "X", "--out", "o"])).toMatchObject({ error: expect.stringMatching(/only with --source postgres/) });
    expect(parseInitArgs(["init", "spec.yaml", "--identity-map", "m.json", "--out", "o"])).toMatchObject({ error: expect.stringMatching(/only with --source postgres/) });
    expect(parseInitArgs(["init", "--source", "postgres", "--dsn-env", "X", "--identity-map", "m.json", "--out", "o"])).toMatchObject({
      error: expect.stringMatching(/only with --probe/),
    });
  });

  it("rejects a source that is not one", () => {
    expect(parseInitArgs(["init", "--source", "mysql", "--out", "o"])).toMatchObject({ error: expect.stringMatching(/not a source/) });
  });

  it("documents the database form, and keeps the spec form's first line", () => {
    expect(INIT_USAGE.split("\n")[0]).toBe("usage: archstone init <spec-file> --out <dir> [options]");
    expect(INIT_USAGE).toMatch(/--source postgres/);
    expect(INIT_USAGE).toMatch(/--dsn-env <VAR>/);
    expect(INIT_USAGE).toMatch(/--identity-map <file>/);
    expect(INIT_USAGE).toMatch(/No LLM is involved, on any path/);
  });
});

describe("the OpenAPI form is unchanged (release-gate's invocation)", () => {
  it("runs `init <spec> --out <dir> --decisions <file> --non-interactive` to a compiling manifest", async () => {
    const ws = workspace();
    try {
      const record = join(ws, "decisions.json");
      writeFileSync(
        record,
        JSON.stringify({
          version: "0",
          company: { id: "acme", name: "Acme Parts" },
          provider: "acme-api",
          decisions: [
            { operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read" },
            { operation: "GET /api/v2/parts/{id}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" },
          ],
        }),
      );
      const out = join(ws, "manifest");
      expect(await runInitCmd(["init", SPEC, "--out", out, "--decisions", record, "--non-interactive"])).toBe(0);
      expect(existsSync(join(out, "capabilities.yaml"))).toBe(true);
      expect(readFileSync(join(out, "bindings", "catalog.estimate-part-price.binding.yaml"), "utf8")).toContain("type: rest");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("`--source postgres <spec>` refuses with exit 2 and writes nothing", async () => {
    const ws = workspace();
    try {
      expect(await runInitCmd(["init", SPEC, "--source", "postgres", "--dsn-env", "X", "--out", join(ws, "o")])).toBe(2);
      expect(errors.join("\n")).toMatch(/takes no <spec-file>/);
      expect(existsSync(join(ws, "o"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ the host half, over a fake pool

type Row = Record<string, unknown>;

/** A pool whose catalog read returns `catalog`, whose role is `role`, and which counts checkouts. */
function fakeDatabase(opts: { role?: Row; catalog?: Row[] } = {}) {
  let connections = 0;
  const sent: string[] = [];
  const pool = {
    async connect() {
      connections += 1;
      return {
        async query(text: string) {
          sent.push(text.split("\n")[0]!.trim());
          if (text.includes("pg_postmaster_start_time")) {
            return { rows: [{ rolsuper: false, rolbypassrls: false, server_started: "2026-10-12T00:00:00.000000", database_oid: 1, ...opts.role }] };
          }
          if (text.includes("has_schema_privilege")) return { rows: opts.catalog ?? [] };
          return { rows: [] };
        },
        release() {},
      };
    },
  };
  const sql: SqlInvokeOptions = { pgPoolFactory: () => pool as never, connectionRegistry: new Map<string, ConnectionEntry>() };
  return { sql, connections: () => connections, sent };
}

const catalogRow = (relation: string, column: string, dataType: string, isNullable: "YES" | "NO", key: string | null = null): Row => ({
  schema_name: "app",
  relation_name: relation,
  relkind: "r",
  column_name: column,
  data_type: dataType,
  is_nullable: isNullable,
  key_column: key,
});

describe("loadCatalogSource", () => {
  it("reads the catalog as the runtime role and hands the adapter a snapshot, the variable's NAME, and no DSN", async () => {
    const db = fakeDatabase({ catalog: [catalogRow("accounts", "id", "integer", "NO", "id"), catalogRow("accounts", "name", "text", "YES", "id")] });
    const dsn = "postgres://runtime:hunter2@db.test/app";
    const loaded = await loadCatalogSource("REPORTING_DSN", { REPORTING_DSN: dsn }, db.sql);
    if (!loaded.ok) throw new Error(loaded.error);
    expect(loaded.input.dsnEnvVar).toBe("REPORTING_DSN");
    expect(loaded.input.catalog!.relations).toEqual([
      { schema: "app", name: "accounts", kind: "table", keyColumns: ["id"], columns: [{ name: "id", dataType: "integer", isNullable: "NO" }, { name: "name", dataType: "text", isNullable: "YES" }] },
    ]);
    expect(loaded.input.origin).toBe("postgres catalog via REPORTING_DSN");
    expect(JSON.stringify(loaded.input)).not.toContain("hunter2");
    expect(postgresAdapter.adapt(loaded.input).operations.map((o) => o.key)).toEqual(["SELECT app.accounts"]);
  });

  it("an unset variable is a usage error, and no connection is opened", async () => {
    const db = fakeDatabase();
    expect(await loadCatalogSource("REPORTING_DSN", {}, db.sql)).toEqual({ ok: false, error: "the environment variable REPORTING_DSN is not set", code: 2 });
    expect(db.connections()).toBe(0);
  });

  it("an over-privileged role is refused with D-9's own message and no catalog is read", async () => {
    const db = fakeDatabase({ role: { rolsuper: true }, catalog: [catalogRow("accounts", "id", "integer", "NO")] });
    const loaded = await loadCatalogSource("REPORTING_DSN", { REPORTING_DSN: "postgres://root@db.test/app" }, db.sql);
    expect(loaded).toEqual({
      ok: false,
      error: "connection for 'REPORTING_DSN' uses a role with rolsuper = true; the runtime role must not be a superuser — see the topology guide",
      code: 1,
    });
    expect(db.sent.some((s) => s.startsWith("SELECT n.nspname"))).toBe(false);
  });
});

describe("runInitCmd --source postgres", () => {
  it("an over-privileged DSN exits non-zero and writes nothing — not even the output directory", async () => {
    const ws = workspace();
    try {
      const db = fakeDatabase({ role: { rolbypassrls: true } });
      const record = join(ws, "decisions.json");
      writeFileSync(record, JSON.stringify({ version: "0", company: { id: "acme" }, decisions: [] }));
      const code = await runInitCmd(
        ["init", "--source", "postgres", "--dsn-env", "REPORTING_DSN", "--out", join(ws, "out"), "--decisions", record, "--non-interactive"],
        { sql: db.sql, env: { REPORTING_DSN: "postgres://bypass@db.test/app" } },
      );
      expect(code).toBe(1);
      expect(errors.join("\n")).toMatch(/rolbypassrls = true; the runtime role must not bypass row-level security — see the topology guide/);
      expect(existsSync(join(ws, "out"))).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("an unset variable exits 2 naming the variable", async () => {
    const ws = workspace();
    try {
      const code = await runInitCmd(["init", "--source", "postgres", "--dsn-env", "NOT_SET", "--out", join(ws, "out"), "--non-interactive"], { env: {} });
      expect(code).toBe(2);
      expect(errors.join("\n")).toContain("NOT_SET is not set");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it("writes a compiling manifest from the catalog without --probe: no contract, no fixture, exit 0", async () => {
    const ws = workspace();
    try {
      const db = fakeDatabase({ catalog: [catalogRow("accounts", "id", "integer", "NO", "id"), catalogRow("accounts", "name", "text", "YES", "id")] });
      const record = join(ws, "decisions.json");
      writeFileSync(
        record,
        JSON.stringify({
          version: "0",
          company: { id: "acme" },
          decisions: [{ operation: "SELECT app.accounts", keep: true, capabilityId: "reporting.get-account", effect: "read", lookupColumn: "id", resourceName: "Account" }],
        }),
      );
      const out = join(ws, "out");
      const code = await runInitCmd(["init", "--source", "postgres", "--dsn-env", "REPORTING_DSN", "--out", out, "--decisions", record, "--non-interactive"], {
        sql: db.sql,
        env: { REPORTING_DSN: "postgres://runtime:hunter2@db.test/app" },
      });
      expect(code).toBe(0);
      const binding = readFileSync(join(out, "bindings", "reporting.get-account.binding.yaml"), "utf8");
      expect(binding).toContain('dsn: "${REPORTING_DSN}"');
      expect(binding).toContain('WHERE "id" = $1');
      expect(binding).not.toContain("contract:");
      expect(existsSync(join(out, "fixtures"))).toBe(false);
      // The password appears in no written file and no output.
      expect(JSON.stringify([logs, errors, binding, readFileSync(join(out, "INIT-REPORT.md"), "utf8")])).not.toContain("hunter2");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe("readIdentityMap", () => {
  it("reads principal -> claims, and refuses what is not that", () => {
    const ws = workspace();
    try {
      const good = join(ws, "good.json");
      writeFileSync(good, JSON.stringify({ a: { tenant_id: "acme" }, b: { tenant_id: "globex" } }));
      expect(readIdentityMap(good)).toEqual({ ok: true, map: { a: { tenant_id: "acme" }, b: { tenant_id: "globex" } } });
      for (const bad of ["[]", '{"a": "acme"}', '{"a": {"t": 1}}', "not json"]) {
        const path = join(ws, "bad.json");
        writeFileSync(path, bad);
        expect(readIdentityMap(path).ok, bad).toBe(false);
      }
      expect(readIdentityMap(join(ws, "missing.json")).ok).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

// ------------------------------------------------------------------ the gate

/** Answers by prompt text. A list is consumed one answer per ask, in order — one per candidate. */
function scripted(answers: Record<string, string | string[]>): Ask & { asked: string[] } {
  const asked: string[] = [];
  const next = new Map<string, number>();
  return {
    asked,
    question: async (text: string, fallback?: string) => {
      asked.push(text);
      const key = Object.keys(answers).find((k) => text.includes(k));
      const given = key === undefined ? undefined : answers[key];
      const index = key === undefined ? 0 : (next.get(key) ?? 0);
      if (key !== undefined) next.set(key, index + 1);
      const answer = Array.isArray(given) ? given[index] : given;
      if (answer !== undefined && answer !== "") return answer;
      return fallback ?? "";
    },
  };
}

const CATALOG: CatalogSnapshot = {
  relations: [
    { schema: "app", name: "accounts", kind: "table", keyColumns: ["id"], columns: [{ name: "id", dataType: "integer", isNullable: "NO" }, { name: "name", dataType: "text", isNullable: "YES" }] },
    { schema: "app", name: "positions_v", kind: "view", keyColumns: [], columns: [{ name: "id", dataType: "integer", isNullable: "YES" }, { name: "label", dataType: "text", isNullable: "YES" }] },
  ],
  deferred: [],
};
const draft = () => postgresAdapter.adapt({ origin: "x", catalog: CATALOG, dsnEnvVar: "REPORTING_DSN" });
const args = { spec: "", out: "out", probe: false, interactive: true, force: false, company: "acme", domain: "reporting" };

describe("the gate, for a database", () => {
  it("never asks for a base URL or a credential variable", async () => {
    const ask = scripted({ "keep as a capability": "n" });
    await runGate(draft(), ask, args);
    expect(ask.asked.some((q) => /base URL|credential/.test(q))).toBe(false);
  });

  it("pre-fills `read` for a SELECT and the catalog's key as the lookup column; holding Enter takes both", async () => {
    const ask = scripted({ "keep as a capability": "y", "capability id": ["reporting.get-account", "reporting.get-position"] });
    const record = await runGate(draft(), ask, { ...args, probe: false });
    // The first candidate takes the key; the second (a view) has none to offer, so its default is `list`.
    expect(record!.decisions[0]).toMatchObject({ keep: true, effect: "read", lookupColumn: "id" });
    expect(record!.decisions[1]).toMatchObject({ keep: true, effect: "read" });
    expect(record!.decisions[1]).not.toHaveProperty("lookupColumn");
  });

  it("`list` makes it a bounded list even where a key exists", async () => {
    const ask = scripted({ "keep as a capability": ["y", "n"], "capability id": "reporting.get-account", "lookup column": "list" });
    const record = await runGate(draft(), ask, args);
    expect(record!.decisions[0]).not.toHaveProperty("lookupColumn");
  });

  it("a view must be told its lookup column, and an answer it does not offer is re-asked", async () => {
    const ask = scripted({ "keep as a capability": "y", "capability id": ["reporting.get-account", "reporting.get-position"], "lookup column": ["", "bogus", "label"] });
    const record = await runGate(draft(), ask, args);
    expect(record!.decisions[1]).toMatchObject({ lookupColumn: "label" });
    expect(errors.join("\n")).toMatch(/answer with 'list' or one of: id, label/);
    expect(logs.join("\n")).toMatch(/columns: id, label/);
  });

  it("offers a probe only for a lookup, asks for the sample key and the two principals once, and records them", async () => {
    const ask = scripted({
      "keep as a capability": ["y", "n"],
      "capability id": "reporting.get-account",
      "lookup column": "id",
      "record a golden fixture": "y",
      "sample value for id": "7",
      "Principal that owns": "acme-analyst",
      "A DIFFERENT principal": "globex-analyst",
    });
    const record = await runGate(draft(), ask, { ...args, probe: true, principals: ["acme-analyst", "globex-analyst"] });
    expect(record!.decisions[0]).toMatchObject({ lookupColumn: "id", probe: true, sampleInput: { id: 7 } });
    expect(record!.identities).toEqual({ principal: "acme-analyst", negativePrincipal: "globex-analyst" });
    // No second SELECT-method confirmation: a database call has no HTTP method.
    expect(ask.asked.some((q) => /is not a GET/.test(q))).toBe(false);
    expect(ask.asked.filter((q) => /Principal that owns/.test(q))).toHaveLength(1);
  });

  it("a list is offered no probe, and says why", async () => {
    const ask = scripted({ "keep as a capability": ["y", "n"], "capability id": "reporting.read", "lookup column": "list" });
    const record = await runGate(draft(), ask, { ...args, probe: true });
    expect(ask.asked.some((q) => /record a golden fixture/.test(q))).toBe(false);
    expect(logs.join("\n")).toMatch(/a list cannot carry a contract/);
    expect(record!.identities).toBeUndefined();
  });

  it("defaults the principals to the identity map's, in file order", async () => {
    const ask = scripted({ "keep as a capability": ["y", "n"], "capability id": "reporting.get-account", "record a golden fixture": "y", "sample value for id": "1" });
    const record = await runGate(draft(), ask, { ...args, probe: true, principals: ["acme-analyst", "globex-analyst"] });
    expect(record!.identities).toEqual({ principal: "acme-analyst", negativePrincipal: "globex-analyst" });
  });
});
