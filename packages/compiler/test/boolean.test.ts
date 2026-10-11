// The `boolean` semantic type (#212): authoring, loading, validation, the IR and the IR diff.
// The lowering, the input validator and the response mapper are tested in emitter-support.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { load } from "@archstone/schema";
import { validateSemantics } from "../src/validate";
import { compile } from "../src/compile";
import { diffIR } from "../src/ir-diff";
import { SEMANTIC_TYPES } from "../src/ir";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

function manifest(input: string, output: string, resources: Record<string, string> = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-boolean-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
    "shop.search.capability.yaml": `capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: store\n${input}${output}`,
  };
  for (const [name, fields] of Object.entries(resources)) files[`shop.${name}.resource.yaml`] = `resource:\n  name: shop.${name}\n  fields:\n${fields}`;
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const compileDir = (dir: string) => {
  const model = load(dir);
  return { model, diagnostics: validateSemantics(model).filter((d) => d.severity === "error"), ir: compile(model) };
};

describe("boolean is a registered semantic type", () => {
  it("is in SEMANTIC_TYPES", () => expect(SEMANTIC_TYPES.has("boolean")).toBe(true));
});

describe("AC-1 / AC-2: a boolean input and output compile", () => {
  it("scalar input and output: loads, no diagnostics, scalar boolean in the IR", () => {
    const { model, diagnostics, ir } = compileDir(
      manifest("  input:\n    includeClosed:\n      type: boolean\n      required: false\n", "  output:\n    available:\n      type: boolean\n"),
    );
    expect(model.issues).toEqual([]);
    expect(diagnostics).toEqual([]);
    const tool = ir.tools[0]!;
    expect(tool.input[0]).toMatchObject({ name: "includeClosed", required: false, type: { kind: "scalar", semantic: "boolean" } });
    expect(tool.output[0]).toMatchObject({ name: "available", required: true, type: { kind: "scalar", semantic: "boolean" } });
  });

  it("list: boolean is admitted, as an input and an output", () => {
    const { model, diagnostics, ir } = compileDir(manifest("  input:\n    flags:\n      list: boolean\n", "  output:\n    answers:\n      list: boolean\n"));
    expect(model.issues).toEqual([]);
    expect(diagnostics).toEqual([]);
    expect(ir.tools[0]!.input[0]!.type).toEqual({ kind: "list", items: "boolean" });
    expect(ir.tools[0]!.output[0]!.type).toEqual({ kind: "list", items: "boolean" });
  });

  it("inside a resource", () => {
    const { model, diagnostics, ir } = compileDir(
      manifest("", "  output:\n    rooms:\n      collection: Room\n", { Room: "    name:\n      type: text\n    breakfast:\n      type: boolean\n    tags:\n      list: boolean\n      required: false\n" }),
    );
    expect(model.issues).toEqual([]);
    expect(diagnostics).toEqual([]);
    const room = ir.resources["shop.Room"]!;
    expect(room.find((f) => f.name === "breakfast")!.type).toEqual({ kind: "scalar", semantic: "boolean" });
    expect(room.find((f) => f.name === "tags")!.type).toEqual({ kind: "list", items: "boolean" });
  });

  it("is not origin-bound, so it is accepted as an input (unlike web-page and image)", () => {
    const { diagnostics } = compileDir(manifest("  input:\n    f:\n      type: boolean\n", "  output:\n    g:\n      type: boolean\n"));
    expect(diagnostics.map((d) => d.code)).toEqual([]);
  });
});

describe("the schema still refuses near-misses and names the value", () => {
  for (const wrong of ["bool", "boolean "]) {
    it(`type: ${JSON.stringify(wrong)} is refused`, () => {
      const model = load(manifest(`  input:\n    f:\n      type: ${JSON.stringify(wrong)}\n`, "  output:\n    g:\n      type: boolean\n"));
      expect(model.issues.length).toBeGreaterThan(0);
      expect(model.issues.map((i) => i.message).join(" | ")).toContain(wrong);
    });
  }
  it("type: Boolean reads as a resource name and is refused by the semantic pass", () => {
    const dir = manifest("  input:\n    f:\n      type: Boolean\n", "  output:\n    g:\n      type: boolean\n");
    expect(validateSemantics(load(dir)).some((d) => d.severity === "error")).toBe(true);
  });
  it("list: bool is refused", () => {
    expect(load(manifest("  input:\n    f:\n      list: bool\n", "  output:\n    g:\n      type: boolean\n")).issues.length).toBeGreaterThan(0);
  });
});

describe("ir-diff: a field retyped string -> boolean is breaking", () => {
  const ir = (semantic: string) => compileDir(manifest(`  input:\n    f:\n      type: ${semantic}\n`, `  output:\n    g:\n      type: ${semantic}\n`)).ir;
  it("input and output", () => {
    const { entries, summary } = diffIR(ir("string"), ir("boolean"));
    expect(summary.breaking).toBe(2);
    expect(entries).toContainEqual(expect.objectContaining({ severity: "breaking", kind: "input-retyped", path: "input.f", detail: "input 'f' type changed: string → boolean" }));
    expect(entries).toContainEqual(expect.objectContaining({ severity: "breaking", kind: "output-retyped", path: "output.g" }));
  });
});
