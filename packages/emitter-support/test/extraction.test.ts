import { describe, it, expect } from "vitest";
import { validateExtraction } from "../src/extraction";
import { ExtractionSchemaError } from "../src/lowering";
import type { IRField, IRResourceRegistry } from "@archstone/compiler";

const STAY: IRField[] = [
  { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
  { name: "location", required: true, type: { kind: "scalar", semantic: "location" } },
  { name: "pricePerNight", required: true, type: { kind: "scalar", semantic: "quantity" } },
  { name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } },
];

const ok = { name: "Casa Verde", location: "Brașov", pricePerNight: 320, rating: 4.6 };

describe("#9 / ADR-0011: the three outcomes", () => {
  it("ok — every declared field present and well-shaped", () => {
    expect(validateExtraction(STAY, ok)).toEqual({ status: "ok", data: ok });
  });

  it("degraded — an absent OPTIONAL field is returned without it", () => {
    const { rating: _dropped, ...withoutRating } = ok;
    const r = validateExtraction(STAY, withoutRating);
    expect(r.status).toBe("degraded");
    expect(r.degraded).toEqual(["rating"]);
    expect(r.data).toEqual(withoutRating);
  });

  it("violation — an absent REQUIRED field never degrades, and withholds the document whole", () => {
    const { pricePerNight: _dropped, ...withoutPrice } = ok;
    const r = validateExtraction(STAY, withoutPrice);
    expect(r.status).toBe("violation");
    expect(r.missing).toEqual(["pricePerNight"]);
    expect(r.data).toBeUndefined(); // as a contract violation withholds a provider's raw body
    expect(r.degraded ?? []).not.toContain("pricePerNight");
  });

  it("null is treated as absent, not as a value", () => {
    expect(validateExtraction(STAY, { ...ok, pricePerNight: null }).missing).toEqual(["pricePerNight"]);
  });
});

describe("#9: undeclared keys are dropped and named, and never change status", () => {
  it("drops an undeclared key from data and names it", () => {
    const r = validateExtraction(STAY, { ...ok, confidence: 0.91, internalNotes: "…" });
    expect(r.status).toBe("ok");
    expect(r.undeclared).toEqual(["confidence", "internalNotes"]);
    expect(r.data).toEqual(ok);
    expect(Object.keys(r.data!)).not.toContain("confidence");
  });

  it("drops one nested inside a collection item — depth is not an escape hatch", () => {
    const resources: IRResourceRegistry = { "tourism.Stay": STAY };
    const fields: IRField[] = [{ name: "stays", required: true, type: { kind: "collection", of: "tourism.Stay" } }];
    const r = validateExtraction(fields, { stays: [{ ...ok, secretMargin: 41 }] }, resources);
    expect(r.status).toBe("ok");
    expect(r.undeclared).toEqual(["stays[0].secretMargin"]);
    expect(JSON.stringify(r.data)).not.toContain("secretMargin");
  });

  it("drops one nested inside a composite semantic value", () => {
    const fields: IRField[] = [{ name: "price", required: true, type: { kind: "scalar", semantic: "money" } }];
    const r = validateExtraction(fields, { price: { amount: 10, currency: "EUR", netRate: 7 } });
    expect(r.undeclared).toEqual(["price.netRate"]);
    expect(r.data).toEqual({ price: { amount: 10, currency: "EUR" } });
  });
});

describe("#9: no coercion, on any type", () => {
  it('a stringified number is a violation, not a number', () => {
    const r = validateExtraction(STAY, { ...ok, pricePerNight: "320" });
    expect(r.status).toBe("violation");
    expect(r.invalid).toEqual(["pricePerNight: expected number"]);
  });

  it("NaN and Infinity are not numbers", () => {
    expect(validateExtraction(STAY, { ...ok, pricePerNight: NaN }).status).toBe("violation");
    expect(validateExtraction(STAY, { ...ok, pricePerNight: Infinity }).status).toBe("violation");
  });

  it("a non-integer where the lowering says integer is a violation (party.adults)", () => {
    const fields: IRField[] = [{ name: "who", required: true, type: { kind: "scalar", semantic: "party" } }];
    expect(validateExtraction(fields, { who: { adults: 2.5 } }).invalid).toEqual(["who.adults: expected integer"]);
    expect(validateExtraction(fields, { who: { adults: 2 } }).status).toBe("ok");
  });

  it("an out-of-set enum value is a violation", () => {
    const fields: IRField[] = [
      { name: "status", required: true, type: { kind: "scalar", semantic: "enum", values: ["open", "closed"] } },
    ];
    expect(validateExtraction(fields, { status: "pending" }).status).toBe("violation");
    expect(validateExtraction(fields, { status: "open" }).status).toBe("ok");
  });

  it("a `ref:` field must be a bare id, never an expanded object", () => {
    const fields: IRField[] = [{ name: "hotel", required: true, type: { kind: "resource", name: "Hotel", identity: true } }];
    expect(validateExtraction(fields, { hotel: "htl_1" }).status).toBe("ok");
    expect(validateExtraction(fields, { hotel: { id: "htl_1" } }).invalid).toEqual(["hotel: expected string"]);
  });

  it("a preference-set must be an array of string", () => {
    const fields: IRField[] = [{ name: "tags", required: true, type: { kind: "scalar", semantic: "preference-set" } }];
    expect(validateExtraction(fields, { tags: ["sea", "quiet"] }).status).toBe("ok");
    expect(validateExtraction(fields, { tags: ["sea", 3] }).status).toBe("violation");
  });
});

describe("#9: no message ever carries a value from the document", () => {
  // The acceptance criterion, as a test rather than a promise. Extraction input is the most
  // sensitive text in the deployment; an error that echoes it writes it into whatever catches it.
  const CANARY = "MRN-88131-SECRET";

  it("survives a canary in every field form", () => {
    const resources: IRResourceRegistry = { R: [{ name: "leaf", required: true, type: { kind: "scalar", semantic: "text" } }] };
    const fields: IRField[] = [
      { name: "q", required: true, type: { kind: "scalar", semantic: "quantity" } },
      { name: "e", required: true, type: { kind: "scalar", semantic: "enum", values: ["a", "b"] } },
      { name: "m", required: true, type: { kind: "scalar", semantic: "money" } },
      { name: "p", required: true, type: { kind: "scalar", semantic: "preference-set" } },
      { name: "r", required: true, type: { kind: "resource", name: "R" } },
      { name: "c", required: true, type: { kind: "collection", of: "R" } },
      { name: "id", required: true, type: { kind: "resource", name: "R", identity: true } },
    ];
    const document = {
      q: CANARY, e: CANARY, m: { amount: CANARY, currency: CANARY }, p: [CANARY],
      r: { leaf: 1 }, c: [{ leaf: 1 }], id: 7,
    };
    const r = validateExtraction(fields, document, resources);
    expect(r.status).toBe("violation");
    expect(JSON.stringify(r)).not.toContain(CANARY);
    expect(r.invalid!.length).toBeGreaterThan(0); // it really did fail, on every one of them
  });

  it("names the enum's size, never its declared values or the model's answer", () => {
    const fields: IRField[] = [
      { name: "s", required: true, type: { kind: "scalar", semantic: "enum", values: ["alpha", "beta"] } },
    ];
    const r = validateExtraction(fields, { s: CANARY });
    expect(r.invalid).toEqual(["s: expected one of 2 declared enum values"]);
  });
});

describe("#9: malformed documents fail closed rather than throwing", () => {
  for (const [label, document] of [
    ["null", null],
    ["a string", "not an object"],
    ["a number", 7],
    ["an array", [{ ...ok }]],
  ] as const) {
    it(`${label} → violation`, () => {
      const r = validateExtraction(STAY, document);
      expect(r.status).toBe("violation");
      expect(r.invalid).toEqual(["(root): expected object"]);
      expect(r.data).toBeUndefined();
    });
  }

  it("a nested object where a collection is declared is a violation, not a silent single item", () => {
    const resources: IRResourceRegistry = { "tourism.Stay": STAY };
    const fields: IRField[] = [{ name: "stays", required: true, type: { kind: "collection", of: "tourism.Stay" } }];
    expect(validateExtraction(fields, { stays: ok }, resources).invalid).toEqual(["stays: expected array"]);
  });
});

describe("#9: refuses exactly what extractionJsonSchema refuses", () => {
  it("a self-referential resource", () => {
    const cyclic: IRResourceRegistry = { Node: [{ name: "child", required: false, type: { kind: "resource", name: "Node" } }] };
    const fields: IRField[] = [{ name: "root", required: true, type: { kind: "resource", name: "Node" } }];
    expect(() => validateExtraction(fields, { root: {} }, cyclic)).toThrow(ExtractionSchemaError);
  });

  it("an unknown resource name", () => {
    const fields: IRField[] = [{ name: "x", required: true, type: { kind: "resource", name: "Nope" } }];
    expect(() => validateExtraction(fields, { x: {} }, {})).toThrow(ExtractionSchemaError);
  });
});

describe("#212: a boolean field is an extraction target; nothing is repaired into one", () => {
  const FLAG: IRField[] = [{ name: "breakfast", required: true, type: { kind: "scalar", semantic: "boolean" } }];
  it("true and false are kept", () => {
    expect(validateExtraction(FLAG, { breakfast: true })).toEqual({ status: "ok", data: { breakfast: true } });
    expect(validateExtraction(FLAG, { breakfast: false })).toEqual({ status: "ok", data: { breakfast: false } });
  });
  it("'true', 1 and null are refused without echoing the answer", () => {
    for (const v of ["true", 1]) {
      const r = validateExtraction(FLAG, { breakfast: v });
      expect(r.status).toBe("violation");
      expect(JSON.stringify(r)).toContain("breakfast: expected boolean");
      expect(JSON.stringify(r)).not.toContain('"true"');
    }
    expect(validateExtraction(FLAG, { breakfast: null }).missing).toEqual(["breakfast"]);
  });
});
