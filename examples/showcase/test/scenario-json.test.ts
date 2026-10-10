// scenarios.json: the one table every consumer reads (AC-1.10), and the data and hygiene rules the
// whole example must keep (AC-1.11, AC-1.12).

import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { GUEST_NAMES } from "../api/wanderlust-api.mjs";
import { DEMO_KEY_A, DEMO_KEY_B, DEMO_KEYS } from "../credentials.mjs";
import { REPO_ROOT, SHOWCASE_DIR, loadScenarios, openRegistry, type ScenarioRow } from "./harness";

const doc = loadScenarios();
const rows = doc.scenarios;
const byId = (id: string): ScenarioRow => rows.find((r) => r.id === id)!;
const ids = Array.from({ length: 23 }, (_, i) => `S-${String(i + 1).padStart(2, "0")}`);

function textFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((f) => {
    if (f === "node_modules" || f === "dist") return [];
    const p = join(dir, f);
    return statSync(p).isDirectory() ? textFiles(p) : [p];
  });
}

describe("AC-1.10: the scenario table", () => {
  it("has every S-01..S-23 exactly once, in order", () => {
    expect(rows.map((r) => r.id)).toEqual(ids);
    expect(new Set(rows.map((r) => r.id)).size).toBe(23);
  });

  it("gives every row except the two locked ones its N-xx id, numbered like the scenario", () => {
    for (const r of rows) {
      if (r.id === "S-10" || r.id === "S-22") {
        expect(r.negative, r.id).toBeNull();
      } else {
        expect(r.negative?.id, r.id).toBe(`N-${r.id.slice(2)}`);
      }
    }
  });

  it("has live rows S-01..S-09, S-11..S-14 and S-23, recorded rows S-15..S-21, and exactly two locked ones", () => {
    const modes = (m: string) => rows.filter((r) => r.mode === m).map((r) => r.id);
    expect(modes("live")).toEqual(["S-01", "S-02", "S-03", "S-04", "S-05", "S-06", "S-07", "S-08", "S-09", "S-11", "S-12", "S-13", "S-14", "S-23"]);
    expect(modes("recorded")).toEqual(["S-15", "S-16", "S-17", "S-18", "S-19", "S-20", "S-21"]);
    expect(modes("locked")).toEqual(["S-10", "S-22"]);
  });

  it("links the two locked rows to their issues and no other row to any", () => {
    expect(byId("S-10").issue).toBe(165);
    expect(byId("S-10").issueUrl).toBe("https://github.com/NousVigil/archstone/issues/165");
    expect(byId("S-22").issue).toBe(166);
    expect(byId("S-22").issueUrl).toBe("https://github.com/NousVigil/archstone/issues/166");
    for (const r of rows.filter((x) => x.mode !== "locked")) {
      expect(r.issue, r.id).toBeNull();
      expect(r.issueUrl, r.id).toBeNull();
    }
    expect(byId("S-10").parent).toBe("S-08/S-09");
  });

  it("has a companion anchor per row, derived from its id", () => {
    for (const r of rows) expect(r.anchor, r.id).toBe(`/demo/how-it-works#${r.id.toLowerCase()}`);
  });

  it("has English copy for every row and a Romanian slot for each of the three columns", () => {
    for (const r of rows) {
      for (const col of ["ask", "happens", "refused"] as const) {
        expect(typeof r.copy.en[col], `${r.id}.en.${col}`).toBe("string");
        expect(r.copy.en[col].trim().length, `${r.id}.en.${col}`).toBeGreaterThan(10);
        expect(typeof r.copy.ro[col], `${r.id}.ro.${col}`).toBe("string");
      }
      expect(Object.keys(r.copy).sort()).toEqual(["en", "ro"]);
    }
  });

  it("keeps the card copy plain: no tool names, field names, code or reason codes", () => {
    for (const r of rows) {
      for (const text of Object.values(r.copy.en)) {
        expect(text, r.id).not.toMatch(/[`{}<>[\]_]|wanderlust|archstone \w+ |rate_limit|principal_|policy_|contract_violation|lifecycle_/);
      }
    }
  });

  it("makes no claim Archstone does not keep: approval is declared, not enforced; nothing is guaranteed safe", () => {
    const all = rows.map((r) => Object.values(r.copy.en).join(" ")).join(" ").toLowerCase();
    expect(all).toContain("does not enforce");
    expect(byId("S-10").copy.en.refused.toLowerCase()).toContain("not enforced");
    expect(byId("S-08").copy.en.refused.toLowerCase()).toContain("archstone does not pause it");
    expect(byId("S-09").copy.en.refused.toLowerCase()).toContain("not archstone");
    expect(all).not.toMatch(/\b(safe|secure|secured|guarantee|guaranteed)\b/);
  });

  it("carries a valid key label and a coherent shape on every row", () => {
    for (const r of rows) {
      expect(["none", "A", "B"], r.id).toContain(r.key);
      if (r.negative?.key) expect(["none", "A", "B", "other"], r.id).toContain(r.negative.key);
      if (r.mode === "live") {
        expect(r.tool, r.id).toMatch(/^[a-z]+_[a-z-]+$|^tourism_search$/);
        expect(r.arguments, r.id).not.toBeNull();
        expect(["success", "refused", "unknown-tool"], r.id).toContain(r.outcome);
      } else {
        expect(r.tool, r.id).toBeNull();
        expect(r.arguments, r.id).toBeNull();
        expect(r.outcome, r.id).toBe(r.mode);
      }
      if (r.mode === "recorded") expect(r.command?.length, r.id).toBeGreaterThan(5);
    }
    expect(Object.keys(doc.keys).sort()).toEqual(["A", "B", "none", "other"]);
  });

  it("points every live row's tool at a capability of the manifest; only S-14 names nothing", () => {
    const registry = openRegistry();
    const names = new Map(registry.invocableTools().map((t) => [t.name, t.tool.id]));
    for (const r of rows.filter((x) => x.mode === "live")) {
      if (r.absent) {
        expect(r.id).toBe("S-14");
        expect(names.has(r.tool!), r.id).toBe(false);
        expect(r.capability).toBeNull();
        continue;
      }
      expect(names.get(r.tool!), r.id).toBe(r.capability);
      if (r.negative?.tool) expect(registry.getCapability(r.negative.capability!), r.id).toBeDefined();
    }
  });

  it("links every live row to a test file that exists and runs it by id", () => {
    for (const r of rows) {
      if (r.mode === "live") {
        expect(r.test, r.id).not.toBeNull();
        const file = resolve(REPO_ROOT, r.test!.file);
        expect(existsSync(file), r.test!.file).toBe(true);
        expect(r.test!.name).toBe(r.id);
        const src = readFileSync(file, "utf8");
        expect(src).toContain("for (const r of liveRows)");
        expect(src).toContain("`${r.id}: ");
      } else {
        // Recorded rows get their test with the recorder; locked rows run nothing.
        expect(r.test, r.id).toBeNull();
      }
    }
  });

  it("defines a setup chain only where a call needs something an earlier call returned", () => {
    expect(rows.filter((r) => r.setup).map((r) => r.id)).toEqual(["S-06", "S-07", "S-09"]);
    expect(byId("S-09").setup!.map((s) => s.tool)).toEqual(["wanderlust_quote", "wanderlust_book"]);
  });
});

describe("AC-1.11: personal data is visibly invented", () => {
  it("every guest name in the table is one of the API's invented names", () => {
    const guests = [...JSON.stringify(rows).matchAll(/"guestName":\s*"([^"]+)"/g)].map((m) => m[1]);
    expect(guests.length).toBeGreaterThan(0);
    for (const g of guests) expect(GUEST_NAMES, g).toContain(g);
  });

  it("the two keys are the published, obviously fake ones", () => {
    expect(DEMO_KEY_A).toMatch(/^demo-public-key-visitor-/);
    expect(DEMO_KEY_B).toMatch(/^demo-public-key-blocked-/);
    expect(DEMO_KEYS.A.principal).toBe("demo:visitor");
    expect(DEMO_KEYS.B.principal).toBe("demo:blocked");
  });

  it("no file in the example carries an e-mail or phone number that is not the reserved fake form", () => {
    for (const f of textFiles(SHOWCASE_DIR)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/[A-Za-z0-9._-]+@[A-Za-z0-9.-]+/g)) {
        expect(m[0], f).toMatch(/@guest\.example$|^\.\.\.@|\$\{/); // reserved domain only
      }
      for (const m of src.matchAll(/\+\d[\d ]{6,}/g)) expect(m[0], f).toMatch(/^\+00 000 000/);
    }
  });
});

describe("AC-1.12: public-repo hygiene", () => {
  // The example must be self-contained and neutral: it points at nothing but reserved example
  // domains, this repository's public issues, local addresses, and the SVG namespace.
  it("every URL in every file is on an allowed host", () => {
    const seen = new Set<string>();
    for (const f of textFiles(SHOWCASE_DIR)) {
      const src = readFileSync(f, "utf8");
      for (const m of src.matchAll(/https?:\/\/[^\s"'`<>)\]\\,;}]+/g)) {
        const url = m[0].replace(/[.:]+$/, "");
        if (url.includes("${")) continue;
        let host: string;
        try {
          host = new URL(url).hostname;
        } catch {
          continue;
        }
        seen.add(host);
        const ok =
          host.endsWith(".example") ||
          host === "demo.archstone.dev" || // the public demo Worker, which serves the images
          host === "localhost" ||
          host === "127.0.0.1" ||
          host === "www.w3.org" ||
          (host === "github.com" && /^https:\/\/github\.com\/NousVigil\/archstone\/(issues\/\d+)?$/.test(url));
        expect(ok, `${f}: ${url}`).toBe(true);
      }
    }
    expect(seen.size).toBeGreaterThan(5);
  });

  it("contains no absolute local path and no reference outside this directory's own tree", () => {
    for (const f of textFiles(SHOWCASE_DIR)) {
      const src = readFileSync(f, "utf8");
      expect(src, f).not.toMatch(/\/Users\/|\/home\/|\/private\/|\.\.\/\.\.\/\.\.\/(?!demo)/);
    }
  });

  it("has a README that frames the example honestly", () => {
    const readme = readFileSync(resolve(SHOWCASE_DIR, "README.md"), "utf8");
    for (const must of [DEMO_KEY_A, DEMO_KEY_B, "public", "synthetic", "invented", "over-expos", "not enforced", "MCP annotation"]) {
      expect(readme.toLowerCase(), must).toContain(must.toLowerCase());
    }
    expect(readme).toMatch(/does not make a real backend safe|cannot make a real backend safe/i);
  });
});
