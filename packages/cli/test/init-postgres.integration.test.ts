// `archstone init --source postgres` against a REAL Postgres (ADR-0012 D-10; issue #87).
//
// Spawns the real CLI, and hands the child only what an operator would: PATH, the runtime role's
// DSN under the variable `--dsn-env` names, and files. The admin url never reaches it. Skipped
// locally unless ARCHSTONE_TEST_PG_URL is set, and a failure (never a skip) in CI.

import { afterAll, beforeAll, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
// Test-only, by relative path: the fixture owns `pg` and the Postgres gate (see its header).
import { createPgFixture, createScriptDatabase, describePostgres, DSN_VARS, type PgFixture, type ScriptDatabase } from "../../../providers/sql/test/support/postgres";

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

function runCli(args: string[], env: Record<string, string>): Promise<CliRun> {
  return new Promise((done) => {
    const child = execFile(tsx, [cli, ...args], { cwd: root, env: { PATH: process.env.PATH ?? "", ...env }, timeout: 90_000 }, (_err, stdout, stderr) => {
      done({ code: child.exitCode, stdout, stderr });
    });
    child.stdin?.end();
  });
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}
const everything = (dir: string): string =>
  filesUnder(dir)
    .map((f) => `--- ${relative(dir, f)}\n${readFileSync(f, "utf8")}`)
    .join("\n");

const IDENTITY_MAP = join(example, "identity-map.json");
const verifyArgs = (dir: string) => ["verify", dir, "--identity-map", IDENTITY_MAP, "--json"];
const resultsOf = (run: CliRun) => (JSON.parse(run.stdout) as { results: Array<{ capabilityId: string; status: string; detail: string }> }).results;

type Decision = Record<string, unknown>;
const lookup = (over: Decision = {}): Decision => ({
  operation: "SELECT app.positions_v",
  keep: true,
  capabilityId: "reporting.get-position",
  effect: "read",
  lookupColumn: "id",
  resourceName: "Position",
  probe: true,
  sampleInput: { id: 1 },
  ...over,
});
const list = (): Decision => ({ operation: "SELECT app.positions_v", keep: true, capabilityId: "reporting.list-positions", effect: "read", resourceName: "Position", probe: true });
const both = { principal: "acme-analyst", negativePrincipal: "globex-analyst" };

describePostgres("archstone init --source postgres against a real Postgres", () => {
  let db: ScriptDatabase;
  let work: string;
  let n = 0;

  /** One `init` run: its own decisions file and output directory, the runtime role's DSN in the
   *  environment, and the sql-reporting example's identity map. */
  async function init(decisions: Decision[], opts: { identities?: Record<string, string> | null; probe?: boolean; map?: boolean; env?: Record<string, string> } = {}) {
    n += 1;
    const out = join(work, `out-${n}`);
    const record = join(work, `decisions-${n}.json`);
    const identities = opts.identities === undefined ? both : opts.identities;
    writeFileSync(record, JSON.stringify({ version: "0", company: { id: "harborline" }, ...(identities ? { identities } : {}), decisions }));
    const args = ["init", "--source", "postgres", "--dsn-env", "REPORTING_DSN", "--out", out, "--decisions", record, "--non-interactive"];
    if (opts.probe !== false) args.push("--probe");
    if (opts.map !== false && opts.probe !== false) args.push("--identity-map", IDENTITY_MAP);
    const run = await runCli(args, opts.env ?? { REPORTING_DSN: db.dsn });
    return { run, out };
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "archstone-init-pg-"));
    // The example's own fixture, as its README runs it.
    db = await createScriptDatabase(readFileSync(join(example, "fixture.sql"), "utf8"));
  }, 60_000);

  afterAll(async () => {
    await db?.teardown();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it("(a) --probe writes a manifest `apply` accepts and `verify --identity-map` reports green, with no hand edits", async () => {
    const { run, out } = await init([lookup()]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(JSON.parse(readFileSync(join(out, "fixtures", "reporting.get-position.golden.json"), "utf8"))).toMatchObject({
      request: { id: 1 },
      identity: { principal: "acme-analyst" },
      negativeIdentity: { principal: "globex-analyst" },
      expects: { collectionNonEmpty: true },
    });
    expect((await runCli(["apply", out], {})).code).toBe(0);
    const verified = await runCli(verifyArgs(out), { REPORTING_DSN: db.dsn });
    expect(verified.code, verified.stdout + verified.stderr).toBe(0);
    expect(resultsOf(verified)).toEqual([expect.objectContaining({ capabilityId: "reporting.get-position", status: "green" })]);
  }, 180_000);

  it("(a) and the recorded isolation test is real: switching row-level security off turns it red", async () => {
    const { out } = await init([lookup({ capabilityId: "reporting.get-position-again" })]);
    await db.admin("ALTER TABLE app.positions DISABLE ROW LEVEL SECURITY");
    try {
      const red = await runCli(verifyArgs(out), { REPORTING_DSN: db.dsn });
      expect(red.code).toBe(1);
      expect(resultsOf(red)[0]!.detail).toMatch(/^isolation test failed/);
    } finally {
      await db.admin("ALTER TABLE app.positions ENABLE ROW LEVEL SECURITY");
    }
  }, 180_000);

  it("(i) no literal DSN or password appears in any emitted file, the report or the output", async () => {
    const { run, out } = await init([lookup({ capabilityId: "reporting.get-position-i" })]);
    const url = new URL(db.dsn);
    const text = `${run.stdout}\n${run.stderr}\n${everything(out)}`;
    expect(text).not.toContain(decodeURIComponent(url.password));
    expect(text).not.toContain(url.password);
    expect(text).not.toMatch(/postgres(ql)?:\/\//);
    expect(readFileSync(join(out, "bindings", "reporting.get-position-i.binding.yaml"), "utf8")).toContain('dsn: "${REPORTING_DSN}"');
  }, 180_000);

  it("(d) without --probe: a compiling manifest, no contract, no fixture, exit 0 — and nothing was read from a tenant table", async () => {
    const { run, out } = await init([lookup(), { ...list(), probe: undefined }], { probe: false });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(existsSync(join(out, "fixtures"))).toBe(false);
    expect(everything(out)).not.toMatch(/^\s*contract:/m);
    expect((await runCli(["apply", out], {})).code).toBe(0);
  }, 180_000);

  it("(d) with --probe but no negative identity: not an error, no contract, and the report says why", async () => {
    const { run, out } = await init([lookup()], { identities: { principal: "acme-analyst" } });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(existsSync(join(out, "fixtures"))).toBe(false);
    expect(run.stdout).toMatch(/negativePrincipal/);
    expect((await runCli(["apply", out], {})).code).toBe(0);
  }, 180_000);

  it("(e) a negative principal missing from the identity map is a refusal at the gate: no contract", async () => {
    const { run, out } = await init([lookup()], { identities: { principal: "acme-analyst", negativePrincipal: "initech-analyst" } });
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(run.stdout).toMatch(/initech-analyst/);
    expect(existsSync(join(out, "fixtures"))).toBe(false);
    expect(everything(out)).not.toMatch(/^\s*contract:/m);
  }, 180_000);

  it("(f) a list never gets a contract, and the report says a list has no isolation test", async () => {
    const { run, out } = await init([list()]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(existsSync(join(out, "fixtures"))).toBe(false);
    expect(everything(out)).not.toMatch(/^\s*contract:/m);
    expect(run.stdout).toMatch(/list-has-no-isolation-test/);
    expect(readFileSync(join(out, "bindings", "reporting.list-positions.binding.yaml"), "utf8")).toContain("LIMIT 100");
  }, 180_000);

  it("(g) a lookup whose positive leg returns zero rows records no contract", async () => {
    const { run, out } = await init([lookup({ sampleInput: { id: 99 } })]);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    expect(existsSync(join(out, "fixtures"))).toBe(false);
    expect(everything(out)).not.toMatch(/^\s*contract:/m);
    expect(run.stdout).toMatch(/non-empty/);
  }, 180_000);

  it("(g) nor does a sample key that belongs to the negative principal's tenant", async () => {
    // id 3 is globex's: the positive leg (acme) sees nothing.
    const { out } = await init([lookup({ sampleInput: { id: 3 } })]);
    expect(existsSync(join(out, "fixtures"))).toBe(false);
  }, 180_000);

  it("the report names the candidates the role can see and nothing else (the runtime role has no grant on app.positions)", async () => {
    const { run, out } = await init([{ operation: "SELECT zzz.zzz", keep: true, capabilityId: "reporting.nope", effect: "read" }, lookup()], { probe: false });
    const text = `${run.stdout}\n${everything(out)}`;
    expect(text).toContain("SELECT app.positions_v");
    expect(text).not.toMatch(/internal_cost|app\.positions(?!_v)/);
  }, 180_000);
});

describePostgres("archstone init --source postgres — what the runtime role may read, and the roles it refuses", () => {
  let fx: PgFixture;
  let work: string;
  let n = 0;

  async function init(decisions: Decision[], dsnVar: string, extra: string[] = []) {
    n += 1;
    const out = join(work, `out-${n}`);
    const record = join(work, `decisions-${n}.json`);
    writeFileSync(record, JSON.stringify({ version: "0", company: { id: "acme" }, decisions }));
    const run = await runCli(
      ["init", "--source", "postgres", "--dsn-env", "PG_DSN", "--out", out, "--decisions", record, "--non-interactive", ...extra],
      { PG_DSN: fx.env[dsnVar]! },
    );
    return { run, out };
  }

  beforeAll(async () => {
    work = mkdtempSync(join(tmpdir(), "archstone-init-pg2-"));
    fx = await createPgFixture();
    const role = decodeURIComponent(new URL(fx.env[DSN_VARS.runtime]!).username);
    await fx.admin(`
      CREATE SCHEMA sealed;
      CREATE TABLE sealed.vault (id int4 PRIMARY KEY, token text);
      GRANT SELECT ON sealed.vault TO ${role};
      CREATE TABLE app.ledger (id int4 PRIMARY KEY, memo text NOT NULL, hidden_notes text);
      GRANT SELECT (id, memo) ON app.ledger TO ${role};
      CREATE TABLE app.denied (id int4, secret_figure int4);
      CREATE TABLE app.kinds (
        id int4 PRIMARY KEY, name text NOT NULL, active boolean NOT NULL, doc jsonb, raw json, tags text[], opened timestamptz, note text
      );
      INSERT INTO app.kinds VALUES (1, 'one', true, '{"a":1}', '{"b":2}', '{x,y}', '2026-10-01T10:00:00Z', NULL);
      GRANT SELECT ON app.kinds TO ${role};
    `);
  }, 60_000);

  afterAll(async () => {
    await fx?.teardown();
    rmSync(work, { recursive: true, force: true });
  }, 60_000);

  it("(b) proposes nothing the role cannot SELECT: not a name, not a column, not in the report", async () => {
    // Keys nobody could have typed from the output; the unknown-candidate detail lists what IS proposed.
    const { run, out } = await init([{ operation: "SELECT zzz.zzz", keep: true, capabilityId: "acme.nope", effect: "read" }, { operation: "SELECT app.ledger", keep: true, capabilityId: "acme.list-ledger", effect: "read", resourceName: "Entry" }], DSN_VARS.runtime);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const text = `${run.stdout}\n${run.stderr}\n${everything(out)}`;
    expect(text).not.toMatch(/sealed|vault|token|hidden_notes|denied|secret_figure|internal_cost/);
    expect(text).not.toMatch(/app\.positions(?!_v)/);
    // The column-level grant is honoured: only the granted columns are selected.
    expect(readFileSync(join(out, "bindings", "acme.list-ledger.binding.yaml"), "utf8")).toContain('SELECT "id", "memo"\n');
    // And the candidates it may read ARE offered.
    expect(text).toContain("SELECT app.kinds");
  }, 180_000);

  it("(h) boolean is a boolean; json, jsonb and array columns are left out with column-type-not-expressible, the capability still emitted", async () => {
    const { run, out } = await init([{ operation: "SELECT app.kinds", keep: true, capabilityId: "acme.list-kinds", effect: "read", resourceName: "Kind" }], DSN_VARS.runtime);
    expect(run.code, run.stdout + run.stderr).toBe(0);
    const binding = readFileSync(join(out, "bindings", "acme.list-kinds.binding.yaml"), "utf8");
    expect(binding).toContain('SELECT "id", "name", "active", "opened", "note"\n');
    expect(binding).not.toMatch(/"doc"|"raw"|"tags"/);
    const resource = readFileSync(join(out, "acme.Kind.resource.yaml"), "utf8");
    expect(resource).toMatch(/active:\n\s+type: boolean/);
    expect(resource).toMatch(/note:\n\s+type: string\n\s+required: false/);
    expect(run.stdout).toMatch(/column-type-not-expressible \[field\] \(3\)/);
    expect((await runCli(["apply", out], {})).code).toBe(0);
  }, 180_000);

  const refused: Array<[string, keyof typeof DSN_VARS, RegExp]> = [
    ["a superuser", "superuser", /rolsuper = true; the runtime role must not be a superuser — see the topology guide/],
    ["a role with BYPASSRLS", "bypassrls", /rolbypassrls = true; the runtime role must not bypass row-level security — see the topology guide/],
    ["a role that owns a relation it can read", "ownerWithGrant", /owns app\.owned_by_owner, which it also holds a grant on — the runtime role must not own any relation it can query — see the topology guide/],
  ];
  for (const [name, key, message] of refused) {
    it(`(c) ${name} is refused with D-9's message, exit non-zero, nothing written`, async () => {
      if (!fx.created[key]) return;
      const { run, out } = await init([{ operation: "SELECT app.kinds", keep: true, capabilityId: "acme.list-kinds", effect: "read", resourceName: "Kind" }], DSN_VARS[key]);
      expect(run.code).not.toBe(0);
      expect(run.stderr).toMatch(message);
      expect(existsSync(out)).toBe(false);
      expect(run.stdout).not.toMatch(/Wrote/);
    }, 180_000);
  }
});
