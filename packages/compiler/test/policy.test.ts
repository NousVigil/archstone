import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "@archstone/schema";
import { validateSemantics, type Diagnostic } from "../src/validate";
import { compile } from "../src/compile";

// #43 (ADD-43 §8.3/§8.4) — policy resolution + every new semantic diagnostic + neutral lowering.
// The compiler decides WHICH policies attach to WHICH capabilities; it never decides whether a
// call is permitted (that is emitter-support's evaluator, tested separately).

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

const codes = (d: Diagnostic[]) => d.map((x) => x.code);
const errors = (d: Diagnostic[]) => d.filter((x) => x.severity === "error");
const warnings = (d: Diagnostic[]) => d.filter((x) => x.severity === "warning");

function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-policy-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

/** capabilities.yaml + two capabilities on two different providers. */
const BASE: Record<string, string> = {
  "capabilities.yaml":
    "company:\n  id: acme\ncapabilities:\n  - bank.list\n  - bank.pay\n  - shop.browse\nproviders:\n  - core\n  - store\n",
  "bank.list.capability.yaml": "capability:\n  id: bank.list\n  description: list\n  effect: read\n  provider: core\n",
  "bank.pay.capability.yaml": "capability:\n  id: bank.pay\n  description: pay\n  effect: write\n  provider: core\n",
  "shop.browse.capability.yaml": "capability:\n  id: shop.browse\n  description: browse\n  effect: read\n  provider: store\n",
};

/** A policy document, assembled from parts so each test varies exactly one thing. */
function policy(id: string, metadata: string, spec: string): string {
  return `apiVersion: archstone/v1\nkind: Policy\nmetadata:\n  id: ${id}\n  name: ${id}\n${metadata}spec:\n${spec}`;
}

function diagnose(files: Record<string, string>): Diagnostic[] {
  const dir = fixture({ ...BASE, ...files });
  try {
    return validateSemantics(load(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function compiled(files: Record<string, string>) {
  const dir = fixture({ ...BASE, ...files });
  try {
    return compile(load(dir));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("policy resolution (BR-5, S-US1.3/1.4/1.5)", () => {
  it("resolves a capability-scoped policy onto exactly that capability", () => {
    const ir = compiled({
      "p.policy.yaml": policy("only-alice", "  scope: capability\n  capabilityId: bank.list\n", '  allow:\n    - "user:alice"\n'),
    });
    expect(ir.tools.find((t) => t.id === "bank.list")?.policyRules).toEqual([{ id: "only-alice", allow: ["user:alice"] }]);
    expect(ir.tools.find((t) => t.id === "bank.pay")?.policyRules).toBeUndefined();
  });

  // S-US1.5 — a provider-scoped policy applies to every capability of that provider, and to no
  // capability of another provider.
  it("resolves a provider-scoped policy onto every capability of that provider only", () => {
    const ir = compiled({
      "p.policy.yaml": policy("core-wide", "  scope: provider\n  provider: core\n", '  allow:\n    - "user:alice"\n'),
    });
    expect(ir.tools.find((t) => t.id === "bank.list")?.policyRules).toHaveLength(1);
    expect(ir.tools.find((t) => t.id === "bank.pay")?.policyRules).toHaveLength(1);
    expect(ir.tools.find((t) => t.id === "shop.browse")?.policyRules).toBeUndefined();
  });

  it("attaches BOTH a provider-scoped and a capability-scoped policy to one capability (BR-6)", () => {
    const ir = compiled({
      "a.policy.yaml": policy("core-wide", "  scope: provider\n  provider: core\n", '  allow:\n    - "user:alice"\n    - "user:bob"\n'),
      "b.policy.yaml": policy("list-only", "  scope: capability\n  capabilityId: bank.list\n", '  allow:\n    - "user:bob"\n'),
    });
    expect(ir.tools.find((t) => t.id === "bank.list")?.policyRules?.map((r) => r.id).sort()).toEqual([
      "core-wide",
      "list-only",
    ]);
  });

  it("refuses a policy with no scope — it would apply to nothing (S-US1.3)", () => {
    const d = diagnose({ "p.policy.yaml": policy("scopeless", "", '  allow:\n    - "user:alice"\n') });
    const err = errors(d).find((e) => e.code === "policy-scope-unresolvable");
    expect(err).toBeDefined();
    expect(err!.message).toContain("scopeless");
    expect(err!.message).toContain("p.policy.yaml");
  });

  it("refuses a capability-scoped policy naming an unknown capability (S-US1.4)", () => {
    const d = diagnose({
      "p.policy.yaml": policy("ghost", "  scope: capability\n  capabilityId: bank.does-not-exist\n", '  allow:\n    - "user:alice"\n'),
    });
    const err = errors(d).find((e) => e.code === "policy-scope-unresolvable");
    expect(err?.message).toContain("bank.does-not-exist");
  });

  it("refuses scope: capability with no capabilityId, and scope: provider with no provider", () => {
    expect(codes(errors(diagnose({ "p.policy.yaml": policy("a", "  scope: capability\n", '  allow:\n    - "x"\n') })))).toContain(
      "policy-scope-unresolvable",
    );
    expect(codes(errors(diagnose({ "p.policy.yaml": policy("a", "  scope: provider\n", '  allow:\n    - "x"\n') })))).toContain(
      "policy-scope-unresolvable",
    );
  });

  it("refuses a provider-scoped policy naming a provider not in capabilities.yaml", () => {
    const d = diagnose({ "p.policy.yaml": policy("ghost", "  scope: provider\n  provider: nowhere\n", '  allow:\n    - "x"\n') });
    expect(errors(d).find((e) => e.code === "policy-scope-unresolvable")?.message).toContain("nowhere");
  });

  // EC-3 — a redundant `provider` on a capability-scoped policy is ignored when it agrees, and
  // is an ERROR when it disagrees rather than a silent precedence rule.
  it("ignores a redundant, agreeing provider but refuses a disagreeing one (EC-3)", () => {
    const agreeing = diagnose({
      "p.policy.yaml": policy("ok", "  scope: capability\n  capabilityId: bank.list\n  provider: core\n", '  allow:\n    - "x"\n'),
    });
    expect(codes(errors(agreeing))).not.toContain("policy-scope-conflict");

    const disagreeing = diagnose({
      "p.policy.yaml": policy("bad", "  scope: capability\n  capabilityId: bank.list\n  provider: store\n", '  allow:\n    - "x"\n'),
    });
    expect(codes(errors(disagreeing))).toContain("policy-scope-conflict");
  });

  it("refuses two policy documents sharing a metadata.id, naming both files (S-US1.7)", () => {
    const spec = '  allow:\n    - "user:alice"\n';
    const meta = "  scope: capability\n  capabilityId: bank.list\n";
    const d = diagnose({ "a.policy.yaml": policy("same-id", meta, spec), "b.policy.yaml": policy("same-id", meta, spec) });
    const err = errors(d).find((e) => e.code === "duplicate-policy");
    expect(err?.message).toContain("a.policy.yaml");
    expect(err?.message).toContain("b.policy.yaml");
  });
});

describe("pattern grammar refusals (BR-10/BR-11, S-US6.3/6.4/6.5)", () => {
  const cap = "  scope: capability\n  capabilityId: bank.list\n";

  it("refuses a '*' in an allow entry, naming file, policy and entry (S-US6.3)", () => {
    const d = diagnose({ "p.policy.yaml": policy("wild", cap, '  allow:\n    - "role:finance-*"\n') });
    const err = errors(d).find((e) => e.code === "policy-wildcard-entry");
    expect(err).toBeDefined();
    expect(err!.message).toContain("p.policy.yaml");
    expect(err!.message).toContain("wild");
    expect(err!.message).toContain("role:finance-*");
    expect(err!.message).toMatch(/not a wildcard/);
  });

  // S-US6.4 — the fail-open this rule exists to prevent: under exact matching `deny: ["*"]`
  // reads to a human reviewer as "deny everyone" and would in fact deny NO ONE.
  it("refuses a bare '*' in deny rather than compiling a rule that denies no one (S-US6.4)", () => {
    const d = diagnose({ "p.policy.yaml": policy("wild", cap, '  deny:\n    - "*"\n') });
    expect(codes(errors(d))).toContain("policy-wildcard-entry");
  });

  it("refuses an empty-string entry (S-US6.5)", () => {
    const d = diagnose({ "p.policy.yaml": policy("empty", cap, '  allow:\n    - ""\n') });
    expect(codes(errors(d))).toContain("policy-empty-entry");
  });
});

describe("fail-closed at authoring time (BR-22/BR-23, S-US4.1/4.2/4.3)", () => {
  const cap = "  scope: capability\n  capabilityId: bank.list\n";

  // #45 / ADD-45 D-1: rateLimit is now ENFORCED (the evaluation-point half lives in
  // emitter-support's evaluateRateLimit; the compiler's job is shape+resolution only, same as
  // allow/deny). A complete `{ maxInvocations, windowSeconds }` compiles cleanly and is lowered
  // into `policyRules` verbatim.
  it("accepts a complete spec.rateLimit and lowers it verbatim (#45)", () => {
    const files = {
      "p.policy.yaml": policy("rl", cap, "  rateLimit:\n    maxInvocations: 5\n    windowSeconds: 60\n"),
    };
    expect(errors(diagnose(files))).toHaveLength(0);
    const rules = compiled(files).tools.find((t) => t.id === "bank.list")?.policyRules;
    expect(rules).toEqual([{ id: "rl", rateLimit: { maxInvocations: 5, windowSeconds: 60 } }]);
  });

  it("refuses spec.rateLimit missing windowSeconds, naming the file (S-US4.1)", () => {
    const d = diagnose({ "p.policy.yaml": policy("rl", cap, "  rateLimit:\n    maxInvocations: 5\n") });
    const err = errors(d).find((e) => e.code === "policy-ratelimit-invalid");
    expect(err?.message).toContain("p.policy.yaml");
  });

  it("refuses spec.rateLimit missing maxInvocations, naming the file (S-US4.1)", () => {
    const d = diagnose({ "p.policy.yaml": policy("rl", cap, "  rateLimit:\n    windowSeconds: 60\n") });
    const err = errors(d).find((e) => e.code === "policy-ratelimit-invalid");
    expect(err?.message).toContain("p.policy.yaml");
  });

  // A non-positive maxInvocations/windowSeconds is refused at the SHAPE layer
  // (`policy.schema.json`'s `minimum: 1`) before this semantic pass ever runs — `load()`
  // rejects the document outright, so `validateSemantics` never sees it as a `PolicyDoc` at
  // all. `policy-ratelimit-invalid` exists for the case shape validation permits (neither key
  // is individually required) but this increment does not: one of the pair missing.

  it("refuses a non-empty spec.constraints, naming the file (S-US4.2)", () => {
    const d = diagnose({ "p.policy.yaml": policy("c", cap, "  constraints:\n    maxRefundAmount: 500\n") });
    const err = errors(d).find((e) => e.code === "policy-constraints-unsupported");
    expect(err?.message).toContain("p.policy.yaml");
  });

  // S-US4.3 (ADD-43 D-3) — the mechanism that makes BR-23 and BR-24 consistent WITHOUT an
  // exception clause in the evaluator: an empty constraints object is legal to author and is
  // simply never lowered, so the evaluator's unknown-key deny never has to special-case it.
  it("accepts an EMPTY constraints object and strips it at lowering (S-US4.3)", () => {
    const files = { "p.policy.yaml": policy("empty-c", cap, '  allow:\n    - "user:alice"\n  constraints: {}\n') };
    expect(errors(diagnose(files))).toHaveLength(0);
    const rules = compiled(files).tools.find((t) => t.id === "bank.list")?.policyRules;
    expect(rules).toEqual([{ id: "empty-c", allow: ["user:alice"] }]);
    expect(Object.keys(rules![0])).not.toContain("constraints");
  });

  it("the `rate-limited` CDL token is NOT the spec.rateLimit document key (BR-38, S-US7.4)", () => {
    const d = diagnose({
      "shop.browse.capability.yaml":
        "capability:\n  id: shop.browse\n  description: browse\n  effect: read\n  provider: store\n  policies:\n    - rate-limited\n",
    });
    // The token warns; it never triggers the document-level `spec.rateLimit` shape refusal.
    expect(codes(errors(d))).not.toContain("policy-ratelimit-invalid");
    expect(codes(warnings(d))).toContain("unenforced-policy-token");
  });
});

describe("authoring warnings that never block (BR-17/BR-46, EC-5/EC-7, S-US1.8/1.9)", () => {
  const cap = "  scope: capability\n  capabilityId: bank.list\n";

  it("warns that a deny-only policy does not deny an anonymous caller (BR-17)", () => {
    const d = diagnose({ "p.policy.yaml": policy("deny-only", cap, '  deny:\n    - "user:mallory"\n') });
    expect(errors(d)).toHaveLength(0);
    expect(warnings(d).find((w) => w.code === "policy-deny-only")?.message).toMatch(/anonymous/);
  });

  it("warns on a rule-less policy (EC-5)", () => {
    const d = diagnose({ "p.policy.yaml": policy("nothing", cap, "  {}\n") });
    expect(errors(d)).toHaveLength(0);
    expect(codes(warnings(d))).toContain("policy-without-rules");
  });

  it("warns when the same principal is in both allow and deny of one policy (EC-7)", () => {
    const d = diagnose({ "p.policy.yaml": policy("contra", cap, '  allow:\n    - "user:alice"\n  deny:\n    - "user:alice"\n') });
    expect(warnings(d).find((w) => w.code === "policy-allow-deny-contradiction")?.message).toContain("user:alice");
  });

  // S-US1.8 / BR-46 — without this the author learns "invocable by nobody" from a production
  // denial rather than from `apply`.
  it("warns when two resolved allow sets are disjoint, naming the capability and both ids (S-US1.8)", () => {
    const d = diagnose({
      "a.policy.yaml": policy("core-wide", "  scope: provider\n  provider: core\n", '  allow:\n    - "user:alice"\n'),
      "b.policy.yaml": policy("list-only", cap, '  allow:\n    - "user:bob"\n'),
    });
    const warn = warnings(d).find((w) => w.code === "policy-disjoint-allow");
    expect(warn).toBeDefined();
    expect(warn!.message).toContain("bank.list");
    expect(warn!.message).toContain("core-wide");
    expect(warn!.message).toContain("list-only");
    expect(errors(d)).toHaveLength(0); // warning, never an error — a lockdown is legal
  });

  it("does NOT warn when the allow sets overlap (S-US1.9)", () => {
    const d = diagnose({
      "a.policy.yaml": policy("core-wide", "  scope: provider\n  provider: core\n", '  allow:\n    - "user:alice"\n    - "user:bob"\n'),
      "b.policy.yaml": policy("list-only", cap, '  allow:\n    - "user:bob"\n'),
    });
    expect(codes(warnings(d))).not.toContain("policy-disjoint-allow");
  });
});

describe("declared-but-unenforced CDL tokens (BR-40, S-US7.1)", () => {
  // The minimum honest fix for #43's own opening complaint: a `policies:` line must not read as
  // a list of shipped guarantees in a manifest a compliance reviewer treats as evidence.
  it("emits exactly three warnings for examples/manifests/bank, and none for `authenticated` or `human-approval`", () => {
    const d = validateSemantics(load(join(manifests, "bank")));
    const unenforced = warnings(d).filter((w) => w.code === "unenforced-policy-token");
    expect(unenforced).toHaveLength(3);
    expect(unenforced.filter((w) => w.message.includes("tenant-scoped"))).toHaveLength(2);
    expect(unenforced.filter((w) => w.message.includes("human-approval"))).toHaveLength(0);
    expect(unenforced.filter((w) => w.message.includes("rate-limited"))).toHaveLength(1);
    expect(unenforced.some((w) => w.message.includes("[authenticated]"))).toBe(false);
    // human-approval is enforced by a decision gate since ADD-393; bank's binding declares none,
    // so it is reported as a missing gate instead.
    const gate = warnings(d).filter((w) => w.code === "approval-gate-missing");
    expect(gate.map((w) => [w.capability, w.token])).toEqual([["banking.initiate-transfer", "human-approval"]]);
    expect(errors(d)).toHaveLength(0); // S-US7.2 — warnings never block
  });

  it("emits two for examples/manifests/booking and none for tourism (five across the examples)", () => {
    const booking = validateSemantics(load(join(manifests, "booking"))).filter(
      (w) => w.code === "unenforced-policy-token",
    );
    const tourism = validateSemantics(load(join(manifests, "tourism"))).filter(
      (w) => w.code === "unenforced-policy-token",
    );
    expect(booking).toHaveLength(2);
    expect(tourism).toHaveLength(0);
  });
});

describe("lowering is neutral (BR-7, S-US8.3)", () => {
  it("copies allow/deny verbatim, carries no identity semantics, and leaves version at '0'", () => {
    const ir = compiled({
      "p.policy.yaml": policy("p", "  scope: capability\n  capabilityId: bank.list\n", '  allow:\n    - "user:alice"\n  deny:\n    - "user:mallory"\n'),
    });
    expect(ir.version).toBe("0");
    const rule = ir.tools.find((t) => t.id === "bank.list")!.policyRules![0];
    expect(rule).toEqual({ id: "p", allow: ["user:alice"], deny: ["user:mallory"] });
    // No principal, no claims, no auth scheme — the IR is reused across many invocations by
    // many end users; identity is a fact about ONE invocation (ADD-42 §2's note to #43).
    expect(Object.keys(rule).sort()).toEqual(["allow", "deny", "id"]);
  });

  it("leaves every shipped example manifest without a policyRules field (BR-14)", () => {
    for (const name of ["booking", "bank", "tourism"]) {
      const ir = compile(load(join(manifests, name)));
      expect(ir.tools.every((t) => t.policyRules === undefined)).toBe(true);
    }
  });
});
