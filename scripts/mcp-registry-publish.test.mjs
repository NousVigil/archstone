#!/usr/bin/env node
// Executes release.yml's REAL "Publish server.json to the MCP Registry" shell against stubbed
// binaries (#69).
//
//   node --test scripts/mcp-registry-publish.test.mjs
//
// Same approach as publish-loop.test.mjs, and for the same reason: a real publish to
// registry.modelcontextprotocol.io cannot run from a test (it needs the release job's OIDC
// identity, and would publish), so without this the step's control flow — idempotence, the
// checksum gate, "a refused publish may still be a published version", fail-on-unconfirmed —
// would first execute on a tag.
//
// What is stubbed is only the edge: the readback's answer (the `node` stub intercepts only the
// readback invocation), the download (`curl`), checksum verification (`sha256sum`), extraction
// (`tar`, which drops a stub `mcp-publisher` where the real archive would), and mcp-publisher
// itself. No env override was added to the step to make this possible — the step runs exactly
// as CI runs it, just with a PATH whose binaries report what they were asked to do.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync, rmSync, chmodSync, existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { extractRunBlock } from "./release-gate.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const STEP_NAME = "Publish server.json to the MCP Registry";
const RUN_BLOCK = extractRunBlock(readFileSync(join(ROOT, ".github", "workflows", "release.yml"), "utf8"), STEP_NAME);
assert.ok(RUN_BLOCK, `step "${STEP_NAME}" or its "run: |" block not found in release.yml`);

// The step refuses to publish a server.json that disagrees with the tag, so the tests use
// whatever version the real server.json is stamped to rather than a constant that would rot.
const SERVER = JSON.parse(readFileSync(join(ROOT, "server.json"), "utf8"));

/**
 * Scenarios, as (readback answer, publisher behaviour, checksum):
 *   fresh             absent at the 0s idempotence probe, present after publishing
 *   already-present   present at the idempotence probe
 *   rejected-present  absent at first; `publish` exits 1 (duplicate from a racing run); present after
 *   unconfirmed       never present; `publish` exits 0 (the "exit 0 is a claim" case)
 *   bad-checksum      absent; the downloaded archive fails sha256 verification
 */
function runStep({ scenario, env = {}, workspace = ROOT }) {
  const dir = join(tmpdir(), `archstone-mcp-registry-${scenario}-${process.pid}-${Math.random().toString(36).slice(2)}`);
  const bin = join(dir, "bin");
  const runnerTemp = join(dir, "runner-temp");
  mkdirSync(bin, { recursive: true });
  mkdirSync(runnerTemp, { recursive: true });
  const log = join(dir, "calls.txt");
  writeFileSync(log, "");

  const stubs = {
    node: `#!/usr/bin/env bash
if [[ "\${1:-}" == *mcp-registry-readback.mjs ]]; then
  TIMEOUT="$5"
  echo "READBACK|$2|$3|$TIMEOUT" >> "$CALL_LOG"
  case "$SCENARIO" in
    fresh|rejected-present|bad-checksum) [ "$TIMEOUT" = "0" ] && exit 1 || exit 0 ;;
    already-present) exit 0 ;;
    unconfirmed) exit 1 ;;
    *) echo "unknown scenario $SCENARIO" >&2; exit 3 ;;
  esac
fi
exec ${JSON.stringify(process.execPath)} "$@"
`,
    curl: `#!/usr/bin/env bash
URL="\${@: -1}"
OUT=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-o" ]; then OUT="$2"; shift; fi
  shift
done
echo "DOWNLOAD|$URL" >> "$CALL_LOG"
echo "archive" > "$OUT"
`,
    sha256sum: `#!/usr/bin/env bash
echo "SHA256SUM|$(cat)" >> "$CALL_LOG"
[ "$SCENARIO" = "bad-checksum" ] && exit 1
exit 0
`,
    tar: `#!/usr/bin/env bash
DEST=""
while [ $# -gt 0 ]; do
  if [ "$1" = "-C" ]; then DEST="$2"; shift; fi
  shift
done
echo "EXTRACT|$DEST" >> "$CALL_LOG"
cat > "$DEST/mcp-publisher" <<'STUB'
#!/usr/bin/env bash
echo "PUBLISHER|$*|$PWD" >> "$CALL_LOG"
if [ "$1" = "publish" ] && [ "$SCENARIO" = "rejected-present" ]; then
  echo "Error: publish failed: cannot publish duplicate version" >&2
  exit 1
fi
exit 0
STUB
chmod +x "$DEST/mcp-publisher"
`,
  };
  for (const [name, body] of Object.entries(stubs)) {
    writeFileSync(join(bin, name), body);
    chmodSync(join(bin, name), 0o755);
  }

  const script = join(dir, "mcp-registry-step.sh");
  writeFileSync(script, RUN_BLOCK);

  const res = spawnSync("bash", ["-e", "-o", "pipefail", script], {
    cwd: ROOT,
    encoding: "utf8",
    env: {
      PATH: `${bin}:${process.env.PATH}`,
      HOME: process.env.HOME,
      CALL_LOG: log,
      SCENARIO: scenario,
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      V: SERVER.version,
      MCP_PUBLISHER_VERSION: "v1.8.1",
      MCP_PUBLISHER_SHA256: "a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc",
      MCP_READBACK_TIMEOUT_S: "300",
      MCP_READBACK_GRACE_S: "20",
      ...env,
    },
  });

  const calls = readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => l.split("|"));
  rmSync(dir, { recursive: true, force: true });
  const of = (kind) => calls.filter((c) => c[0] === kind);
  return {
    code: res.status,
    out: `${res.stdout ?? ""}\n${res.stderr ?? ""}`,
    stdout: res.stdout ?? "",
    readbacks: of("READBACK"),
    downloads: of("DOWNLOAD"),
    checksums: of("SHA256SUM"),
    publisher: of("PUBLISHER").map((c) => c[1]),
    publisherCwd: of("PUBLISHER").map((c) => c[2]),
  };
}

test("mcp registry step: a fresh version is downloaded, verified, published, confirmed — exit 0", () => {
  const r = runStep({ scenario: "fresh" });
  assert.equal(r.code, 0, `expected success, got ${r.code}\n${r.out}`);
  assert.deepEqual(r.publisher, ["login github-oidc", "publish"], "must log in with OIDC, then publish");
  assert.ok(r.publisherCwd.every((cwd) => cwd === ROOT), "publish must run in the repo root, where server.json is");
  assert.equal(r.downloads.length, 1);
  assert.match(r.downloads[0][1], /\/releases\/download\/v1\.8\.1\/mcp-publisher_linux_amd64\.tar\.gz$/, "the pinned version, never latest");
  assert.match(r.checksums[0][1], /^a06c9096dcb9727c13555b6be26c7effa707b01f06a4c561ba7a3635443cf2cc {2}/, "the pinned sha256 is what gets checked");
  // The idempotence probe, then the real confirmation — with the server name and version out of server.json.
  assert.deepEqual(
    r.readbacks.map((c) => c.slice(1)),
    [
      [SERVER.name, SERVER.version, "0"],
      [SERVER.name, SERVER.version, "300"],
    ],
  );
});

test("mcp registry step: an already-present version publishes nothing and downloads nothing", () => {
  // The workflow_dispatch resume path: must pass straight through to the GitHub Release step.
  const r = runStep({ scenario: "already-present" });
  assert.equal(r.code, 0, `expected idempotent success, got ${r.code}\n${r.out}`);
  assert.deepEqual(r.publisher, [], "nothing may be published");
  assert.equal(r.downloads.length, 0, "no reason to fetch the publisher at all");
  assert.match(r.stdout, /already on the MCP Registry — skipping \(idempotent\)/);
});

test("mcp registry step: publish refused (duplicate) but the version is on the registry — exit 0", () => {
  // A racing or resumed run: the version landed between our 0s probe and our publish, and the
  // registry refused the duplicate. That is "already published", not a failed release.
  const r = runStep({ scenario: "rejected-present" });
  assert.equal(r.code, 0, `a duplicate refusal of a present version must not fail the release\n${r.out}`);
  assert.deepEqual(r.publisher, ["login github-oidc", "publish"]);
  assert.equal(r.readbacks.length, 2, "the readback must still run after a non-zero publish");
  assert.match(r.stdout, /mcp-publisher exited 1/);
});

test("mcp registry step (#69): publish exits 0 but the registry never confirms — exit 1 with recovery", () => {
  const r = runStep({ scenario: "unconfirmed" });
  assert.equal(r.code, 1, `an unconfirmed publish must fail the step\n${r.out}`);
  assert.deepEqual(r.publisher, ["login github-oidc", "publish"]);
  assert.match(r.stdout, /::error::/, "must emit a GitHub error annotation, not just a non-zero exit");
  assert.match(r.stdout, new RegExp(`workflow_dispatch with version=${SERVER.version.replace(/\./g, "\\.")}`), "must tell the operator how to resume");
  assert.match(r.stdout, /curl -s https:\/\/registry\.modelcontextprotocol\.io\/v0\/servers\/io\.github\.NousVigil%2Farchstone\/versions\//, "must print the exact endpoint to check");
});

test("mcp registry step: a checksum mismatch stops before the publisher ever runs", () => {
  const r = runStep({ scenario: "bad-checksum" });
  assert.notEqual(r.code, 0, "an unverified publisher must not run");
  assert.deepEqual(r.publisher, [], "no login, no publish with an unverified binary");
  assert.match(r.stdout, /::error::.*does not match its pinned sha256/);
});

test("mcp registry step: a missing readback script fails before downloading or publishing", () => {
  const empty = join(tmpdir(), `archstone-no-mcp-readback-${process.pid}`);
  mkdirSync(empty, { recursive: true });
  const r = runStep({ scenario: "fresh", workspace: empty });
  rmSync(empty, { recursive: true, force: true });
  assert.notEqual(r.code, 0, "must refuse to publish without the readback");
  assert.equal(r.downloads.length, 0, "nothing may be downloaded before the preflight passes");
  assert.deepEqual(r.publisher, [], "nothing may be published before the preflight passes");
  assert.match(r.stdout, /::error::.*mcp-registry-readback\.mjs is missing/);
});

test("mcp registry step: an empty readback timeout refuses to run rather than silently not waiting", () => {
  const r = runStep({ scenario: "fresh", env: { MCP_READBACK_TIMEOUT_S: "" } });
  assert.notEqual(r.code, 0, "an unset/empty timeout must stop the step");
  assert.deepEqual(r.publisher, []);
  assert.equal(r.downloads.length, 0);
});

test("mcp registry step: a server.json that disagrees with the tag is refused before publishing", () => {
  const r = runStep({ scenario: "fresh", env: { V: "99.0.0" } });
  assert.notEqual(r.code, 0);
  assert.deepEqual(r.publisher, []);
  assert.match(r.stdout, /::error::server\.json is at .* but the tag says 99\.0\.0/);
});

test("the extracted run block really is the workflow's MCP Registry step", () => {
  assert.ok(RUN_BLOCK.includes('"$PUBLISHER" publish'), "extracted block is not the MCP Registry step");
  assert.ok(RUN_BLOCK.includes("sha256sum -c"), "extracted block has no checksum verification");
  assert.ok(!RUN_BLOCK.startsWith(" "), "extracted block must be dedented to runnable shell");
  assert.ok(existsSync(join(ROOT, "scripts", "mcp-registry-readback.mjs")));
});
