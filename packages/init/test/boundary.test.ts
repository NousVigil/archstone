import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// ADD-37 §6 step 1's hard gate, and the D-5 layer split made checkable.
//
// The root entry (src/index.ts and everything it TRANSITIVELY imports) must have ZERO
// reachability to the filesystem, the network, a terminal, the MCP SDK, or anything under
// providers/. A convention would not survive: the first contributor who wants "just a small
// readFileSync" in the emitter would take the whole hosted-flow constraint (§9) with it, and
// nothing would fail until someone tried to run this in a runtime with no fs.
//
// Same source-scan shape as the sibling guards in @archstone/agent and
// @archstone/emitter-support, deliberately — one reviewable pattern, not three.

const here = dirname(fileURLToPath(import.meta.url));
const src = resolve(here, "../src");

const FORBIDDEN: RegExp[] = [
  /^node:/, // fs, path, os, http, crypto — ALL of it. The root export is pure.
  /^@modelcontextprotocol\/sdk/,
  /^@archstone\/provider-rest$/,
  /^pg$/, // a driver: the Postgres adapter is handed a catalog, it never opens a connection
  /^@archstone\/provider-sql/, // the host reads the catalog; init never depends on a provider
  /^@archstone\/runtime/, // root or subpath: the loop needs neither, and R-2 says do not reach for it early
];

const SPEC_RE =
  /(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]|(?:import|require)\s*\(\s*['"]([^'"]+)['"]\s*\)/g;

function collectImports(file: string): string[] {
  const specs: string[] = [];
  for (const m of readFileSync(file, "utf8").matchAll(SPEC_RE)) {
    const spec = m[1] ?? m[2];
    if (spec) specs.push(spec);
  }
  return specs;
}

function resolveRelative(fromFile: string, spec: string): string | undefined {
  const base = resolve(dirname(fromFile), spec);
  for (const candidate of [`${base}.ts`, `${base}/index.ts`]) {
    if (existsSync(candidate)) return candidate;
  }
  return undefined;
}

/** BFS the import graph from `entry`, following only relative (in-package) imports. Package
 *  specifiers are graph LEAVES: checked against FORBIDDEN, never walked into. */
function reachableFrom(entry: string): { files: Set<string>; violations: { file: string; spec: string }[] } {
  const files = new Set<string>();
  const violations: { file: string; spec: string }[] = [];
  const queue = [entry];
  while (queue.length > 0) {
    const file = queue.shift()!;
    if (files.has(file)) continue;
    files.add(file);
    for (const spec of collectImports(file)) {
      if (FORBIDDEN.some((re) => re.test(spec))) violations.push({ file: file.slice(src.length + 1), spec });
      if (spec.startsWith(".")) {
        const resolved = resolveRelative(file, spec);
        if (resolved) queue.push(resolved);
      }
    }
  }
  return { files, violations };
}

describe("@archstone/init root export — pure by construction", () => {
  it("nothing reachable from src/index.ts touches fs, the network, the terminal, the MCP SDK, or a provider", () => {
    expect(reachableFrom(resolve(src, "index.ts")).violations).toEqual([]);
  });

  it("src/loop.ts (the fs-touching subpath) is not part of the root's import graph", () => {
    const { files } = reachableFrom(resolve(src, "index.ts"));
    expect([...files].some((f) => f.endsWith("/loop.ts"))).toBe(false);
  });

  it("the adapter is reachable from the pure root — `adapt()` has no side effects to hide", () => {
    // Step 5's adapter ships INSIDE the pure graph, deliberately. That is the whole point of
    // the boundary: a hosted "point us at your spec" flow (§9) calls the identical inference
    // with bytes it obtained however it likes, and the check above proves the adapter reads
    // no file and opens no socket to do it.
    const { files } = reachableFrom(resolve(src, "index.ts"));
    expect([...files].some((f) => f.endsWith("/adapters/openapi/index.ts"))).toBe(true);
  });

  it("OpenAPI knowledge lives ONLY under `adapters/` (§2's own acceptance item)", () => {
    // #37's "Layer purity" item, kept checkable — and stated as the property that is actually
    // load-bearing rather than as a word search. The reason-code enum is SUPPOSED to name the
    // constructs it refuses (that list is the scope boundary, in prose, on purpose); what must
    // never happen is a shared file that PARSES a spec or reaches into an adapter.
    //
    // Two things make that concrete: nothing outside `adapters/` may import the YAML parser,
    // and nothing outside `adapters/` may import an adapter module — with one exception, the
    // barrel's single re-export, which is how the adapter reaches the pure root at all.
    const shared = readdirSync(src, { withFileTypes: true })
      .filter((e) => e.isFile() && e.name.endsWith(".ts"))
      .map((e) => resolve(src, e.name));
    for (const file of shared) {
      const isBarrel = file.endsWith("/index.ts");
      for (const spec of collectImports(file)) {
        expect(spec, `${file} parses documents outside adapters/`).not.toBe("yaml");
        if (spec.includes("adapters/")) {
          expect(isBarrel, `${file} reaches into an adapter`).toBe(true);
        }
      }
    }
  });
});

describe("@archstone/init/loop — fs is allowed here, and only here", () => {
  it("loop.ts reads the filesystem and compiles through the shipped pipeline", () => {
    const specs = collectImports(resolve(src, "loop.ts"));
    expect(specs).toContain("node:fs");
    expect(specs).toContain("@archstone/schema");
    expect(specs).toContain("@archstone/compiler");
    expect(specs).toContain("@archstone/emitter-support");
  });

  it("even the loop opens no socket itself and knows no MCP", () => {
    // `init` never holds a `fetch`. The probe leg reaches the network only by asking the
    // module that already owns record-and-replay to do it (D-6) — which is what makes the
    // fixture `init` writes the same artifact `verify` replays (R-1).
    for (const file of [resolve(src, "loop.ts"), resolve(src, "probe.ts")]) {
      const specs = collectImports(file);
      expect(specs.some((s) => /^node:(http|https|net|dgram|tls)$/.test(s) || s.startsWith("@modelcontextprotocol"))).toBe(false);
      expect(specs).not.toContain("@archstone/provider-rest");
    }
  });

  it("the probe reaches runtime through the `/verify` SUBPATH, never the root (R-2)", () => {
    // `@archstone/runtime`'s root index re-exports `serveStdio`, so importing it drags the MCP
    // SDK into this package's dependency closure. Irrelevant for a Node CLI today; it matters
    // the day the hosted flow is built, and ADD-0008 already established the lesson: a bundler
    // can tree-shake an IMPORT, not a method.
    const specs = [...collectImports(resolve(src, "probe.ts")), ...collectImports(resolve(src, "loop.ts"))];
    expect(specs).toContain("@archstone/runtime/verify");
    expect(specs).not.toContain("@archstone/runtime");
  });
});
