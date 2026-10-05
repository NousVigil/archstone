import { describe, it, expect } from "vitest";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load, type LoadResult, type PolicyDoc } from "@archstone/schema";
import { compile } from "../src/compile";
import { validateSemantics } from "../src/validate";
import { lintIR, LINT_CODES, type LintFinding } from "../src/lint";
import { UNENFORCED_POLICY_TOKENS } from "../src/unenforced-tokens";

// ADD-311 — the irreversible checklist. Flawed manifests are built in memory from a copy of the
// bank example (nothing flawed is added under examples/manifests/): the real loader runs once,
// each test clones its result and changes exactly one thing.

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");
const bank = load(join(manifests, "bank"));
const TRANSFER = "banking.initiate-transfer";

type Cap = LoadResult["capabilityDocs"][number]["capability"];

/** A clone of the bank manifest with `edit` applied to banking.initiate-transfer's capability. */
function bankWith(edit: (cap: Cap) => void, policyDocs: PolicyDoc[] = []): LoadResult {
  const model = structuredClone(bank);
  edit(model.capabilityDocs.find((d) => d.capability.id === TRANSFER)!.capability);
  model.policyDocs = policyDocs;
  return model;
}

const lint = (model: LoadResult): LintFinding[] => lintIR(compile(model), model);
const forCap = (fs: LintFinding[], code?: string) => fs.filter((f) => f.capability === TRANSFER && (!code || f.code === code));

function policy(id: string, spec: PolicyDoc["spec"]): PolicyDoc {
  return {
    file: `${id}.policy.yaml`,
    apiVersion: "archstone/v1",
    kind: "Policy",
    metadata: { id, name: id, scope: "capability", capabilityId: TRANSFER },
    spec,
  };
}

describe("lintIR — bank (S-US1.4, S-US3.4, S-US4.1/4.2)", () => {
  const findings = lint(bank);

  it("reports exactly the two unenforced tokens of banking.initiate-transfer, human-approval then rate-limited", () => {
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => [f.code, f.severity, f.capability, f.token])).toEqual([
      ["irreversible-unenforced-policy", "warning", TRANSFER, "human-approval"],
      ["irreversible-unenforced-policy", "warning", TRANSFER, "rate-limited"],
    ]);
  });

  it("carries the AC copy, split into message and because", () => {
    expect(`${findings[0]!.message} ${findings[0]!.because}`).toBe(
      "is irreversible and declares policies:[human-approval], which this version does not enforce: no approval mechanism exists. An agent can run it without anyone approving. Put the approval step in the provider, or do not serve this capability to an agent unattended.",
    );
    expect(`${findings[1]!.message} ${findings[1]!.because}`).toBe(
      "is irreversible and declares policies:[rate-limited], which this version does not enforce: enforcing it needs invocation counting and therefore state — tracked as issue #45. An agent can run it as often as it is called. Attach a Policy document with spec.rateLimit, which is enforced, or limit it in the provider.",
    );
  });

  it("neither row 1 nor row 4 fires: it declares failures and authenticated", () => {
    expect(findings.map((f) => f.code)).not.toContain("irreversible-no-failures");
    expect(findings.map((f) => f.code)).not.toContain("irreversible-unauthenticated");
  });

  it("is deterministic: equal inputs give equal outputs", () => {
    const ir = compile(bank);
    expect(lintIR(ir, bank)).toEqual(lintIR(ir, bank));
    expect(lint(bankWith(() => {}))).toEqual(findings);
  });

  it("only uses the closed code set", () => {
    expect(LINT_CODES).toEqual(["irreversible-no-failures", "irreversible-unauthenticated", "irreversible-unenforced-policy"]);
    for (const f of findings) expect(LINT_CODES).toContain(f.code);
  });
});

describe("lintIR — row 1, irreversible-no-failures (S-US2.x)", () => {
  it("fires once, with the AC copy, when failures is removed", () => {
    const fs = forCap(lint(bankWith((c) => delete c.failures)), "irreversible-no-failures");
    expect(fs).toHaveLength(1);
    expect(`${fs[0]!.message} ${fs[0]!.because}`).toBe(
      "is irreversible and declares no failures. When it fails, an agent can say only that it failed, not why, and must not retry. Name the business outcomes that stop it under failures: (for example insufficient-funds, already-refunded).",
    );
    expect(fs[0]!.token).toBeUndefined();
  });

  it("comes before the capability's other findings", () => {
    const codes = forCap(lint(bankWith((c) => delete c.failures))).map((f) => f.code);
    expect(codes).toEqual(["irreversible-no-failures", "irreversible-unenforced-policy", "irreversible-unenforced-policy"]);
  });

  it("does not fire for a write that declares no failures (booking's tourism.invoice)", () => {
    const booking = load(join(manifests, "booking"));
    expect(booking.capabilityDocs.find((d) => d.capability.id === "tourism.invoice")?.capability.effect).toBe("write");
    expect(lint(booking)).toEqual([]);
  });

  it("does not fire when the IR has a tool the documents do not (absence is never inferred)", () => {
    const ir = compile(bankWith((c) => delete c.failures));
    expect(lintIR(ir, { capabilityDocs: [] }).map((f) => f.code)).not.toContain("irreversible-no-failures");
  });
});

describe("lintIR — row 4, irreversible-unauthenticated (S-US3.x)", () => {
  const noAuth = (c: Cap) => {
    c.policies = (c.policies ?? []).filter((p) => p !== "authenticated");
  };

  it("fires once, with the AC copy, when authenticated is removed", () => {
    const fs = forCap(lint(bankWith(noAuth)), "irreversible-unauthenticated");
    expect(fs).toHaveLength(1);
    expect(`${fs[0]!.message} ${fs[0]!.because}`).toBe(
      "is irreversible and does not declare policies:[authenticated]. Any caller that can reach this server can invoke it. If that is intended, nothing to change; this line stays so the decision stays visible. Otherwise add authenticated to policies:.",
    );
  });

  it("fires, and nothing else does, on an irreversible capability with no policies at all", () => {
    const fs = forCap(lint(bankWith((c) => delete c.policies)));
    expect(fs.map((f) => f.code)).toEqual(["irreversible-unauthenticated"]);
  });

  it("does not fire where an attached rule has a non-empty allow (D-11)", () => {
    const fs = lint(bankWith(noAuth, [policy("ops-only", { allow: ["role:ops"] })]));
    expect(forCap(fs, "irreversible-unauthenticated")).toEqual([]);
  });

  it("still fires for a deny-only rule, and for an empty allow", () => {
    expect(forCap(lint(bankWith(noAuth, [policy("no-interns", { deny: ["role:intern"] })])), "irreversible-unauthenticated")).toHaveLength(1);
    expect(forCap(lint(bankWith(noAuth, [policy("empty", { allow: [] })])), "irreversible-unauthenticated")).toHaveLength(1);
  });
});

describe("lintIR — row 6, irreversible-unenforced-policy (S-US4.x)", () => {
  it("reports four findings, one per unenforced token, and none for authenticated", () => {
    const model = bankWith((c) => {
      c.policies = ["authenticated", "human-approval", "consent-required", "tenant-scoped", "rate-limited"];
    });
    const fs = forCap(lint(model));
    expect(fs.map((f) => [f.code, f.token])).toEqual([
      ["irreversible-unenforced-policy", "human-approval"],
      ["irreversible-unenforced-policy", "consent-required"],
      ["irreversible-unenforced-policy", "tenant-scoped"],
      ["irreversible-unenforced-policy", "rate-limited"],
    ]);
    // ...and BR-40 still emits all four for the renderer to replace, keyed on structure.
    const br40 = validateSemantics(model).filter((d) => d.code === "unenforced-policy-token" && d.capability === TRANSFER);
    expect(br40.map((d) => d.token)).toEqual(fs.map((f) => f.token));
  });

  it("states each token's own consequence and action", () => {
    const model = bankWith((c) => {
      c.policies = ["authenticated", "consent-required", "tenant-scoped"];
    });
    const [consent, tenant] = forCap(lint(model));
    expect(consent!.because).toBe(
      "An agent can run it without anyone recording consent. Collect consent in the provider, or do not serve this capability to an agent unattended.",
    );
    expect(tenant!.because).toBe("Archstone does not confine a call to one tenant's data. Confine it in the provider.");
  });

  it("reports a token listed twice once (EC-2)", () => {
    const fs = forCap(lint(bankWith((c) => (c.policies = ["authenticated", "human-approval", "human-approval"]))));
    expect(fs.map((f) => f.token)).toEqual(["human-approval"]);
  });

  it("does not report rate-limited where an attached rule carries rateLimit (D-12); the other token still is", () => {
    const fs = forCap(lint(bankWith(() => {}, [policy("cap", { rateLimit: { maxInvocations: 10, windowSeconds: 60 } })])));
    expect(fs.map((f) => f.token)).toEqual(["human-approval"]);
  });

  it("still reports rate-limited when the attached rule has no rateLimit", () => {
    const fs = forCap(lint(bankWith(() => {}, [policy("ops-only", { allow: ["role:ops"] })])));
    expect(fs.map((f) => f.token)).toEqual(["human-approval", "rate-limited"]);
  });

  it("covers every listed token with all three clauses (R-4)", () => {
    expect(Object.keys(UNENFORCED_POLICY_TOKENS).sort()).toEqual(["consent-required", "human-approval", "rate-limited", "tenant-scoped"]);
    for (const [token, e] of Object.entries(UNENFORCED_POLICY_TOKENS)) {
      expect(e.why, token).not.toBe("");
      expect(e.consequence, token).not.toBe("");
      expect(e.action, token).not.toBe("");
      const model = bankWith((c) => (c.policies = ["authenticated", token]));
      expect(forCap(lint(model)).map((f) => f.token), token).toEqual([token]);
    }
  });

  it("leaves both rules together when a token gains enforcement (S-US4.6)", () => {
    const saved = UNENFORCED_POLICY_TOKENS["rate-limited"]!;
    delete (UNENFORCED_POLICY_TOKENS as Record<string, unknown>)["rate-limited"];
    try {
      expect(lint(bank).map((f) => f.token)).toEqual(["human-approval"]);
      expect(validateSemantics(bank).filter((d) => d.token === "rate-limited")).toEqual([]);
    } finally {
      (UNENFORCED_POLICY_TOKENS as Record<string, unknown>)["rate-limited"] = saved;
    }
  });
});

describe("lintIR — lifecycle (S-US4.7, EC-3/4)", () => {
  const flawed = (c: Cap) => {
    delete c.failures;
    c.policies = ["human-approval", "rate-limited"];
  };

  it("does not lint a retired capability; BR-40 still reports its tokens", () => {
    const model = bankWith((c) => {
      flawed(c);
      c.lifecycle = "retired";
    });
    expect(forCap(lint(model))).toEqual([]);
    expect(validateSemantics(model).filter((d) => d.capability === TRANSFER).map((d) => d.token)).toEqual(["human-approval", "rate-limited"]);
  });

  for (const lifecycle of ["experimental", "beta", "stable", "deprecated"]) {
    it(`lints a ${lifecycle} capability`, () => {
      const fs = forCap(lint(bankWith((c) => { flawed(c); c.lifecycle = lifecycle; })));
      expect(fs.map((f) => f.code)).toEqual([
        "irreversible-no-failures",
        "irreversible-unauthenticated",
        "irreversible-unenforced-policy",
        "irreversible-unenforced-policy",
      ]);
    });
  }

  it("lints an unbound capability alike", () => {
    const model = bankWith(flawed);
    model.bindings = model.bindings.filter((b) => b.binding.capabilityId !== TRANSFER);
    const ir = compile(model);
    expect(ir.tools.find((t) => t.id === TRANSFER)?.connector).toBeUndefined();
    expect(forCap(lintIR(ir, model))).toHaveLength(4);
  });
});

describe("lintIR — nothing to say", () => {
  it("returns [] for booking and tourism, whose capabilities are none irreversible", () => {
    for (const name of ["booking", "tourism"]) {
      const model = load(join(manifests, name));
      expect(lint(model), name).toEqual([]);
    }
  });

  it("does not lint a read or a write, however its policies read", () => {
    const model = bankWith((c) => {
      c.effect = "write";
      delete c.failures;
      delete c.policies;
    });
    expect(forCap(lint(model))).toEqual([]);
  });
});
