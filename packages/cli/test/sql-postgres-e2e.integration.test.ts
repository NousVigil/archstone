// `archstone verify` end to end against a REAL Postgres (ADR-0012 D-8, D-9; issue #153), and the
// `sql-reporting` example that makes the same claim checkable by anyone with a container.
//
// Spawns the real CLI — never the admin url: the child sees only the runtime role's DSN, handed
// over as the `${…}` env var the binding names, and an `--identity-map` file. Skipped locally
// unless ARCHSTONE_TEST_PG_URL is set, and a failure (never a skip) in CI.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fingerprintShape } from "@archstone/compiler";
import { buildRegistry, callTool, toolDefinitions } from "@archstone/runtime";
import { invokeConnector, type ConnectorInvokeOptions } from "@archstone/runtime/connector";
import type { ConnectionEntry } from "@archstone/provider-sql";
// Test-only, by relative path: the fixture owns `pg` and the Postgres gate (see its header).
import { createPgFixture, createScriptDatabase, describePostgres, endPools, DSN_VARS, type PgFixture, type ScriptDatabase } from "../../../providers/sql/test/support/postgres";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const example = resolve(root, "examples/manifests/sql-reporting");

interface CliRun {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** The CLI as an operator runs it. The environment is built from scratch: PATH, plus exactly the
 *  variables the manifest names — the admin url never reaches the child. */
function runCli(args: string[], env: Record<string, string>): Promise<CliRun> {
  return new Promise((done) => {
    const child = execFile(tsx, [cli, ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", ...env }, timeout: 90_000 }, (_err, stdout, stderr) => {
      done({ code: child.exitCode, stdout, stderr });
    });
    child.stdin?.end();
  });
}

const resultOf = (run: CliRun) => (JSON.parse(run.stdout) as { results: Array<{ capabilityId: string; status: string; detail: string }> }).results[0];

// -------------------------------------------------------------------- 1. a manifest written here

const CAP = "reporting.holding";
const DSN_VAR = "IT_RUNTIME_DSN";

/** A minimal `sql` manifest over the curated view `app.positions_v`, with a contract recorded from
 *  tenant A's row and a negative identity (tenant B) to replay it as. */
function writeManifest(dir: string, opts: { negativeIdentity?: boolean } = {}): void {
  mkdirSync(join(dir, "bindings"), { recursive: true });
  mkdirSync(join(dir, "fixtures"), { recursive: true });
  const fingerprint = fingerprintShape([{ id: 1, label: "acme-alpha" }]); // what tenant A's row 1 is, as the view returns it
  writeFileSync(join(dir, "capabilities.yaml"), `company:\n  id: acme\ncapabilities:\n  - ${CAP}\nproviders:\n  - warehouse\n`);
  writeFileSync(
    join(dir, `${CAP}.capability.yaml`),
    `capability:\n  id: ${CAP}\n  description: One holding of the caller.\n  effect: read\n  provider: warehouse\n  input:\n    id:\n      type: identifier\n`,
  );
  writeFileSync(
    join(dir, "bindings", `${CAP}.binding.yaml`),
    [
      "binding:",
      `  capabilityId: ${CAP}`,
      "  connector:",
      "    type: sql",
      "    sql:",
      "      engine: postgres",
      `      dsn: "\${${DSN_VAR}}"`,
      "      statementKind: select",
      "      query: SELECT id, label FROM app.positions_v WHERE id = $1",
      "      params:",
      "        - id",
      "  contract:",
      "    source: recorded",
      `    fingerprint: "${fingerprint}"`,
      '    verifiedAt: "2026-10-07T00:00:00Z"',
      "    probe:",
      `      fixture: fixtures/${CAP}.golden.json`,
      "",
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "fixtures", `${CAP}.golden.json`),
    JSON.stringify({
      capabilityId: CAP,
      request: { id: 1 },
      identity: { principal: "tenant-a" },
      ...(opts.negativeIdentity === false ? {} : { negativeIdentity: { principal: "tenant-b" } }),
    }),
  );
}

describePostgres("archstone verify end to end against a real Postgres", () => {
  let fx: PgFixture;
  let dir: string;
  let identityMap: string;
  const env = () => ({ [DSN_VAR]: fx.env[DSN_VARS.runtime] });
  const verify = (extra: string[] = []) => runCli(["verify", dir, "--identity-map", identityMap, ...extra], env());

  /** Run SQL as the admin against `app.positions`, run the CLI, put the policy back. */
  async function withPolicy(change: string[], restore: string[] = []) {
    for (const sql of change) await fx.admin(sql);
    try {
      return await verify(["--json"]);
    } finally {
      for (const sql of restore) await fx.admin(sql);
    }
  }
  const POLICY = "CREATE POLICY tenant_isolation ON app.positions USING (tenant_id = app.current_tenant_id())";
  const RESTORE = ["DROP POLICY IF EXISTS tenant_isolation ON app.positions", POLICY, "ALTER TABLE app.positions ENABLE ROW LEVEL SECURITY, FORCE ROW LEVEL SECURITY"];

  beforeAll(async () => {
    fx = await createPgFixture();
    dir = mkdtempSync(join(tmpdir(), "archstone-cli-pg-"));
    writeManifest(dir);
    identityMap = join(dir, "identity-map.json");
    writeFileSync(identityMap, JSON.stringify({ "tenant-a": { tenant_id: "acme" }, "tenant-b": { tenant_id: "beta" } }));
  }, 60_000);

  afterAll(async () => {
    await fx?.teardown();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }, 60_000);

  it("green, exit 0: the recorded contract holds and tenant B's replay of tenant A's request returns zero rows", async () => {
    const run = await verify();
    expect(run.code).toBe(0);
    expect(run.stdout).toContain(`🟢 ${CAP} — fingerprint unchanged`);
    const json = await verify(["--json"]);
    expect(json.code).toBe(0);
    expect(resultOf(json)).toMatchObject({ capabilityId: CAP, status: "green", detail: "fingerprint unchanged" });
  }, 120_000);

  it("RED, exit 1, when the policy is replaced by one that admits every row (USING true)", async () => {
    const run = await withPolicy(["DROP POLICY tenant_isolation ON app.positions", "CREATE POLICY tenant_isolation ON app.positions USING (true)"], RESTORE);
    expect(run.code).toBe(1);
    expect(resultOf(run)).toEqual({ capabilityId: CAP, status: "red", detail: `isolation test failed: 1 foreign row returned for capability '${CAP}'` });
  }, 120_000);

  it("RED, exit 1, when row-level security is disabled on the table", async () => {
    const run = await withPolicy(["ALTER TABLE app.positions DISABLE ROW LEVEL SECURITY"], RESTORE);
    expect(run.code).toBe(1);
    expect(resultOf(run)).toEqual({ capabilityId: CAP, status: "red", detail: `isolation test failed: 1 foreign row returned for capability '${CAP}'` });
  }, 120_000);

  it("RED, exit 1, when FORCE is dropped: the view's owner is then exempt from the policy and sees every tenant", async () => {
    const run = await withPolicy(["ALTER TABLE app.positions NO FORCE ROW LEVEL SECURITY"], RESTORE);
    expect(run.code).toBe(1);
    expect(resultOf(run)).toEqual({ capabilityId: CAP, status: "red", detail: `isolation test failed: 1 foreign row returned for capability '${CAP}'` });
  }, 120_000);

  it("a DROPPED policy under FORCE fails closed — default-deny, zero rows for everyone: isolation holds, so it is yellow (shape drift), exit 0, not red", async () => {
    // Not a leak, but not green either: tenant A's own replay is empty too, and that no longer
    // matches the recorded contract. Pinned so a dropped policy is never read as a silent pass.
    const run = await withPolicy(["DROP POLICY tenant_isolation ON app.positions"], RESTORE);
    expect(run.code).toBe(0);
    const result = resultOf(run);
    expect(result.status).toBe("yellow");
    expect(result.detail).toMatch(/^response shape changed/);
  }, 120_000);

  it("the fixture is back to green after every variant above (the restore is real)", async () => {
    expect(resultOf(await verify(["--json"])).status).toBe("green");
  }, 120_000);

  it("RED, exit 1, when no negative identity is recorded: isolation is unproven, and unproven is not green", async () => {
    const bare = mkdtempSync(join(tmpdir(), "archstone-cli-pg-bare-"));
    try {
      writeManifest(bare, { negativeIdentity: false });
      const run = await runCli(["verify", bare, "--identity-map", identityMap, "--json"], env());
      expect(run.code).toBe(1);
      expect(resultOf(run)).toEqual({ capabilityId: CAP, status: "red", detail: "isolation not verified: no negative identity recorded" });
    } finally {
      rmSync(bare, { recursive: true, force: true });
    }
  }, 120_000);

  it("refuses an over-privileged connection before it reports anything: a superuser DSN exits 1", async (ctx) => {
    if (!fx.created.superuser) ctx.skip();
    const run = await runCli(["verify", dir, "--identity-map", identityMap, "--json"], { [DSN_VAR]: fx.env[DSN_VARS.superuser] });
    expect(run.code).toBe(1);
    expect(run.stdout).not.toContain("results");
    expect(run.stdout).toContain("rolsuper = true");
  }, 120_000);
});

// ----------------------------------------------------------------------------- 2. the example


describe("examples/manifests/sql-reporting is a valid manifest, and indistinguishable from a REST one", () => {
  it("applies offline and lists one tool", () => {
    const built = buildRegistry(example);
    expect(built.diagnostics.filter((d) => d.severity === "error")).toEqual([]);
    expect(built.ok).toBe(true);
    expect(toolDefinitions(built.registry!).map((t) => t.name)).toEqual(["reporting_get-position"]);
  });

  it("a rest binding for the same capability yields the identical MCP tool: name, description, input, output schema, annotations", () => {
    const twin = mkdtempSync(join(tmpdir(), "archstone-rest-twin-"));
    try {
      cpSync(example, twin, { recursive: true });
      const bindingPath = join(twin, "bindings", "reporting.get-position.binding.yaml");
      const mapping = readFileSync(bindingPath, "utf8").split("\n  # What `archstone verify`")[0].split("  response:")[1];
      writeFileSync(
        bindingPath,
        `binding:\n  capabilityId: reporting.get-position\n  connector:\n    type: rest\n    rest:\n      baseUrl: "\${POSITIONS_API_URL}"\n      method: POST\n      path: /v1/positions\n  response:${mapping}`,
      );
      const sql = buildRegistry(example);
      const rest = buildRegistry(twin);
      expect(rest.ok).toBe(true);
      expect(rest.registry!.getCapability("reporting_get-position")!.connector!.type).toBe("rest");
      expect(sql.registry!.getCapability("reporting_get-position")!.connector!.type).toBe("sql");
      expect(toolDefinitions(sql.registry!)).toEqual(toolDefinitions(rest.registry!));
    } finally {
      rmSync(twin, { recursive: true, force: true });
    }
  });
});

describePostgres("examples/manifests/sql-reporting against a database built from its own fixture.sql", () => {
  let db: ScriptDatabase;

  beforeAll(async () => {
    // The fixture's own text, as the README runs it. Role names are made run-unique and the runtime
    // role is found from the catalog by the shared helper — the same code the release gate runs (#162).
    db = await createScriptDatabase(readFileSync(join(example, "fixture.sql"), "utf8"));
    expect(db.runtimeRole).toBe("reporting_runtime");
  }, 60_000);

  afterAll(async () => {
    await db?.teardown();
  }, 60_000);

  it("verify is green, exit 0, and goes red, exit 1, once row-level security is switched off", async () => {
    const args = ["verify", example, "--identity-map", join(example, "identity-map.json"), "--json"];
    const green = await runCli(args, { REPORTING_DSN: db.dsn });
    expect(green.code).toBe(0);
    expect(resultOf(green)).toMatchObject({ capabilityId: "reporting.get-position", status: "green", detail: "fingerprint unchanged, mapping OK" });

    await db.admin("ALTER TABLE app.positions DISABLE ROW LEVEL SECURITY");
    const red = await runCli(args, { REPORTING_DSN: db.dsn });
    expect(red.code).toBe(1);
    expect(resultOf(red).status).toBe("red");
    expect(resultOf(red).detail).toMatch(/^isolation test failed: \d+ foreign rows? returned/);
  }, 120_000);

  it("the same capability, called through the MCP layer, returns what a REST backend returning those rows returns", async () => {
    // Restore the example's isolation first (the previous test switched it off).
    await db.admin("ALTER TABLE app.positions ENABLE ROW LEVEL SECURITY");

    // A REST backend that returns acme's rows, as a service in front of the same data would.
    const rows = [{ id: 1, label: "ACME-BOND-2031", qty: 120 }];
    const backend = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(rows));
    });
    await new Promise<void>((r) => backend.listen(0, "127.0.0.1", r));
    const twin = mkdtempSync(join(tmpdir(), "archstone-rest-twin-"));
    const connectionRegistry = new Map<string, ConnectionEntry>();
    try {
      cpSync(example, twin, { recursive: true });
      const bindingPath = join(twin, "bindings", "reporting.get-position.binding.yaml");
      const mapping = readFileSync(bindingPath, "utf8").split("\n  # What `archstone verify`")[0].split("  response:")[1];
      writeFileSync(
        bindingPath,
        `binding:\n  capabilityId: reporting.get-position\n  connector:\n    type: rest\n    rest:\n      baseUrl: "\${POSITIONS_API_URL}"\n      method: POST\n      path: /v1/positions\n  response:${mapping}`,
      );
      const port = (backend.address() as { port: number }).port;

      // Typed as the full (Node-only) options, so the sql-only fields are allowed in the bag.
      const sqlOptions: ConnectorInvokeOptions = {
        env: { REPORTING_DSN: db.dsn },
        identityAdapter: (principal) => (principal === "acme-analyst" ? { tenant_id: "acme" } : undefined),
        caller: { principal: "acme-analyst" },
        connectionRegistry,
      };
      const viaSql = await callTool(buildRegistry(example).registry!, "reporting_get-position", { id: 1 }, { ...sqlOptions, connector: invokeConnector });
      const viaRest = await callTool(buildRegistry(twin).registry!, "reporting_get-position", { id: 1 }, { env: { POSITIONS_API_URL: `http://127.0.0.1:${port}` } });

      expect(viaSql.isError).toBe(false);
      expect(viaSql.structuredContent).toEqual({ positions: [{ id: 1, label: "ACME-BOND-2031", quantity: 120 }] });
      expect(viaSql).toEqual(viaRest);
    } finally {
      await endPools(connectionRegistry);
      await new Promise((r) => backend.close(r));
      rmSync(twin, { recursive: true, force: true });
    }
  }, 120_000);
});
