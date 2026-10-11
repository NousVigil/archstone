// `archstone init` maps an OpenAPI `type: boolean` and a Postgres `boolean` column to the
// `boolean` semantic type (#212). A spec that states the type has the standing of
// `number` -> `quantity`; a union that also names `string` keeps resolving to `string`.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { emit, openApiAdapter, type DecisionRecord } from "@archstone/init";
import { commitFileSet } from "@archstone/init/loop";
import { mapColumnType } from "../src/adapters/postgres/columns";

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
      parameters:
        - name: includeClosed
          in: query
          required: false
          schema:
            type: boolean
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
      required: [id, breakfast]
      properties:
        id:
          type: string
        breakfast:
          type: boolean
        pets:
          type: [boolean, "null"]
        mixed:
          type: [boolean, string]
`;

const decisions: DecisionRecord = {
  version: "0",
  company: { id: "example", name: "Example Stays" },
  provider: "example-api",
  decisions: [{ operation: "GET /v1/stays", keep: true, capabilityId: "stays.list", effect: "read", responseLocus: "$.items[*]" }],
};

describe("OpenAPI type: boolean -> boolean", () => {
  const workspace = mkdtempSync(join(tmpdir(), "archstone-init-boolean-"));
  afterAll(() => rmSync(workspace, { recursive: true, force: true }));

  const draft = openApiAdapter.adapt({ origin: "stays.yaml", document: DOCUMENT, documents: {} });
  const emitted = emit(draft, decisions);
  const committed = commitFileSet(emitted.files, { targetDir: join(workspace, "generated") });
  const stay = () => Object.entries(committed.ir!.resources).find(([name]) => name.endsWith("Stay"))?.[1];

  it("the generated manifest compiles", () => {
    expect(committed.failures).toEqual([]);
    expect(committed.ok).toBe(true);
  });

  it("a response field declared boolean is boolean, with no degradation note", () => {
    expect(stay()?.find((f) => f.name === "breakfast")).toMatchObject({ required: true, type: { kind: "scalar", semantic: "boolean" } });
    expect(JSON.stringify(draft)).not.toContain("no boolean primitive");
  });

  it("[boolean, null] is an optional boolean", () => {
    expect(stay()?.find((f) => f.name === "pets")).toMatchObject({ required: false, type: { kind: "scalar", semantic: "boolean" } });
  });

  it("[boolean, string] still resolves to string, deliberately", () => {
    expect(stay()?.find((f) => f.name === "mixed")?.type).toEqual({ kind: "scalar", semantic: "string" });
  });

  it("a query parameter declared boolean is a boolean input", () => {
    const input = committed.ir!.tools[0]!.input.find((f) => f.name === "includeClosed");
    expect(input).toMatchObject({ required: false, type: { kind: "scalar", semantic: "boolean" } });
  });
});

describe("Postgres boolean column -> boolean", () => {
  it("is mapped from the catalog; json, jsonb and array stay skipped", () => {
    expect(mapColumnType("boolean", "active")).toEqual({ ok: true, type: "boolean" });
    for (const t of ["json", "jsonb", "ARRAY"]) expect(mapColumnType(t, "c").ok).toBe(false);
  });
});
