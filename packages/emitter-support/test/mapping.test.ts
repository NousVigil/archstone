import { describe, it, expect } from "vitest";
import type { IRField, IRResourceRegistry, IRTool } from "@archstone/compiler";
import { applyResponseMapping, contractViolationMessage, degradedNotes } from "../src/mapping";

// Required-ness is the resource registry's, NOT the mapping's (single source of truth):
// name + price required, tag optional.
const resources: IRResourceRegistry = {
  "shop.Widget": [
    { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
    { name: "price", required: true, type: { kind: "scalar", semantic: "quantity" } },
    { name: "tag", required: false, type: { kind: "scalar", semantic: "text" } },
  ],
};

function tool(response: IRTool["response"]): IRTool {
  return {
    id: "shop.search",
    description: "",
    effect: "read",
    provider: "",
    policies: [],
    lifecycle: "stable",
    input: [],
    output: [{ name: "items", required: true, type: { kind: "collection", of: "shop.Widget" } }],
    response,
  };
}

const collectionMapping: IRTool["response"] = {
  resource: "shop.Widget",
  field: "items",
  collection: "$.results[*]",
  fields: [
    { name: "name", path: "$.n" },
    { name: "price", path: "$.p" },
    { name: "tag", path: "$.t" },
  ],
};

describe("applyResponseMapping (ADD-12)", () => {
  it("OK: maps each item to the resource, dropping unmapped provider fields", () => {
    const body = { results: [{ n: "Widget A", p: 9, t: "sale", junk: "dropped" }] };
    const r = applyResponseMapping(tool(collectionMapping), body, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: [{ name: "Widget A", price: 9, tag: "sale" }] });
  });

  it("DEGRADED: an absent OPTIONAL field is omitted, result still returned", () => {
    const body = { results: [{ n: "Widget A", p: 9 }] }; // no tag
    const r = applyResponseMapping(tool(collectionMapping), body, resources);
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["tag"]);
    expect(r.data).toEqual({ items: [{ name: "Widget A", price: 9 }] });
  });

  it("VIOLATION: an absent REQUIRED field fails closed — no data returned", () => {
    const body = { results: [{ n: "Widget A" }] }; // no price
    const r = applyResponseMapping(tool(collectionMapping), body, resources);
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["price"]);
    expect(r.data).toBeUndefined();
  });

  it("empty collection is OK (emptiness is not drift)", () => {
    const r = applyResponseMapping(tool(collectionMapping), { results: [] }, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: [] });
  });

  it("requiredOverride:false loosens a required field to DEGRADED instead of VIOLATION", () => {
    const loosened: IRTool["response"] = {
      ...collectionMapping,
      fields: [
        { name: "name", path: "$.n" },
        { name: "price", path: "$.p", requiredOverride: false },
        { name: "tag", path: "$.t" },
      ],
    };
    const body = { results: [{ n: "Widget A", t: "sale" }] }; // no price, but loosened
    const r = applyResponseMapping(tool(loosened), body, resources);
    expect(r.status).toBe("degraded");
    expect(r.degraded).toContain("price");
  });

  it("no `collection`: maps a single object at the body root", () => {
    const single: IRTool["response"] = {
      resource: "shop.Widget",
      field: "items",
      fields: [
        { name: "name", path: "$.n" },
        { name: "price", path: "$.p" },
      ],
    };
    const r = applyResponseMapping(tool(single), { n: "Solo", p: 5 }, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: { name: "Solo", price: 5 } });
  });
});

// `tool.extract` (extends ADD-12 with a sibling binding block, per the accepted architecture
// decision): additional SCALAR output fields read straight off the raw body ROOT — never
// `mapping.collection`-scoped items — with required-ness sourced from `tool.output` directly
// (there is no resource registry entry for a scalar field).
describe("applyResponseMapping — extract (extends ADD-12)", () => {
  function toolWith(opts: { output: IRField[]; response?: IRTool["response"]; extract?: IRTool["extract"] }): IRTool {
    return {
      id: "shop.search",
      description: "",
      effect: "read",
      provider: "",
      policies: [],
      lifecycle: "stable",
      input: [],
      output: opts.output,
      response: opts.response,
      extract: opts.extract,
    };
  }

  const countOutput: IRField[] = [{ name: "count", required: true, type: { kind: "scalar", semantic: "quantity" } }];

  it("extract:-only (no response: at all): OK maps the scalar field off the body root", () => {
    const t = toolWith({ output: countOutput, extract: [{ name: "count", path: "$.total" }] });
    const r = applyResponseMapping(t, { total: 42 }, {});
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ count: 42 });
  });

  it("extract:-only: required-ness comes from `tool.output` directly — a missing REQUIRED field is a VIOLATION", () => {
    const t = toolWith({ output: countOutput, extract: [{ name: "count", path: "$.total" }] });
    const r = applyResponseMapping(t, {}, {});
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["count"]);
    expect(r.data).toBeUndefined();
  });

  it("extract:-only: an absent OPTIONAL field DEGRADES, per `tool.output`'s own required: false", () => {
    const optionalOutput: IRField[] = [{ name: "count", required: false, type: { kind: "scalar", semantic: "quantity" } }];
    const t = toolWith({ output: optionalOutput, extract: [{ name: "count", path: "$.total" }] });
    const r = applyResponseMapping(t, {}, {});
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["count"]);
    expect(r.data).toEqual({});
  });

  it("extract:'s own requiredOverride:false loosens a required output field to DEGRADED", () => {
    const t = toolWith({ output: countOutput, extract: [{ name: "count", path: "$.total", requiredOverride: false }] });
    const r = applyResponseMapping(t, {}, {});
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["count"]);
  });

  it("response: + extract: together populate a single merged structuredContent (one MappingResult)", () => {
    const output: IRField[] = [
      { name: "items", required: true, type: { kind: "collection", of: "shop.Widget" } },
      { name: "count", required: true, type: { kind: "scalar", semantic: "quantity" } },
    ];
    const t = toolWith({ output, response: collectionMapping, extract: [{ name: "count", path: "$.total" }] });
    const body = { results: [{ n: "Widget A", p: 9, t: "sale" }], total: 1 };
    const r = applyResponseMapping(t, body, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: [{ name: "Widget A", price: 9, tag: "sale" }], count: 1 });
  });

  it("a missing required field from EITHER side merges into ONE violation, not two separate errors", () => {
    const output: IRField[] = [
      { name: "items", required: true, type: { kind: "collection", of: "shop.Widget" } },
      { name: "count", required: true, type: { kind: "scalar", semantic: "quantity" } },
    ];
    const t = toolWith({ output, response: collectionMapping, extract: [{ name: "count", path: "$.total" }] });
    // `price` (response:'s Widget field) AND `count` (extract:'s output field) both absent.
    const body = { results: [{ n: "Widget A", t: "sale" }] };
    const r = applyResponseMapping(t, body, resources);
    expect(r.status).toBe("violation");
    expect([...(r.missing ?? [])].sort()).toEqual(["count", "price"]);
    expect(r.data).toBeUndefined();
  });

  it("extract: reads the body ROOT, never `mapping.collection`-scoped items", () => {
    const output: IRField[] = [
      { name: "items", required: true, type: { kind: "collection", of: "shop.Widget" } },
      { name: "count", required: true, type: { kind: "scalar", semantic: "quantity" } },
    ];
    const t = toolWith({ output, response: collectionMapping, extract: [{ name: "count", path: "$.total" }] });
    // `total` sits at the body root, a sibling of `results` — NOT inside any result item.
    const body = { results: [{ n: "Widget A", p: 9, t: "sale", total: 999 }], total: 1 };
    const r = applyResponseMapping(t, body, resources);
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ items: [{ name: "Widget A", price: 9, tag: "sale" }], count: 1 });
  });
});

// #81 (ADD-12 §8.1) — row-level errors: a `response.onError` discriminator classifies each
// collection item before the success mapping runs. `shop.RowError` mirrors the "code/message"
// error shape the ADD names.
const errorResources: IRResourceRegistry = {
  ...resources,
  "shop.RowError": [
    { name: "code", required: true, type: { kind: "scalar", semantic: "identifier" } },
    { name: "message", required: false, type: { kind: "scalar", semantic: "text" } },
  ],
};

const onErrorMapping: IRTool["response"] = {
  ...collectionMapping,
  onError: { errorResource: "shop.RowError", when: { path: "$.code", exists: true } },
};

describe("applyResponseMapping — onError row-level errors (#81, ADD-12 §8.1)", () => {
  it("a mixed collection returns the valid row fully mapped, and is not a whole-response violation", () => {
    const body = {
      results: [
        { n: "Widget A", p: 9, t: "sale" },
        { code: "out-of-stock", message: "no longer available" },
      ],
    };
    const r = applyResponseMapping(tool(onErrorMapping), body, errorResources);
    expect(r.status).toBe("ok");
    const items = r.data!.items as Record<string, unknown>[];
    expect(items).toContainEqual({ $row: "ok", name: "Widget A", price: 9, tag: "sale" });
  });

  it("a declared error row is present, distinguishable from a succeeding row, without loosening required fields", () => {
    const body = {
      results: [
        { n: "Widget A", p: 9, t: "sale" },
        { code: "out-of-stock", message: "no longer available" },
      ],
    };
    const r = applyResponseMapping(tool(onErrorMapping), body, errorResources);
    const items = r.data!.items as Record<string, unknown>[];
    expect(items).toContainEqual({ $row: "error", code: "out-of-stock", message: "no longer available" });
    expect(items).toHaveLength(2);
  });

  it("a row missing a required field, not declared as a row-level error, is a PER-ROW violation — other rows unaffected", () => {
    const body = {
      results: [
        { n: "Widget A", p: 9, t: "sale" }, // valid
        { n: "Widget B" }, // missing required `price`, no `code` — matches neither shape
      ],
    };
    const r = applyResponseMapping(tool(onErrorMapping), body, errorResources);
    expect(r.status).toBe("ok"); // at least one usable row — not a whole-response violation
    const items = r.data!.items as Record<string, unknown>[];
    expect(items).toEqual([{ $row: "ok", name: "Widget A", price: 9, tag: "sale" }]);
    expect(r.rowViolations).toEqual([{ index: 1, missing: ["price"] }]);
  });

  it("every row failing (all declared error rows) reports zero usable rows, distinguishable from an empty collection", () => {
    const body = { results: [{ code: "a" }, { code: "b" }] };
    const r = applyResponseMapping(tool(onErrorMapping), body, errorResources);
    expect(r.status).toBe("ok");
    const items = r.data!.items as Record<string, unknown>[];
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.$row === "error")).toBe(true);
  });

  it("a successful row is never loosened to accommodate error rows elsewhere in the same call", () => {
    const body = {
      results: [
        { code: "a" }, // declared error row — usable on its own terms
        { n: "Widget B" }, // missing required `price` — a per-row violation, NOT a DEGRADED pass
      ],
    };
    const r = applyResponseMapping(tool(onErrorMapping), body, errorResources);
    // The error row is usable, so this is not a whole-response violation — but `price` on the
    // second row is still enforced as required: it is named as a per-row violation, never
    // silently dropped to DEGRADED and never present in `data` with `price` missing.
    expect(r.status).toBe("ok");
    expect(r.rowViolations).toEqual([{ index: 1, missing: ["price"] }]);
    const items = r.data!.items as Record<string, unknown>[];
    expect(items.some((i) => i.name === "Widget B")).toBe(false);
  });

  it("every row failing for real (no usable row at all) IS a whole-response violation", () => {
    const body = { results: [{ n: "Widget B" }] }; // missing required `price`, no `code` either
    const r = applyResponseMapping(tool(onErrorMapping), body, errorResources);
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["price"]);
    expect(r.rowViolations).toEqual([{ index: 0, missing: ["price"] }]);
  });

  it("the mixed collection AC scenario: one valid row, one declared error row, one successful-shape row missing a required field", () => {
    const body = {
      results: [
        { n: "Widget A", p: 9, t: "sale" }, // valid
        { code: "out-of-stock", message: "no longer available" }, // declared error row
        { n: "Widget C" }, // successful shape, missing required `price`
      ],
    };
    const r = applyResponseMapping(tool(onErrorMapping), body, errorResources);
    expect(r.status).toBe("ok"); // one usable row keeps this from being a whole-response violation
    const items = r.data!.items as Record<string, unknown>[];
    expect(items).toEqual([
      { $row: "ok", name: "Widget A", price: 9, tag: "sale" },
      { $row: "error", code: "out-of-stock", message: "no longer available" },
    ]);
    expect(r.rowViolations).toEqual([{ index: 2, missing: ["price"] }]);
  });

  it("without onError declared, a row missing a required field still whole-response VIOLATES exactly as before #81", () => {
    const body = { results: [{ n: "Widget A", p: 9, t: "sale" }, { n: "Widget B" }] };
    const r = applyResponseMapping(tool(collectionMapping), body, resources);
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["price"]);
    expect(r.rowViolations).toBeUndefined();
  });

  it("onError.map reads a renamed error field by its own JSONPath, not the same-named-key default", () => {
    const renamedOnErrorMapping: IRTool["response"] = {
      ...collectionMapping,
      onError: {
        errorResource: "shop.RowError",
        when: { path: "$.errCode", exists: true },
        map: [
          { name: "code", path: "$.errCode" }, // provider calls it `errCode`, not `code`
          { name: "message", path: "$.errMsg" },
        ],
      },
    };
    const body = { results: [{ errCode: "out-of-stock", errMsg: "no longer available" }] };
    const r = applyResponseMapping(tool(renamedOnErrorMapping), body, errorResources);
    expect(r.status).toBe("ok");
    const items = r.data!.items as Record<string, unknown>[];
    expect(items).toEqual([{ $row: "error", code: "out-of-stock", message: "no longer available" }]);
  });

  it("onError.map omitting a field falls back to the same-named-key default for that field only", () => {
    const partialMapMapping: IRTool["response"] = {
      ...collectionMapping,
      onError: {
        errorResource: "shop.RowError",
        when: { path: "$.errCode", exists: true },
        map: [{ name: "code", path: "$.errCode" }], // `message` has no entry — falls back to $.message
      },
    };
    const body = { results: [{ errCode: "out-of-stock", message: "no longer available" }] };
    const r = applyResponseMapping(tool(partialMapMapping), body, errorResources);
    const items = r.data!.items as Record<string, unknown>[];
    expect(items).toEqual([{ $row: "error", code: "out-of-stock", message: "no longer available" }]);
  });
});

// #82 (ADD-12 §8.2) — arrays outside the collection: `extract:` admits an array of one scalar
// semantic type; all matches, not just the first.
describe("applyResponseMapping — extract: scalar arrays (#82, ADD-12 §8.2)", () => {
  const warningsOutput: IRField[] = [{ name: "warnings", required: true, type: { kind: "list", items: "text" } }];

  function toolWithArray(output: IRField[], extract: IRTool["extract"]): IRTool {
    return {
      id: "shop.search",
      description: "",
      effect: "read",
      provider: "",
      policies: [],
      lifecycle: "stable",
      input: [],
      output,
      extract,
    };
  }

  it("a scalar array field is declarable and returns item for item", () => {
    const t = toolWithArray(warningsOutput, [{ name: "warnings", path: "$.warnings[*]" }]);
    const r = applyResponseMapping(t, { warnings: ["low stock", "price changed"] }, {});
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ warnings: ["low stock", "price changed"] });
  });

  it("an empty array is OK, not DEGRADED — the field is present as an empty array", () => {
    const t = toolWithArray(warningsOutput, [{ name: "warnings", path: "$.warnings[*]" }]);
    const r = applyResponseMapping(t, { warnings: [] }, {});
    expect(r.status).toBe("ok");
    expect(r.data).toEqual({ warnings: [] });
  });

  it("an undeclared array never reaches structuredContent", () => {
    const t = toolWithArray(warningsOutput, [{ name: "warnings", path: "$.warnings[*]" }]);
    const r = applyResponseMapping(t, { warnings: ["a"], extra: ["b", "c"] }, {});
    expect(r.data).toEqual({ warnings: ["a"] });
    expect(Object.keys(r.data!)).not.toContain("extra");
  });
});

// #196: a value that is present but the wrong shape is `invalid`, not `missing`.
describe("applyResponseMapping — present-but-malformed is invalid, not missing (#196)", () => {
  // price is `money` here: a bare string is the wrong shape for it (#176).
  const moneyResources: IRResourceRegistry = {
    "shop.Widget": [
      { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
      { name: "tag", required: false, type: { kind: "scalar", semantic: "money" } },
    ],
  };

  it("VIOLATION: a required field of the wrong shape is named invalid, with its expected type, not missing", () => {
    const body = { results: [{ n: "Widget A", p: "129.00" }] };
    const r = applyResponseMapping(tool(collectionMapping), body, moneyResources);
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual([]);
    expect(r.invalid).toEqual([{ field: "price", expected: "money" }]);
  });

  it("VIOLATION: absent and malformed required fields are listed separately", () => {
    const body = { results: [{ p: { nested: true } }] }; // name absent, price an object
    const r = applyResponseMapping(tool(collectionMapping), body, resources);
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["name"]);
    expect(r.invalid).toEqual([{ field: "price", expected: "quantity" }]);
  });

  it("VIOLATION: an absent required field leaves `invalid` off the result", () => {
    const r = applyResponseMapping(tool(collectionMapping), { results: [{ n: "A" }] }, resources);
    expect(r.missing).toEqual(["price"]);
    expect(r.invalid).toBeUndefined();
  });

  it("never carries the offending value", () => {
    const r = applyResponseMapping(tool(collectionMapping), { results: [{ n: "A", p: "SECRET-VALUE" }] }, moneyResources);
    expect(JSON.stringify(r)).not.toContain("SECRET-VALUE");
  });

  it("DEGRADED: a malformed optional field is named invalid, and stays in `degraded` with the absent ones", () => {
    const withTagged: IRResourceRegistry = {
      "shop.Widget": [
        ...resources["shop.Widget"]!.slice(0, 2),
        { name: "tag", required: false, type: { kind: "scalar", semantic: "money" } },
        { name: "note", required: false, type: { kind: "scalar", semantic: "text" } },
      ],
    };
    const mapping: IRTool["response"] = {
      ...collectionMapping!,
      fields: [...collectionMapping!.fields, { name: "note", path: "$.o" }],
    };
    const r = applyResponseMapping(tool(mapping), { results: [{ n: "A", p: 1, t: "not-money" }] }, withTagged);
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["note", "tag"]);
    expect(r.invalid).toEqual([{ field: "tag", expected: "money" }]);
    expect(r.data).toEqual({ items: [{ name: "A", price: 1 }] });
  });
});

describe("contractViolationMessage — invalid (#196)", () => {
  it("names invalid fields with the expected type, apart from missing ones", () => {
    const text = contractViolationMessage("shop.search", ["name"], [], [{ field: "price", expected: "quantity" }]);
    expect(text).toBe(
      "contract violation: capability 'shop.search' — provider response is missing required field(s): name; and has a value of the wrong shape in field(s): price (expected quantity). Declared output shape not met; raw body withheld.",
    );
  });
  it("is byte-identical to the old sentence when nothing is invalid", () => {
    expect(contractViolationMessage("shop.search", ["name"])).toBe(
      "contract violation: capability 'shop.search' — provider response is missing required field(s): name. Declared output shape not met; raw body withheld.",
    );
  });
});

describe("degradedNotes (#196)", () => {
  it("separates optional fields that were not sent from those sent in the wrong shape", () => {
    expect(degradedNotes(["note", "tag"], [{ field: "tag", expected: "money" }])).toEqual([
      "note: optional field(s) absent (degraded): note",
      "note: optional field(s) present but of the wrong shape, omitted (degraded): tag (expected money)",
    ]);
  });
  it("is the old single note when nothing is invalid", () => {
    expect(degradedNotes(["note"])).toEqual(["note: optional field(s) absent (degraded): note"]);
  });
});
