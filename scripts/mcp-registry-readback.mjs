#!/usr/bin/env node
// Ask the official MCP Registry, and keep asking, whether a server version is actually there (#69).
//
// Every release since 0.11.5 stamped `server.json` and published nothing from it: release.yml
// had no step that sent it to registry.modelcontextprotocol.io, and no check that would have
// noticed. `io.github.NousVigil/archstone` sat at 0.11.5 while npm moved on to 0.22.0,
// so every client discovering Archstone through the registry was offered a version eleven
// minors stale — and every release run went green. The publish step that fixes that is only
// half the fix; the other half is this witness, for the same reason npm-readback.mjs exists
// (#123): a publisher exiting 0 is a claim, and the registry answering is the evidence.
//
// Same three states as npm-readback.mjs, and collapsing them would be the same bug:
//   present — the registry answered 200 with a server document whose `server.version` is the
//             version we asked for. The only success.
//   absent  — the registry answered 404 for this name+version. A real, informative answer.
//   unknown — no answer we can use: network error, 5xx, 429, an unparseable body, or a 200 whose
//             document is not about the version requested. NOT absence, and never success.
//
// Why a 200 is not enough on its own: the per-version endpoint is the one we ask, so a correct
// registry can only answer it with that version — but "a correct registry" is the assumption a
// readback exists to not make. A 200 carrying some other version (a fallback to latest, a
// rewrite, a proxy) would otherwise confirm a publish that did not happen, which is the one
// outcome this script must never produce. It is `unknown` rather than `absent` because such a
// body says nothing about whether our version exists; in practice both keep the poll going.
//
// The polling itself — bounded exponential backoff, the separate grace window for unanswered
// probes, the injected clock — is npm-readback.mjs's `waitForVersion`, imported rather than
// copied: the two readbacks differ in what they ask, not in how patiently they wait.
//
// Usage:
//   node scripts/mcp-registry-readback.mjs <server-name> <version> [--timeout-seconds N]
//                                                                  [--unknown-grace-seconds N]
//                                                                  [--registry URL]
// The server name is an argument, not a constant: release.yml reads it out of server.json, so
// the name that is checked is by construction the name that was published. It is case-sensitive
// (the registry keys `io.github.<owner>` on GitHub's casing of the owner).
// Exit 0 = confirmed present. Exit 1 = NOT confirmed present (absent, or never answered).

import { pathToFileURL } from "node:url";
import { parseArgs, waitForVersion } from "./npm-readback.mjs";

export const DEFAULT_MCP_REGISTRY = "https://registry.modelcontextprotocol.io";

const USAGE = "usage: mcp-registry-readback.mjs <server-name> <version> [--timeout-seconds N]";

/** The per-version endpoint. A server name contains exactly one slash (`io.github.X/name`),
 *  which must be encoded or the registry routes it as two path segments. */
export function serverVersionUrl(registryUrl, name, version) {
  return `${registryUrl.replace(/\/+$/, "")}/v0/servers/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
}

/**
 * Pure — turn one HTTP outcome into one of the three states. Separated from the request so the
 * classification (the part with the judgement in it) is testable without a network or a stub
 * server. `error` is any thrown/aborted request.
 */
export function classifyServerResponse({ status, body, error }, version) {
  if (error) return { state: "unknown", detail: `request failed: ${error}` };
  if (status === 404) {
    // Both "no such server" and "no such version of it" are 404 here. Either way the registry
    // answered, and before the publish lands this is exactly what a healthy release looks like.
    return { state: "absent", detail: "registry has no such server version (404)" };
  }
  if (status !== 200) return { state: "unknown", detail: `registry returned HTTP ${status}` };
  let doc;
  try {
    doc = typeof body === "string" ? JSON.parse(body) : body;
  } catch (e) {
    return { state: "unknown", detail: `unparseable server document: ${e.message}` };
  }
  const got = doc?.server?.version;
  if (typeof got !== "string") {
    return { state: "unknown", detail: "server document has no `server.version` string" };
  }
  if (got !== version) {
    // See the header: a 200 about a different version must never confirm this one.
    return { state: "unknown", detail: `registry answered with server.version ${got}, not ${version}` };
  }
  return { state: "present", detail: `registry lists ${version}` };
}

/** One real probe. Bounded per-request so a hung connection cannot eat the whole window. */
export async function probeMcpRegistry({ registryUrl, name, version, fetchImpl = fetch, requestTimeoutMs = 15_000 }) {
  try {
    const res = await fetchImpl(serverVersionUrl(registryUrl, name, version), {
      headers: {
        accept: "application/json",
        // A request, not a guarantee — as with npm, any cache in front of the read endpoint can
        // only under-report a version published after its snapshot, which costs a retry and
        // never a false confirmation.
        "cache-control": "no-cache",
        pragma: "no-cache",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(requestTimeoutMs),
    });
    const body = res.status === 200 ? await res.text() : "";
    return classifyServerResponse({ status: res.status, body }, version);
  } catch (e) {
    return classifyServerResponse({ error: e?.message ?? String(e) }, version);
  }
}

async function main(argv) {
  let args;
  try {
    args = parseArgs(argv, USAGE);
  } catch (e) {
    console.error(e.message);
    return 2;
  }
  // No `npm config`-style detection here: nothing in the pipeline configures a different MCP
  // Registry, and mcp-publisher itself defaults to this one.
  const registryUrl = args.registryUrl ?? DEFAULT_MCP_REGISTRY;
  const timeoutMs = args.timeoutMs ?? 0;
  const unknownGraceMs = args.unknownGraceMs ?? 0;
  const label = `${args.name}@${args.version}`;

  if (timeoutMs > 0) console.log(`⏳ waiting for ${label} on ${registryUrl} (up to ${Math.round(timeoutMs / 1000)}s)`);

  const result = await waitForVersion({
    probe: () => probeMcpRegistry({ registryUrl, name: args.name, version: args.version }),
    timeoutMs,
    unknownGraceMs,
    log: (line) => console.log(line),
  });

  const took = `${Math.round(result.elapsedMs / 1000)}s, ${result.attempts} probe(s)`;
  if (result.ok) {
    console.log(`✓ ${label} confirmed on ${registryUrl} (${took})`);
    return 0;
  }
  console.log(`✗ ${label} NOT confirmed on ${registryUrl} after ${took} — last state: ${result.state} (${result.detail})`);
  return 1;
}

// `import.meta.main` is Node >= 24; this repo's CI pins Node 22 (see npm-readback.mjs).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main(process.argv.slice(2)));
}
