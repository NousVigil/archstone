import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { load } from "../src/index";

const here = dirname(fileURLToPath(import.meta.url));
const manifests = resolve(here, "../../../examples/manifests");

/** Create a throwaway manifest dir from a map of relative path -> contents. */
function fixture(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "archstone-"));
  for (const [rel, content] of Object.entries(files)) {
    const full = join(dir, rel);
    // rel here is always flat (no subdirs) in these tests
    writeFileSync(full, content);
  }
  return dir;
}

describe("load — valid fixtures", () => {
  it("loads the booking manifest clean", () => {
    const r = load(join(manifests, "booking"));
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    expect(r.capabilities?.company.id).toBe("booking");
    expect(r.capabilityDocs).toHaveLength(4);
    expect(r.capabilityDocs.map((d) => d.capability.id)).toContain("tourism.search");
    expect(r.bindings).toHaveLength(1);
  });

  it("loads the bank manifest clean", () => {
    const r = load(join(manifests, "bank"));
    expect(r.ok).toBe(true);
    expect(r.capabilityDocs).toHaveLength(6);
    // effect enum is honoured (bank has an irreversible transfer)
    expect(r.capabilityDocs.map((d) => d.capability.effect)).toContain("irreversible");
  });

  it("loads *.resource.yaml into resourceDocs (bank has 6)", () => {
    const r = load(join(manifests, "bank"));
    expect(r.resourceDocs).toHaveLength(6);
    const account = r.resourceDocs.find((d) => d.resource.name === "banking.Account");
    expect(account).toBeDefined();
    expect(account!.file).toBe("banking.Account.resource.yaml");
    expect(Object.keys(account!.resource.fields)).toContain("balance");
  });

  it("loads the tourism demo's Stay resource", () => {
    const r = load(join(manifests, "tourism"));
    expect(r.ok).toBe(true);
    expect(r.resourceDocs.map((d) => d.resource.name)).toContain("tourism.Stay");
  });
});

describe("load — rejections (validation actually bites)", () => {
  it("reports a directory that does not exist", () => {
    const r = load("/tmp/archstone-does-not-exist-xyz");
    expect(r.ok).toBe(false);
    expect(r.issues[0]?.message).toMatch(/directory not found/);
  });

  it("flags missing required fields: providers (capabilities.yaml) and effect (capability)", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: bad\ncapabilities:\n  - tourism.search\n",
      "x.capability.yaml": "capability:\n  id: tourism.search\n  description: no effect field\n",
    });
    const r = load(dir);
    expect(r.ok).toBe(false);
    const msgs = r.issues.map((i) => i.message).join(" | ");
    expect(msgs).toMatch(/providers/);
    expect(msgs).toMatch(/effect/);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a missing capabilities.yaml", () => {
    const dir = fixture({
      "x.capability.yaml": "capability:\n  id: tourism.search\n  description: ok\n  effect: read\n",
    });
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "capabilities.yaml" && /missing/.test(i.message))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a malformed resource file, naming it (missing required 'fields')", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: ok\ncapabilities:\n  - shop.search\nproviders:\n  - store\n",
      "Bad.resource.yaml": "resource:\n  name: Bad\n",
    });
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "Bad.resource.yaml" && /fields/.test(i.message))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles malformed YAML without throwing", () => {
    const dir = fixture({
      "capabilities.yaml": "company:\n  id: ok\ncapabilities:\n  - tourism.search\nproviders:\n  - booking-api\n",
      "x.capability.yaml": "capability: [unterminated\n",
    });
    // must not throw — the bad file becomes an issue
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "x.capability.yaml" && /parse error/.test(i.message))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------------------
// #43 (ADD-43 §8.1 / BR-1, BR-2) — `*.policy.yaml` joins the loaded set. Shape only: whether
// the scope RESOLVES, and whether this version can evaluate what the spec declares, is the
// semantic pass's job (see packages/compiler/test/policy.test.ts).

const CAPS = "company:\n  id: acme\ncapabilities:\n  - shop.search\nproviders:\n  - store\n";
const CAP = "capability:\n  id: shop.search\n  description: find\n  effect: read\n  provider: store\n";
const POLICY = [
  "apiVersion: archstone/v1",
  "kind: Policy",
  "metadata:",
  "  id: shop-search-allow",
  "  name: Shop search allow-list",
  "  scope: capability",
  "  capabilityId: shop.search",
  "spec:",
  "  allow:",
  '    - "user:alice"',
  "",
].join("\n");

// Extends ADD-12 (per the accepted architecture decision): binding.schema.json's new sibling
// `extract:` property. Shape only — a real field/kind/path check is the semantic pass
// (packages/compiler/test/validate.test.ts); this just proves the schema itself accepts a
// well-formed block and refuses a malformed one, naming the file.
describe("load — bindings/*.binding.yaml extract: (extends ADD-12)", () => {
  const CAPS = "company:\n  id: acme\ncapabilities:\n  - shop.count\nproviders:\n  - store\n";
  const CAP = "capability:\n  id: shop.count\n  description: count\n  effect: read\n  provider: store\n  output:\n    total:\n      type: quantity\n";
  const CONNECTOR = "  connector:\n    type: rest\n    rest:\n      method: GET\n      path: /count\n";

  it("accepts a well-formed extract: — a bare JSONPath string and a {path, required:false} form", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), CAPS);
    writeFileSync(join(dir, "shop.count.capability.yaml"), CAP);
    mkdirSync(join(dir, "bindings"));
    writeFileSync(
      join(dir, "bindings", "shop.count.binding.yaml"),
      `binding:\n  capabilityId: shop.count\n${CONNECTOR}  extract:\n    total: "$.total"\n`,
    );
    const r = load(dir);
    expect(r.ok).toBe(true);
    expect(r.bindings[0].binding.extract).toEqual({ total: "$.total" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts the {path, required: false} object form", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), CAPS);
    writeFileSync(join(dir, "shop.count.capability.yaml"), CAP);
    mkdirSync(join(dir, "bindings"));
    writeFileSync(
      join(dir, "bindings", "shop.count.binding.yaml"),
      `binding:\n  capabilityId: shop.count\n${CONNECTOR}  extract:\n    total:\n      path: "$.total"\n      required: false\n`,
    );
    const r = load(dir);
    expect(r.ok).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects required: true (only false is a legal loosening, mirroring response.schema.json's map)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), CAPS);
    writeFileSync(join(dir, "shop.count.capability.yaml"), CAP);
    mkdirSync(join(dir, "bindings"));
    writeFileSync(
      join(dir, "bindings", "shop.count.binding.yaml"),
      `binding:\n  capabilityId: shop.count\n${CONNECTOR}  extract:\n    total:\n      path: "$.total"\n      required: true\n`,
    );
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "bindings/shop.count.binding.yaml")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an empty extract: map (minProperties: 1, mirroring response.schema.json's map)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), CAPS);
    writeFileSync(join(dir, "shop.count.capability.yaml"), CAP);
    mkdirSync(join(dir, "bindings"));
    writeFileSync(join(dir, "bindings", "shop.count.binding.yaml"), `binding:\n  capabilityId: shop.count\n${CONNECTOR}  extract: {}\n`);
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "bindings/shop.count.binding.yaml")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("load — *.policy.yaml (#43)", () => {
  it("discovers a policy document by suffix from the manifest root and shape-validates it", () => {
    const dir = fixture({ "capabilities.yaml": CAPS, "x.capability.yaml": CAP, "shop.policy.yaml": POLICY });
    const r = load(dir);
    expect(r.ok).toBe(true);
    expect(r.policyDocs).toHaveLength(1);
    expect(r.policyDocs[0].file).toBe("shop.policy.yaml");
    expect(r.policyDocs[0].metadata.id).toBe("shop-search-allow");
    expect(r.policyDocs[0].spec.allow).toEqual(["user:alice"]);
    rmSync(dir, { recursive: true, force: true });
  });

  // BR-2: capabilities.schema.json is `additionalProperties: false` with no slot for policies,
  // so there is deliberately NO declared-without-file / file-not-declared cross-check for them —
  // exactly the *.resource.yaml precedent.
  it("needs no declaration in capabilities.yaml and produces no declaration cross-check", () => {
    const dir = fixture({ "capabilities.yaml": CAPS, "x.capability.yaml": CAP, "shop.policy.yaml": POLICY });
    const r = load(dir);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  // S-US1.2 — policy.schema.json sets additionalProperties:false on spec.
  it("reports a malformed policy document as a shape issue naming the file", () => {
    const dir = fixture({
      "capabilities.yaml": CAPS,
      "x.capability.yaml": CAP,
      "bad.policy.yaml": POLICY.replace("  allow:", "  bogusKey: 1\n  allow:"),
    });
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "bad.policy.yaml")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports a policy with a bad metadata.id pattern", () => {
    const dir = fixture({
      "capabilities.yaml": CAPS,
      "x.capability.yaml": CAP,
      "bad.policy.yaml": POLICY.replace("id: shop-search-allow", "id: Shop_Search"),
    });
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "bad.policy.yaml")).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  it("handles malformed policy YAML without throwing", () => {
    const dir = fixture({
      "capabilities.yaml": CAPS,
      "x.capability.yaml": CAP,
      "bad.policy.yaml": "spec: [unterminated\n",
    });
    const r = load(dir);
    expect(r.ok).toBe(false);
    expect(r.issues.some((i) => i.file === "bad.policy.yaml" && /parse error/.test(i.message))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });

  // EC-2: discovery is manifest-ROOT only, mirroring *.resource.yaml. A policy under bindings/
  // is inert — documented in ONBOARDING as a placement rule so it is not mistaken for a bug.
  it("does not discover a policy placed in bindings/ (root-only, like *.resource.yaml)", () => {
    const dir = fixture({ "capabilities.yaml": CAPS, "x.capability.yaml": CAP });
    mkdirSync(join(dir, "bindings"));
    writeFileSync(join(dir, "bindings", "shop.policy.yaml"), POLICY);
    const r = load(dir);
    expect(r.ok).toBe(true);
    expect(r.policyDocs).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("leaves policyDocs empty for every shipped example manifest (nothing changes meaning)", () => {
    for (const name of ["booking", "bank", "tourism"]) {
      expect(load(join(manifests, name)).policyDocs).toEqual([]);
    }
  });
});

// #63 — `listField` CDL form (`list:`), and connector.schema.json's widened `rest.query`.
const LIST_CAPS = "company:\n  id: acme\ncapabilities:\n  - acme.thing\nproviders:\n  - store\n";
const LIST_CAP_OK = "capability:\n  id: acme.thing\n  description: d\n  effect: read\n  input:\n    tags:\n      list: string\n      required: false\n      description: filter tags\n";

describe("load — list-valued input fields (#63)", () => {
  it("accepts a `list:` field with `required`/`description`", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), LIST_CAPS);
    writeFileSync(join(dir, "acme.thing.capability.yaml"), LIST_CAP_OK);
    const r = load(dir);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("requires `values` when `list: enum`, exactly like `semanticField`", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), LIST_CAPS);
    writeFileSync(join(dir, "acme.thing.capability.yaml"), "capability:\n  id: acme.thing\n  description: d\n  effect: read\n  input:\n    tags:\n      list: enum\n");
    const r = load(dir);
    expect(r.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects `type:` and `list:` on the SAME field (mutually exclusive forms)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), LIST_CAPS);
    writeFileSync(
      join(dir, "acme.thing.capability.yaml"),
      "capability:\n  id: acme.thing\n  description: d\n  effect: read\n  input:\n    tags:\n      type: string\n      list: string\n",
    );
    const r = load(dir);
    expect(r.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it("accepts the widened `rest.query` object form (explode, onQuery, name)", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), LIST_CAPS);
    writeFileSync(join(dir, "acme.thing.capability.yaml"), LIST_CAP_OK);
    mkdirSync(join(dir, "bindings"));
    writeFileSync(
      join(dir, "bindings", "acme.thing.binding.yaml"),
      "binding:\n  capabilityId: acme.thing\n  connector:\n    type: rest\n    rest:\n      method: GET\n      path: /things\n      query:\n        tags:\n          explode: false\n        legacyRename: wire_name\n",
    );
    const r = load(dir);
    expect(r.ok).toBe(true);
    expect(r.issues).toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("rejects an unmodeled key inside a `rest.query` object entry", () => {
    const dir = mkdtempSync(join(tmpdir(), "archstone-"));
    writeFileSync(join(dir, "capabilities.yaml"), LIST_CAPS);
    writeFileSync(join(dir, "acme.thing.capability.yaml"), LIST_CAP_OK);
    mkdirSync(join(dir, "bindings"));
    writeFileSync(
      join(dir, "bindings", "acme.thing.binding.yaml"),
      "binding:\n  capabilityId: acme.thing\n  connector:\n    type: rest\n    rest:\n      method: GET\n      path: /things\n      query:\n        tags:\n          style: deepObject\n",
    );
    const r = load(dir);
    expect(r.ok).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
});
