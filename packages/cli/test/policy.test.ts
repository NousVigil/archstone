import { describe, it, expect } from "vitest";
import { resolve, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";

// #43 end to end through the real CLI: authoring diagnostics (SF-6) and the artifact strip rule
// (BR-8/ADD-43 D-9). Spawning the CLI is deliberate — the exit code IS the acceptance criterion
// for "a malformed policy fails `archstone apply`" (#43 DoD item 1), and only a subprocess sees it.

// #134: every `it` here spawns a fresh `tsx` process (transpile + run the whole CLI),
// which is slow to cold-start under real CPU load — sighting #2 on #134 was this file
// timing out at ~5032ms, a hair past vitest's 5000ms default, only under a loaded
// machine, never in isolation. Explicit generous timeouts below (already the convention
// for the child-process-spawning tests in serve-http.test.ts and verify.test.ts) remove
// that race without loosening any assertion.
const execFileAsync = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const cli = resolve(root, "packages/cli/src/index.ts");
const bank = resolve(root, "examples/manifests/bank");

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

async function run(args: string[], cwd = root): Promise<Run> {
  try {
    const { stdout, stderr } = await execFileAsync(tsx, [cli, ...args], { cwd });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string };
    return { code: e.code ?? 1, stdout: e.stdout ?? "", stderr: e.stderr ?? "" };
  }
}

function manifest(policy?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-cli-policy-"));
  writeFileSync(
    join(dir, "capabilities.yaml"),
    "company:\n  id: demo\ncapabilities:\n  - demo.read\nproviders:\n  - acme\n",
  );
  writeFileSync(
    join(dir, "demo.read.capability.yaml"),
    "capability:\n  id: demo.read\n  description: Read a thing.\n  effect: read\n  provider: acme\n",
  );
  mkdirSync(join(dir, "bindings"));
  writeFileSync(
    join(dir, "bindings", "demo.read.binding.yaml"),
    'binding:\n  capabilityId: demo.read\n  connector:\n    type: rest\n    rest:\n      baseUrl: "https://backend.example"\n      method: GET\n      path: /thing\n',
  );
  if (policy) writeFileSync(join(dir, "demo.policy.yaml"), policy);
  return dir;
}

function policyDoc(spec: string, metadata = "  scope: capability\n  capabilityId: demo.read\n"): string {
  return `apiVersion: archstone/v1\nkind: Policy\nmetadata:\n  id: demo-policy\n  name: Demo policy\n${metadata}spec:\n${spec}`;
}

const ALLOW_ALICE = policyDoc('  allow:\n    - "user:alice"\n');

describe("archstone apply — policy documents (SF-1/SF-6)", () => {
  it("exits 0 and reports a well-formed policy that resolves (S-US1.1)", async () => {
    const dir = manifest(ALLOW_ALICE);
    try {
      const r = await run(["apply", dir]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("shapes valid");
      expect(r.stdout).toContain("0 error(s)");
      // "…reports the policy as loaded and resolved onto demo.read" — a policy the author
      // believes is enforced must never be invisible in apply's output.
      expect(r.stdout).toContain("1 policy document(s)");
      expect(r.stdout).toMatch(/demo-policy\s+→ capability demo\.read/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("exits 1 and prints a shape issue naming a malformed policy file (S-US1.2)", async () => {
    const dir = manifest(policyDoc("  bogusKey: 1\n"));
    try {
      const r = await run(["apply", dir]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("demo.policy.yaml");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("exits 1 with a semantic error for an unresolvable scope, naming file and policy id", async () => {
    const dir = manifest(policyDoc('  allow:\n    - "user:alice"\n', "  scope: capability\n  capabilityId: demo.nope\n"));
    try {
      const r = await run(["apply", dir]);
      expect(r.code).toBe(1);
      expect(r.stdout).toContain("demo.nope");
      expect(r.stdout).toContain("demo-policy");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("exits 1 on an incomplete spec.rateLimit and on non-empty spec.constraints (S-US4.1/S-US4.2)", async () => {
    // #45: `spec.rateLimit` is enforced now, but `maxInvocations`/`windowSeconds` are still
    // required TOGETHER — a document declaring only one is refused at authoring time exactly
    // like an unsupported key would be. `constraints` remains refused outright (unchanged).
    for (const spec of ["  rateLimit:\n    maxInvocations: 5\n", "  constraints:\n    maxRefundAmount: 500\n"]) {
      const dir = manifest(policyDoc(spec));
      try {
        expect((await run(["apply", dir])).code).toBe(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30000);

  it("exits 0 on a COMPLETE spec.rateLimit (#45)", async () => {
    const dir = manifest(policyDoc("  rateLimit:\n    maxInvocations: 5\n    windowSeconds: 60\n"));
    try {
      const r = await run(["apply", dir]);
      expect(r.code).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("prints unenforced-token warnings without blocking, on a real example manifest (S-US7.1/7.2)", async () => {
    const r = await run(["apply", bank]);
    expect(r.code).toBe(0); // warnings never block
    // ADD-311: for an `irreversible` capability the per-token line is the lint's
    // `irreversible-unenforced-policy` wording ("this version does not enforce"), which replaces
    // — never duplicates — the general one ("is not enforced in this version"). Each
    // (capability, token) pair is still reported exactly once.
    const unenforced = r.stdout
      .split("\n")
      .filter((l) => l.includes("not enforced in this version") || l.includes("this version does not enforce"));
    expect(unenforced).toHaveLength(4);
    expect(unenforced.filter((l) => l.includes("not enforced in this version"))).toHaveLength(2);
    expect(unenforced.filter((l) => l.includes("policies:[tenant-scoped]"))).toHaveLength(2);
    expect(unenforced.filter((l) => l.includes("policies:[human-approval]"))).toHaveLength(1);
    expect(unenforced.filter((l) => l.includes("policies:[rate-limited]"))).toHaveLength(1);
    // `authenticated` IS enforced now, so it must never appear in this warning class. (It does
    // still appear in the pre-existing ADD-32 "no caller placeholder" advisory — a different
    // warning, which is why this filters by the unenforced-token wording rather than by token.)
    expect(unenforced.some((l) => l.includes("policies:[authenticated]"))).toBe(false);
  }, 20000);
});

describe("archstone build — the strip rule (BR-8 / ADD-43 D-9)", () => {
  // `contract` is stripped because the invocation path cannot use it. `policyRules` is
  // invocation-path data: stripping it ships an unpoliced embedded SDK beside a policed MCP
  // surface — silently, since `fromIR` validates only `version` and trusts the rest.
  it("keeps policyRules in the artifact while still stripping contract", async () => {
    const dir = manifest(ALLOW_ALICE);
    const out = join(dir, "archstone.ir.json");
    try {
      expect((await run(["build", dir, "--out", out])).code).toBe(0);
      const ir = JSON.parse(readFileSync(out, "utf8")) as { version: string; tools: Record<string, unknown>[] };
      expect(ir.version).toBe("0"); // S-US8.3 — no version bump (ADD-43 D-10)
      expect(ir.tools[0].policyRules).toEqual([{ id: "demo-policy", allow: ["user:alice"] }]);
      expect(ir.tools[0]).not.toHaveProperty("contract");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("refuses to build a manifest whose spec.rateLimit is incomplete (#45)", async () => {
    const dir = manifest(policyDoc("  rateLimit:\n    maxInvocations: 5\n"));
    try {
      expect((await run(["build", dir, "--out", join(dir, "ir.json")])).code).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 20000);

  it("leaves every shipped example manifest's artifact free of policyRules (S-US8.2)", async () => {
    for (const name of ["booking", "bank", "tourism"]) {
      const dir = mkdtempSync(join(tmpdir(), "archstone-cli-nopolicy-"));
      const out = join(dir, "ir.json");
      try {
        expect((await run(["build", resolve(root, "examples/manifests", name), "--out", out])).code).toBe(0);
        const ir = JSON.parse(readFileSync(out, "utf8")) as { tools: Record<string, unknown>[] };
        expect(ir.tools.every((t) => !("policyRules" in t))).toBe(true);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    }
  }, 30000);
});
