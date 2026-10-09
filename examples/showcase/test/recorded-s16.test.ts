// S-16 (AC-5.2): `apply --exposure` lists none of margin, passport, phone, description_html, or any delete tool.
// Parsed from the recorded report text, which is what a reader sees.

import { describe, it, expect } from "vitest";
import { expectWellFormed, stepWith } from "./recorded";

const t = expectWellFormed("S-16", "cli");
const out = stepWith(t, "archstone apply examples/showcase/manifest --exposure").stdout!;

/** The report, as { capability, exposes[], withholds[] } read off its lines. */
const sections = out
  .split(/\n(?= {2}\S+ {2}\[(?:read|write|irreversible)\]\n)/)
  .slice(1)
  .map((block) => ({
    capability: /^ {2}(\S+) {2}\[/.exec(block)![1],
    exposes: /\n {4}exposes\s+([^\n]*)/.exec(block)?.[1] ?? "",
    withholds: /\n {4}withholds\s+([^\n]*)/.exec(block)?.[1] ?? "",
  }));

describe("recorded S-16: what the AI sees, in one list", () => {
  it("covers all 13 capabilities and exits 0", () => {
    expect(stepWith(t, "archstone apply examples/showcase/manifest --exposure").exit).toBe(0);
    expect(sections).toHaveLength(13);
  });

  it("negative: no exposed list names margin, passport, phone or description_html", () => {
    const exposed = sections.map((s) => s.exposes).join("\n").toLowerCase();
    expect(exposed.length).toBeGreaterThan(500);
    for (const word of ["margin", "passport", "phone", "description_html"]) expect(exposed, word).not.toContain(word);
  });

  it("negative: no capability in the list deletes", () => {
    expect(sections.map((s) => s.capability).filter((c) => /delete|remove|erase|destroy|purge/i.test(c))).toEqual([]);
  });

  it("the absence is the manifest's doing: the backend was observed returning each of them", () => {
    const withheld = sections.map((s) => s.withholds).join("\n").toLowerCase();
    for (const word of ["margin", "passport", "phone", "description_html"]) expect(withheld, word).toContain(word);
  });
});
