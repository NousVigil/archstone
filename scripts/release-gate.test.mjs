#!/usr/bin/env node
// Lightweight regression tests for the pure helpers exported by release-gate.mjs (#33/ADD-33).
// Repo-root CI tooling lives outside the archstone/ Vitest workspace, so this uses Node's
// built-in test runner instead of pulling in a test framework dependency for a single script.
//
//   node --test scripts/release-gate.test.mjs

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  checkServerManifestVersion,
  parseStampList,
  parsePublishList,
  diffStampList,
  checkWorkflowPackageLists,
  findRegistryLeaks,
  exampleGateInputs,
  gateInputProblems,
  runVerifyProbe,
  PG_URL_VAR,
  WORKSPACE_PG_FROM,
} from "./release-gate.mjs";
import { renameRoles, rolesCreatedBy } from "./lib/script-database.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const REAL_STAMP_LIST =
  "packages/schema packages/compiler packages/emitter-support packages/agent packages/runtime providers/rest packages/cli";

test("parseStampList: extracts the loop from the real Stamp version step", () => {
  const workflowText = `
jobs:
  release:
    steps:
      - name: Assert the tagged commit is stamped
        run: |
          for p in ${REAL_STAMP_LIST}; do
            echo "$p"
          done
`;
  const result = parseStampList(workflowText);
  assert.ok(result, "expected a Set, got null");
  assert.deepEqual(
    [...result].sort(),
    ["packages/agent", "packages/cli", "packages/compiler", "packages/emitter-support", "packages/runtime", "packages/schema", "providers/rest"].sort(),
  );
});

// BF-1 regression: an unrelated, same-shaped "for p in X; do" loop appearing in an EARLIER
// step must never be mistaken for the real stamp-version list — the parser must be scoped
// to the named step, not a whole-file first-match search.
test("parseStampList (BF-1): ignores an unrelated 'for p in ...; do' loop in an earlier step", () => {
  const workflowText = `
jobs:
  release:
    steps:
      - name: Some earlier unrelated step
        run: |
          for p in foo bar baz; do
            echo "$p"
          done

      - name: Assert the tagged commit is stamped
        run: |
          for p in ${REAL_STAMP_LIST}; do
            echo "$p"
          done

      - name: Publish snapshot + tag to public
        run: |
          for p in should not be seen; do
            echo "$p"
          done
`;
  const result = parseStampList(workflowText);
  assert.ok(result, "expected a Set, got null");
  assert.deepEqual(
    [...result].sort(),
    ["packages/agent", "packages/cli", "packages/compiler", "packages/emitter-support", "packages/runtime", "packages/schema", "providers/rest"].sort(),
  );
  assert.ok(!result.has("foo"), "must not have picked up the earlier unrelated loop's items");
  assert.ok(!result.has("should"), "must not have picked up a later, different step's loop");
});

// The pathological case the reviewer called out: an unrelated EARLIER loop whose items
// happen to equal the real 7 package dirs would, under a whole-file first-match search,
// cause a silent false pass. Scoping to the named step must still find the REAL step's
// list (identical here) rather than accidentally "working" for the wrong reason — proven
// by asserting the step-isolation boundary below, not just that the numbers match.
test("parseStampList (BF-1): step isolation returns null when the named step is absent", () => {
  const workflowText = `
jobs:
  release:
    steps:
      - name: Some other step
        run: |
          for p in ${REAL_STAMP_LIST}; do
            echo "$p"
          done
`;
  const result = parseStampList(workflowText);
  assert.equal(result, null, "must not match a same-shaped loop under any step name other than the real one");
});

test("parseStampList: returns null when the named step exists but has no for-loop", () => {
  const workflowText = `
jobs:
  release:
    steps:
      - name: Assert the tagged commit is stamped
        run: echo "no loop here"
`;
  assert.equal(parseStampList(workflowText), null);
});

test("diffStampList: empty diff when discovered set matches stamped set", () => {
  const discovered = ["packages/schema", "packages/cli"];
  const stamped = new Set(["packages/schema", "packages/cli"]);
  assert.deepEqual(diffStampList(discovered, stamped), { missingFromStamp: [], missingFromDiscovery: [] });
});

test("diffStampList (R-4): flags a private:false package with no matching stamp entry", () => {
  const discovered = ["packages/schema", "packages/cli", "packages/eighth-new-package"];
  const stamped = new Set(["packages/schema", "packages/cli"]);
  const diff = diffStampList(discovered, stamped);
  assert.deepEqual(diff.missingFromStamp, ["packages/eighth-new-package"]);
  assert.deepEqual(diff.missingFromDiscovery, []);
});

test("diffStampList: flags a stamped path that isn't a discovered private:false package", () => {
  const discovered = ["packages/schema"];
  const stamped = new Set(["packages/schema", "packages/cli"]);
  const diff = diffStampList(discovered, stamped);
  assert.deepEqual(diff.missingFromStamp, []);
  assert.deepEqual(diff.missingFromDiscovery, ["packages/cli"]);
});

test("findRegistryLeaks: no leaks when every @archstone/* entry resolves from the local registry", () => {
  const lock = {
    packages: {
      "node_modules/@archstone/cli": { resolved: "http://127.0.0.1:9999/@archstone/cli/-/cli-0.3.2.tgz" },
      "node_modules/ajv": { resolved: "https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz" },
    },
  };
  assert.deepEqual(findRegistryLeaks(lock, "http://127.0.0.1:9999/"), []);
});

test("findRegistryLeaks (R-1): flags an @archstone/* entry resolved from the public registry", () => {
  const lock = {
    packages: {
      "node_modules/@archstone/schema": {
        resolved: "https://registry.npmjs.org/@archstone/schema/-/schema-0.3.1.tgz",
      },
    },
  };
  const leaks = findRegistryLeaks(lock, "http://127.0.0.1:9999/");
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /@archstone\/schema/);
});

// NF-2 regression: a missing `resolved` field must be flagged, not silently skipped.
test("findRegistryLeaks (NF-2): flags an @archstone/* entry with no resolved field at all", () => {
  const lock = {
    packages: {
      "node_modules/@archstone/runtime": {},
    },
  };
  const leaks = findRegistryLeaks(lock, "http://127.0.0.1:9999/");
  assert.equal(leaks.length, 1);
  assert.match(leaks[0], /@archstone\/runtime/);
  assert.match(leaks[0], /no resolved field/);
});

test("findRegistryLeaks: ignores non-@archstone packages entirely", () => {
  const lock = {
    packages: {
      "node_modules/yaml": {},
      "node_modules/ajv": { resolved: "https://registry.npmjs.org/ajv/-/ajv-8.17.1.tgz" },
    },
  };
  assert.deepEqual(findRegistryLeaks(lock, "http://127.0.0.1:9999/"), []);
});

// ---------------------------------------------------------------------------------------
// ADD-37 Amendment 1 §A-5 step 8 (iii) / O-19 — BOTH loops, checked against the REAL file.
//
// Every test above works on synthetic workflow text, which is right for the parser but
// cannot catch the failure O-19 actually found: a real publishable package missing from a
// real hardcoded list. `packages/init` was absent from BOTH loops, and the moment
// `@archstone/cli` took a `workspace:*` dependency on it, `pnpm publish` would rewrite that
// dep to a concrete version of a package that was never published — breaking
// `npm install @archstone/cli` for every user, discoverable only at release time.
//
// These read the real release.yml and the real workspace, so they fail the moment the two
// drift, in whatever runs this file — not on a tag.
// ---------------------------------------------------------------------------------------

/** Every `private: false` workspace package, discovered the same way release-gate.mjs does. */
function discoverPublishableRelDirs() {
  const found = [];
  for (const group of ["packages", "providers"]) {
    const groupDir = join(ROOT, group);
    let entries;
    try {
      entries = readdirSync(groupDir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const pkgJsonPath = join(groupDir, e.name, "package.json");
      if (!existsSync(pkgJsonPath)) continue;
      if (JSON.parse(readFileSync(pkgJsonPath, "utf8")).private === false) found.push(`${group}/${e.name}`);
    }
  }
  return found.sort();
}

test("release.yml (O-19): every private:false package appears in BOTH the stamp and publish loops", () => {
  const workflowText = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const result = checkWorkflowPackageLists(workflowText, discoverPublishableRelDirs());
  assert.ok(result.ok, result.message);
});

test("release.yml (O-19): packages/init specifically is in both loops", () => {
  const workflowText = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  // Named explicitly rather than left to the set check above, because this is the package
  // whose omission is the documented near-miss — a future refactor that loosens the set
  // check must still trip on this one.
  assert.ok(parseStampList(workflowText).has("packages/init"), "packages/init missing from the stamp loop");
  assert.ok(parsePublishList(workflowText).has("packages/init"), "packages/init missing from the publish loop");
});

test("release.yml: a package is published only after everything it depends on", () => {
  // Order is load-bearing in exactly one direction (see the publish loop's own comment): a
  // consumer installing a dependent between two publishes must never get an unresolvable
  // tree. Checked against each package's real `workspace:*` deps rather than a frozen list.
  const workflowText = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const order = [...parsePublishList(workflowText)];
  const nameOf = new Map();
  for (const relDir of order) {
    const pkg = JSON.parse(readFileSync(join(ROOT, relDir, "package.json"), "utf8"));
    nameOf.set(pkg.name, relDir);
  }
  for (const [i, relDir] of order.entries()) {
    const pkg = JSON.parse(readFileSync(join(ROOT, relDir, "package.json"), "utf8"));
    for (const [dep, range] of Object.entries(pkg.dependencies ?? {})) {
      if (!String(range).startsWith("workspace:")) continue;
      const depRelDir = nameOf.get(dep);
      assert.ok(depRelDir, `${pkg.name} depends on ${dep}, which release.yml never publishes`);
      assert.ok(
        order.indexOf(depRelDir) < i,
        `${pkg.name} (${relDir}) is published before its dependency ${dep} (${depRelDir})`,
      );
    }
  }
});

// #123 regression: the publish step gained a shell function, a nested `if`, and a block of
// operator-guidance echoes around the package loop (the post-publish registry readback). The
// R-4/O-19 tripwire reads that step by text, so the parser must still see exactly the package
// list and nothing else — not the readback plumbing wrapped around it.
test("parsePublishList (#123): the readback shell around the loop is not absorbed into the list", () => {
  const workflowText = `
jobs:
  release:
    steps:
      - name: Publish packages to npm
        env:
          READBACK_TIMEOUT_S: 600
        run: |
          npm install -g npm@latest
          cd archstone

          on_registry() {
            node "$GITHUB_WORKSPACE/scripts/npm-readback.mjs" "$1" "$2" \\
              --timeout-seconds "$3" --unknown-grace-seconds "$READBACK_GRACE_S"
          }

          for p in ${REAL_STAMP_LIST}; do
            NAME=$(node -p "require('./$p/package.json').name")
            if on_registry "$NAME" "$V" 0; then
              echo "skip"
            else
              ( cd "$p" && pnpm publish --access public --no-git-checks --tag "$DIST_TAG" )
              if ! on_registry "$NAME" "$V" "$READBACK_TIMEOUT_S"; then
                echo "::error::not confirmed"
                exit 1
              fi
            fi
          done
`;
  const result = parsePublishList(workflowText);
  assert.ok(result, "expected a Set, got null");
  assert.deepEqual(
    [...result].sort(),
    ["packages/agent", "packages/cli", "packages/compiler", "packages/emitter-support", "packages/runtime", "packages/schema", "providers/rest"].sort(),
  );
  for (const noise of ["on_registry", "npm-readback.mjs", "--timeout-seconds", "install", "-g"]) {
    assert.ok(!result.has(noise), `readback plumbing "${noise}" leaked into the parsed package list`);
  }
});

// A release that dies on "Cannot find module" halfway through the publish loop dies AFTER the
// version stamp has been pushed — the worst moment available. Every helper release.yml shells
// out to must therefore exist, checked here (in the pre-mutation build gate) rather than
// discovered on a tag.
//
// Resolved against BOTH roots, now as pure tolerance rather than because a step needs it. The
// tree used to live under `archstone/` in the private development repository, so some steps ran
// from the repo root and some `cd archstone` first; since ADR-0010 the checkout IS the root and
// the last surviving `cd archstone` (verify-doc-snippets.yml) is gone. The second root is kept
// because a regex over YAML still cannot know the cwd of the line it matched, and this test's
// job is to catch the failure that actually happens — a script renamed or deleted while
// release.yml still calls it — not to police where it is called from.
test("release.yml: every script it shells out to actually exists", () => {
  const workflowText = readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8");
  const referenced = [...workflowText.matchAll(/(?:^|[/"\s])(scripts\/[\w.-]+\.(?:mjs|sh))/g)].map((m) => m[1]);
  assert.ok(referenced.length >= 4, `expected the workflow to invoke several scripts, found ${referenced.length}`);
  for (const rel of new Set(referenced)) {
    const foundAt = [join(ROOT, rel), join(ROOT, "archstone", rel)].filter((p) => existsSync(p));
    assert.ok(foundAt.length > 0, `release.yml invokes ${rel}, which exists at neither the repo root nor archstone/`);
  }
});

test("checkWorkflowPackageLists: reports the step by name when a package is missing from one loop", () => {
  const workflowText = `
jobs:
  release:
    steps:
      - name: Assert the tagged commit is stamped
        run: |
          for p in packages/schema packages/init; do
            echo "$p"
          done

      - name: Publish packages to npm
        run: |
          for p in packages/schema; do
            echo "$p"
          done
`;
  const result = checkWorkflowPackageLists(workflowText, ["packages/schema", "packages/init"]);
  assert.equal(result.ok, false);
  assert.match(result.message, /Publish packages to npm/);
  assert.match(result.message, /packages\/init/);
});

// --- #101: server.json version drift ---------------------------------------------------
// The MCP Registry manifest is not a package, so neither the stamp loop nor package discovery
// can see it. At v0.11.7 it silently stayed at 0.11.6.

test("checkServerManifestVersion: passes when both fields match the root version", () => {
  const manifest = { version: "0.13.0", packages: [{ identifier: "@archstone/cli", version: "0.13.0" }] };
  assert.deepEqual(checkServerManifestVersion(manifest, "0.13.0"), { ok: true });
});

test("checkServerManifestVersion: catches the top-level version drifting", () => {
  const manifest = { version: "0.11.6", packages: [{ identifier: "@archstone/cli", version: "0.13.0" }] };
  const result = checkServerManifestVersion(manifest, "0.13.0");
  assert.equal(result.ok, false);
  assert.match(result.message, /\.version is "0\.11\.6", expected "0\.13\.0"/);
});

test("checkServerManifestVersion: catches a packages[] entry drifting, and names which", () => {
  const manifest = { version: "0.13.0", packages: [{ identifier: "@archstone/cli", version: "0.12.0" }] };
  const result = checkServerManifestVersion(manifest, "0.13.0");
  assert.equal(result.ok, false);
  assert.match(result.message, /packages\[0\] \(@archstone\/cli\)/);
});

test("checkServerManifestVersion: reports every mismatch at once, not just the first", () => {
  const manifest = {
    version: "0.11.6",
    packages: [
      { identifier: "@archstone/cli", version: "0.11.6" },
      { identifier: "@archstone/runtime", version: "0.12.0" },
    ],
  };
  const result = checkServerManifestVersion(manifest, "0.13.0");
  assert.equal(result.ok, false);
  // A release engineer fixing one line at a time, re-running the gate each time, is exactly the
  // loop this avoids.
  assert.equal(result.message.split("\n").length - 1, 3);
});

test("checkServerManifestVersion: a manifest with no packages[] is still checked on .version", () => {
  assert.equal(checkServerManifestVersion({ version: "0.13.0" }, "0.13.0").ok, true);
  assert.equal(checkServerManifestVersion({ version: "0.12.0" }, "0.13.0").ok, false);
});

// ---------------------------------------------------------------------------------------
// #162 — gate inputs. The 0.31.0 dispatch failed because `sql-reporting`'s verify needs an
// identity map and a real database, and the gate supplied neither; nothing on a PR ran that path.
// ---------------------------------------------------------------------------------------

const MANIFESTS = join(ROOT, "examples", "manifests");
const SQL_EXAMPLE = join(MANIFESTS, "sql-reporting");

test("exampleGateInputs (#162): sql-reporting needs its identity map, its fixture.sql, and the DSN var its binding names", () => {
  const inputs = exampleGateInputs(SQL_EXAMPLE);
  assert.equal(inputs.identityMap, join(SQL_EXAMPLE, "identity-map.json"));
  assert.deepEqual(inputs.sql, { dsnVars: ["REPORTING_DSN"], fixture: join(SQL_EXAMPLE, "fixture.sql"), unparsedDsn: [] });
});

test("exampleGateInputs: a REST-only example needs nothing beyond the environment", () => {
  assert.deepEqual(exampleGateInputs(join(MANIFESTS, "booking")), { identityMap: null, sql: null });
});

// The PR-time half of the guard that does not need a database: every example's needs, as the gate
// reads them, are needs the gate can meet once a Postgres is configured. A new example with a sql
// binding and no fixture.sql, or a dsn that is not a `${VAR}`, fails here on its PR.
test("every example under examples/manifests/ needs only gate inputs the gate can supply (#162)", () => {
  const dirs = readdirSync(MANIFESTS, { withFileTypes: true }).filter((e) => e.isDirectory());
  assert.ok(dirs.length >= 4, `expected the examples, found ${dirs.length}`);
  for (const e of dirs) {
    const problems = gateInputProblems(exampleGateInputs(join(MANIFESTS, e.name)), { [PG_URL_VAR]: "postgres://configured" });
    assert.deepEqual(problems, [], `${e.name}: ${problems.join("; ")}`);
  }
});

test("gateInputProblems (#162): a sql example with no Postgres configured is a failure, not a skip", () => {
  const problems = gateInputProblems(exampleGateInputs(SQL_EXAMPLE), {});
  assert.equal(problems.length, 1);
  assert.match(problems[0], new RegExp(`${PG_URL_VAR} is not set`));
  assert.match(problems[0], /never skipped/);
});

test("runVerifyProbe (#162): with no Postgres configured the sql example's verify leg FAILS before running anything", async () => {
  const result = await runVerifyProbe({ name: "sql-reporting", cli: ["/nonexistent/archstone"], mockUrl: "http://127.0.0.1:1", pgFrom: WORKSPACE_PG_FROM, env: {} });
  assert.equal(result.status, "fail");
  assert.equal(result.exitCode, null);
  assert.match(result.detail, /gate inputs missing/);
});

test("exampleGateInputs + gateInputProblems: a sql binding without fixture.sql, or with a literal dsn, is named", () => {
  const dir = mkdtempSync(join(tmpdir(), "archstone-gate-inputs-"));
  try {
    mkdirSync(join(dir, "bindings"));
    writeFileSync(
      join(dir, "bindings", "x.get.binding.yaml"),
      "binding:\n  capabilityId: x.get\n  connector:\n    type: sql\n    sql:\n      engine: postgres\n      dsn: postgres://literal@host/db\n",
    );
    const inputs = exampleGateInputs(dir);
    assert.deepEqual(inputs.sql, { dsnVars: [], fixture: null, unparsedDsn: ["x.get.binding.yaml"] });
    const problems = gateInputProblems(inputs, { [PG_URL_VAR]: "postgres://configured" }).join("\n");
    assert.match(problems, /not a single "\$\{VAR\}" placeholder.*x\.get\.binding\.yaml/);
    assert.match(problems, /ships no fixture\.sql/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renameRoles: every role the script creates is renamed wherever it appears, and nothing else is", () => {
  const sql = "CREATE ROLE a_owner LOGIN;\nCREATE ROLE a_runtime LOGIN;\nCREATE SCHEMA app AUTHORIZATION a_owner;\nGRANT SELECT ON app.v TO a_runtime;\nSELECT a_owner_x;";
  assert.deepEqual(rolesCreatedBy(sql), ["a_owner", "a_runtime"]);
  const out = renameRoles(sql, (r) => `z_${r}`);
  assert.match(out, /AUTHORIZATION z_a_owner;/);
  assert.match(out, /TO z_a_runtime;/);
  assert.match(out, /SELECT a_owner_x;/, "a longer identifier that merely starts with a role name is left alone");
});

// The same example against a real Postgres — positive, and with isolation removed from its fixture —
// is in release-gate.postgres.test.mjs: it needs `pnpm install` and a built CLI, and release.yml runs
// THIS file before either exists.
