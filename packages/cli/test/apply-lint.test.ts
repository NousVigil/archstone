import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";

// `archstone apply` and the irreversible checklist (ADD-311), end to end through the real CLI.
// Flawed manifests are temp copies of examples/manifests/bank, edited here; nothing flawed is
// committed under examples/manifests/. The unchanged bank output is pinned by
// apply-exposure.test.ts against fixtures/reports/apply-bank.txt.

const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");

interface Run {
  stdout: string;
  stderr: string;
  code: number;
}
async function apply(dir: string, ...flags: string[]): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(tsx, [cli, "apply", dir, ...flags], { cwd: root });
    return { stdout, stderr, code: 0 };
  } catch (e) {
    const err = e as { stdout: string; stderr: string; code: number };
    return { stdout: err.stdout, stderr: err.stderr, code: err.code };
  }
}

const TRANSFER = "banking.initiate-transfer";
const TRANSFER_FILE = "banking.initiate-transfer.capability.yaml";
const FAILURES_BLOCK = / {2}failures:\n(?: {4}.*\n)+\n/;
const semantic = (out: string) => out.split("\n").find((l) => l.startsWith("  semantic"));
const lines = (out: string, needle: string) => out.split("\n").filter((l) => l.includes(needle));

let tmp: string;
let n = 0;
/** A copy of bank with `edit` applied to banking.initiate-transfer's capability file. */
function bankCopy(edit: (yaml: string) => string): string {
  const dir = join(tmp, `bank-${n++}`);
  cpSync(resolve(root, "examples/manifests/bank"), dir, { recursive: true });
  const file = join(dir, TRANSFER_FILE);
  writeFileSync(file, edit(readFileSync(file, "utf8")));
  return dir;
}
const withoutFailures = (y: string) => {
  expect(y).toMatch(FAILURES_BLOCK);
  return y.replace(FAILURES_BLOCK, "");
};
const withoutAuthenticated = (y: string) => {
  expect(y).toContain("    - authenticated\n");
  return y.replace("    - authenticated\n", "");
};

const NO_FAILURES =
  `    ⚠ capability '${TRANSFER}' is irreversible and declares no failures. When it fails, an agent can say only that it failed, not why, and must not retry. Name the business outcomes that stop it under failures: (for example insufficient-funds, already-refunded).`;
const UNAUTHENTICATED =
  `    ⚠ capability '${TRANSFER}' is irreversible and does not declare policies:[authenticated]. Any caller that can reach this server can invoke it. If that is intended, nothing to change; this line stays so the decision stays visible. Otherwise add authenticated to policies:.`;
const HUMAN_APPROVAL =
  `    ⚠ capability '${TRANSFER}' is irreversible and declares policies:[human-approval], which this version does not enforce: no approval mechanism exists. An agent can run it without anyone approving. Put the approval step in the provider, or do not serve this capability to an agent unattended.`;
const RATE_LIMITED =
  `    ⚠ capability '${TRANSFER}' is irreversible and declares policies:[rate-limited], which this version does not enforce: enforcing it needs invocation counting and therefore state — tracked as issue #45. An agent can run it as often as it is called. Attach a Policy document with spec.rateLimit, which is enforced, or limit it in the provider.`;
const BR40_PREFIX = `capability '${TRANSFER}' (${TRANSFER_FILE}) declares policies:[`;

beforeAll(() => {
  tmp = mkdtempSync(join(tmpdir(), "archstone-apply-lint-"));
});
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

describe("apply — bank, as shipped (S-US1.1, S-US2.2, S-US4.x)", () => {
  it("prints the two unenforced-policy lines last, counted, with no new heading", async () => {
    const r = await apply("examples/manifests/bank");
    expect(r.code).toBe(0);
    expect(semantic(r.stdout)).toBe("  semantic   0 error(s), 7 warning(s)");
    const block = r.stdout.split("\n").filter((l) => l.startsWith("    ⚠"));
    expect(block.slice(-2)).toEqual([HUMAN_APPROVAL, RATE_LIMITED]);
    expect(block).toHaveLength(7);
    expect(r.stdout).not.toContain("declares no failures");
  }, 20000);

  it("no longer prints BR-40's line for the irreversible capability, and keeps it for the reads", async () => {
    const { stdout } = await apply("examples/manifests/bank");
    expect(stdout).not.toContain(BR40_PREFIX);
    expect(lines(stdout, "declares policies:[tenant-scoped], which is not enforced in this version")).toHaveLength(2);
  }, 20000);

  it("--json alone is the same human report (S-US5.4)", async () => {
    expect((await apply("examples/manifests/bank", "--json")).stdout).toBe((await apply("examples/manifests/bank")).stdout);
  }, 20000);
});

describe("apply — rows 1 and 4 (S-US1.2, S-US2.1, S-US3.1, S-US3.3, S-US5.3)", () => {
  it("removing failures adds the no-failures line, counted, exit 0", async () => {
    const r = await apply(bankCopy(withoutFailures));
    expect(lines(r.stdout, "declares no failures.")).toEqual([NO_FAILURES]);
    expect(semantic(r.stdout)).toBe("  semantic   0 error(s), 8 warning(s)");
    expect(r.code).toBe(0);
  }, 20000);

  it("removing authenticated adds the unauthenticated line; the caller-credential warning leaves, so the count holds", async () => {
    const r = await apply(bankCopy(withoutAuthenticated));
    expect(lines(r.stdout, "does not declare policies:[authenticated]")).toEqual([UNAUTHENTICATED]);
    expect(r.stdout).not.toContain("never references a caller credential");
    expect(semantic(r.stdout)).toBe("  semantic   0 error(s), 7 warning(s)");
    expect(r.code).toBe(0);
  }, 20000);

  it("the line stays on every run and with --json; there is nothing to silence it", async () => {
    const dir = bankCopy(withoutAuthenticated);
    for (const flags of [[], [], ["--json"], ["--exposure"]]) {
      expect(lines((await apply(dir, ...flags)).stdout, "does not declare policies:[authenticated]")).toEqual([UNAUTHENTICATED]);
    }
  }, 40000);

  it("both removed: four lint lines, in order, after every other warning; exit 0", async () => {
    const r = await apply(bankCopy((y) => withoutAuthenticated(withoutFailures(y))));
    const block = r.stdout.split("\n").filter((l) => l.startsWith("    ⚠"));
    expect(block.slice(-4)).toEqual([NO_FAILURES, UNAUTHENTICATED, HUMAN_APPROVAL, RATE_LIMITED]);
    expect(semantic(r.stdout)).toBe("  semantic   0 error(s), 8 warning(s)");
    expect(r.code).toBe(0);
  }, 20000);
});

describe("apply — fallbacks to BR-40 (S-US4.7, S-US4.8)", () => {
  it("a retired irreversible capability is not linted and keeps BR-40's lines", async () => {
    const r = await apply(bankCopy((y) => withoutFailures(y).replace("lifecycle: beta", "lifecycle: retired")));
    expect(r.stdout).not.toContain("is irreversible and");
    expect(lines(r.stdout, BR40_PREFIX)).toHaveLength(2);
    expect(r.code).toBe(0);
  }, 20000);

  it("an attached spec.rateLimit keeps BR-40's rate-limited line; human-approval is still replaced", async () => {
    const dir = bankCopy((y) => y);
    writeFileSync(
      join(dir, "transfer-rate.policy.yaml"),
      `apiVersion: archstone/v1\nkind: Policy\nmetadata:\n  id: transfer-rate\n  name: transfer-rate\n  scope: capability\n  capabilityId: ${TRANSFER}\nspec:\n  rateLimit:\n    maxInvocations: 10\n    windowSeconds: 60\n`,
    );
    const r = await apply(dir);
    expect(r.stdout).not.toContain("which this version does not enforce: enforcing it needs");
    expect(lines(r.stdout, `${BR40_PREFIX}rate-limited], which is not enforced in this version`)).toHaveLength(1);
    expect(lines(r.stdout, "which this version does not enforce: no approval mechanism exists")).toHaveLength(1);
    expect(lines(r.stdout, `${BR40_PREFIX}human-approval]`)).toHaveLength(0);
    expect(r.code).toBe(0);
  }, 20000);
});

describe("apply — an invalid manifest gets no lint (S-US1.3)", () => {
  it("prints BR-40's lines, no lint line, and exits 1", async () => {
    const dir = bankCopy(withoutFailures);
    const list = join(dir, "banking.list-accounts.capability.yaml");
    writeFileSync(list, readFileSync(list, "utf8").replace("provider: core-banking", "provider: nowhere"));
    const r = await apply(dir);
    expect(r.code).toBe(1);
    expect(r.stdout).not.toContain("is irreversible and");
    expect(lines(r.stdout, BR40_PREFIX)).toHaveLength(2);
    const warnings = r.stdout.split("\n").filter((l) => l.startsWith("    ⚠"));
    expect(semantic(r.stdout)).toMatch(new RegExp(`, ${warnings.length} warning\\(s\\)$`));
  }, 20000);
});
