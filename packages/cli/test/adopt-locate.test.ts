import { describe, it, expect } from "vitest";
import { resolve, dirname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import type { IRTool } from "@archstone/compiler";
import { locateFiles } from "../src/adopt";

// #177 — two namespaces sharing a bare resource name (tourism.Stay / wanderlust.Stay).
const here = dirname(fileURLToPath(import.meta.url));
const showcase = resolve(here, "../../../examples/showcase/manifest");

/** Only `id` and `response.resource` are read by locateFiles. */
function tool(resource: string): IRTool {
  return { id: "wanderlust.search", response: { resource } } as unknown as IRTool;
}

describe("locateFiles — resource lookup across namespaces (#177)", () => {
  it("an exact name picks its own file, not an earlier namespace's suffix match", () => {
    const located = locateFiles(showcase, tool("wanderlust.Stay"));
    expect("problem" in located).toBe(false);
    if ("problem" in located) return;
    expect(basename(located.resourceFile)).toBe("wanderlust.Stay.resource.yaml");
    const other = locateFiles(showcase, tool("tourism.Stay"));
    if ("problem" in other) throw new Error(other.problem);
    expect(basename(other.resourceFile)).toBe("tourism.Stay.resource.yaml");
  });

  it("an ambiguous bare-name fallback is a problem naming every candidate", () => {
    const located = locateFiles(showcase, tool("Stay"));
    expect("problem" in located).toBe(true);
    if (!("problem" in located)) return;
    expect(located.problem).toContain("ambiguous");
    expect(located.problem).toContain("tourism.Stay");
    expect(located.problem).toContain("wanderlust.Stay");
  });

  it("an unambiguous bare-name fallback still resolves", () => {
    const scratch = mkdtempSync(resolve(tmpdir(), "archstone-locate-"));
    try {
      cpSync(showcase, scratch, { recursive: true });
      const located = locateFiles(scratch, tool("Amenity"));
      if ("problem" in located) throw new Error(located.problem);
      expect(basename(located.resourceFile)).toBe("wanderlust.Amenity.resource.yaml");
    } finally {
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
