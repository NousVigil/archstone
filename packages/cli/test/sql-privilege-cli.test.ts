import { describe, it, expect } from "vitest";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";

// #133 end to end: spawn the real CLI against a `sql`-bound manifest whose DSN points at a closed
// local port. The eager D-9 check reaches no verdict (ECONNREFUSED, immediate and deterministic),
// so every surface must still refuse to start (exit 1) — and must not call the connection
// over-privileged, because nothing was learned about it.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const manifest = resolve(root, "packages/cli/test/fixtures/sql-unreachable");

/** Port 1 on loopback: nothing listens there, so the connect is refused at once. The password
 *  is never in any output; the host is only in the operator's own `archstone:` diagnostic line. */
const UNREACHABLE = "postgres://runtime:s3cret@127.0.0.1:1/app";

function run(args: string[]): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((done) => {
    // `timeout` only bounds a regression where the check passed and the server kept running.
    const child = execFile(tsx, [cli, ...args], { cwd: root, env: { ...process.env, DATABASE_URL: UNREACHABLE }, timeout: 60_000 }, (_err, stdout, stderr) => {
      done({ code: child.exitCode, stdout, stderr });
    });
    child.stdin?.end();
  });
}

/** The refusal itself — the surface's lines, not the operator's scrubbed `archstone:` driver log. */
function refusalLines(stderr: string): string[] {
  return stderr.split("\n").filter((l) => l.length > 0 && !l.startsWith("archstone: "));
}

function expectIncompleteRefusal(stderr: string, prefix: string) {
  expect(stderr).toContain(`${prefix} — sql connection privilege check(s) could not complete:`);
  expect(stderr).toContain("  - pool checkout failed while checking connection privileges (ECONNREFUSED)");
  expect(stderr).not.toContain("over-privileged");
  expect(stderr).not.toContain("s3cret");
  for (const line of refusalLines(stderr)) expect(line).not.toContain("127.0.0.1");
}

describe("CLI startup with an unreachable sql database (#133)", () => {
  it("verify exits 1 and says the check could not complete, never over-privileged", async () => {
    const { code, stderr } = await run(["verify", manifest]);
    expect(code).toBe(1);
    expectIncompleteRefusal(stderr, `archstone verify ${manifest}: refusing`);
  }, 90_000);

  it("verify --json reports sql_privilege_check_incomplete, with the refused/incomplete split and the flat errors list", async () => {
    const { code, stdout, stderr } = await run(["verify", manifest, "--json"]);
    expect(code).toBe(1);
    expect(JSON.parse(stdout)).toEqual({
      error: "sql_privilege_check_incomplete",
      errors: ["pool checkout failed while checking connection privileges (ECONNREFUSED)"],
      refused: [],
      incomplete: ["pool checkout failed while checking connection privileges (ECONNREFUSED)"],
    });
    expect(stdout).not.toContain("127.0.0.1");
    expect(stderr).not.toContain("over-privileged");
  }, 90_000);

  it("serve (stdio, sql configured) exits 1 before the transport connects, with the same message", async () => {
    const { code, stdout, stderr } = await run(["serve", manifest, "--sql-guc-prefix", "app."]);
    expect(code).toBe(1);
    expect(stdout).toBe(""); // stdout is MCP's; nothing reached it
    expectIncompleteRefusal(stderr, "archstone serve: refusing to start");
  }, 90_000);

  it("serve --http exits 1 before listening, with the same message", async () => {
    const { code, stderr } = await run(["serve", "--http", manifest, "--port", "0", "--token", "t"]);
    expect(code).toBe(1);
    expectIncompleteRefusal(stderr, "archstone serve --http: refusing to start");
  }, 90_000);
});
