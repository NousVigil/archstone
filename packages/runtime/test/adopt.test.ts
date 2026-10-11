import { describe, it, expect } from "vitest";
import type { IRResourceRegistry, IRTool, ShapeDiff } from "@archstone/compiler";
import { planAdoption, adoptable } from "../src/adopt";

const resources: IRResourceRegistry = {
  Stay: [
    { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
    { name: "location", required: true, type: { kind: "scalar", semantic: "location" } },
    { name: "pricePerNight", required: true, type: { kind: "scalar", semantic: "quantity" } },
    { name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } },
  ],
};

function tool(collection: string | null = "$.stays[*]"): IRTool {
  return {
    id: "tourism.search",
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [{ name: "stays", required: true, type: { kind: "collection", of: "Stay" } }],
    connector: { type: "rest", rest: { baseUrl: "https://x.test", method: "POST", path: "/search" } },
    response: {
      resource: "Stay",
      field: "stays",
      ...(collection ? { collection } : {}),
      fields: [
        { name: "name", path: "$.name" },
        { name: "location", path: "$.location" },
        { name: "pricePerNight", path: "$.pricePerNight" },
        { name: "rating", path: "$.rating" },
      ],
    },
  };
}

const drift = (added: ShapeDiff["added"]): ShapeDiff => ({ added, removed: [], retyped: [] });

describe("planAdoption — what can be declared (ADD-117 D-5, §3)", () => {
  it("adopts a string as text and a number as quantity", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.stays[].boardType", type: "string" },
        { path: "$.stays[].distanceToBeachM", type: "number" },
      ]),
      resources,
    );
    expect(adoptable(plan)).toEqual([
      { adoptable: true, path: "$.stays[].boardType", field: "boardType", itemPath: "$.boardType", observed: "string", semantic: "text", kind: "resource-field" },
      { adoptable: true, path: "$.stays[].distanceToBeachM", field: "distanceToBeachM", itemPath: "$.distanceToBeachM", observed: "number", semantic: "quantity", kind: "resource-field" },
    ]);
    expect(plan.resource).toBe("Stay");
  });

  it("does NOT infer date from a string, however date-shaped the field name is", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].freeCancellationUntil", type: "string" }]), resources);
    // The shape records types, never values — there is nothing to pattern-match, and guessing
    // from a name is the guess this project refuses. The human can widen it afterwards.
    expect(adoptable(plan)[0].semantic).toBe("text");
  });

  it("does NOT infer money from a number", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].net", type: "number" }]), resources);
    expect(adoptable(plan)[0].semantic).toBe("quantity");
  });

  it("offers an observed JSON boolean as boolean: the shape records the type, not a value", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].refundable", type: "boolean" }]), resources);
    expect(adoptable(plan)).toHaveLength(1);
    expect(adoptable(plan)[0]).toMatchObject({ field: "refundable", observed: "boolean", semantic: "boolean", kind: "resource-field" });
  });

  it("offers an observed array of booleans as list: boolean", () => {
    const plan = planAdoption(
      tool(),
      drift([{ path: "$.flags", type: "array" }, { path: "$.flags[]", type: "boolean" }]),
      resources,
    );
    expect(adoptable(plan).map((c) => ({ field: c.field, semantic: c.semantic, kind: c.kind }))).toEqual([
      { field: "flags", semantic: "boolean", kind: "output-array" },
    ]);
  });

  it("refuses a structure rather than declaring it", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.stays[].amenities", type: "array" },
        { path: "$.stays[].address", type: "object" },
        { path: "$.stays[].cancelledAt", type: "null" },
      ]),
      resources,
    );
    expect(plan.candidates.map((c) => (c.adoptable ? "adopted" : c.reason))).toEqual([
      "not-a-leaf",
      "not-a-leaf",
      "not-a-leaf",
    ]);
  });

  it("refuses a nested path", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].address.city", type: "string" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "nested" });
  });

  it("refuses a path outside the mapped collection", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.totalResults", type: "number" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "outside-collection" });
  });

  it("refuses a field the capability already declares — by mapping or by resource", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.stays[].rating", type: "number" },
        { path: "$.stays[].location", type: "string" },
      ]),
      resources,
    );
    expect(plan.candidates.every((c) => !c.adoptable && c.reason === "already-declared")).toBe(true);
  });

  it("every refusal carries a sentence, so nothing is silently dropped", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.stays[].amenities", type: "array" },
        { path: "$.total", type: "number" },
      ]),
      resources,
    );
    for (const c of plan.candidates) {
      if (!c.adoptable) expect(c.detail.length).toBeGreaterThan(10);
    }
    expect(plan.candidates).toHaveLength(2);
  });

  it("handles a single-object response, whose fields hang off the root", () => {
    const plan = planAdoption(tool(null), drift([{ path: "$.boardType", type: "string" }]), resources);
    expect(adoptable(plan)[0]).toMatchObject({ field: "boardType", itemPath: "$.boardType" });
  });

  it("considers only added paths — removed and retyped are out of scope (ADR-0008)", () => {
    const plan = planAdoption(
      tool(),
      {
        added: [],
        removed: [{ path: "$.stays[].net", type: "number" }],
        retyped: [{ path: "$.stays[].pricePerNight", from: "number", to: "string" }],
      },
      resources,
    );
    expect(plan.candidates).toEqual([]);
  });

  it("plans nothing for a capability with no response mapping", () => {
    const t = tool();
    delete t.response;
    expect(planAdoption(t, drift([{ path: "$.x", type: "string" }]), resources)).toEqual({
      capabilityId: "tourism.search",
      candidates: [],
    });
  });
});

// #82 (ADD-12 §8.2): an observed field outside the collection whose value is consistently an
// array of one scalar type is adoptable via `extract:`; an array of objects is refused, with a
// reason distinct from `not-a-leaf`.
describe("planAdoption — scalar arrays outside the collection (#82, ADD-12 §8.2)", () => {
  it("offers a scalar array field as adoptable, not refused as not-a-leaf", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.warnings", type: "array" },
        { path: "$.warnings[]", type: "string" },
      ]),
      resources,
    );
    const offer = adoptable(plan).find((c) => c.field === "warnings");
    expect(offer).toMatchObject({ field: "warnings", itemPath: "$.warnings[*]", observed: "array", semantic: "text" });
  });

  it("a numeric scalar array field adopts as `quantity`", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.scores", type: "array" },
        { path: "$.scores[]", type: "number" },
      ]),
      resources,
    );
    expect(adoptable(plan).find((c) => c.field === "scores")).toMatchObject({ semantic: "quantity" });
  });

  it("refuses an array of objects with a reason distinct from not-a-leaf, naming the row-shape gap", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.nearby", type: "array" },
        { path: "$.nearby[]", type: "object" },
      ]),
      resources,
    );
    const refusal = plan.candidates.find((c) => !c.adoptable && c.path === "$.nearby");
    expect(refusal).toMatchObject({ adoptable: false, reason: "array-of-objects-unresolved" });
    expect((refusal as { detail: string }).detail).not.toContain("structure rather than a value"); // not-a-leaf's wording
  });

  it("refuses an empty (never-populated) array with a reason distinct from not-a-leaf, naming the element type as unknown", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.warnings", type: "array" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "array-element-type-unknown" });
  });

  it("does not re-offer/refuse the array's own element-detail entry as a separate candidate", () => {
    const plan = planAdoption(
      tool(),
      drift([
        { path: "$.warnings", type: "array" },
        { path: "$.warnings[]", type: "string" },
      ]),
      resources,
    );
    expect(plan.candidates).toHaveLength(1);
  });
});

// #290 regression: the motivating case (`response: { resource, map }`, NO `collection:`) fell
// through to the collection-item path, which has no notion of an array field at all —
// `$.warnings` refused `not-a-leaf`, `$.warnings[]` refused `nested`. Fixed for all three tool
// shapes a `response:`-adjacent binding can take: WITH a collection (already covered above),
// WITHOUT one, and no `response:` at all.
describe("planAdoption — scalar-array adoption across all three tool shapes (#290)", () => {
  const bothEntries: ShapeDiff["added"] = [
    { path: "$.warnings", type: "array" },
    { path: "$.warnings[]", type: "string" },
  ];

  it("response: WITHOUT a collection — the $.x + $.x[] pair collapses to one output-array candidate", () => {
    const plan = planAdoption(tool(null), drift(bothEntries), resources);
    expect(plan.candidates).toHaveLength(1);
    expect(adoptable(plan)[0]).toMatchObject({ field: "warnings", itemPath: "$.warnings[*]", semantic: "text", kind: "output-array" });
  });

  it("response: WITHOUT a collection — $.x[] alone (no base entry) still adopts", () => {
    const plan = planAdoption(tool(null), drift([{ path: "$.warnings[]", type: "string" }]), resources);
    expect(plan.candidates).toHaveLength(1);
    expect(adoptable(plan)[0]).toMatchObject({ field: "warnings", itemPath: "$.warnings[*]", semantic: "text", kind: "output-array" });
  });

  it("response: WITHOUT a collection — a genuinely empty array is refused with a clear, distinct reason", () => {
    const plan = planAdoption(tool(null), drift([{ path: "$.warnings", type: "array" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "array-element-type-unknown" });
  });

  it("response: WITHOUT a collection — a plain scalar root field is still a resource-field candidate, unaffected", () => {
    const plan = planAdoption(tool(null), drift([{ path: "$.boardType", type: "string" }]), resources);
    expect(adoptable(plan)[0]).toMatchObject({ field: "boardType", itemPath: "$.boardType", kind: "resource-field" });
  });

  it("NO response: at all (extract:-only tool) — the $.x + $.x[] pair still collapses to one candidate", () => {
    const t = tool();
    delete t.response;
    const plan = planAdoption(t, drift(bothEntries), resources);
    expect(plan.candidates).toHaveLength(1);
    expect(adoptable(plan)[0]).toMatchObject({ field: "warnings", itemPath: "$.warnings[*]", semantic: "text", kind: "output-array" });
  });

  it("NO response: at all — $.x[] alone (no base entry) still adopts", () => {
    const t = tool();
    delete t.response;
    const plan = planAdoption(t, drift([{ path: "$.warnings[]", type: "string" }]), resources);
    expect(adoptable(plan)[0]).toMatchObject({ field: "warnings", itemPath: "$.warnings[*]", kind: "output-array" });
  });

  it("NO response: at all — a genuinely empty array is refused with a clear, distinct reason", () => {
    const t = tool();
    delete t.response;
    const plan = planAdoption(t, drift([{ path: "$.warnings", type: "array" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "array-element-type-unknown" });
  });

  it("NO response: at all — a plain non-array field is silently skipped (no resource to write it into)", () => {
    const t = tool();
    delete t.response;
    const plan = planAdoption(t, drift([{ path: "$.boardType", type: "string" }]), resources);
    expect(plan.candidates).toEqual([]);
  });

  it("response: WITH a collection — an array nested INSIDE a collection item stays out of scope, unaffected", () => {
    const plan = planAdoption(tool(), drift([{ path: "$.stays[].amenities", type: "array" }]), resources);
    expect(plan.candidates[0]).toMatchObject({ adoptable: false, reason: "not-a-leaf" });
  });
});
