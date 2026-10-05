// `web-page` — the Experimental, output-only semantic type checked against a binding's declared
// origins (issue #141). This file covers authoring and validation (S-A.*): the grammar, the IR
// lowering, and the six named compile rules. The runtime check lives in emitter-support's
// `web-page.test.ts`; the CLI exit codes in cli's `web-page.test.ts`.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "@archstone/schema";
import { validateSemantics, originEntryKey, type Diagnostic } from "../src/validate";
import { compile } from "../src/compile";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

const errors = (d: Diagnostic[]) => d.filter((x) => x.severity === "error");
const withCode = (d: Diagnostic[], code: string) => d.filter((x) => x.code === code);

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

interface Spec {
  /** The capability's `input:`/`output:` blocks, indented under `capability:`. */
  input?: string;
  output?: string;
  /** Extra resource files: name → `fields:` body (indented four spaces). */
  resources?: Record<string, string>;
  /** Appended verbatim under `binding:` (response:/extract:/origins:). Omit for no binding. */
  binding?: string;
}

/** A one-capability manifest (`shop.search`) in a fresh temp dir. */
function manifest(spec: Spec): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-webpage-"));
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

const ORIGINS = '  origins:\n    pages:\n      - "https://www.example.com"\n';
const origins = (...entries: string[]) => `  origins:\n    pages:\n${entries.map((e) => `      - ${JSON.stringify(e)}\n`).join("")}`;

/** A direct `listingUrl: web-page` output field, filled by `extract:`. */
const DIRECT_OUTPUT = "  output:\n    listingUrl:\n      type: web-page\n";
const DIRECT_EXTRACT = '  extract:\n    listingUrl: "$.url"\n';

/** A collection output of a Stay resource carrying an optional `listingUrl`. */
const STAY = "    name:\n      type: text\n    listingUrl:\n      type: web-page\n      required: false\n";
const STAYS_OUTPUT = "  output:\n    stays:\n      collection: Stay\n";
const STAYS_RESPONSE = '  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      listingUrl: "$.url"\n';

describe("S-A.1 / S-A.2: a web-page output field with declared origins compiles", () => {
  const dir = manifest({ output: DIRECT_OUTPUT, binding: DIRECT_EXTRACT + ORIGINS });

  it("S-A.1: compiles, and the IR tool carries origins.pages exactly as declared", () => {
    const model = load(dir);
    expect(model.issues).toEqual([]);
    expect(errors(validateSemantics(model))).toEqual([]);
    const tool = compile(model).tools[0];
    expect(tool.origins).toEqual({ pages: ["https://www.example.com"] });
  });

  it("S-A.2: the output field is a scalar web-page semantic", () => {
    const tool = compile(load(dir)).tools[0];
    expect(tool.output.find((f) => f.name === "listingUrl")?.type).toEqual({ kind: "scalar", semantic: "web-page" });
  });
});

describe("S-A.3: a manifest without origins compiles to an unchanged IR", () => {
  // The goldens were produced by the compiler and loader as they were before `web-page` and
  // `origins:` existed (commit 1e574d8, run from a throwaway checkout of that commit's
  // packages/schema/src + packages/compiler/src over these example manifests, written as
  // `JSON.stringify(ir, null, 2) + "\n"`), none of which uses either.
  for (const name of ["tourism", "booking", "bank"]) {
    it(`${name}: no tool carries an origins member, and the IR is byte-identical to the previous one`, () => {
      const ir = compile(load(join(manifests, name)));
      expect(ir.tools.some((t) => "origins" in t)).toBe(false);
      expect(ir.version).toBe("0");
      const golden = readFileSync(join(here, "fixtures/ir", `${name}.ir.json`), "utf8");
      expect(JSON.stringify(ir, null, 2) + "\n").toBe(golden);
    });
  }
});

describe("S-A.4 / S-A.5: web-page is output-only", () => {
  it("S-A.4: a web-page field in input: is refused, naming the capability and the field", () => {
    const dir = manifest({ input: "  input:\n    page:\n      type: web-page\n" });
    const found = withCode(validateSemantics(load(dir)), "web-page-in-input");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain("capability 'shop.search'");
    expect(found[0].message).toContain("input field 'page'");
  });

  it("S-A.5: a resource containing a web-page field, used as input by representation, is refused naming the resource", () => {
    for (const form of ["type: Stay", "collection: Stay"]) {
      const dir = manifest({ input: `  input:\n    stay:\n      ${form}\n`, resources: { Stay: STAY } });
      const found = withCode(validateSemantics(load(dir)), "web-page-in-input");
      expect(found).toHaveLength(1);
      expect(found[0].message).toContain("capability 'shop.search'");
      expect(found[0].message).toContain("resource 'shop.Stay'");
      expect(found[0].message).toContain("'stay.listingUrl'");
    }
  });

  it("a `ref:` to such a resource is a bare identifier, not the resource's fields — not refused", () => {
    const dir = manifest({ input: "  input:\n    stay:\n      ref: Stay\n", resources: { Stay: STAY } });
    expect(withCode(validateSemantics(load(dir)), "web-page-in-input")).toEqual([]);
  });
});

describe("S-A.6 – S-A.8: an output that reaches web-page needs origins and a mapping", () => {
  it("S-A.6: no origins.pages → web-page-no-origins, naming the capability", () => {
    const dir = manifest({ output: DIRECT_OUTPUT, binding: DIRECT_EXTRACT });
    const found = withCode(validateSemantics(load(dir)), "web-page-no-origins");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain("capability 'shop.search'");
  });

  it("S-A.7: reaching web-page through a collection of a resource counts", () => {
    const dir = manifest({ output: STAYS_OUTPUT, resources: { Stay: STAY }, binding: STAYS_RESPONSE });
    const found = withCode(validateSemantics(load(dir)), "web-page-no-origins");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("'stays.listingUrl'");
  });

  it("…and through a nested resource inside the mapped one", () => {
    const dir = manifest({
      output: STAYS_OUTPUT,
      resources: { Stay: "    name:\n      type: text\n    host:\n      type: Host\n      required: false\n", Host: "    profileUrl:\n      type: web-page\n      required: false\n" },
      binding: '  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      host: "$.host"\n',
    });
    expect(withCode(validateSemantics(load(dir)), "web-page-no-origins")).toHaveLength(1);
  });

  it("…and through an onError errorResource, whose rows land in the same output field", () => {
    const dir = manifest({
      output: STAYS_OUTPUT,
      resources: { Stay: "    name:\n      type: text\n", RowError: "    code:\n      type: text\n    helpUrl:\n      type: web-page\n      required: false\n" },
      binding:
        '  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n    onError:\n      errorResource: RowError\n      when:\n        path: "$.error"\n        exists: true\n',
    });
    expect(withCode(validateSemantics(load(dir)), "web-page-no-origins")).toHaveLength(1);
  });

  it("S-A.8: origins declared but neither response: nor extract: → web-page-needs-mapping, naming the capability", () => {
    const dir = manifest({ output: DIRECT_OUTPUT, binding: ORIGINS });
    const found = withCode(validateSemantics(load(dir)), "web-page-needs-mapping");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain("capability 'shop.search'");
  });

  it("a capability with no binding at all is not invocable and is not refused", () => {
    const dir = manifest({ output: DIRECT_OUTPUT });
    const d = validateSemantics(load(dir));
    expect(withCode(d, "web-page-no-origins")).toEqual([]);
    expect(withCode(d, "web-page-needs-mapping")).toEqual([]);
  });
});

describe("S-A.9 – S-A.12: origin entries", () => {
  const malformed = (entry: string) => withCode(validateSemantics(load(manifest({ output: DIRECT_OUTPUT, binding: DIRECT_EXTRACT + origins(entry) }))), "origins-malformed");

  it("S-A.9: an entry with a path is refused, naming the entry", () => {
    const found = malformed("https://www.example.com/stays");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("error");
    expect(found[0].message).toContain("'https://www.example.com/stays'");
  });

  it("S-A.10: each forbidden form is refused, naming that entry", () => {
    for (const entry of [
      "http://www.example.com",
      "https://*.example.com",
      "https://www.example.com/",
      "https://user@www.example.com",
      "https://www.example.com?x=1",
      "${PAGES_ORIGIN}",
      "www.example.com",
    ]) {
      const found = malformed(entry);
      expect({ entry, count: found.length }).toEqual({ entry, count: 1 });
      expect(found[0].message).toContain(`'${entry}'`);
    }
  });

  it("further forms the syntax excludes: fragment, trailing-dot host, empty label, port 0, upper-case scheme", () => {
    for (const entry of ["https://www.example.com#x", "https://www.example.com.", "https://www..example.com", "https://www.example.com:0", "HTTPS://www.example.com"]) {
      expect({ entry, count: malformed(entry).length }).toEqual({ entry, count: 1 });
    }
  });

  it("accepted forms: a port, an internationalised host, a host written in upper case", () => {
    for (const entry of ["https://www.example.com:8443", "https://bücher.example", "https://WWW.EXAMPLE.COM"]) {
      expect({ entry, count: malformed(entry).length }).toEqual({ entry, count: 0 });
    }
  });

  it("S-A.11: an empty list is a schema error stating the list must not be empty", () => {
    const dir = manifest({ output: DIRECT_OUTPUT, binding: DIRECT_EXTRACT + "  origins:\n    pages: []\n" });
    const model = load(dir);
    expect(model.ok).toBe(false);
    const issue = model.issues.find((i) => i.file === "bindings/shop.search.binding.yaml");
    expect(issue?.message).toMatch(/\/binding\/origins\/pages must NOT have fewer than 1 items/);
  });

  it("S-A.12: duplicates are refused, including after normalisation, naming the duplicate", () => {
    const dir = manifest({ output: DIRECT_OUTPUT, binding: DIRECT_EXTRACT + origins("https://www.example.com", "https://WWW.EXAMPLE.COM:443") });
    const found = withCode(validateSemantics(load(dir)), "origins-malformed");
    expect(found).toHaveLength(1);
    expect(found[0].message).toContain("'https://WWW.EXAMPLE.COM:443'");
    expect(found[0].message).toContain("duplicates");
  });

  it("originEntryKey normalises the host case and elides the default port", () => {
    expect(originEntryKey("https://WWW.Example.com:443")).toBe("https://www.example.com");
    expect(originEntryKey("https://www.example.com:8443")).toBe("https://www.example.com:8443");
    expect(originEntryKey("https://www.example.com/")).toBeUndefined();
  });
});

describe("S-A.13 / S-A.14: warnings", () => {
  it("S-A.13: origins declared, no web-page reachable → origins-unused, naming the capability", () => {
    const dir = manifest({ output: "  output:\n    title:\n      type: text\n", binding: '  extract:\n    title: "$.t"\n' + ORIGINS });
    const d = validateSemantics(load(dir));
    const found = withCode(d, "origins-unused");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain("capability 'shop.search'");
    expect(errors(d)).toEqual([]);
  });

  it("S-A.14: a required web-page in a collection with no onError → warning recommending optional", () => {
    const dir = manifest({
      output: STAYS_OUTPUT,
      resources: { Stay: "    name:\n      type: text\n    listingUrl:\n      type: web-page\n" },
      binding: STAYS_RESPONSE + ORIGINS,
    });
    const d = validateSemantics(load(dir));
    const found = withCode(d, "web-page-required-in-collection");
    expect(found).toHaveLength(1);
    expect(found[0].severity).toBe("warning");
    expect(found[0].message).toContain("'stays.listingUrl'");
    expect(found[0].message).toMatch(/optional/);
    expect(errors(d)).toEqual([]);
  });

  it("no warning when the field is optional, loosened by the map, or the mapping declares onError", () => {
    const requiredStay = { Stay: "    name:\n      type: text\n    listingUrl:\n      type: web-page\n" };
    const loosened = '  response:\n    collection: "$.results[*]"\n    resource: Stay\n    map:\n      name: "$.name"\n      listingUrl:\n        path: "$.url"\n        required: false\n';
    const withOnError =
      STAYS_RESPONSE + "    onError:\n      errorResource: RowError\n      when:\n        path: \"$.error\"\n        exists: true\n";
    const cases = [
      manifest({ output: STAYS_OUTPUT, resources: { Stay: STAY }, binding: STAYS_RESPONSE + ORIGINS }),
      manifest({ output: STAYS_OUTPUT, resources: requiredStay, binding: loosened + ORIGINS }),
      manifest({ output: STAYS_OUTPUT, resources: { ...requiredStay, RowError: "    code:\n      type: text\n" }, binding: withOnError + ORIGINS }),
    ];
    for (const dir of cases) {
      const d = validateSemantics(load(dir));
      expect(withCode(d, "web-page-required-in-collection")).toEqual([]);
      expect(errors(d)).toEqual([]);
    }
  });

  it("a clean collection with an optional web-page and declared origins produces none of the six codes", () => {
    const dir = manifest({ output: STAYS_OUTPUT, resources: { Stay: STAY }, binding: STAYS_RESPONSE + ORIGINS });
    const codes = validateSemantics(load(dir)).map((x) => x.code);
    for (const code of ["web-page-in-input", "web-page-no-origins", "web-page-needs-mapping", "origins-malformed", "origins-unused", "web-page-required-in-collection"]) {
      expect(codes).not.toContain(code);
    }
  });
});

describe("S-A.15: `list: web-page` is refused for now", () => {
  it("is a schema error naming the unsupported list item type", () => {
    const dir = manifest({ output: "  output:\n    links:\n      list: web-page\n" });
    const model = load(dir);
    expect(model.ok).toBe(false);
    const issue = model.issues.find((i) => i.file === "shop.search.capability.yaml");
    expect(issue?.message).toMatch(/\/capability\/output\/links\/list must be equal to one of the allowed values \(got "web-page"\)/);
  });

  it("the echoed value is JSON-quoted and truncated, so it cannot break an output line", () => {
    const dir = manifest({ output: `  output:\n    links:\n      list: "web-page\\n${"x".repeat(200)}"\n` });
    const issue = load(dir).issues.find((i) => i.file === "shop.search.capability.yaml");
    expect(issue?.message).toContain('(got "web-page\\nxxx');
    expect(issue?.message).not.toContain("\n");
    expect(issue?.message).toMatch(/…\)/);
  });
});
