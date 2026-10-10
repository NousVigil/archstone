import { describe, it, expect } from "vitest";
import { toolName, inputJsonSchema, objectJsonSchema, extractionJsonSchema, ExtractionSchemaError } from "../src/lowering";
import type { IRField, IRResourceRegistry } from "@archstone/compiler";

describe("toolName", () => {
  it("sanitizes capability ids to MCP tool names", () => {
    expect(toolName("tourism.search")).toBe("tourism_search");
  });
});

describe("#16 NF-7: inputJsonSchema lowers IR field kinds (crafted IR)", () => {
  it("an enum scalar lowers to { type: 'string', enum: [...] }", () => {
    const fields: IRField[] = [
      { name: "status", required: true, type: { kind: "scalar", semantic: "enum", values: ["open", "closed"] } },
    ];
    const schema = inputJsonSchema(fields) as {
      properties: Record<string, { type: string; enum?: string[] }>;
      required?: string[];
    };
    expect(schema.properties.status).toMatchObject({ type: "string", enum: ["open", "closed"] });
    expect(schema.required).toContain("status");
  });

  it("a ref/resource field lowers to { type: 'object' }", () => {
    const fields: IRField[] = [{ name: "hotel", required: false, type: { kind: "resource", name: "Hotel" } }];
    const schema = inputJsonSchema(fields) as { properties: Record<string, { type: string }>; required?: string[] };
    expect(schema.properties.hotel.type).toBe("object");
    expect(schema.required ?? []).not.toContain("hotel"); // required: false
  });

  it("a collection field lowers to { type: 'array' }", () => {
    const fields: IRField[] = [{ name: "rooms", required: true, type: { kind: "collection", of: "Room" } }];
    const schema = inputJsonSchema(fields) as {
      properties: Record<string, { type: string; items?: { type: string } }>;
    };
    expect(schema.properties.rooms.type).toBe("array");
    expect(schema.properties.rooms.items?.type).toBe("object");
  });
});

// #63 — IRType.kind "list": a LIST of one scalar semantic type, distinct from `collection`
// (a list of a resource, tested above).
describe("#63: inputJsonSchema lowers IRType.kind 'list'", () => {
  it("a list of `string` lowers to { type: 'array', items: { type: 'string' } }", () => {
    const fields: IRField[] = [{ name: "tags", required: false, type: { kind: "list", items: "string" } }];
    const schema = inputJsonSchema(fields) as { properties: Record<string, { type: string; items?: { type: string } }> };
    expect(schema.properties.tags.type).toBe("array");
    expect(schema.properties.tags.items?.type).toBe("string");
  });

  it("a list of `enum` carries the closed value set on `items`", () => {
    const fields: IRField[] = [{ name: "tags", required: true, type: { kind: "list", items: "enum", values: ["a", "b"] } }];
    const schema = inputJsonSchema(fields) as { properties: Record<string, { items?: { enum?: string[] } }> };
    expect(schema.properties.tags.items?.enum).toEqual(["a", "b"]);
  });

  it("a list field's own `description` wins over the item semantic's generic text", () => {
    const fields: IRField[] = [{ name: "tags", required: false, description: "Filter by tag.", type: { kind: "list", items: "string" } }];
    const schema = inputJsonSchema(fields) as { properties: Record<string, { description?: string }> };
    expect(schema.properties.tags.description).toBe("Filter by tag.");
  });
});

describe("#25 identity fields lower to a bare string, not the full resource", () => {
  it("a `ref:`-originated (identity: true) field lowers to { type: 'string' }, not the object", () => {
    const resources: IRResourceRegistry = {
      FrameProfile: [
        { name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } },
        { name: "material", required: true, type: { kind: "scalar", semantic: "string" } },
      ],
    };
    const fields: IRField[] = [
      {
        name: "frameProfileId",
        required: true,
        description: "The frame profile to price.",
        type: { kind: "resource", name: "FrameProfile", identity: true },
      },
    ];
    const schema = inputJsonSchema(fields, resources) as {
      properties: Record<string, { type: string; description?: string; properties?: unknown }>;
    };
    expect(schema.properties.frameProfileId).toEqual({ type: "string", description: "The frame profile to price." });
    expect(schema.properties.frameProfileId.properties).toBeUndefined();
  });

  it("a nested `ref:`-originated field inside a resource's own field map also lowers to a bare string (R-3)", () => {
    // Order.customerId: { ref: Customer } — the resource registry itself holds a resource
    // whose field is identity-shaped, exercised via the same lowerFields/fieldJsonSchema path.
    const resources: IRResourceRegistry = {
      Customer: [{ name: "name", required: true, type: { kind: "scalar", semantic: "string" } }],
      Order: [
        { name: "reference", required: true, type: { kind: "scalar", semantic: "identifier" } },
        { name: "customerId", required: true, type: { kind: "resource", name: "Customer", identity: true } },
      ],
    };
    const schema = objectJsonSchema(
      [{ name: "order", required: true, type: { kind: "resource", name: "Order" } }],
      resources,
    ) as { properties: Record<string, { properties: Record<string, { type: string; properties?: unknown }> }> };
    const order = schema.properties.order;
    expect(order.properties.customerId).toEqual({ type: "string" });
    expect(order.properties.customerId.properties).toBeUndefined();
  });
});

describe("objectJsonSchema — resource cycle guard", () => {
  it("cycle-guards a self-referential resource (no infinite expansion)", () => {
    // Node → Node: the emitter must stop at a generic object on the second visit.
    const resources: IRResourceRegistry = {
      Node: [
        { name: "id", required: true, type: { kind: "scalar", semantic: "identifier" } },
        { name: "next", required: false, type: { kind: "resource", name: "Node" } },
      ],
    };
    const schema = objectJsonSchema(
      [{ name: "root", required: true, type: { kind: "resource", name: "Node" } }],
      resources,
    ) as { properties: Record<string, { properties: Record<string, { properties?: unknown; type: string }> }> };
    const root = schema.properties.root;
    expect(root.properties.id.type).toBe("string"); // first expansion is typed
    expect(root.properties.next.type).toBe("object"); // recursion stops at a generic object
    expect(root.properties.next.properties).toBeUndefined();
  });
});

describe("#8: a semantic type's description never overwrites the authored one", () => {
  // `location` is the only semantic type that ships a description today, which is why this
  // defect looked like working code on every other field. The assertions below pin the RULE,
  // not the one case: the second test proves the fallback still applies, so a semantic type
  // that gains a description later is covered in both directions.
  const described: IRField[] = [
    {
      name: "location",
      required: true,
      description: "Where the stay is — city, region, or address.",
      type: { kind: "scalar", semantic: "location" },
    },
  ];

  it("keeps the manifest's own sentence", () => {
    const schema = objectJsonSchema(described) as { properties: Record<string, { description: string }> };
    expect(schema.properties.location.description).toBe("Where the stay is — city, region, or address.");
  });

  it("falls back to the semantic type's text when the field declares none", () => {
    const bare: IRField[] = [{ name: "location", required: true, type: { kind: "scalar", semantic: "location" } }];
    const schema = objectJsonSchema(bare) as { properties: Record<string, { description?: string }> };
    expect(schema.properties.location.description).toBe("A place — city, region, or address.");
  });

  it("overrides the description only — every other key stays semantic-owned", () => {
    const money: IRField[] = [
      { name: "price", required: true, description: "What the guest pays.", type: { kind: "scalar", semantic: "money" } },
    ];
    const schema = objectJsonSchema(money) as {
      properties: Record<string, { description: string; type: string; required: string[] }>;
    };
    expect(schema.properties.price.description).toBe("What the guest pays.");
    expect(schema.properties.price.type).toBe("object"); // not clobbered by `base`
    expect(schema.properties.price.required).toEqual(["amount", "currency"]);
  });

  it("emits `description` first, so key order is unchanged for fields this does not affect", () => {
    const schema = objectJsonSchema(described) as { properties: Record<string, object> };
    expect(Object.keys(schema.properties.location)).toEqual(["description", "type"]);
  });
});

describe("#7 / ADR-0011: extractionJsonSchema — a CLOSED schema, alongside the open one", () => {
  const resources: IRResourceRegistry = {
    "tourism.Stay": [
      { name: "name", required: true, type: { kind: "scalar", semantic: "text" } },
      { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
    ],
  };

  it("closes the root object", () => {
    const schema = extractionJsonSchema([{ name: "n", required: true, type: { kind: "scalar", semantic: "text" } }]);
    expect(schema.additionalProperties).toBe(false);
  });

  it("closes an expanded resource-typed field", () => {
    const fields: IRField[] = [{ name: "stay", required: true, type: { kind: "resource", name: "tourism.Stay" } }];
    const schema = extractionJsonSchema(fields, resources) as {
      properties: Record<string, { additionalProperties?: boolean }>;
    };
    expect(schema.properties.stay.additionalProperties).toBe(false);
  });

  it("closes the items of a collection", () => {
    const fields: IRField[] = [{ name: "stays", required: true, type: { kind: "collection", of: "tourism.Stay" } }];
    const schema = extractionJsonSchema(fields, resources) as {
      properties: Record<string, { items: { additionalProperties?: boolean } }>;
    };
    expect(schema.properties.stays.items.additionalProperties).toBe(false);
  });

  it("closes the composite semantic shapes (money, party, date-range)", () => {
    const fields: IRField[] = [
      { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
      { name: "who", required: true, type: { kind: "scalar", semantic: "party" } },
      { name: "when", required: true, type: { kind: "scalar", semantic: "date-range" } },
    ];
    const schema = extractionJsonSchema(fields) as { properties: Record<string, { additionalProperties?: boolean }> };
    for (const f of ["price", "who", "when"]) expect(schema.properties[f].additionalProperties).toBe(false);
  });

  it("leaves a `ref:` field a bare string — identity is never expanded, so nothing to close", () => {
    const fields: IRField[] = [{ name: "hotel", required: true, type: { kind: "resource", name: "Hotel", identity: true } }];
    const schema = extractionJsonSchema(fields, resources) as { properties: Record<string, { type: string }> };
    expect(schema.properties.hotel.type).toBe("string");
  });

  it("agrees with the open lowering on type, required and description — only closure differs", () => {
    const fields: IRField[] = [
      { name: "name", required: true, description: "The property's display name.", type: { kind: "scalar", semantic: "text" } },
      { name: "rating", required: false, type: { kind: "scalar", semantic: "quantity" } },
    ];
    const open = objectJsonSchema(fields) as Record<string, unknown>;
    const strict = extractionJsonSchema(fields) as Record<string, unknown>;
    const { additionalProperties, ...rest } = strict;
    expect(additionalProperties).toBe(false);
    expect(rest).toEqual(open);
  });

  it("refuses a self-referential resource instead of degrading to an open object", () => {
    const cyclic: IRResourceRegistry = {
      Node: [{ name: "child", required: false, type: { kind: "resource", name: "Node" } }],
    };
    const fields: IRField[] = [{ name: "root", required: true, type: { kind: "resource", name: "Node" } }];
    expect(() => extractionJsonSchema(fields, cyclic)).toThrow(ExtractionSchemaError);
    // …where the open lowering still degrades, unchanged.
    expect(() => objectJsonSchema(fields, cyclic)).not.toThrow();
  });

  it("refuses an unknown resource name instead of emitting an open object", () => {
    const fields: IRField[] = [{ name: "x", required: true, type: { kind: "resource", name: "Nope" } }];
    expect(() => extractionJsonSchema(fields, {})).toThrow(/not in the registry/);
  });
});

describe("#7: the open lowering is untouched by the strict one", () => {
  // The pin. `objectJsonSchema`/`inputJsonSchema` output is a published wire shape reached by
  // every shipped manifest — this fails if adding the extraction path changed a byte of it.
  it("emits no additionalProperties anywhere, at any depth", () => {
    const resources: IRResourceRegistry = {
      Room: [{ name: "beds", required: true, type: { kind: "scalar", semantic: "quantity" } }],
    };
    const fields: IRField[] = [
      { name: "rooms", required: true, type: { kind: "collection", of: "Room" } },
      { name: "price", required: true, type: { kind: "scalar", semantic: "money" } },
      { name: "who", required: false, type: { kind: "scalar", semantic: "party" } },
    ];
    expect(JSON.stringify(objectJsonSchema(fields, resources))).not.toContain("additionalProperties");
  });

  // #195: the INPUT lowering is deliberately no longer open — `validateInput` refuses undeclared
  // keys, so the advertised schema says so. The output lowering above is untouched.
  it("#195: the input lowering is closed at every object level and bounds party counts at 0", () => {
    const resources: IRResourceRegistry = {
      Room: [{ name: "beds", required: true, type: { kind: "scalar", semantic: "quantity" } }],
    };
    const fields: IRField[] = [
      { name: "rooms", required: true, type: { kind: "collection", of: "Room" } },
      { name: "who", required: false, type: { kind: "scalar", semantic: "party" } },
    ];
    const s = inputJsonSchema(fields, resources) as {
      additionalProperties?: boolean;
      properties: { rooms: { items: { additionalProperties?: boolean } }; who: { additionalProperties?: boolean; properties: Record<string, { minimum?: number }> } };
    };
    expect(s.additionalProperties).toBe(false);
    expect(s.properties.rooms.items.additionalProperties).toBe(false);
    expect(s.properties.who.additionalProperties).toBe(false);
    expect(s.properties.who.properties.adults.minimum).toBe(0);
    expect(s.properties.who.properties.children.minimum).toBe(0);
    // ...and the output lowering of the same party carries no minimum.
    expect(JSON.stringify(objectJsonSchema(fields, resources))).not.toContain("minimum");
  });

  it("#195: an unknown resource in an input still degrades to a generic object rather than throwing", () => {
    const fields: IRField[] = [{ name: "x", required: true, type: { kind: "resource", name: "Nope" } }];
    expect(() => inputJsonSchema(fields, {})).not.toThrow();
  });

  it("still degrades an unknown resource to a generic object rather than throwing", () => {
    const fields: IRField[] = [{ name: "x", required: true, type: { kind: "resource", name: "Nope" } }];
    const schema = objectJsonSchema(fields, {}) as { properties: Record<string, { type: string }> };
    expect(schema.properties.x.type).toBe("object");
  });
});

// #81 (ADD-12 §8.1): a `response.onError` discriminator widens the outputSchema of the ONE
// collection field it targets to admit both row shapes.
describe("objectJsonSchema — onError row shapes in outputSchema (#81, ADD-12 §8.1)", () => {
  const resources: IRResourceRegistry = {
    Widget: [{ name: "name", required: true, type: { kind: "scalar", semantic: "text" } }],
    RowError: [
      { name: "code", required: true, type: { kind: "scalar", semantic: "identifier" } },
      { name: "message", required: false, type: { kind: "scalar", semantic: "text" } },
    ],
  };
  const fields: IRField[] = [{ name: "items", required: true, type: { kind: "collection", of: "Widget" } }];

  it("admits both a success-row and an error-row shape for collection items", () => {
    const schema = objectJsonSchema(fields, resources, undefined, { field: "items", errorResource: "RowError" }) as {
      properties: { items: { type: string; items: { oneOf: Record<string, unknown>[] } } };
    };
    const itemsSchema = schema.properties.items;
    expect(itemsSchema.type).toBe("array");
    expect(itemsSchema.items.oneOf).toHaveLength(2);
    const [success, error] = itemsSchema.items.oneOf as { properties: Record<string, unknown>; required: string[] }[];
    expect(success.properties).toHaveProperty("name");
    expect(success.properties).toHaveProperty("$row", { const: "ok" });
    expect(success.required).toEqual(["name", "$row"]);
    expect(error.properties).toHaveProperty("code");
    expect(error.properties).toHaveProperty("$row", { const: "error" });
    expect(error.required).toEqual(["code", "$row"]);
  });

  it("leaves every other field, and a tool with no onError, untouched", () => {
    const plain = objectJsonSchema(fields, resources) as { properties: { items: { items: Record<string, unknown> } } };
    expect(plain.properties.items.items).not.toHaveProperty("oneOf");
  });
});
