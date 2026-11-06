// RFC-0011: a binding maps a provider's 4xx to a declared failure token — the binding schema, the
// D-4 diagnostics, the D-5 IR lowering and the `diffIR` severity. The matcher is tested in
// emitter-support, the MCP result in runtime and the agent outcome in agent.

import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "@archstone/schema";
import { validateSemantics } from "../src/validate";
import { compile } from "../src/compile";
import { diffIR } from "../src/ir-diff";

const here = dirname(fileURLToPath(import.meta.url));
const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const DECLARED = "  failures:\n    game-not-found: The game id does not exist.\n    already-refunded: The purchase was already refunded.\n";
const REST = "  connector:\n    type: rest\n    rest:\n      baseUrl: https://api.example.com\n      method: GET\n      path: /games/{gameId}\n";
const SQL =
  '  connector:\n    type: sql\n    sql:\n      engine: postgres\n      dsn: "${DATABASE_URL}"\n      statementKind: select\n      query: "SELECT id FROM t WHERE id = $1"\n      params:\n        - gameId\n';

function manifest(opts: { failures?: string; declared?: string; connector?: string; effect?: string }): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-failure-mapping-"));
  dirs.push(dir);
  const files: Record<string, string> = {
    "capabilities.yaml": "company:\n  id: acme\ncapabilities:\n  - games.prices\nproviders:\n  - store\n",
    "games.prices.capability.yaml": `capability:\n  id: games.prices\n  description: look up prices\n  effect: ${opts.effect ?? "read"}\n  provider: store\n  input:\n    gameId:\n      type: text\n  output:\n    price:\n      type: text\n${opts.declared ?? DECLARED}`,
    "bindings/games.prices.binding.yaml": `binding:\n  capabilityId: games.prices\n${opts.connector ?? REST}${opts.failures ?? ""}`,
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return dir;
}

const MAPPED =
  '  failures:\n    - status: 404\n      body: { path: "$.error.code", equals: "game_not_found" }\n      failure: game-not-found\n    - status: 404\n      failure: game-not-found\n    - status: 409\n      failure: already-refunded\n';

const run = (dir: string) => {
  const model = load(dir);
  const codes = validateSemantics(model)
    .filter((d) => d.severity === "error")
    .map((d) => d.code);
  return { model, codes, ir: compile(model) };
};

describe("D-1..D-3: the binding schema", () => {
  it("accepts an ordered list with an optional body test", () => {
    const { model, codes } = run(manifest({ failures: MAPPED }));
    expect(model.issues).toEqual([]);
    expect(model.bindings[0]!.binding.failures).toHaveLength(3);
    expect(codes.filter((c) => c.includes("failure-mapping"))).toEqual([]);
  });

  it.each([
    ["a 5xx status", "  failures:\n    - status: 503\n      failure: game-not-found\n"],
    ["a non-integer status", "  failures:\n    - status: 404.5\n      failure: game-not-found\n"],
    ["a string status", '  failures:\n    - status: "404"\n      failure: game-not-found\n'],
    ["an extra key", "  failures:\n    - status: 404\n      failure: game-not-found\n      retry: true\n"],
    ["a body without equals", '  failures:\n    - status: 404\n      body: { path: "$.code" }\n      failure: game-not-found\n'],
    ["an object as equals", '  failures:\n    - status: 404\n      body: { path: "$.code", equals: { a: 1 } }\n      failure: game-not-found\n'],
    ["a missing failure", "  failures:\n    - status: 404\n"],
    ["a non-kebab token", "  failures:\n    - status: 404\n      failure: GameNotFound\n"],
    ["an empty list", "  failures: []\n"],
  ])("refuses %s", (_label, failures) => {
    const { model } = run(manifest({ failures }));
    expect(model.bindings).toEqual([]);
    expect(model.issues.map((i) => i.file)).toContain("bindings/games.prices.binding.yaml");
  });
});

describe("D-4: semantic validation", () => {
  it("failure-mapping-unknown-token", () => {
    const { codes } = run(manifest({ failures: "  failures:\n    - status: 404\n      failure: no-such-token\n" }));
    expect(codes).toContain("failure-mapping-unknown-token");
  });

  it("failure-mapping-without-failures: once per binding, no per-entry unknown-token", () => {
    const { codes } = run(manifest({ declared: "", failures: MAPPED }));
    expect(codes.filter((c) => c === "failure-mapping-without-failures")).toHaveLength(1);
    expect(codes).not.toContain("failure-mapping-unknown-token");
  });

  it("failure-mapping-not-rest", () => {
    const { codes } = run(manifest({ connector: SQL, failures: "  failures:\n    - status: 404\n      failure: game-not-found\n" }));
    expect(codes).toContain("failure-mapping-not-rest");
  });

  it("bad-failure-mapping-path", () => {
    const { codes } = run(manifest({ failures: '  failures:\n    - status: 404\n      body: { path: "error.code[", equals: "x" }\n      failure: game-not-found\n' }));
    expect(codes).toContain("bad-failure-mapping-path");
  });

  it("failure-mapping-shadowed: an entry after a body-less entry for the same status", () => {
    const { codes } = run(
      manifest({ failures: '  failures:\n    - status: 404\n      failure: game-not-found\n    - status: 404\n      body: { path: "$.code", equals: "x" }\n      failure: already-refunded\n' }),
    );
    expect(codes).toEqual(["failure-mapping-shadowed"]);
  });

  it("failure-mapping-duplicate: the same status and body test twice", () => {
    const { codes } = run(
      manifest({
        failures:
          '  failures:\n    - status: 409\n      body: { path: "$.code", equals: 1 }\n      failure: already-refunded\n    - status: 409\n      body: { path: "$.code", equals: 1 }\n      failure: game-not-found\n',
      }),
    );
    expect(codes).toEqual(["failure-mapping-duplicate"]);
  });

  it("a different body value, or a different equals type, is not a duplicate", () => {
    const { codes } = run(
      manifest({
        failures:
          '  failures:\n    - status: 409\n      body: { path: "$.code", equals: 1 }\n      failure: already-refunded\n    - status: 409\n      body: { path: "$.code", equals: "1" }\n      failure: game-not-found\n',
      }),
    );
    expect(codes).toEqual([]);
  });

  it("the schema-valid example produces no error", () => {
    expect(run(manifest({ failures: MAPPED })).codes).toEqual([]);
  });
});

describe("D-5: the IR", () => {
  it("lowers the mappings in order, with the token's description and a fixed key order", () => {
    const { ir } = run(manifest({ failures: MAPPED }));
    expect(ir.tools[0]!.failures).toEqual([
      { status: 404, body: { path: "$.error.code", equals: "game_not_found" }, failure: "game-not-found", description: "The game id does not exist." },
      { status: 404, failure: "game-not-found", description: "The game id does not exist." },
      { status: 409, failure: "already-refunded", description: "The purchase was already refunded." },
    ]);
    expect(Object.keys(ir.tools[0]!.failures![0]!)).toEqual(["status", "body", "failure", "description"]);
  });

  it("is absent when the binding declares none", () => {
    const { ir } = run(manifest({}));
    expect("failures" in ir.tools[0]!).toBe(false);
  });

  it("existing example manifests compile byte-identically to their golden IR", () => {
    const root = resolve(here, "../../..");
    for (const name of ["tourism", "booking", "bank"]) {
      const ir = compile(load(join(root, "examples/manifests", name)));
      expect(ir.tools.some((t) => "failures" in t)).toBe(false);
      const golden = readFileSync(join(here, "fixtures/ir", `${name}.ir.json`), "utf8");
      expect(JSON.stringify(ir, null, 2) + "\n").toBe(golden);
    }
  });
});

describe("D-5: diffIR", () => {
  const pair = (effect: string) => {
    const before = run(manifest({ effect, failures: "  failures:\n    - status: 404\n      failure: game-not-found\n" })).ir;
    const after = run(manifest({ effect, failures: "  failures:\n    - status: 404\n      failure: already-refunded\n" })).ir;
    return diffIR(before, after).entries.filter((e) => e.path === "failures");
  };

  it("a mapping change on a read capability is compatible", () => {
    const entries = pair("read");
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "binding-changed", severity: "compatible", before: ["game-not-found"], after: ["already-refunded"] });
  });

  it.each(["write", "irreversible"])("a mapping change on a %s capability is breaking", (effect) => {
    const entries = pair(effect);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ kind: "binding-changed", severity: "breaking" });
  });

  it("adding mappings is reported; identical mappings are not", () => {
    const none = run(manifest({})).ir;
    const some = run(manifest({ failures: MAPPED })).ir;
    expect(diffIR(none, some).entries.filter((e) => e.path === "failures")).toHaveLength(1);
    expect(diffIR(some, run(manifest({ failures: MAPPED })).ir).entries.filter((e) => e.path === "failures")).toEqual([]);
  });
});
