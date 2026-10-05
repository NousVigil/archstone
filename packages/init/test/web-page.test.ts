// S-C.7 (issue #141): `archstone init` never infers `web-page`.
//
// A `format: uri` string in an OpenAPI document says "this is a URL", not "this is the page a
// person sees this resource on, on the provider's own site", and it says nothing about which
// origins such a page may live on. Inferring the type would also mean inventing an `origins:`
// list. So the field stays `string`, and no `origins` are written.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
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
      required: [id, listingUrl]
      properties:
        id:
          type: string
        listingUrl:
          type: string
          format: uri
          description: The page for this stay on the provider's site.
`;

const decisions: DecisionRecord = {
  version: "0",
  company: { id: "example", name: "Example Stays" },
  provider: "example-api",
  decisions: [{ operation: "GET /v1/stays", keep: true, capabilityId: "stays.list", effect: "read", responseLocus: "$.items[*]" }],
};

describe("S-C.7: init does not infer web-page", () => {
  const workspace = mkdtempSync(join(tmpdir(), "archstone-init-webpage-"));
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  const draft = openApiAdapter.adapt({ origin: "stays.yaml", document: DOCUMENT, documents: {} });
  const emitted = emit(draft, decisions);
  const committed = commitFileSet(emitted.files, { targetDir: join(workspace, "generated") });

  it("the generated manifest compiles", () => {
    expect(committed.failures).toEqual([]);
    expect(committed.ok).toBe(true);
  });

  it("a `format: uri` string is typed string, not web-page", () => {
    const stay = Object.entries(committed.ir!.resources).find(([name]) => name.endsWith("Stay"))?.[1];
    expect(stay?.find((f) => f.name === "listingUrl")?.type).toEqual({ kind: "scalar", semantic: "string" });
  });

  it("no file mentions web-page, and no binding writes origins", () => {
    expect(emitted.files.size).toBeGreaterThan(0);
    for (const [path, content] of emitted.files) {
      expect(content, `${path} infers web-page`).not.toMatch(/web-page/);
      expect(content, `${path} writes origins:`).not.toMatch(/^\s*origins:/m);
    }
    expect(committed.ir!.tools.every((t) => t.origins === undefined)).toBe(true);
  });
});
