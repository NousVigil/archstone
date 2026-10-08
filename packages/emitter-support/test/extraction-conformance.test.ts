// #10 / ADR-0011 R-1 — the schema and the validator must agree.
//
// `extractionJsonSchema` produces the contract a model is TOLD to satisfy; `validateExtraction`
// decides whether it DID. If those two disagree, a deployer is telling the model one thing and
// judging it by another, and nothing surfaces it until someone reports an extraction that
// "should have worked". Construction mitigates half of this (one field walker). This file is
// the other half.
//
// Ajv is the ORACLE here and stays in the test. Shipping it into `emitter-support` is what
// ADR-0011 rejected: the validator reads the IR, not the schema derived from it.

import { describe, it, expect } from "vitest";
import Ajv2020 from "ajv/dist/2020.js";
import { SEMANTIC_TYPES, ORIGIN_BOUND_TYPES, type IRField, type IRResourceRegistry, type SemanticType } from "@archstone/compiler";
import { extractionJsonSchema, ExtractionSchemaError } from "../src/lowering";
import { validateExtraction } from "../src/extraction";

// Formats are registered as always-true, exactly as `@archstone/schema`'s loader does. ADR-0011
// states that `format` is an annotation in this increment and is not enforced — so the oracle
// must not enforce it either, or this file would report a divergence the decision already owns.
// A consumer who validates our emitted schema with `ajv-formats` gets a STRICTER check than
// `validateExtraction`; that is the stated limitation, not a defect this test can find.
function ajv(): Ajv2020 {
  const instance = new Ajv2020({ allErrors: true, strict: false });
  for (const f of ["date", "date-time", "uri", "email"]) instance.addFormat(f, () => true);
  return instance;
}

const LEAF: IRResourceRegistry = {
  Leaf: [
    { name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } },
    { name: "note", required: false, type: { kind: "scalar", semantic: "text" } },
  ],
};

interface Case {
  field: IRField;
  resources?: IRResourceRegistry;
  /** Documents that must be accepted by BOTH. Declared keys only — see the divergence block. */
  accepted: unknown[];
  /** Documents that must be refused by BOTH. */
  refused: unknown[];
}

const scalar = (semantic: SemanticType, values?: string[]): IRField => ({
  name: "v",
  required: true,
  type: { kind: "scalar", semantic, ...(values ? { values } : {}) },
});

const CASES: Record<string, Case> = {
  location: { field: scalar("location"), accepted: ["Brașov"], refused: [7, null, {}] },
  identifier: { field: scalar("identifier"), accepted: ["htl_1"], refused: [7, []] },
  string: { field: scalar("string"), accepted: ["x"], refused: [7] },
  text: { field: scalar("text"), accepted: ["a longer sentence"], refused: [false] },
  // `format` is annotation-only on both sides — an ill-formed date string is accepted by each.
  date: { field: scalar("date"), accepted: ["2026-01-01", "not a date"], refused: [20260101] },
  datetime: { field: scalar("datetime"), accepted: ["2026-01-01T00:00:00Z"], refused: [0] },
  "time-slot": { field: scalar("time-slot"), accepted: ["2026-01-01T09:00:00Z"], refused: [9] },
  quantity: { field: scalar("quantity"), accepted: [3, 3.5, 0, -1], refused: ["3", true, null] },
  enum: {
    field: scalar("enum", ["open", "closed"]),
    accepted: ["open", "closed"],
    refused: ["pending", "", 1],
  },
  "preference-set": {
    field: scalar("preference-set"),
    accepted: [[], ["sea"], ["sea", "quiet"]],
    refused: ["sea", [1], [null]],
  },
  money: {
    field: scalar("money"),
    accepted: [{ amount: 10, currency: "EUR" }, { amount: 0.5, currency: "RON" }],
    refused: [{ amount: 10 }, { currency: "EUR" }, { amount: "10", currency: "EUR" }, "10 EUR"],
  },
  party: {
    field: scalar("party"),
    accepted: [{ adults: 2 }, { adults: 2, children: 1 }, { adults: 1, children: 0 }],
    refused: [{ children: 1 }, { adults: 2.5 }, { adults: "2" }, { adults: 2, children: 1.5 }, 2],
  },
  "date-range": {
    field: scalar("date-range"),
    accepted: [{ from: "2026-01-01", to: "2026-01-05" }],
    refused: [{ from: "2026-01-01" }, { to: "2026-01-05" }, { from: 1, to: 2 }, "jan"],
  },
  "ref (identity)": {
    field: { name: "v", required: true, type: { kind: "resource", name: "Leaf", identity: true } },
    resources: LEAF,
    accepted: ["leaf_1"],
    refused: [{ id: "leaf_1" }, 1],
  },
  "resource-typed": {
    field: { name: "v", required: true, type: { kind: "resource", name: "Leaf" } },
    resources: LEAF,
    accepted: [{ id: "leaf_1" }, { id: "leaf_1", note: "n" }],
    refused: [{ note: "n" }, { id: 1 }, "leaf_1", []],
  },
  collection: {
    field: { name: "v", required: true, type: { kind: "collection", of: "Leaf" } },
    resources: LEAF,
    accepted: [[], [{ id: "a" }], [{ id: "a" }, { id: "b", note: "n" }]],
    refused: [{ id: "a" }, [{ note: "n" }], ["a"]],
  },
};

describe("#10: every semantic type and field form is covered", () => {
  it("the table names every member of SEMANTIC_TYPES — adding one without a case fails here", () => {
    // An origin-bound type is never an extraction target, so it has no accept/refuse case: it is
    // covered by the refusal test below instead.
    const covered = new Set([...Object.keys(CASES), ...Object.keys(ORIGIN_BOUND_TYPES)]);
    const uncovered = [...SEMANTIC_TYPES].filter((t) => !covered.has(t));
    expect(uncovered).toEqual([]);
  });

  // S-C.6: `web-page` is output-only — refused as an extraction target by the schema AND by the
  // validator (which asks the schema), naming the field, through the existing error mechanism.
  it("every origin-bound type is refused by both, naming the field (S-C.6)", () => {
    for (const semantic of Object.keys(ORIGIN_BOUND_TYPES) as SemanticType[]) {
      const field: IRField = { name: "listingUrl", required: false, type: { kind: "scalar", semantic } };
      expect(() => extractionJsonSchema([field])).toThrow(ExtractionSchemaError);
      expect(() => extractionJsonSchema([field])).toThrow(new RegExp(`field 'listingUrl' is of type ${semantic}`));
      expect(() => validateExtraction([field], { listingUrl: "https://www.example.com/x" })).toThrow(ExtractionSchemaError);
      // …and inside a resource, where the walk reaches it the same way.
      const nested: IRResourceRegistry = { Stay: [{ name: "listingUrl", required: true, type: { kind: "scalar", semantic } }] };
      const viaResource: IRField = { name: "stay", required: true, type: { kind: "resource", name: "Stay" } };
      expect(() => extractionJsonSchema([viaResource], nested)).toThrow(/field 'listingUrl'/);
    }
  });

  it("and all three composite field forms", () => {
    for (const form of ["ref (identity)", "resource-typed", "collection"]) {
      expect(Object.keys(CASES)).toContain(form);
    }
  });
});

describe("#10: the emitted schema and the validator agree, over declared keys", () => {
  for (const [label, c] of Object.entries(CASES)) {
    const resources = c.resources ?? {};
    const schema = extractionJsonSchema([c.field], resources);
    const accepts = ajv().compile(schema);

    it(`${label} — accepted by both`, () => {
      for (const v of c.accepted) {
        const document = { v };
        const bySchema = accepts(document) as boolean;
        const byValidator = validateExtraction([c.field], document, resources).status !== "violation";
        expect({ case: label, bySchema, byValidator }).toEqual({ case: label, bySchema: true, byValidator: true });
      }
    });

    it(`${label} — refused by both`, () => {
      for (const v of c.refused) {
        const document = { v };
        const bySchema = accepts(document) as boolean;
        const byValidator = validateExtraction([c.field], document, resources).status !== "violation";
        expect({ case: label, bySchema, byValidator }).toEqual({ case: label, bySchema: false, byValidator: false });
      }
    });

    it(`${label} — an absent required field is refused by both`, () => {
      expect(accepts({}) as boolean).toBe(false);
      expect(validateExtraction([c.field], {}, resources).status).toBe("violation");
    });
  }

  it("an absent OPTIONAL field is accepted by both — degraded is not a violation", () => {
    const fields: IRField[] = [
      { name: "a", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "b", required: false, type: { kind: "scalar", semantic: "text" } },
    ];
    const accepts = ajv().compile(extractionJsonSchema(fields));
    expect(accepts({ a: "x" }) as boolean).toBe(true);
    expect(validateExtraction(fields, { a: "x" }).status).toBe("degraded");
  });
});

describe("#10: the ONE place they diverge, and it is the decision, not a bug", () => {
  // The schema closes every object, so Ajv REFUSES an undeclared key — which is right: it is what
  // the model is told. `validateExtraction` DROPS and names it instead — also right, and argued
  // in ADR-0011: a model is a generator, an extra key is a fact about this inference, and failing
  // the whole extraction on it makes the boundary unusable against real models. The two are not
  // in conflict; they are the two halves of "tell the model no, and never propagate it if it
  // does". Pinned here so the divergence stays deliberate.
  const fields: IRField[] = [{ name: "leaf", required: true, type: { kind: "resource", name: "Leaf" } }];
  const listFields: IRField[] = [{ name: "leaves", required: true, type: { kind: "collection", of: "Leaf" } }];

  it("at the root", () => {
    const accepts = ajv().compile(extractionJsonSchema(fields, LEAF));
    // `note` is supplied so the only thing in play is the undeclared key: an absent optional
    // would legitimately report `degraded` and blur what this test is about.
    const document = { leaf: { id: "a", note: "n" }, extra: 1 };
    expect(accepts(document) as boolean).toBe(false);
    const r = validateExtraction(fields, document, LEAF);
    expect(r.status).toBe("ok");
    expect(r.undeclared).toEqual(["extra"]);
    expect(r.data).toEqual({ leaf: { id: "a", note: "n" } });
  });

  it("inside an expanded resource field", () => {
    const accepts = ajv().compile(extractionJsonSchema(fields, LEAF));
    const document = { leaf: { id: "a", extra: 1 } };
    expect(accepts(document) as boolean).toBe(false);
    const r = validateExtraction(fields, document, LEAF);
    expect(r.undeclared).toEqual(["leaf.extra"]);
    expect(JSON.stringify(r.data)).not.toContain("extra");
  });

  it("inside collection items", () => {
    const accepts = ajv().compile(extractionJsonSchema(listFields, LEAF));
    const document = { leaves: [{ id: "a" }, { id: "b", extra: 1 }] };
    expect(accepts(document) as boolean).toBe(false);
    const r = validateExtraction(listFields, document, LEAF);
    expect(r.undeclared).toEqual(["leaves[1].extra"]);
    expect(JSON.stringify(r.data)).not.toContain("extra");
  });

  it("inside a composite semantic value", () => {
    const money: IRField[] = [{ name: "price", required: true, type: { kind: "scalar", semantic: "money" } }];
    const accepts = ajv().compile(extractionJsonSchema(money));
    const document = { price: { amount: 1, currency: "EUR", netRate: 0.7 } };
    expect(accepts(document) as boolean).toBe(false);
    const r = validateExtraction(money, document);
    expect(r.undeclared).toEqual(["price.netRate"]);
    expect(r.data).toEqual({ price: { amount: 1, currency: "EUR" } });
  });
});
