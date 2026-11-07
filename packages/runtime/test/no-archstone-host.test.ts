import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, dirname, resolve, relative } from "node:path";
import { fileURLToPath } from "node:url";

// ADR-0014 D-6, mechanically (ADD-393 §10, row "ADR-0014 D-6"): the core ships with no default
// endpoint — nothing in it can send a call, an ask or a byte to a host Archstone operates. The
// decision gate's endpoint is always the deployer's, named in a binding. This pins it as a
// source scan: no file under `packages/*/src` or `providers/*/src` contains `archstone.dev` or
// `nousvigil`, case-insensitively, anywhere — code, string or comment.
//
// Scope, deliberately: only `src/`. The JSON Schemas' `$id`s (`packages/schema/schemas/*.json`,
// `https://archstone.dev/schema/v1/…`) are identifiers that are never dereferenced, and each
// `package.json`'s `homepage`/`repository` is npm metadata; neither is under `src/`. The scan
// found no hit under `src/` when written, so it is the whole-file assertion rather than one
// narrowed to URL-shaped string literals — a doc link added to a comment later fails here and
// should be weighed then, not pre-excused.

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
const FORBIDDEN = /archstone\.dev|nousvigil/i;

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

function srcDirs(): string[] {
  const dirs: string[] = [];
  for (const group of ["packages", "providers"]) {
    for (const pkg of readdirSync(join(root, group))) {
      const src = join(root, group, pkg, "src");
      if (existsSync(src) && statSync(src).isDirectory()) dirs.push(src);
    }
  }
  return dirs;
}

describe("ADR-0014 D-6 — no Archstone-operated host in the core's source", () => {
  it("finds the source trees it is meant to scan", () => {
    const rel = srcDirs().map((d) => relative(root, d));
    for (const expected of ["packages/runtime/src", "packages/emitter-support/src", "packages/compiler/src", "providers/rest/src"]) {
      expect(rel).toContain(expected);
    }
  });

  it("no file under packages/*/src or providers/*/src mentions archstone.dev or nousvigil", () => {
    const hits: string[] = [];
    for (const dir of srcDirs()) {
      for (const file of walk(dir)) {
        readFileSync(file, "utf8")
          .split("\n")
          .forEach((line, i) => {
            if (FORBIDDEN.test(line)) hits.push(`${relative(root, file)}:${i + 1}: ${line.trim().slice(0, 160)}`);
          });
      }
    }
    expect(hits).toEqual([]);
  });

  it("the pattern itself catches the spellings it must (guards against a vacuous scan)", () => {
    for (const s of ['const URL = "https://approvals.archstone.dev/consume"', "fetch('https://ARCHSTONE.DEV')", "// see nousvigil.com", "NousVigil"]) {
      expect(FORBIDDEN.test(s)).toBe(true);
    }
    expect(FORBIDDEN.test("@archstone/emitter-support")).toBe(false);
  });
});
