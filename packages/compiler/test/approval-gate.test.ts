import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { load, type LoadResult } from "@archstone/schema";
import { validateSemantics, type Diagnostic } from "../src/validate";
import { compile } from "../src/compile";
import { diffIR, type IRDiffEntry } from "../src/ir-diff";
import type { IR, IRDecisionGate } from "../src/ir";

// ADD-393 §2/§5/§8 (archstone#165) — the compiler's half of the decision gates: the binding's
// `approval:`/`consent:` block (shape), its verbatim lowering to `IRTool.approval`/`consent`, the
// `apply` rules that refuse a gate that would check less than it appears to (no token, a bad id
// input, a templated path, no `${VAR}` secret in `Authorization`, a non-loopback `http:`
// literal), the `*-gate-missing` warning that replaces BR-40's "not enforced" for both tokens,
// and `diffIR`'s report of a gate added, removed or changed.

const codes = (d: Diagnostic[]) => d.map((x) => x.code);
const errors = (d: Diagnostic[]) => d.filter((x) => x.severity === "error");
const warnings = (d: Diagnostic[]) => d.filter((x) => x.severity === "warning");

function withFixture<T>(files: Record<string, string>, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "archstone-gate-"));
  try {
    for (const [rel, content] of Object.entries(files)) {
      const full = join(dir, rel);
      mkdirSync(dirname(full), { recursive: true });
      writeFileSync(full, content);
    }
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

interface Spec {
  policies?: string[];
  /** Extra input fields, as YAML lines indented under `input:`. */
  inputs?: string;
  /** The `approval:` block, as YAML lines indented under `binding:` (without the key). */
  approval?: string;
  consent?: string;
}

const APPROVAL_INPUT = "    approval:\n      ref: Approval\n";
const CONSENT_INPUT = "    consent:\n      type: identifier\n";

/** `ask:` YAML under a gate block — the defaults are a valid gate. */
function ask(over: { baseUrl?: string; path?: string; headers?: string; timeout?: number } = {}): string {
  const headers = over.headers ?? '      Authorization: "Bearer ${APPROVALS_TOKEN}"\n';
  return (
    `  ask:\n` +
    `    baseUrl: "${over.baseUrl ?? "${APPROVALS_URL}"}"\n` +
    `    path: ${over.path ?? "/approvals/consume"}\n` +
    `    headers:\n${headers.replace(/^ {6}/gm, "      ")}` +
    (over.timeout !== undefined ? `    timeoutSeconds: ${over.timeout}\n` : "")
  );
}

function gateBlock(input: string, askYaml = ask()): string {
  return `  input: ${input}\n${askYaml}`;
}

function files(spec: Spec): Record<string, string> {
  const policies = spec.policies ?? ["human-approval"];
  const indent = (block: string) => block.replace(/^/gm, "  ").replace(/ +$/, "");
  return {
    "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - pay.send\nproviders:\n  - core\n",
    "pay.Approval.resource.yaml": "resource:\n  name: pay.Approval\n  description: An approval.\n  fields:\n    id:\n      type: identifier\n    status:\n      type: enum\n      values: [pending, approved, rejected]\n",
    "pay.send.capability.yaml":
      "capability:\n  id: pay.send\n  description: Send money.\n  effect: irreversible\n  provider: core\n" +
      "  input:\n    amount:\n      type: money\n" +
      (spec.inputs ?? APPROVAL_INPUT + CONSENT_INPUT) +
      (policies.length > 0 ? `  policies:\n${policies.map((p) => `    - ${p}\n`).join("")}` : ""),
    "bindings/pay.send.binding.yaml":
      'binding:\n  capabilityId: pay.send\n  connector:\n    type: rest\n    rest:\n      baseUrl: "${CORE_URL}"\n      method: POST\n      path: /transfers\n' +
      (spec.approval !== undefined ? `  approval:\n${indent(spec.approval)}` : "") +
      (spec.consent !== undefined ? `  consent:\n${indent(spec.consent)}` : ""),
  };
}

function loaded(spec: Spec): LoadResult {
  return withFixture(files(spec), (dir) => load(dir));
}
function diagnose(spec: Spec): Diagnostic[] {
  return validateSemantics(loaded(spec));
}
function compiled(spec: Spec): IR {
  return compile(loaded(spec));
}
const gateErrors = (d: Diagnostic[], block = "approval") => codes(errors(d)).filter((c) => c.startsWith(`${block}-gate-`));

// ---------------------------------------------------------------------------------------------
// Shape — binding.schema.json
// ---------------------------------------------------------------------------------------------

describe("binding schema — the approval:/consent: block (ADD-393 §2)", () => {
  it("accepts input + ask{baseUrl, path, headers, timeoutSeconds}", () => {
    const r = loaded({ approval: gateBlock("approval", ask({ timeout: 10 })), consent: gateBlock("consent", ask({ timeout: 1 })), policies: ["human-approval", "consent-required"] });
    expect(r.issues).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.bindings).toHaveLength(1);
  });

  it("accepts timeoutSeconds 1 and 50, and none", () => {
    for (const timeout of [1, 50, undefined]) {
      const r = loaded({ approval: gateBlock("approval", ask({ timeout })) });
      expect(r.ok).toBe(true);
    }
  });

  const rejected: [string, string][] = [
    ["a `method` (always POST, not authorable)", gateBlock("approval", ask() + "    method: GET\n")],
    ["a `body` (fixed, never a template)", gateBlock("approval", ask() + '    body: "{}"\n')],
    ["an unknown key in ask", gateBlock("approval", ask() + "    retries: 3\n")],
    ["an unknown key in the block (an answer mapping)", gateBlock("approval") + "  answer:\n    outcome: $.status\n"],
    ["timeoutSeconds 0", gateBlock("approval", ask({ timeout: 0 }))],
    ["timeoutSeconds 51", gateBlock("approval", ask({ timeout: 51 }))],
    ["timeoutSeconds 2.5", gateBlock("approval", ask({ timeout: 2.5 }))],
    ["no input", ask()],
    ["no ask", "  input: approval\n"],
  ];
  for (const [label, block] of rejected) {
    it(`rejects ${label}`, () => {
      for (const which of ["approval", "consent"] as const) {
        const r = loaded({ policies: ["human-approval", "consent-required"], [which]: block });
        expect(r.ok).toBe(false);
        expect(r.bindings).toHaveLength(0);
        expect(r.issues.map((i) => i.file).join(" ")).toContain("pay.send.binding.yaml");
      }
    });
  }
});

// ---------------------------------------------------------------------------------------------
// Lowering
// ---------------------------------------------------------------------------------------------

describe("compile — IRTool.approval / consent lowered verbatim (ADD-393 §2)", () => {
  it("copies the block verbatim, headers in sorted key order, no ${VAR} resolved", () => {
    const headers = '      X-Tenant: "${caller.tenantId}"\n      Authorization: "Bearer ${APPROVALS_TOKEN}"\n      Accept: application/json\n';
    const ir = compiled({ approval: gateBlock("approval", ask({ headers })) });
    const t = ir.tools.find((x) => x.id === "pay.send")!;
    const expected: IRDecisionGate = {
      input: "approval",
      ask: {
        baseUrl: "${APPROVALS_URL}",
        path: "/approvals/consume",
        headers: { Accept: "application/json", Authorization: "Bearer ${APPROVALS_TOKEN}", "X-Tenant": "${caller.tenantId}" },
      },
    };
    expect(t.approval).toEqual(expected);
    expect(Object.keys(t.approval!.ask.headers)).toEqual(["Accept", "Authorization", "X-Tenant"]);
    expect("timeoutSeconds" in t.approval!.ask).toBe(false);
    expect(t.consent).toBeUndefined();
  });

  it("authoring order never changes IR bytes", () => {
    const a = compiled({ approval: gateBlock("approval", ask({ headers: '      Authorization: "Bearer ${T}"\n      X-A: a\n' })) });
    const b = compiled({ approval: gateBlock("approval", ask({ headers: '      X-A: a\n      Authorization: "Bearer ${T}"\n' })) });
    expect(JSON.stringify(a.tools[0]!.approval)).toBe(JSON.stringify(b.tools[0]!.approval));
  });

  it("keeps timeoutSeconds only when authored", () => {
    const t = compiled({ approval: gateBlock("approval", ask({ timeout: 7 })) }).tools[0]!;
    expect(t.approval!.ask.timeoutSeconds).toBe(7);
  });

  it("lowers consent: the same way", () => {
    const t = compiled({ policies: ["consent-required"], consent: gateBlock("consent", ask({ baseUrl: "https://consents.test" })) }).tools[0]!;
    expect(t.consent).toEqual({
      input: "consent",
      ask: { baseUrl: "https://consents.test", path: "/approvals/consume", headers: { Authorization: "Bearer ${APPROVALS_TOKEN}" } },
    });
    expect(t.approval).toBeUndefined();
  });

  it("absent when the binding has no block (the IR of an ungated manifest is unchanged)", () => {
    const t = compiled({}).tools[0]!;
    expect("approval" in t).toBe(false);
    expect("consent" in t).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------
// apply rules
// ---------------------------------------------------------------------------------------------

describe("validateSemantics — a valid gate (ADD-393 §8)", () => {
  it("a well-formed approval gate on a declared token: no gate diagnostics at all", () => {
    const d = diagnose({ approval: gateBlock("approval") });
    expect(codes(d).filter((c) => c.includes("gate"))).toEqual([]);
    expect(errors(d)).toEqual([]);
  });

  it("neither token produces unenforced-policy-token any more — with or without a gate", () => {
    for (const spec of [{ policies: ["human-approval", "consent-required"] }, { policies: ["human-approval", "consent-required"], approval: gateBlock("approval"), consent: gateBlock("consent") }]) {
      const d = diagnose(spec);
      const unenforced = d.filter((x) => x.code === "unenforced-policy-token").map((x) => x.token);
      expect(unenforced).not.toContain("human-approval");
      expect(unenforced).not.toContain("consent-required");
    }
  });
});

for (const block of ["approval", "consent"] as const) {
  const token = block === "approval" ? "human-approval" : "consent-required";
  const idInput = block === "approval" ? "approval" : "consent";
  const g = (input: string, askYaml?: string): Spec => ({ policies: [token], [block]: gateBlock(input, askYaml) });

  describe(`validateSemantics — ${block}: rules (ADD-393 §5/§8)`, () => {
    it(`warning ${block}-gate-missing when the token is declared without a block — not an error`, () => {
      const d = diagnose({ policies: [token] });
      const w = warnings(d).filter((x) => x.code === `${block}-gate-missing`);
      expect(w).toHaveLength(1);
      expect(w[0]!.capability).toBe("pay.send");
      expect(w[0]!.token).toBe(token);
      expect(gateErrors(d, block)).toEqual([]);
      // The public wording rule (§6): the guarantee as "refused unless … answers `allowed`",
      // never "single-use" or "prevents reuse".
      expect(w[0]!.message).toContain("refused");
      expect(w[0]!.message).not.toMatch(/single[- ]use|prevents reuse/i);
    });

    it(`error ${block}-gate-without-token: a block for a capability that does not declare the token`, () => {
      const d = diagnose({ policies: [], [block]: gateBlock(idInput) });
      expect(gateErrors(d, block)).toEqual([`${block}-gate-without-token`]);
    });

    it(`error ${block}-gate-input-invalid: an undeclared field`, () => {
      expect(gateErrors(diagnose(g("ticket")), block)).toEqual([`${block}-gate-input-invalid`]);
    });

    it(`error ${block}-gate-input-invalid: an optional field`, () => {
      const d = diagnose({ ...g("ticket"), inputs: APPROVAL_INPUT + CONSENT_INPUT + "    ticket:\n      type: identifier\n      required: false\n" });
      expect(gateErrors(d, block)).toEqual([`${block}-gate-input-invalid`]);
    });

    for (const type of ["money", "string", "text"]) {
      it(`error ${block}-gate-input-invalid: a \`type: ${type}\` field`, () => {
        const d = diagnose({ ...g("ticket"), inputs: APPROVAL_INPUT + CONSENT_INPUT + `    ticket:\n      type: ${type}\n` });
        expect(gateErrors(d, block)).toEqual([`${block}-gate-input-invalid`]);
      });
    }

    it("accepts a required `ref:` field and a required `type: identifier` field", () => {
      expect(gateErrors(diagnose(g("approval")), block)).toEqual([]); // ref: Approval
      expect(gateErrors(diagnose(g("consent")), block)).toEqual([]); // type: identifier
    });

    for (const path of ["/a/{id}", "/approvals/{approval}/consume", "/a/${APPROVAL_PATH}"]) {
      it(`error ${block}-gate-path-templated: ${path}`, () => {
        expect(gateErrors(diagnose(g(idInput, ask({ path }))), block)).toContain(`${block}-gate-path-templated`);
      });
    }

    const noSecret: [string, string][] = [
      ["no Authorization header", '      X-Api-Key: "${APPROVALS_TOKEN}"\n'],
      ["a literal-only Authorization", "      Authorization: Bearer hard-coded\n"],
      ["Authorization with only ${caller.token}", '      Authorization: "Bearer ${caller.token}"\n'],
      ["${VAR} in a different header beside a literal Authorization", '      Authorization: Bearer literal\n      X-Key: "${APPROVALS_TOKEN}"\n'],
    ];
    for (const [label, headers] of noSecret) {
      it(`error ${block}-gate-no-secret: ${label}`, () => {
        expect(gateErrors(diagnose(g(idInput, ask({ headers }))), block)).toEqual([`${block}-gate-no-secret`]);
      });
    }

    it('accepts a lowercase `authorization: "Bearer ${T}"`, and a ${caller.*} header beside it', () => {
      const headers = '      authorization: "Bearer ${T}"\n      X-User: "${caller.accessToken}"\n';
      expect(gateErrors(diagnose(g(idInput, ask({ headers }))), block)).toEqual([]);
    });

    for (const baseUrl of ["http://example.com", "http://localhost.example.com", "ftp://approvals.test"]) {
      it(`error ${block}-gate-insecure-url: ${baseUrl}`, () => {
        expect(gateErrors(diagnose(g(idInput, ask({ baseUrl }))), block)).toEqual([`${block}-gate-insecure-url`]);
      });
    }

    for (const baseUrl of ["http://localhost:8080", "http://127.0.0.1:9000", "http://[::1]:7000", "https://x", "${APPROVALS_URL}", "https://${HOST}/v1"]) {
      it(`accepts baseUrl ${baseUrl}`, () => {
        expect(gateErrors(diagnose(g(idInput, ask({ baseUrl }))), block)).toEqual([]);
      });
    }
  });
}

describe("validateSemantics — both gates together", () => {
  it("each block is checked against its own token, and each reports under its own prefix", () => {
    const d = diagnose({
      policies: ["human-approval"],
      approval: gateBlock("approval"),
      consent: gateBlock("consent", ask({ baseUrl: "http://example.com" })),
    });
    expect(gateErrors(d, "approval")).toEqual([]);
    expect(gateErrors(d, "consent").sort()).toEqual(["consent-gate-insecure-url", "consent-gate-without-token"]);
  });
});

// ---------------------------------------------------------------------------------------------
// diffIR
// ---------------------------------------------------------------------------------------------

describe("diffIR — decision gates (ADD-393 §10, ir-diff.ts diffBinding)", () => {
  const GATE: IRDecisionGate = { input: "approval", ask: { baseUrl: "${APPROVALS_URL}", path: "/consume", headers: { Authorization: "Bearer ${T}" } } };

  function ir(over: { policies?: string[]; approval?: IRDecisionGate; consent?: IRDecisionGate } = {}): IR {
    return {
      version: "0",
      company: { id: "acme" },
      tools: [
        {
          id: "pay.send",
          description: "Send money.",
          effect: "irreversible",
          provider: "core",
          policies: over.policies ?? ["human-approval"],
          lifecycle: "stable",
          input: [{ name: "approval", required: true, type: { kind: "scalar", semantic: "identifier" } }],
          output: [],
          connector: { type: "rest", rest: { method: "POST", path: "/transfers" } },
          ...(over.approval ? { approval: over.approval } : {}),
          ...(over.consent ? { consent: over.consent } : {}),
        },
      ],
      resources: {},
    };
  }
  const at = (entries: IRDiffEntry[], path: string) => entries.filter((e) => e.path === path);

  it("gate added → binding-changed, compatible, path 'approval'", () => {
    const { entries } = diffIR(ir(), ir({ approval: GATE }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "binding-changed", severity: "compatible", capabilityId: "pay.send", path: "approval" });
    expect(entries[0]!.detail).not.toMatch(/single[- ]use|prevents reuse/i);
  });

  it("consent gate added → path 'consent'", () => {
    const { entries } = diffIR(ir({ policies: ["consent-required"] }), ir({ policies: ["consent-required"], consent: { ...GATE, input: "approval" } }));
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "binding-changed", severity: "compatible", path: "consent" });
  });

  it("gate removed while the token is still declared → breaking", () => {
    const { entries } = diffIR(ir({ approval: GATE }), ir());
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "binding-changed", severity: "breaking", path: "approval" });
  });

  it("consent gate removed while consent-required is still declared → breaking", () => {
    const { entries } = diffIR(ir({ policies: ["consent-required"], consent: GATE }), ir({ policies: ["consent-required"] }));
    expect(at(entries, "consent")[0]).toMatchObject({ severity: "breaking" });
  });

  it("gate removed together with the token → the gate row is not breaking", () => {
    const { entries } = diffIR(ir({ approval: GATE }), ir({ policies: [] }));
    const rows = at(entries, "approval");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "binding-changed" });
    expect(rows[0]!.severity).not.toBe("breaking");
    expect(entries.some((e) => e.severity === "breaking")).toBe(false);
  });

  it("gate changed → reported", () => {
    for (const changed of [
      { ...GATE, input: "ticket" },
      { ...GATE, ask: { ...GATE.ask, path: "/v2/consume" } },
      { ...GATE, ask: { ...GATE.ask, timeoutSeconds: 20 } },
      { ...GATE, ask: { ...GATE.ask, headers: { Authorization: "Bearer ${OTHER}" } } },
    ]) {
      const { entries } = diffIR(ir({ approval: GATE }), ir({ approval: changed }));
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ kind: "binding-changed", capabilityId: "pay.send", path: "approval" });
    }
  });

  it("the token gained with no gate → policy-tokens-changed is breaking (every call is now refused)", () => {
    const { entries } = diffIR(ir({ policies: [] }), ir());
    const rows = at(entries, "policies");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: "policy-tokens-changed", severity: "breaking" });
    expect(rows[0]!.detail).toMatch(/no gate for 'human-approval'|no gate for "human-approval"|no gate for human-approval/);
  });

  it("the token gained together with its gate → policy-tokens-changed keeps its usual severity", () => {
    const { entries } = diffIR(ir({ policies: [] }), ir({ approval: GATE }));
    expect(at(entries, "policies")[0]!.severity).not.toBe("breaking");
  });

  it("an identical gate → nothing reported", () => {
    expect(diffIR(ir({ approval: GATE }), ir({ approval: { ...GATE, ask: { ...GATE.ask, headers: { ...GATE.ask.headers } } } })).entries).toEqual([]);
  });
});
