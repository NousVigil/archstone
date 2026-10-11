// @archstone/runtime — Capability Registry (#5)
//
// The product kernel: capabilities queryable at runtime, indexed over the IR.
// File-backed (no DB) — the IR is derived from manifests on disk. The MCP emitter
// (#7) consumes this to list and resolve tools.
//
// `Registry` (index-only) moved to @archstone/emitter-support (ADD-0008 #27) — re-exported
// here for back-compat so nothing downstream breaks. This file keeps the fs-touching
// pipeline (`buildRegistry`), which is why the /http subpath (http.ts) never imports it.
//
// ADD-24 (#24): `buildRegistry` also optionally reads a conventional health-snapshot file
// (`readHealthSnapshot`, below) — the ONE other fs-touching, network-free addition this ADD
// makes. Binding health itself is never computed here (that's `archstone verify`'s own live
// probe, ADD-18 D-5) — only its already-serialized `--json` output is read back.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load, type LoadResult, type LoadIssue } from "@archstone/schema";
import { validateSemantics, compile, type Diagnostic } from "@archstone/compiler";
import { Registry, UnknownSemanticTypeError, type HealthStatus } from "@archstone/emitter-support";

export { Registry, UnknownSemanticTypeError } from "@archstone/emitter-support";

/** Conventional health-snapshot file, read once next to the manifest dir (ADD-24 D-8): the
 *  operator/CI populates it by redirecting the ALREADY-shipped `archstone verify --json`
 *  output here — no new serialization. `buildRegistry` reads it (fs, but no network — the
 *  live probe stays exclusively `verify`'s, ADD-18 D-5) and hands the parsed map to
 *  `Registry`, which composes it with each tool's lifecycle exposure (ADD-24 §7 step 5). */
export const HEALTH_SNAPSHOT_FILE = ".archstone-health.json";

const HEALTH_STATUSES: ReadonlySet<string> = new Set(["green", "yellow", "red"]);

/**
 * Parse the `{results: ToolVerification[]}` shape `archstone verify --json` already produces
 * (ADD-20) into a capabilityId -> HealthStatus map. Fail-open (ADD-24 D-9): a missing file, a
 * parse error, or a malformed/unexpected shape all return `undefined` — the caller then
 * proceeds with lifecycle-only exposure, never mistaking "no snapshot" for "known bad".
 *
 * #43 (ADD-43 D-14): an entry marked `policyDenied` is SKIPPED. A refusal that happened before
 * the call is not a health fact — no request was issued, so nothing about the backend's contract
 * was observed. Left in, it would reach `combineExposure` as a `red` and append
 * `"binding health: red — the last contract verification failed"` to the tool's agent-facing
 * description at the highest severity: a statement that never happened, shown to every caller
 * including permitted ones, making policy affect listing (which BR-36 forbids). Skipping leaves
 * the tool with NO health entry, which is exactly ADD-24 D-9's ratified posture — absent health
 * must never be manufactured into known-bad.
 */
function readHealthSnapshot(dir: string): Map<string, HealthStatus> | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(join(dir, HEALTH_SNAPSHOT_FILE), "utf8"));
  } catch {
    return undefined; // absent, unreadable, or invalid JSON — fail-open
  }

  const results = (parsed as { results?: unknown } | null)?.results;
  if (!Array.isArray(results)) return undefined;

  const map = new Map<string, HealthStatus>();
  for (const r of results) {
    if (!r || typeof r !== "object") continue;
    // ADD-43 D-14: a policy denial is not a health reading — drop it rather than let it become
    // an agent-facing "the last contract verification failed" hint for a verification that
    // never ran. See this function's doc comment.
    if ((r as { policyDenied?: unknown }).policyDenied === true) continue;
    const capabilityId = (r as { capabilityId?: unknown }).capabilityId;
    const status = (r as { status?: unknown }).status;
    if (typeof capabilityId === "string" && typeof status === "string" && HEALTH_STATUSES.has(status)) {
      map.set(capabilityId, status as HealthStatus);
    }
  }
  return map;
}

export interface BuildResult {
  ok: boolean;
  registry?: Registry;
  issues: LoadIssue[];
  diagnostics: Diagnostic[];
}

/**
 * File-backed pipeline: load (#2) → semantic-validate (#3) → compile (#4) → Registry (#5).
 * `registry` is present only when shapes are valid, there are no semantic errors, AND no
 * tool-name collision (ADD-30 D-2) — folded into this function's existing `diagnostics`/
 * `ok` contract (new `tool-name-collision` diagnostic code) rather than a new mechanism, so
 * `serveStdio`/`runServeHttp` (which already refuse to proceed on `!built.ok`) inherit the
 * gate for free.
 */
export function buildRegistry(dir: string): BuildResult {
  const model: LoadResult = load(dir);
  const diagnostics = validateSemantics(model);
  const hasErrors = diagnostics.some((d) => d.severity === "error");
  let ok = model.ok && !hasErrors;

  let registry: Registry | undefined;
  if (ok) {
    try {
      registry = new Registry(compile(model), readHealthSnapshot(dir));
    } catch (err) {
      // #214: the shared load-time check refuses an unknown semantic type; report it like any
      // other build diagnostic so `serve` refuses to start rather than crashing with a stack.
      if (!(err instanceof UnknownSemanticTypeError)) throw err;
      ok = false;
      diagnostics.push({ severity: "error", code: "unknown-semantic-type", message: err.message });
    }
  }
  if (registry) {
    for (const c of registry.toolNameCollisions) {
      ok = false;
      diagnostics.push({
        severity: "error",
        code: "tool-name-collision",
        message: `tool name '${c.name}' is ambiguous — capabilities ${c.ids.join(", ")} all sanitize to it`,
      });
    }
  }

  return {
    ok,
    registry: ok ? registry : undefined,
    issues: model.issues,
    diagnostics,
  };
}
