import { describe, it, expect } from "vitest";
import { readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "@archstone/schema";
import { compile } from "../src/compile";
import { validateSemantics } from "../src/validate";
import { diffIR, type IRDiffEntry } from "../src/ir-diff";
import type { IR, IRTool } from "../src/ir";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

/** A small but complete IR: one bound read capability whose output reaches a resource that
 *  itself reaches a second one, plus a resource-typed input. Every row mutates a copy of it. */
function base(): IR {
  return {
    version: "0",
    company: { id: "acme" },
    tools: [
      {
        id: "shop.search",
        description: "Search the catalogue.",
        effect: "read",
        provider: "catalogue",
        policies: [],
        policyRules: [{ id: "partners", allow: ["partner:a", "partner:b"], deny: ["banned"], rateLimit: { maxInvocations: 10, windowSeconds: 60 } }],
        lifecycle: "beta",
        input: [
          { name: "query", required: true, type: { kind: "scalar", semantic: "string" } },
          { name: "near", required: false, type: { kind: "scalar", semantic: "location" } },
          { name: "filter", required: false, type: { kind: "resource", name: "shop.Filter" } },
        ],
        output: [
          { name: "items", required: true, type: { kind: "collection", of: "shop.Item" } },
          { name: "total", required: false, type: { kind: "scalar", semantic: "quantity" } },
        ],
        connector: { type: "rest", rest: { method: "GET", path: "/search" } },
        response: { resource: "shop.Item", field: "items", collection: "$.items[]", fields: [{ name: "name", path: "$.name" }] },
      },
      {
        id: "shop.lookup",
        description: "Look one item up by its seller.",
        effect: "read",
        provider: "catalogue",
        policies: [],
        lifecycle: "stable",
        input: [{ name: "seller", required: true, type: { kind: "resource", name: "shop.Seller", identity: true } }],
        output: [],
      },
    ],
    resources: {
      "shop.Item": [
        { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
        { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
        { name: "seller", required: false, type: { kind: "resource", name: "shop.Seller" } },
      ],
      "shop.Seller": [{ name: "handle", required: true, type: { kind: "scalar", semantic: "string" } }],
      "shop.Filter": [{ name: "maxPrice", required: false, type: { kind: "scalar", semantic: "money" } }],
      "shop.Unused": [{ name: "x", required: true, type: { kind: "scalar", semantic: "string" } }],
    },
  };
}

function edit(mutate: (ir: IR, search: IRTool) => void): IR {
  const ir = base();
  mutate(ir, ir.tools[0]!);
  return ir;
}

/** The single entry a one-row change produces. */
function only(after: IR, before: IR = base()): IRDiffEntry {
  const { entries } = diffIR(before, after);
  expect(entries).toHaveLength(1);
  return entries[0]!;
}

describe("diffIR — ADD-309 §4, one test per row", () => {
  it("capability removed → breaking", () => {
    const e = only(edit((ir) => ir.tools.splice(1, 1)));
    expect(e).toMatchObject({ severity: "breaking", kind: "capability-removed", capabilityId: "shop.lookup" });
  });

  it("capability added → compatible", () => {
    const e = only(base(), edit((ir) => ir.tools.splice(1, 1)));
    expect(e).toMatchObject({ severity: "compatible", kind: "capability-added", capabilityId: "shop.lookup" });
  });

  it("effect changed, any direction → breaking", () => {
    const up = only(edit((_ir, t) => { t.effect = "irreversible"; }));
    expect(up).toMatchObject({ severity: "breaking", kind: "effect-changed", path: "effect", before: "read", after: "irreversible" });
    expect(up.detail).toBe("effect changed: read → irreversible");
    // D-3: the "safer-looking" direction is not safe either.
    const down = only(base(), edit((_ir, t) => { t.effect = "write"; }));
    expect(down).toMatchObject({ severity: "breaking", kind: "effect-changed", before: "write", after: "read" });
  });

  it("lifecycle → retired → breaking", () => {
    const e = only(edit((_ir, t) => { t.lifecycle = "retired"; }));
    expect(e).toMatchObject({ severity: "breaking", kind: "lifecycle-retired", before: "beta", after: "retired" });
  });

  it("lifecycle → deprecated → notable", () => {
    const e = only(edit((_ir, t) => { t.lifecycle = "deprecated"; }));
    expect(e).toMatchObject({ severity: "notable", kind: "lifecycle-deprecated" });
  });

  it("lifecycle forward (experimental → beta → stable) → compatible", () => {
    expect(only(edit((_ir, t) => { t.lifecycle = "stable"; }))).toMatchObject({ severity: "compatible", kind: "lifecycle-forward" });
    const exp = edit((_ir, t) => { t.lifecycle = "experimental"; });
    expect(only(base(), exp)).toMatchObject({ severity: "compatible", kind: "lifecycle-forward", before: "experimental", after: "beta" });
  });

  it("lifecycle moves the table does not list resolve toward breaking (R-1)", () => {
    expect(only(edit((_ir, t) => { t.lifecycle = "experimental"; }))).toMatchObject({ severity: "breaking", kind: "lifecycle-reversed" });
    const retired = edit((_ir, t) => { t.lifecycle = "retired"; });
    expect(only(base(), retired)).toMatchObject({ severity: "breaking", kind: "lifecycle-reversed", before: "retired", after: "beta" });
  });

  it("input added, required → breaking", () => {
    const e = only(edit((_ir, t) => { t.input.push({ name: "page", required: true, type: { kind: "scalar", semantic: "quantity" } }); }));
    expect(e).toMatchObject({ severity: "breaking", kind: "input-added-required", path: "input.page" });
  });

  it("input added, optional → compatible", () => {
    const e = only(edit((_ir, t) => { t.input.push({ name: "page", required: false, type: { kind: "scalar", semantic: "quantity" } }); }));
    expect(e).toMatchObject({ severity: "compatible", kind: "input-added-optional", path: "input.page" });
    expect(e.detail).toBe("input 'page' added (optional, quantity)");
  });

  it("input removed → breaking", () => {
    const e = only(edit((_ir, t) => { t.input = t.input.filter((f) => f.name !== "near"); }));
    expect(e).toMatchObject({ severity: "breaking", kind: "input-removed", path: "input.near" });
  });

  it("input optional → required → breaking", () => {
    const e = only(edit((_ir, t) => { t.input[1]!.required = true; }));
    expect(e).toMatchObject({ severity: "breaking", kind: "input-now-required", path: "input.near", before: false, after: true });
  });

  it("input required → optional → compatible", () => {
    const e = only(edit((_ir, t) => { t.input[0]!.required = false; }));
    expect(e).toMatchObject({ severity: "compatible", kind: "input-now-optional", path: "input.query" });
  });

  it("input type changed → breaking", () => {
    const e = only(edit((_ir, t) => { t.input[0]!.type = { kind: "scalar", semantic: "location" }; }));
    expect(e).toMatchObject({ severity: "breaking", kind: "input-retyped", path: "input.query" });
    expect(e.detail).toBe("input 'query' type changed: string → location");
  });

  it("output field removed → breaking", () => {
    const e = only(edit((_ir, t) => { t.output = t.output.filter((f) => f.name !== "total"); }));
    expect(e).toMatchObject({ severity: "breaking", kind: "output-removed", path: "output.total" });
  });

  it("output field added → compatible", () => {
    const e = only(edit((_ir, t) => { t.output.push({ name: "cursor", required: true, type: { kind: "scalar", semantic: "string" } }); }));
    expect(e).toMatchObject({ severity: "compatible", kind: "output-added", path: "output.cursor" });
  });

  it("output required → optional → breaking", () => {
    const e = only(edit((_ir, t) => { t.output[0]!.required = false; }));
    expect(e).toMatchObject({ severity: "breaking", kind: "output-now-optional", path: "output.items" });
  });

  it("output optional → required → compatible", () => {
    const e = only(edit((_ir, t) => { t.output[1]!.required = true; }));
    expect(e).toMatchObject({ severity: "compatible", kind: "output-now-required", path: "output.total" });
  });

  it("output type changed → breaking", () => {
    const e = only(edit((_ir, t) => { t.output[1]!.type = { kind: "scalar", semantic: "money" }; }));
    expect(e).toMatchObject({ severity: "breaking", kind: "output-retyped", path: "output.total" });
  });

  it("enum values are a set: reordering is no change, a new value is a retype", () => {
    const withEnum = edit((_ir, t) => { t.output[1]!.type = { kind: "scalar", semantic: "enum", values: ["a", "b"] }; });
    const reordered = edit((_ir, t) => { t.output[1]!.type = { kind: "scalar", semantic: "enum", values: ["b", "a"] }; });
    expect(diffIR(withEnum, reordered).entries).toEqual([]);
    const widened = edit((_ir, t) => { t.output[1]!.type = { kind: "scalar", semantic: "enum", values: ["a", "b", "c"] }; });
    expect(only(widened, withEnum)).toMatchObject({ severity: "breaking", kind: "output-retyped" });
  });

  describe("resource field changed — as the output row it implies, once, with affects", () => {
    it("removed → breaking, reported once on the resource, naming every capability that reaches it", () => {
      const e = only(edit((ir) => { ir.resources["shop.Item"] = ir.resources["shop.Item"]!.filter((f) => f.name !== "price"); }));
      expect(e).toMatchObject({ severity: "breaking", kind: "resource-field-changed", resource: "shop.Item", affects: ["shop.search"], path: "price" });
      expect(e.capabilityId).toBeUndefined();
      expect(e.detail).toBe("field 'price' removed (reaches shop.search)");
    });

    it("added → compatible; retyped → breaking; required → optional → breaking; optional → required → compatible", () => {
      const added = only(edit((ir) => { ir.resources["shop.Item"]!.push({ name: "sku", required: true, type: { kind: "scalar", semantic: "identifier" } }); }));
      expect(added).toMatchObject({ severity: "compatible", kind: "resource-field-changed", after: { required: true } });
      const retyped = only(edit((ir) => { ir.resources["shop.Item"]![1]!.type = { kind: "scalar", semantic: "quantity" }; }));
      expect(retyped).toMatchObject({ severity: "breaking", kind: "resource-field-changed", before: { kind: "scalar", semantic: "money" } });
      const loosened = only(edit((ir) => { ir.resources["shop.Item"]![0]!.required = false; }));
      expect(loosened).toMatchObject({ severity: "breaking", kind: "resource-field-changed", before: true, after: false });
      const tightened = only(edit((ir) => { ir.resources["shop.Item"]![2]!.required = true; }));
      expect(tightened).toMatchObject({ severity: "compatible", kind: "resource-field-changed" });
    });

    it("reaches transitively through a resource-typed field, but never through a ref: (identity)", () => {
      const e = only(edit((ir) => { ir.resources["shop.Seller"]!.push({ name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } }); }));
      // shop.lookup takes `ref: Seller` — a bare id, never expanded — so it is not affected.
      expect(e).toMatchObject({ resource: "shop.Seller", affects: ["shop.search"] });
    });

    it("a resource reached by an input takes the worse of the input and output rows", () => {
      // Output row alone: optional → required is compatible. Input row: breaking.
      const e = only(edit((ir) => { ir.resources["shop.Filter"]![0]!.required = true; }));
      expect(e).toMatchObject({ severity: "breaking", kind: "resource-field-changed", resource: "shop.Filter", affects: ["shop.search"] });
    });

    it("a resource no capability reaches is still classified by the output row (R-1)", () => {
      const e = only(edit((ir) => { delete ir.resources["shop.Unused"]; }));
      expect(e).toMatchObject({ severity: "breaking", kind: "resource-field-changed", resource: "shop.Unused", affects: [] });
      expect(e.detail).toBe("field 'x' removed (reached by no capability)");
    });

    it("the onError errorResource is part of the output and reaches too", () => {
      const withError = (ir: IR) => {
        ir.resources["shop.Error"] = [{ name: "code", required: true, type: { kind: "scalar", semantic: "string" } }];
        ir.tools[0]!.response!.onError = { errorResource: "shop.Error", when: { path: "$.error", exists: true } };
      };
      const before = edit(withError);
      const after = edit((ir) => { withError(ir); ir.resources["shop.Error"] = []; });
      expect(only(after, before)).toMatchObject({ severity: "breaking", resource: "shop.Error", affects: ["shop.search"] });
    });
  });

  it("policy rule allow narrowed, or deny gained a principal → breaking", () => {
    const narrowed = only(edit((_ir, t) => { t.policyRules![0]!.allow = ["partner:a"]; }));
    expect(narrowed).toMatchObject({ severity: "breaking", kind: "policy-narrowed", path: "policyRules.partners.allow" });
    expect(narrowed.detail).toBe("policy 'partners' narrowed: allow lost 'partner:b'");
    const denied = only(edit((_ir, t) => { t.policyRules![0]!.deny = ["banned", "partner:b"]; }));
    expect(denied).toMatchObject({ severity: "breaking", kind: "policy-narrowed", path: "policyRules.partners.deny" });
    // An unrestricted capability gaining an allow list is the sharpest narrowing there is.
    const fresh = only(edit((_ir, t) => { t.policyRules!.push({ id: "staff", allow: ["staff"] }); }));
    expect(fresh).toMatchObject({ severity: "breaking", kind: "policy-narrowed", path: "policyRules.staff.allow" });
  });

  it("policy rule allow widened, or deny lost a principal → notable", () => {
    const widened = only(edit((_ir, t) => { t.policyRules![0]!.allow = ["partner:a", "partner:b", "partner:*"]; }));
    expect(widened).toMatchObject({ severity: "notable", kind: "policy-widened" });
    expect(widened.detail).toBe("policy 'partners' widened: allow gained 'partner:*'");
    const undenied = only(edit((_ir, t) => { t.policyRules![0]!.deny = []; }));
    expect(undenied).toMatchObject({ severity: "notable", kind: "policy-widened", path: "policyRules.partners.deny" });
  });

  it("policy rule rateLimit tightened / loosened / removed → notable", () => {
    const tightened = only(edit((_ir, t) => { t.policyRules![0]!.rateLimit = { maxInvocations: 5, windowSeconds: 60 }; }));
    expect(tightened).toMatchObject({ severity: "notable", kind: "policy-rate-limit-changed", path: "policyRules.partners.rateLimit" });
    expect(tightened.detail).toBe("policy 'partners' rate limit tightened: 10 per 60s → 5 per 60s");
    const loosened = only(edit((_ir, t) => { t.policyRules![0]!.rateLimit = { maxInvocations: 100, windowSeconds: 60 }; }));
    expect(loosened).toMatchObject({ severity: "notable", kind: "policy-rate-limit-changed" });
    const removed = only(edit((_ir, t) => { delete t.policyRules![0]!.rateLimit; }));
    expect(removed).toMatchObject({ severity: "notable", kind: "policy-rate-limit-changed", after: undefined });
  });

  it("policy token list changed → notable", () => {
    const e = only(edit((_ir, t) => { t.policies = ["authenticated"]; }));
    expect(e).toMatchObject({ severity: "notable", kind: "policy-tokens-changed", path: "policies", before: [], after: ["authenticated"] });
  });

  it("description changed → compatible", () => {
    const e = only(edit((_ir, t) => { t.description = "Search everything."; }));
    expect(e).toMatchObject({ severity: "compatible", kind: "description-changed", path: "description" });
  });

  it("connector changed (binding-changed) → compatible", () => {
    const e = only(edit((_ir, t) => { t.connector = { type: "rest", rest: { method: "GET", path: "/v2/search" } }; }));
    expect(e).toMatchObject({ severity: "compatible", kind: "binding-changed", path: "connector" });
  });

  it("a connector that disappears leaves an advertised, uninvocable capability → breaking (R-1)", () => {
    const e = only(edit((_ir, t) => { delete t.connector; }));
    expect(e).toMatchObject({ severity: "breaking", kind: "binding-changed", path: "connector" });
    expect(only(base(), edit((_ir, t) => { delete t.connector; }))).toMatchObject({ severity: "compatible", kind: "binding-changed" });
  });

  it("origins added, changed or removed (binding-changed, path origins) → compatible", () => {
    const withOrigins = edit((_ir, t) => { t.origins = { pages: ["https://www.example.com"] }; });
    expect(only(withOrigins)).toMatchObject({ severity: "compatible", kind: "binding-changed", path: "origins" });
    expect(only(edit((_ir, t) => { t.origins = { pages: ["https://shop.example.com"] }; }), withOrigins)).toMatchObject({ kind: "binding-changed", path: "origins" });
    expect(only(base(), withOrigins)).toMatchObject({ kind: "binding-changed", path: "origins" });
    expect(diffIR(withOrigins, edit((_ir, t) => { t.origins = { pages: ["https://www.example.com"] }; })).entries).toEqual([]);
  });
});

describe("diffIR — shape of the result", () => {
  it("sorts by capability id (or resource name), then path, and counts by severity", () => {
    const after = edit((ir, t) => {
      t.effect = "write";
      t.description = "changed";
      t.input.push({ name: "a", required: true, type: { kind: "scalar", semantic: "string" } });
      ir.tools[1]!.lifecycle = "deprecated";
      ir.resources["shop.Item"]!.push({ name: "sku", required: false, type: { kind: "scalar", semantic: "string" } });
    });
    const diff = diffIR(base(), after);
    expect(diff.entries.map((e) => [e.capabilityId ?? e.resource, e.path])).toEqual([
      ["shop.Item", "sku"],
      ["shop.lookup", "lifecycle"],
      ["shop.search", "description"],
      ["shop.search", "effect"],
      ["shop.search", "input.a"],
    ]);
    expect(diff.summary).toEqual({ breaking: 2, notable: 1, compatible: 2 });
    expect(diff.before).toEqual({ company: "acme", version: "0" });
    expect(diffIR(base(), after)).toEqual(diff); // deterministic (D-9)
  });

  it("refuses two IRs of different version before evaluating any row", () => {
    const future = { ...base(), version: "1" } as unknown as IR;
    expect(() => diffIR(base(), future)).toThrow(/IR version '0' against IR version '1'/);
  });

  it("never reads contract (D-5)", () => {
    const withContract = edit((_ir, t) => { t.contract = { fingerprint: "sha256:aa", probeFixture: "f.json", shape: { "$": "object" } }; });
    const moved = edit((_ir, t) => { t.contract = { fingerprint: "sha256:bb", probeFixture: "g.json", shape: { "$": "array" } }; });
    expect(diffIR(withContract, moved).entries).toEqual([]);
    expect(diffIR(base(), moved).entries).toEqual([]);
  });

  it("normalises absent optional members to empty — a pre-policyRules artifact against itself is empty (R-5)", () => {
    // What a pre-#43 compiler emitted: no `policyRules`, no `extract`, no `response`, no `connector`.
    const old = base();
    for (const t of old.tools) {
      delete t.policyRules;
      delete t.extract;
      delete t.response;
      delete t.connector;
    }
    expect(diffIR(old, old).entries).toEqual([]);
    // … and against a newer artifact that spells the same absence as an empty list.
    const newer: IR = { ...old, tools: old.tools.map((t) => ({ ...t, policyRules: [], extract: [] })) };
    expect(diffIR(old, newer).entries).toEqual([]);
  });
});

describe("diffIR — the example manifests", () => {
  const dirs = readdirSync(manifests, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);

  it("finds every example", () => {
    expect(dirs.length).toBeGreaterThanOrEqual(3);
  });

  for (const name of dirs) {
    it(`${name}: a self-diff is empty`, () => {
      const res = load(join(manifests, name));
      expect(validateSemantics(res).filter((d) => d.severity === "error")).toEqual([]);
      const ir = compile(res);
      const diff = diffIR(ir, compile(load(join(manifests, name))));
      expect(diff.entries).toEqual([]);
      expect(diff.summary).toEqual({ breaking: 0, notable: 0, compatible: 0 });
    });
  }

  it("a diff over two built (contract-stripped) artifacts is complete", () => {
    const strip = (ir: IR): IR => ({ ...ir, tools: ir.tools.map(({ contract: _contract, ...t }) => t) });
    const before = compile(load(join(manifests, "tourism")));
    const after = structuredClone(before);
    after.resources["tourism.Stay"] = after.resources["tourism.Stay"]!.filter((f) => f.name !== "rating");
    after.tools[0]!.input.push({ name: "page", required: true, type: { kind: "scalar", semantic: "quantity" } });
    const full = diffIR(before, after);
    expect(before.tools.some((t) => t.contract)).toBe(true); // the fixture records one
    expect(full.entries.length).toBe(2);
    expect(diffIR(strip(before), strip(after))).toEqual(full);
    expect(full.entries.find((e) => e.resource === "tourism.Stay")).toMatchObject({ affects: ["tourism.search"], severity: "breaking" });
  });
});
