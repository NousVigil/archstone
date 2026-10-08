// S-A13 (issue #152): `archstone init` never infers `image`.
//
// A field called `image`, `photo` or `thumbnail`, or a `format: uri` string, says "this is text
// that looks like a URL", not "this is an absolute https URL of a picture of the resource, on an
// origin the operator declared". Inferring the type would also mean inventing an `origins:` list.
// The fields stay `string` (or a list of `string`), and no `origins` are written. The guard at the
// end is type-generic: no inference path may emit ANY type the origin-bound table names.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ORIGIN_BOUND_TYPES, type IRType } from "@archstone/compiler";
import { emit, openApiAdapter, type DecisionRecord } from "@archstone/init";
import { commitFileSet } from "@archstone/init/loop";

const DOCUMENT = `openapi: 3.1.0
info:
  title: Example stays (synthetic)
  version: 1.0.0
servers:
  - url: https://api.example.com/v1
paths:
  /stays:
    get:
      summary: List stays
      operationId: listStays
      security: []
      responses:
        '200':
          description: Stays.
          content:
            application/json:
              schema:
                type: object
                required: [items]
                properties:
                  items:
                    type: array
                    items:
                      $ref: '#/components/schemas/Stay'
components:
  schemas:
    Stay:
      type: object
      required: [id, image]
      properties:
        id:
          type: string
        image:
          type: string
          format: uri
        photo:
          type: string
          format: uri-reference
        thumbnail:
          type: string
          description: A small picture of the stay.
        photos:
          type: array
          items:
            type: string
            format: uri
`;

const decisions: DecisionRecord = {
  version: "0",
  company: { id: "example", name: "Example Stays" },
  provider: "example-api",
  decisions: [{ operation: "GET /v1/stays", keep: true, capabilityId: "stays.list", effect: "read", responseLocus: "$.items[*]" }],
};

describe("S-A13: init does not infer image", () => {
  const workspace = mkdtempSync(join(tmpdir(), "archstone-init-image-"));
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  const draft = openApiAdapter.adapt({ origin: "stays.yaml", document: DOCUMENT, documents: {} });
  const emitted = emit(draft, decisions);
  const committed = commitFileSet(emitted.files, { targetDir: join(workspace, "generated") });
  const stay = () => Object.entries(committed.ir!.resources).find(([name]) => name.endsWith("Stay"))?.[1];

  it("the generated manifest compiles", () => {
    expect(committed.failures).toEqual([]);
    expect(committed.ok).toBe(true);
  });

  it("fields called image, photo and thumbnail are typed string, never image", () => {
    for (const name of ["image", "photo", "thumbnail"]) {
      expect(stay()?.find((f) => f.name === name)?.type, name).toEqual({ kind: "scalar", semantic: "string" });
    }
  });

  it("an array of uri strings is not a list: image", () => {
    const photos = stay()?.find((f) => f.name === "photos")?.type;
    expect(photos).not.toEqual({ kind: "list", items: "image" });
  });

  it("guard: no emitted file or IR type uses any origin-bound type, and no binding writes origins", () => {
    const bound = Object.keys(ORIGIN_BOUND_TYPES);
    expect(bound).toContain("image");
    const types = (t: IRType): string[] => (t.kind === "scalar" ? [t.semantic] : t.kind === "list" ? [t.items] : []);
    const used = [
      ...Object.values(committed.ir!.resources).flat().flatMap((f) => types(f.type)),
      ...committed.ir!.tools.flatMap((t) => [...t.input, ...t.output].flatMap((f) => types(f.type))),
    ];
    for (const b of bound) expect(used, `a field is typed ${b}`).not.toContain(b);
    expect(emitted.files.size).toBeGreaterThan(0);
    for (const [path, content] of emitted.files) {
      for (const b of bound) expect(content, `${path} infers ${b}`).not.toMatch(new RegExp(`(?:type|list):\\s*${b}\\b`));
      expect(content, `${path} writes origins:`).not.toMatch(/^\s*origins:/m);
    }
    expect(committed.ir!.tools.every((t) => t.origins === undefined)).toBe(true);
  });
});
