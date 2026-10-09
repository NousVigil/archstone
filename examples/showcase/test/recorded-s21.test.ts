// S-21 (AC-5.7): the embedded SDK exposes the same tools to three vendor shapes, and the S-02 and
// S-14 withholding and refusals still hold. Asserted from the recorded report of examples/showcase/sdk/embedded.mjs.

import { describe, it, expect } from "vitest";
import { expectWellFormed, stepWith } from "./recorded";

const t = expectWellFormed("S-21", "sdk");
const script = stepWith(t, "node examples/showcase/sdk/embedded.mjs");
const report = JSON.parse(script.stdout!) as {
  vendorShapes: Record<string, { tools: number; envelopeKeys: string[] }>;
  toolNames: string[];
  stayDetails: { status: string; topLevelKeys: string[]; forbiddenKeysFound: string[] };
  deleteRequest: { status: string; error: string };
  failures: string[];
};

describe("recorded S-21: the embedded SDK", () => {
  it("ran clean: exit 0 and no failed expectation", () => {
    expect(script.exit).toBe(0);
    expect(report.failures).toEqual([]);
  });

  it("offers the same tools in three vendor shapes", () => {
    expect(Object.keys(report.vendorShapes).sort()).toEqual(["anthropic", "gemini", "openai-chat"]);
    for (const shape of Object.values(report.vendorShapes)) expect(shape.tools).toBe(report.toolNames.length);
    expect(new Set(Object.values(report.vendorShapes).map((s) => s.envelopeKeys.join())).size).toBe(3);
    expect(report.toolNames).toContain("wanderlust_stay-details");
    // the unlisted/retired capabilities are in no shape, exactly as on the MCP path
    expect(report.toolNames).not.toContain("wanderlust_neighbourhood");
    expect(report.toolNames).not.toContain("tourism_search-classic");
  });

  it("S-02 still holds: stay details return no margin, passport, phone, raw HTML or guest list", () => {
    expect(report.stayDetails.status).toBe("ok");
    expect(report.stayDetails.topLevelKeys).toEqual(["stay"]);
    expect(report.stayDetails.forbiddenKeysFound).toEqual([]);
  });

  it("S-14 still holds: no tool deletes, and asking for one is refused as unknown", () => {
    expect(report.toolNames.some((n) => /delete|remove|erase/i.test(n))).toBe(false);
    expect(report.deleteRequest).toEqual({ status: "error", error: "unknown capability: wanderlust.delete-guest-bookings" });
    expect(t.asserts.some((a) => a.negative && /never reached the backend/.test(a.claim))).toBe(true);
  });
});
