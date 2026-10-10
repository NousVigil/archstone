import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { buildRegistry } from "@archstone/runtime";
import { fromIR, sanitizeGeminiSchema } from "../src/index";
import type {
  AnthropicToolDef,
  OpenAIChatToolDef,
  OpenAIResponsesToolDef,
  GeminiToolDef,
  JsonSchemaToolDef,
} from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const tourism = resolve(here, "../../../examples/manifests/tourism");

/** One capability per lifecycle state, all bound to the same (unreachable — never invoked in
 *  these tests) backend — mirrors packages/runtime/test/lifecycle.integration.test.ts's fixture
 *  so `buildToolDefs`'s exposure filtering is exercised the same way `toolDefinitions()`'s is. */
const LIFECYCLES = ["stable", "beta", "deprecated", "experimental", "retired"] as const;

function writeLifecycleManifest(dir: string): void {
  writeFileSync(
    join(dir, "capabilities.yaml"),
    [
      "company:",
      "  id: demo",
      "capabilities:",
      ...LIFECYCLES.map((l) => `  - demo.${l}`),
      "providers:",
      "  - acme",
      "",
    ].join("\n"),
  );
  mkdirSync(join(dir, "bindings"));
  for (const l of LIFECYCLES) {
    writeFileSync(
      join(dir, `demo.${l}.capability.yaml`),
      [
        "capability:",
        `  id: demo.${l}`,
        `  description: A ${l} capability.`,
        "  effect: read",
        "  provider: acme",
        `  lifecycle: ${l}`,
        "  output:",
        "    value:",
        "      type: string",
        "",
      ].join("\n"),
    );
    writeFileSync(
      join(dir, "bindings", `demo.${l}.binding.yaml`),
      [
        "binding:",
        `  capabilityId: demo.${l}`,
        "  connector:",
        "    type: rest",
        "    rest:",
        '      baseUrl: "${DEMO_API_URL}"',
        "      method: GET",
        "      path: /x",
        "",
      ].join("\n"),
    );
  }
}

type JsonSchema = { type?: string; properties?: Record<string, unknown>; required?: string[] };

/** `archstone build`'s artifact is IR round-tripped through JSON — simulate that exactly,
 *  rather than feeding fromIR a live Registry's IR object directly (ADD-0008 #28 DoD). */
function loadArtifact(): unknown {
  const ir = buildRegistry(tourism).registry!.ir;
  return JSON.parse(JSON.stringify(ir));
}

describe("tools(format) — envelope shape per target (tourism.search)", () => {
  const archstone = fromIR(loadArtifact());

  it("anthropic: {name, description, input_schema}", () => {
    const defs = archstone.tools("anthropic") as AnthropicToolDef[];
    const search = defs.find((d) => d.name === "tourism_search");
    expect(search).toBeDefined();
    expect(search!.description).toBeTruthy();
    const schema = search!.input_schema as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
    expect(schema.required).toContain("destination");
  });

  it("openai-chat: {type:'function', function:{name, description, parameters}}", () => {
    const defs = archstone.tools("openai-chat") as OpenAIChatToolDef[];
    const search = defs.find((d) => d.function.name === "tourism_search");
    expect(search).toBeDefined();
    expect(search!.type).toBe("function");
    expect(search!.function.description).toBeTruthy();
    const schema = search!.function.parameters as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
  });

  it("openai-responses: flat {type, name, description, parameters, strict:false}", () => {
    const defs = archstone.tools("openai-responses") as OpenAIResponsesToolDef[];
    const search = defs.find((d) => d.name === "tourism_search");
    expect(search).toBeDefined();
    expect(search!.type).toBe("function");
    expect(search!.strict).toBe(false);
    expect((search as unknown as { function?: unknown }).function).toBeUndefined();
    const schema = search!.parameters as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
  });

  it('openai (deprecated alias): tools() output is byte-identical to "openai-chat"', () => {
    const alias = archstone.tools("openai");
    const chat = archstone.tools("openai-chat");
    expect(alias).toEqual(chat);
  });

  it("gemini: {name, description, parameters} — flat, no OpenAI-style envelope", () => {
    const defs = archstone.tools("gemini") as GeminiToolDef[];
    const search = defs.find((d) => d.name === "tourism_search");
    expect(search).toBeDefined();
    expect((search as unknown as { type?: string }).type).toBeUndefined();
    const schema = search!.parameters as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
  });

  it("json-schema: neutral {name, description, schema}, no provider envelope", () => {
    const defs = archstone.tools("json-schema") as JsonSchemaToolDef[];
    const search = defs.find((d) => d.name === "tourism_search");
    expect(search).toBeDefined();
    const schema = search!.schema as JsonSchema;
    expect(schema.type).toBe("object");
    expect(schema.properties).toHaveProperty("destination");
  });

  it("only invocable (bound) capabilities are listed as tools, across every format", () => {
    for (const format of ["anthropic", "openai", "openai-chat", "openai-responses", "gemini", "json-schema"] as const) {
      const defs = archstone.tools(format) as { name?: string; function?: { name: string } }[];
      const names = defs.map((d) => d.name ?? d.function?.name);
      expect(names).toContain("tourism_search");
    }
  });
});

describe("sanitizeGeminiSchema — Gemini function-calling dialect subset", () => {
  it("strips keys Gemini's Schema object does not support (additionalProperties, const, $ref, ...)", () => {
    const dirty: Record<string, unknown> = {
      type: "object",
      additionalProperties: false,
      $ref: "#/definitions/x",
      allOf: [{ type: "string" }],
      properties: { a: { type: "string", const: "x" }, b: { type: "array", items: { type: "string", not: {} } } },
      required: ["a"],
    };
    const clean = sanitizeGeminiSchema(dirty);
    expect(clean).not.toHaveProperty("additionalProperties");
    expect(clean).not.toHaveProperty("$ref");
    expect(clean).not.toHaveProperty("allOf");
    const props = clean.properties as Record<string, Record<string, unknown>>;
    expect(props.a).not.toHaveProperty("const");
    expect((props.b.items as Record<string, unknown>)).not.toHaveProperty("not");
    // allowed keys survive untouched
    expect(clean.type).toBe("object");
    expect(clean.required).toEqual(["a"]);
  });

  it("only ever removes `additionalProperties` from our own lowering's output (#195)", () => {
    // The input schema is closed (`additionalProperties: false`) because the runtime refuses
    // undeclared keys; Gemini's Schema object cannot state that, so the sanitizer drops it and
    // enforcement stays server-side. It is the ONE keyword the lowering emits that Gemini lacks —
    // everything else must survive untouched.
    const open = (s: unknown): unknown =>
      Array.isArray(s)
        ? s.map(open)
        : s && typeof s === "object"
          ? Object.fromEntries(Object.entries(s).filter(([k]) => k !== "additionalProperties").map(([k, v]) => [k, open(v)]))
          : s;
    const archstone = fromIR(loadArtifact());
    const [search] = archstone.tools("json-schema") as JsonSchemaToolDef[];
    expect(JSON.stringify(search.schema)).toContain("additionalProperties");
    const already = sanitizeGeminiSchema(search.schema as Record<string, unknown>);
    expect(already).toEqual(open(search.schema));
  });
});

describe("#55: tools()/buildToolDefs honour capability exposure/lifecycle (ADD-24 D-6/R-5)", () => {
  let dir: string;
  let archstone: ReturnType<typeof fromIR>;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "archstone-agent-lifecycle-"));
    writeLifecycleManifest(dir);
    const built = buildRegistry(dir);
    if (!built.ok || !built.registry) {
      throw new Error(`fixture manifest failed to build: ${JSON.stringify(built.diagnostics)}`);
    }
    archstone = fromIR(JSON.parse(JSON.stringify(built.registry.ir)));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("lists exactly stable, beta, deprecated — retired and experimental are unlisted (D-10), across every format", () => {
    for (const format of ["anthropic", "openai", "openai-chat", "openai-responses", "gemini", "json-schema"] as const) {
      const defs = archstone.tools(format) as { name?: string; function?: { name: string } }[];
      const names = defs.map((d) => d.name ?? d.function?.name).sort();
      expect(names).toEqual(["demo_beta", "demo_deprecated", "demo_stable"]);
    }
  });

  it("stable has no hint; beta/deprecated carry their lifecycle hint text in the description", () => {
    const defs = archstone.tools("anthropic") as AnthropicToolDef[];
    const byName = new Map(defs.map((d) => [d.name, d.description]));
    expect(byName.get("demo_stable")).toBe("A stable capability.");
    expect(byName.get("demo_beta")).toContain("beta");
    expect(byName.get("demo_deprecated")).toContain("deprecated");
  });

  it("a retired capability never reaches any format's tool list", () => {
    for (const format of ["anthropic", "openai", "openai-chat", "openai-responses", "gemini", "json-schema"] as const) {
      const defs = archstone.tools(format) as { name?: string; function?: { name: string } }[];
      const names = defs.map((d) => d.name ?? d.function?.name);
      expect(names).not.toContain("demo_retired");
    }
  });
});

// #126 — the effect SURFACE test. The MCP emitter now lowers `effect` into MCP tool
// annotations (runtime/src/server.ts `effectAnnotations`); #126 asks for "the equivalent where
// the target format has one", and none of these formats has one. Each was checked at source
// before concluding — see the header comment in `packages/agent/src/tools.ts` for the exact
// field lists, the references and the dates:
//
//   anthropic         six optional properties, none about side effects
//   openai-chat       {type, function:{name, description, parameters}}; no side-effect field
//   openai-responses  {type, name, description, parameters, strict}; readOnly/destructive
//                     hints appear in OpenAI's docs only when describing MCP servers, not this
//                     envelope
//   openai            deprecated alias of openai-chat — same key set, same absence
//   gemini            has `behavior`, but it is BLOCKING/NON_BLOCKING — async execution in the
//                     Live API, not a side-effect annotation
//   json-schema       our own neutral envelope; this consumer is in-process and already holds
//                     `archstone.registry`, so `effect` was never withheld from it
//
// These assertions exist so "we emit nothing" is a recorded decision rather than an omission a
// later reader mistakes for an oversight: adding a field means changing a test that says why it
// is absent. This is the same instinct as audit-surface.test.ts / onresponse-surface.test.ts —
// pin the deliberate absence, not just the presence.
describe("#126 — no agent target format has an effect equivalent, so none is invented", () => {
  let dir: string;
  let archstone: ReturnType<typeof fromIR>;
  const EFFECTS = ["read", "write", "irreversible"] as const;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "archstone-agent-effect-"));
    writeFileSync(
      join(dir, "capabilities.yaml"),
      ["company:", "  id: demo", "capabilities:", ...EFFECTS.map((e) => `  - demo.${e}`), "providers:", "  - acme", ""].join("\n"),
    );
    mkdirSync(join(dir, "bindings"));
    for (const e of EFFECTS) {
      writeFileSync(
        join(dir, `demo.${e}.capability.yaml`),
        [
          "capability:",
          `  id: demo.${e}`,
          `  description: A ${e} capability.`,
          `  effect: ${e}`,
          "  provider: acme",
          "  output:",
          "    value:",
          "      type: string",
          "",
        ].join("\n"),
      );
      writeFileSync(
        join(dir, "bindings", `demo.${e}.binding.yaml`),
        [
          "binding:",
          `  capabilityId: demo.${e}`,
          "  connector:",
          "    type: rest",
          "    rest:",
          '      baseUrl: "${DEMO_API_URL}"',
          `      method: ${e === "read" ? "GET" : "POST"}`,
          "      path: /x",
          "",
        ].join("\n"),
      );
    }
    const built = buildRegistry(dir);
    if (!built.ok || !built.registry) {
      throw new Error(`fixture manifest failed to build: ${JSON.stringify(built.diagnostics)}`);
    }
    archstone = fromIR(JSON.parse(JSON.stringify(built.registry.ir)));
  });

  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  /** Exact key sets, unchanged by #126 — asserted with `.sort()` equality, not `toHaveProperty`,
   *  so an ADDED key fails just as loudly as a missing one. */
  const EXPECTED_KEYS: Record<string, string[]> = {
    anthropic: ["description", "input_schema", "name"],
    openai: ["function", "type"],
    "openai-chat": ["function", "type"],
    "openai-responses": ["description", "name", "parameters", "strict", "type"],
    gemini: ["description", "name", "parameters"],
    "json-schema": ["description", "name", "schema"],
  };

  it.each(EFFECTS)("effect: %s changes no envelope's key set in any format", (effect) => {
    for (const format of ["anthropic", "openai", "openai-chat", "openai-responses", "gemini", "json-schema"] as const) {
      const defs = archstone.tools(format) as { name?: string; function?: { name: string } }[];
      const def = defs.find((d) => (d.name ?? d.function?.name) === `demo_${effect}`)!;
      expect(def, `demo_${effect} must be listed in ${format}`).toBeDefined();
      expect(Object.keys(def).sort(), `${format} envelope for effect: ${effect}`).toEqual(EXPECTED_KEYS[format]);
    }
    // OpenAI-chat's inner function object, the one place a native field could plausibly have
    // gone.
    const openaiChat = archstone.tools("openai-chat") as OpenAIChatToolDef[];
    const fn = openaiChat.find((d) => d.function.name === `demo_${effect}`)!.function;
    expect(Object.keys(fn).sort()).toEqual(["description", "name", "parameters"]);
  });

  it("no format leaks an MCP annotation key or a raw `effect` field onto a tool definition", () => {
    for (const format of ["anthropic", "openai", "openai-chat", "openai-responses", "gemini", "json-schema"] as const) {
      const serialized = JSON.stringify(archstone.tools(format));
      // "effect" is safe to grep for here: this fixture's descriptions are "A <effect>
      // capability." and never contain the word itself.
      for (const forbidden of ["readOnlyHint", "destructiveHint", "idempotentHint", "openWorldHint", "effect"]) {
        expect(serialized, `${format} must not carry ${forbidden}`).not.toContain(forbidden);
      }
    }
  });
});
