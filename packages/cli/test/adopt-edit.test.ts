import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { applyAdoption, applyContractRecording, insertContract, stampVerifiedAt, type AdoptionEdit } from "../src/adopt-edit";

const root = resolve(__dirname, "../../..");
const resourceYaml = readFileSync(resolve(root, "examples/manifests/tourism/tourism.Stay.resource.yaml"), "utf8");
const bindingYaml = readFileSync(resolve(root, "examples/manifests/tourism/bindings/tourism.search.binding.yaml"), "utf8");
const capabilityYaml = readFileSync(resolve(root, "examples/manifests/tourism/tourism.search.capability.yaml"), "utf8");

const boardType: AdoptionEdit = {
  field: "boardType",
  itemPath: "$.boardType",
  semantic: "text",
  description: "What the rate includes — ROOM_ONLY, BREAKFAST, HALF_BOARD or ALL_INCLUSIVE.",
  kind: "resource-field",
};

function ok(r: ReturnType<typeof applyAdoption>) {
  if (!r.ok) throw new Error(`expected ok, got: ${r.problem}`);
  return r;
}

describe("applyAdoption — a review surface survives the edit (ADD-117)", () => {
  it("appends the field to the resource, with required:false and the human's description", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [boardType]));
    expect(r.resource).toContain("    boardType:\n      type: text\n      required: false\n      description:");
    expect(r.resource).toContain("ROOM_ONLY, BREAKFAST, HALF_BOARD or ALL_INCLUSIVE.");
  });

  it("appends the JSONPath to the binding's response map, quoted like its neighbours", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [boardType]));
    expect(r.binding).toContain('      boardType: "$.boardType"');
  });

  it("changes NOTHING else — every original line survives, in order", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [boardType]));
    for (const [before, after] of [
      [resourceYaml, r.resource],
      [bindingYaml, r.binding],
      [capabilityYaml, r.capability],
    ]) {
      const originals = before.split("\n");
      const result = after.split("\n");
      // Every original line still present, in the same relative order: the appended lines are
      // the only difference. This is the property the whole module exists for — a comment lost
      // here is a comment a human wrote about their own business.
      let cursor = 0;
      for (const line of originals) {
        const at = result.indexOf(line, cursor);
        expect(at, `original line vanished or moved: ${JSON.stringify(line)}`).toBeGreaterThanOrEqual(cursor);
        cursor = at + 1;
      }
    }
  });

  it("keeps every comment the human wrote", () => {
    const comments = (s: string) => s.split("\n").filter((l) => l.trim().startsWith("#"));
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [boardType]));
    expect(comments(r.resource)).toEqual(comments(resourceYaml));
    expect(comments(r.binding)).toEqual(comments(bindingYaml));
  });

  it("appends inside the block, not after the blank line that ends it", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [boardType]));
    const lines = r.binding.split("\n");
    const mapIdx = lines.findIndex((l) => l.trim() === "map:");
    const addedIdx = lines.findIndex((l) => l.includes("boardType:"));
    // Nothing but map entries between the header and the new line.
    for (let i = mapIdx + 1; i < addedIdx; i++) {
      expect(lines[i].trim()).toMatch(/^[A-Za-z]/);
    }
  });

  it("applies several fields in one pass", () => {
    const r = ok(
      applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [
        boardType,
        {
          field: "distanceToBeachM",
          itemPath: "$.distanceToBeachM",
          semantic: "quantity",
          description: "Metres to the nearest beach.",
          kind: "resource-field",
        },
      ]),
    );
    expect(r.resource).toContain("    distanceToBeachM:");
    expect(r.binding).toContain('      distanceToBeachM: "$.distanceToBeachM"');
  });

  it("quotes a description that would otherwise break the document", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [{ ...boardType, description: "Board: what it includes # and a hash" }]));
    expect(r.resource).toContain('description: "Board: what it includes # and a hash"');
  });

  it("is a no-op for no edits", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, []));
    expect(r.resource).toBe(resourceYaml);
    expect(r.binding).toBe(bindingYaml);
    expect(r.capability).toBe(capabilityYaml);
  });

  it("refuses rather than guessing when the block is missing", () => {
    const r = applyAdoption("resource:\n  name: tourism.Stay\n", bindingYaml, capabilityYaml, [boardType]);
    expect(r).toEqual({ ok: false, problem: expect.stringContaining("could not find a 'fields:' block") });
  });

  it("refuses rather than guessing when a block is ambiguous", () => {
    const twoMaps = bindingYaml.replace("  contract:", "  response:\n    map:\n      x: \"$.x\"\n\n  contract:");
    const r = applyAdoption(resourceYaml, twoMaps, capabilityYaml, [boardType]);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("refusing to guess");
  });
});

// #82 (ADD-12 §8.2): a scalar-array candidate (`kind: "output-array"`) writes the CAPABILITY's
// own `output:` (a `list:` field) and the binding's `extract:`, never the resource file.
describe("applyAdoption — output-array edits (#82, ADD-12 §8.2)", () => {
  const warnings: AdoptionEdit = {
    field: "warnings",
    itemPath: "$.warnings[*]",
    semantic: "text",
    description: "Non-fatal issues the backend flagged with this search.",
    kind: "output-array",
  };

  it("appends a list: field to the capability's output:, not the resource", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [warnings]));
    expect(r.capability).toContain("    warnings:\n      list: text\n      required: false\n      description:");
    expect(r.resource).toBe(resourceYaml); // the resource file is untouched by an output-array edit
  });

  it("appends to an EXISTING extract: block instead of creating a second one", () => {
    // The tourism fixture already declares `extract: { totalMatches: ... }`.
    expect(bindingYaml).toContain("extract:");
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [warnings]));
    expect(r.binding.match(/^\s*extract:$/gm)).toHaveLength(1);
    expect(r.binding).toContain('    totalMatches: "$.totalMatches"');
    expect(r.binding).toContain('    warnings: "$.warnings[*]"');
  });

  it("appends the JSONPath to the binding's extract:, CREATING the block when a binding has none", () => {
    const noExtract = bindingYaml.replace(/\n {2}# Extract[\s\S]*?extract:\n {4}totalMatches: "\$\.totalMatches"\n/, "\n");
    expect(noExtract).not.toContain("extract:");
    const r = ok(applyAdoption(resourceYaml, noExtract, capabilityYaml, [warnings]));
    expect(r.binding).toContain('  extract:\n    warnings: "$.warnings[*]"');
  });

  it("keeps every comment the human wrote in the capability document", () => {
    const comments = (s: string) => s.split("\n").filter((l) => l.trim().startsWith("#"));
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [warnings]));
    expect(comments(r.capability)).toEqual(comments(capabilityYaml));
  });

  it("a resource-field edit and an output-array edit in the same call touch the right files each", () => {
    const r = ok(applyAdoption(resourceYaml, bindingYaml, capabilityYaml, [boardType, warnings]));
    expect(r.resource).toContain("boardType:"); // resource-field
    expect(r.binding).toContain('boardType: "$.boardType"');
    expect(r.capability).toContain("warnings:"); // output-array
    expect(r.binding).toContain('warnings: "$.warnings[*]"');
  });
});

describe("applyContractRecording — one response, one contract (ADD-117 R-4)", () => {
  const shape = { $: "object", "$.stays": "array", "$.stays[]": "object", "$.stays[].boardType": "string" };

  it("replaces the fingerprint and the whole shape block, rather than accumulating", () => {
    const first = applyContractRecording(bindingYaml, "sha256:" + "a".repeat(64), shape);
    if (!first.ok) throw new Error(first.problem);
    const second = applyContractRecording(first.binding, "sha256:" + "b".repeat(64), { ...shape, "$.stays[].net": "number" });
    if (!second.ok) throw new Error(second.problem);
    expect(second.binding.match(/^\s*shape:$/gm)).toHaveLength(1);
    expect(second.binding).toContain("sha256:" + "b".repeat(64));
    expect(second.binding).not.toContain("sha256:" + "a".repeat(64));
    expect(second.binding).toContain('"$.stays[].net": number');
  });

  it("quotes every path key, so a JSONPath never reads as structure", () => {
    const r = applyContractRecording(bindingYaml, "sha256:" + "c".repeat(64), shape);
    if (!r.ok) throw new Error(r.problem);
    expect(r.binding).toContain('"$.stays[].boardType": string');
    expect(r.binding).toContain('"$": object');
  });

  it("keeps the human's comments around the contract block", () => {
    const before = bindingYaml.split("\n").filter((l) => l.trim().startsWith("#"));
    const r = applyContractRecording(bindingYaml, "sha256:" + "d".repeat(64), shape);
    if (!r.ok) throw new Error(r.problem);
    expect(r.binding.split("\n").filter((l) => l.trim().startsWith("#"))).toEqual(before);
  });

  it("refuses a binding with no contract to update", () => {
    const r = applyContractRecording("binding:\n  capabilityId: x\n", "sha256:" + "e".repeat(64), shape);
    expect(r).toEqual({ ok: false, problem: expect.stringContaining("no contract fingerprint") });
  });
});

describe("insertContract — a contract for a binding that has none", () => {
  // The checked-in binding with its contract (and the comment introducing it) cut off.
  const bare = bindingYaml.slice(0, bindingYaml.indexOf("  # What we last verified")).replace(/\n+$/, "\n");
  const block = {
    fingerprint: "sha256:abc",
    shape: { "$.b": "number", $: "object", "$.a[]": "string" },
    verifiedAt: "2026-11-03T10:00:00.000Z",
    fixture: "fixtures/tourism.search.golden.json",
  };

  it("appends at the end of the binding: block, at its child indent, rendered as init renders it", () => {
    const r = insertContract(bare, block);
    if (!r.ok) throw new Error(r.problem);
    const added = r.binding.slice(bare.length - 1);
    expect(added).toBe(
      [
        "",
        "",
        "  # What we recorded the live backend returning, at the time shown. `archstone verify`",
        "  # replays this fixture's `request` and compares the response shape — that is how you",
        "  # find out the backend changed before an agent does.",
        "  contract:",
        "    source: recorded",
        '    fingerprint: "sha256:abc"',
        "    shape:",
        '      "$": object',
        '      "$.a[]": string',
        '      "$.b": number',
        '    verifiedAt: "2026-11-03T10:00:00.000Z"',
        "    probe:",
        "      fixture: fixtures/tourism.search.golden.json",
        "",
      ].join("\n"),
    );
  });

  it("touches every other byte not at all", () => {
    const r = insertContract(bare, block);
    if (!r.ok) throw new Error(r.problem);
    expect(r.binding.startsWith(bare.replace(/\n$/, ""))).toBe(true);
  });

  it("lands inside binding: when a top-level document follows it", () => {
    const yaml = "# head\nbinding:\n    capabilityId: x  # deeper indent\n\n# trailing top-level comment\n";
    const r = insertContract(yaml, block);
    if (!r.ok) throw new Error(r.problem);
    const lines = r.binding.split("\n");
    expect(lines.slice(0, 3)).toEqual(["# head", "binding:", "    capabilityId: x  # deeper indent"]);
    expect(lines).toContain("    contract:");
    expect(lines).toContain("      source: recorded");
    expect(lines.indexOf("    contract:")).toBeLessThan(lines.indexOf("# trailing top-level comment"));
  });

  it("omits shape: when the recording has none", () => {
    const { shape: _s, ...noShape } = block;
    const r = insertContract(bare, noShape);
    if (!r.ok) throw new Error(r.problem);
    expect(r.binding).not.toContain("shape:");
  });

  it("refuses when a contract: already exists", () => {
    const r = insertContract(bindingYaml, block);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problem).toContain("already declares a contract");
  });

  it("refuses when the binding: block is missing or not top-level", () => {
    expect(insertContract("capability:\n  id: x\n", block).ok).toBe(false);
    expect(insertContract("wrapper:\n  binding:\n    capabilityId: x\n", block).ok).toBe(false);
  });
});

describe("stampVerifiedAt — re-record moves the date it checks", () => {
  it("replaces only the contract's verifiedAt value", () => {
    const r = stampVerifiedAt(bindingYaml, "2026-11-03T10:00:00.000Z");
    if (!r.ok) throw new Error(r.problem);
    expect(r.binding).toBe(bindingYaml.replace('verifiedAt: "2026-09-11T00:00:00Z"', 'verifiedAt: "2026-11-03T10:00:00.000Z"'));
  });

  it("leaves a contract with no verifiedAt unchanged", () => {
    const yaml = "binding:\n  capabilityId: x\n  contract:\n    source: recorded\n    fingerprint: a\n";
    const r = stampVerifiedAt(yaml, "2026-11-03T10:00:00.000Z");
    expect(r).toEqual({ ok: true, binding: yaml });
  });
});
