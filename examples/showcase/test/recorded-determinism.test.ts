// AC-5.8: a rerun on unchanged inputs yields the same transcript, byte for byte, and what is
// committed is what a fresh recording produces.
//
// Runs the recorder twice into temp directories (serially), compares them with each other, then with
// the committed files. It drives the built workspace CLI, so `pnpm build` must have run (`pnpm test`
// does). Without it, locally, the test skips and says why; under CI it fails. S-15 is part of the run
// only when ARCHSTONE_TEST_PG_URL is set: without it the test records S-16..S-21 via the recorder's
// `--only`, so a job with no Postgres (deploy-gate) still checks the other six. The recorder itself
// keeps its rule (a missing URL is a failure under CI), and S-15 stays mandatory in the ci.yml step
// "Showcase recorded scenarios are current", which has Postgres.

import { describe, it, expect } from "vitest";
import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { REPO_ROOT } from "./harness";
import { TRANSCRIPT_DIR } from "./recorded";

const execFileAsync = promisify(execFile);
const recorder = resolve(REPO_ROOT, "examples/showcase/record/record.mjs");
const built = existsSync(resolve(REPO_ROOT, "packages/cli/dist/index.js"));
const runnable = built || Boolean(process.env.CI);

const scenarios = process.env.ARCHSTONE_TEST_PG_URL ? [] : ["--only", "S-16,S-17,S-18,S-19,S-20,S-21"];

async function record(out: string): Promise<void> {
  await execFileAsync(process.execPath, [recorder, "--out", out, ...scenarios], { cwd: REPO_ROOT, env: process.env, maxBuffer: 16 * 1024 * 1024 });
}

const read = (dir: string): Record<string, string> =>
  Object.fromEntries(readdirSync(dir).filter((f) => f.endsWith(".json")).sort().map((f) => [f, readFileSync(join(dir, f), "utf8")]));

/** The release stamp is the one field allowed to differ: see record.mjs (`differsOnlyInStamp`). */
const withoutStamp = (text: string): string => {
  const parsed = JSON.parse(text) as { recorded: { cli: string } };
  parsed.recorded.cli = "<stamp>";
  return JSON.stringify(parsed);
};

describe.skipIf(!runnable)("recorded transcripts are deterministic and current", () => {
  it("two recordings are byte-identical, and match the committed transcripts", async () => {
    const a = mkdtempSync(join(tmpdir(), "showcase-det-a-"));
    const b = mkdtempSync(join(tmpdir(), "showcase-det-b-"));
    try {
      await record(a);
      await record(b);
      const first = read(a);
      expect(Object.keys(first).length).toBeGreaterThanOrEqual(6);
      expect(read(b)).toEqual(first);

      const committed = read(TRANSCRIPT_DIR);
      for (const [name, text] of Object.entries(first)) {
        expect(withoutStamp(committed[name] ?? "{\"recorded\":{}}"), `${name} differs from a fresh recording; run: pnpm showcase:record`).toBe(withoutStamp(text));
      }
      if (process.env.ARCHSTONE_TEST_PG_URL) expect(Object.keys(first)).toContain("s-15.json");
    } finally {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
    }
  }, 300_000);
});
