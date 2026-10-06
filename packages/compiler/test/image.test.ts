// `image` — the second origin-bound semantic type (issue #152). Authoring and validation
// (S-A1..A8, A11, A12, A14, A15), the IR lowering of `origins.images` (fixed key order,
// byte-identity when undeclared) and the IR diff. The runtime check lives in emitter-support's
// `image.test.ts`.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "@archstone/schema";
import { validateSemantics, type Diagnostic } from "../src/validate";
import { compile } from "../src/compile";
import { diffIR } from "../src/ir-diff";
import { ORIGIN_BOUND_TYPES, originListOf } from "../src/ir";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

const errors = (d: Diagnostic[]) => d.filter((x) => x.severity === "error");
const withCode = (d: Diagnostic[], code: string) => d.filter((x) => x.code === code);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Spec {
  input?: string;
  output?: string;
  resources?: Record<string, string>;
  /** Appended verbatim under `binding:` (response:/extract:/origins:). Omit for no binding. */
  binding?: string;
}

function manifest(spec: Spec): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-image-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
    "shop.search.capability.yaml":
      `capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: store\n` + (spec.input ?? "") + (spec.output ?? ""),
  };
  for (const [name, fields] of Object.entries(spec.resources ?? {})) {
    files[`shop.${name}.resource.yaml`] = `resource:\n  name: shop.${name}\n  fields:\n${fields}`;
  }
  if (spec.binding !== undefined) {
    files["bindings/shop.search.binding.yaml"] =
      `binding:\n  capabilityId: shop.search\n  connector:\n    type: rest\n    rest:\n      baseUrl: "\${API_URL}"\n      method: GET\n      path: /search\n` +
      spec.binding;
  }
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const IMAGES = '  origins:\n    images:\n      - "https://img.example.com"\n';
const PAGES = '  origins:\n    pages:\n      - "https://www.example.com"\n';
const BOTH = '  origins:\n    pages:\n      - "https://www.example.com"\n    images:\n      - "https://img.example.com"\n';
const origins = (...entries: string[]) => `  origins:\n    images:\n${entries.map((e) => `      - ${JSON.stringify(e)}\n`).join("")}`;

const SCALAR_OUTPUT = "  output:\n    cover:\n      type: image\n";
const SCALAR_EXTRACT = '  extract:\n    cover: "$.cover"\n';
const LIST_OUTPUT = "  output:\n    photos:\n      list: image\n";
const LIST_EXTRACT = '  extract:\n    photos: "$.photos[*]"\n';

/** A collection of a Room resource carrying `photos` (a list) and optionally a scalar `cover`. */
const ROOM_LIST = "    name:\n      type: text\n    photos:\n      list: image\n";
const ROOM_SCALAR = "    name:\n      type: text\n    cover:\n      type: image\n";
const ROOMS_OUTPUT = "  output:\n    rooms:\n      collection: Room\n";
const roomsResponse = (extra: string) => `  response:\n    collection: "$.results[*]"\n    resource: Room\n    map:\n      name: "$.name"\n${extra}`;

describe("S-A1 / S-A2: an image output with declared origins.images compiles", () => {
  it("S-A1: scalar — compiles, the field is a scalar image, the tool carries origins.images", () => {
    const model = load(manifest({ output: SCALAR_OUTPUT, binding: SCALAR_EXTRACT + IMAGES }));
    expect(model.issues).toEqual([]);
    expect(errors(validateSemantics(model))).toEqual([]);
    const tool = compile(model).tools[0];
    expect(tool.origins).toEqual({ images: ["https://img.example.com"] });
    expect(tool.output.find((f) => f.name === "cover")?.type).toEqual({ kind: "scalar", semantic: "image" });
  });

  it("S-A2: list — compiles, the field is a list of image", () => {
    const model = load(manifest({ output: LIST_OUTPUT, binding: LIST_EXTRACT + IMAGES }));
    expect(model.issues).toEqual([]);
    expect(errors(validateSemantics(model))).toEqual([]);
    expect(compile(model).tools[0].output.find((f) => f.name === "photos")?.type).toEqual({ kind: "list", items: "image" });
  });

  it("S-A2 (absence): a list: image with no origins at all is an error, not silently accepted", () => {
    const found = withCode(validateSemantics(load(manifest({ output: LIST_OUTPUT, binding: LIST_EXTRACT }))), "image-no-origins");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain("'photos'");
  });
});

describe("IR: byte-identity and origin key order", () => {
  for (const name of ["tourism", "booking", "bank"]) {
    it(`${name}: the IR is byte-identical to the pinned golden (no images member anywhere)`, () => {
      const ir = compile(load(join(manifests, name)));
      expect(ir.tools.some((t) => "origins" in t)).toBe(false);
      expect(JSON.stringify(ir, null, 2) + "\n").toBe(readFileSync(join(here, "fixtures/ir", `${name}.ir.json`), "utf8"));
    });
  }

  it("a pages-only manifest yields origins with no images member", () => {
    const tool = compile(load(manifest({ output: "  output:\n    listingUrl:\n      type: web-page\n", binding: '  extract:\n    listingUrl: "$.url"\n' + PAGES }))).tools[0];
    expect(tool.origins).toEqual({ pages: ["https://www.example.com"] });
    expect("images" in (tool.origins ?? {})).toBe(false);
  });

  it("origins are emitted in fixed key order (pages, images) whatever order the author wrote them in", () => {
    const output = "  output:\n    listingUrl:\n      type: web-page\n    cover:\n      type: image\n";
    const extract = '  extract:\n    listingUrl: "$.url"\n    cover: "$.cover"\n';
    const pagesFirst = compile(load(manifest({ output, binding: extract + BOTH }))).tools[0];
    const imagesFirst = compile(
      load(manifest({ output, binding: extract + '  origins:\n    images:\n      - "https://img.example.com"\n    pages:\n      - "https://www.example.com"\n' })),
    ).tools[0];
    expect(Object.keys(pagesFirst.origins!)).toEqual(["pages", "images"]);
    expect(JSON.stringify(imagesFirst.origins)).toBe(JSON.stringify(pagesFirst.origins));
  });

  it("ORIGIN_BOUND_TYPES keeps its shape: type → list name", () => {
    expect(ORIGIN_BOUND_TYPES).toEqual({ "web-page": "pages", image: "images" });
    expect(originListOf("image")).toBe("images");
  });
});

describe("S-A3 / S-A4: image is output-only", () => {
  it("S-A3: type: image and list: image in input: are refused, naming the capability and the field", () => {
    for (const [field, body] of [["pic", "type: image"], ["pics", "list: image"]]) {
      const dir = manifest({ input: `  input:\n    ${field}:\n      ${body}\n` });
      const found = withCode(validateSemantics(load(dir)), "image-in-input");
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe("error");
      expect(found[0].message).toContain("capability 'shop.search'");
      expect(found[0].message).toContain(`input field '${field}'`);
      expect(found[0].message).toContain("output-only");
    }
  });

  it("S-A4: a resource with an image or list: image field, used as input by representation, is refused naming the resource", () => {
    for (const [fields, leaf] of [[ROOM_SCALAR, "cover"], [ROOM_LIST, "photos"]]) {
      for (const form of ["type: Room", "collection: Room"]) {
        const dir = manifest({ input: `  input:\n    room:\n      ${form}\n`, resources: { Room: fields } });
        const found = withCode(validateSemantics(load(dir)), "image-in-input");
        expect(found).toHaveLength(1);
        expect(found[0].message).toContain("resource 'shop.Room'");
        expect(found[0].message).toContain(`'room.${leaf}'`);
      }
    }
  });
});

describe("S-A5 – S-A7, S-A10: an output that reaches image needs origins and a mapping", () => {
  it("S-A5: no origins.images → image-no-origins, naming the capability", () => {
    const found = withCode(validateSemantics(load(manifest({ output: SCALAR_OUTPUT, binding: SCALAR_EXTRACT }))), "image-no-origins");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("capability 'shop.search'");
    expect(found[0].message).toContain("origins.images");
  });

  it("S-A6: origins.images declared but nothing reaches image → origins-unused (warning)", () => {
    const dir = manifest({ output: "  output:\n    title:\n      type: text\n", binding: '  extract:\n    title: "$.t"\n' + IMAGES });
    const found = withCode(validateSemantics(load(dir)), "origins-unused");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain("origins.images");
  });

  it("S-A7: pass-through binding (no response:/extract:) → image-needs-mapping, for scalar and list", () => {
    for (const output of [SCALAR_OUTPUT, LIST_OUTPUT]) {
      const found = withCode(validateSemantics(load(manifest({ output, binding: IMAGES }))), "image-needs-mapping");
      expect(found).toHaveLength(1);
      expect(found[0].severity).toBe("error");
    }
  });

  it("S-A10: a binding extract: into a list: image field compiles", () => {
    expect(errors(validateSemantics(load(manifest({ output: LIST_OUTPUT, binding: LIST_EXTRACT + IMAGES }))))).toEqual([]);
  });
});

describe("S-A8: required-in-collection warning is scalar-only", () => {
  it("a required scalar image in a collection warns", () => {
    const dir = manifest({ output: ROOMS_OUTPUT, resources: { Room: ROOM_SCALAR }, binding: roomsResponse('      cover: "$.cover"\n') + IMAGES });
    const found = withCode(validateSemantics(load(dir)), "image-required-in-collection");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain("'rooms.cover'");
  });

  it("a required list: image in the same position produces no such warning, and the manifest has no errors", () => {
    const dir = manifest({ output: ROOMS_OUTPUT, resources: { Room: ROOM_LIST }, binding: roomsResponse('      photos: "$.photos"\n') + IMAGES });
    const diags = validateSemantics(load(dir));
    expect(withCode(diags, "image-required-in-collection")).toEqual([]);
    expect(errors(diags)).toEqual([]);
  });
});

describe("S-A11 / S-A12: origins.images entries are checked like origins.pages", () => {
  const compileWith = (...entries: string[]) => validateSemantics(load(manifest({ output: SCALAR_OUTPUT, binding: SCALAR_EXTRACT + origins(...entries) })));

  it("S-A11: a path, query, fragment, wildcard, placeholder or http: entry is refused, naming the entry", () => {
    for (const bad of ["https://img.example.com/a", "https://img.example.com?x=1", "https://img.example.com#f", "https://*.example.com", "https://${HOST}", "http://img.example.com"]) {
      const found = withCode(compileWith(bad), "origins-malformed");
      expect(found, bad).toHaveLength(1);
      expect(found[0].message).toContain(bad);
      expect(found[0].message).toContain("origins.images");
    }
  });

  it("S-A12: two spellings of one origin normalise to the same key; the duplicate is rejected", () => {
    const found = withCode(compileWith("https://IMG.Example.com", "https://img.example.com"), "origins-malformed");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("duplicates");
  });

  it("S-A12: an empty origins.images list is rejected by the schema", () => {
    const model = load(manifest({ output: SCALAR_OUTPUT, binding: SCALAR_EXTRACT + "  origins:\n    images: []\n" }));
    expect(model.issues.length).toBeGreaterThan(0);
  });
});

describe("S-A14: list: web-page is still refused", () => {
  it("the schema refuses it and names the value", () => {
    const model = load(manifest({ output: "  output:\n    links:\n      list: web-page\n" }));
    expect(model.issues.some((i) => i.message.includes('"web-page"'))).toBe(true);
  });
});

describe("S-A15: both origin-bound types on one binding need both lists", () => {
  const output = "  output:\n    listingUrl:\n      type: web-page\n    cover:\n      type: image\n";
  const extract = '  extract:\n    listingUrl: "$.url"\n    cover: "$.cover"\n';
  const run = (origins: string) => validateSemantics(load(manifest({ output, binding: extract + origins })));

  it("only origins.pages → image-no-origins (and not web-page-no-origins)", () => {
    const d = run(PAGES);
    expect(withCode(d, "image-no-origins")).toHaveLength(1);
    expect(withCode(d, "web-page-no-origins")).toEqual([]);
  });

  it("only origins.images → web-page-no-origins (and not image-no-origins)", () => {
    const d = run(IMAGES);
    expect(withCode(d, "web-page-no-origins")).toHaveLength(1);
    expect(withCode(d, "image-no-origins")).toEqual([]);
  });

  it("both lists → no errors", () => {
    expect(errors(run(BOTH))).toEqual([]);
  });

  it("a declared list nothing reaches is origins-unused, per list", () => {
    const d = validateSemantics(
      load(manifest({ output: SCALAR_OUTPUT, binding: SCALAR_EXTRACT + BOTH })),
    );
    const unused = withCode(d, "origins-unused");
    expect(unused).toHaveLength(1);
    expect(unused[0].message).toContain("origins.pages");
  });
});

describe("ir-diff: origins.images and image types", () => {
  const build = (binding: string, output = SCALAR_OUTPUT, extract = SCALAR_EXTRACT) => compile(load(manifest({ output, binding: extract + binding })));

  it("adding origins.images is a binding-changed at path origins", () => {
    const before = build(IMAGES);
    const after = build('  origins:\n    images:\n      - "https://img.example.com"\n      - "https://img2.example.com"\n');
    const entries = diffIR(before, after).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "binding-changed", severity: "compatible", path: "origins" });
  });

  it("string -> image and list:string -> list:image go through the existing output-type diff", () => {
    const asString = compile(load(manifest({ output: "  output:\n    cover:\n      type: string\n", binding: SCALAR_EXTRACT })));
    const asImage = build(IMAGES);
    expect(diffIR(asString, asImage).entries.map((e) => e.kind)).toContain("output-retyped");
    const listString = compile(load(manifest({ output: "  output:\n    photos:\n      list: string\n", binding: LIST_EXTRACT })));
    const listImage = build(IMAGES, LIST_OUTPUT, LIST_EXTRACT);
    expect(diffIR(listString, listImage).entries.map((e) => e.kind)).toContain("output-retyped");
  });
});
