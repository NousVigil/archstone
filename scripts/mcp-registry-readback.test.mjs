#!/usr/bin/env node
// Tests for the post-publish MCP Registry readback (#69).
//
//   node --test scripts/mcp-registry-readback.test.mjs
//
// The polling loop is npm-readback.mjs's `waitForVersion`, whose timeout/backoff/grace behaviour
// is covered in npm-readback.test.mjs and is not re-tested here. What is specific to the MCP
// Registry — the URL, and how one response is classified — is what these pin down, plus one
// end-to-end run of the real probe through the shared poll with a stubbed `fetch`.

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyServerResponse,
  serverVersionUrl,
  probeMcpRegistry,
  DEFAULT_MCP_REGISTRY,
} from "./mcp-registry-readback.mjs";
import { parseArgs, waitForVersion } from "./npm-readback.mjs";

const NAME = "io.github.NousVigil/archstone";
const doc = (version) => JSON.stringify({ server: { name: NAME, version }, _meta: {} });

// --- URL --------------------------------------------------------------------------------

test("serverVersionUrl: encodes the slash in the server name, keeps the casing", () => {
  // Unencoded, `/archstone` would route as a separate path segment and every probe would 404 —
  // reported as `absent`, forever, on a release that is fine.
  assert.equal(
    serverVersionUrl(DEFAULT_MCP_REGISTRY, NAME, "0.11.5"),
    "https://registry.modelcontextprotocol.io/v0/servers/io.github.NousVigil%2Farchstone/versions/0.11.5",
  );
});

test("serverVersionUrl: tolerates a trailing slash on an overridden registry", () => {
  assert.equal(
    serverVersionUrl("http://localhost:8080/", NAME, "0.22.0"),
    "http://localhost:8080/v0/servers/io.github.NousVigil%2Farchstone/versions/0.22.0",
  );
});

// --- classification ---------------------------------------------------------------------

test("classifyServerResponse: present when the 200 document is the requested version", () => {
  assert.equal(classifyServerResponse({ status: 200, body: doc("0.22.0") }, "0.22.0").state, "present");
});

test("classifyServerResponse (#69): 404 is absent — the state every release since 0.11.5 left behind", () => {
  assert.equal(classifyServerResponse({ status: 404, body: "" }, "0.22.0").state, "absent");
});

test("classifyServerResponse: a 200 about a DIFFERENT version is never present", () => {
  // e.g. a fallback to latest. Confirming 0.22.0 from a 0.11.5 document is the false green this
  // script exists to make impossible.
  const r = classifyServerResponse({ status: 200, body: doc("0.11.5") }, "0.22.0");
  assert.notEqual(r.state, "present");
  assert.equal(r.state, "unknown");
  assert.match(r.detail, /0\.11\.5, not 0\.22\.0/);
});

test("classifyServerResponse: a 5xx or 429 is unknown, never absent", () => {
  assert.equal(classifyServerResponse({ status: 503, body: "" }, "0.22.0").state, "unknown");
  assert.equal(classifyServerResponse({ status: 429, body: "" }, "0.22.0").state, "unknown");
});

test("classifyServerResponse: a thrown/aborted request is unknown", () => {
  const r = classifyServerResponse({ error: "ECONNRESET" }, "0.22.0");
  assert.equal(r.state, "unknown");
  assert.match(r.detail, /ECONNRESET/);
});

test("classifyServerResponse: a 200 we cannot parse or understand is unknown, not absent", () => {
  assert.equal(classifyServerResponse({ status: 200, body: "<html>maintenance</html>" }, "0.22.0").state, "unknown");
  assert.equal(classifyServerResponse({ status: 200, body: JSON.stringify({ hello: "world" }) }, "0.22.0").state, "unknown");
  assert.equal(classifyServerResponse({ status: 200, body: JSON.stringify({ server: { version: 22 } }) }, "0.22.0").state, "unknown");
});

// --- probe (fetch stubbed) ---------------------------------------------------------------

function stubFetch(responses) {
  const calls = [];
  let i = 0;
  const impl = async (url) => {
    calls.push(url);
    const r = responses[Math.min(i, responses.length - 1)];
    i += 1;
    if (r instanceof Error) throw r;
    return { status: r.status, text: async () => r.body ?? "" };
  };
  impl.calls = calls;
  return impl;
}

test("probeMcpRegistry: asks the encoded per-version URL and classifies the answer", async () => {
  const fetchImpl = stubFetch([{ status: 200, body: doc("0.11.5") }]);
  const r = await probeMcpRegistry({ registryUrl: DEFAULT_MCP_REGISTRY, name: NAME, version: "0.11.5", fetchImpl });
  assert.equal(r.state, "present");
  assert.equal(fetchImpl.calls[0], serverVersionUrl(DEFAULT_MCP_REGISTRY, NAME, "0.11.5"));
});

test("probeMcpRegistry: a network error becomes unknown rather than throwing", async () => {
  const fetchImpl = stubFetch([new Error("getaddrinfo ENOTFOUND")]);
  const r = await probeMcpRegistry({ registryUrl: DEFAULT_MCP_REGISTRY, name: NAME, version: "0.22.0", fetchImpl });
  assert.equal(r.state, "unknown");
});

test("probe + shared poll: 404, then a blip, then the publish lands — confirmed", async () => {
  let t = 0;
  const fetchImpl = stubFetch([{ status: 404 }, new Error("ETIMEDOUT"), { status: 200, body: doc("0.22.0") }]);
  const r = await waitForVersion({
    probe: () => probeMcpRegistry({ registryUrl: DEFAULT_MCP_REGISTRY, name: NAME, version: "0.22.0", fetchImpl }),
    timeoutMs: 300_000,
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  });
  assert.equal(r.ok, true);
  assert.equal(r.attempts, 3);
});

// --- argv (shared parser, this script's usage) -------------------------------------------

test("parseArgs with this script's usage: a missing version names mcp-registry-readback", () => {
  assert.throws(() => parseArgs([NAME], "usage: mcp-registry-readback.mjs <server-name> <version>"), /mcp-registry-readback/);
  const a = parseArgs([NAME, "0.22.0", "--timeout-seconds", "300", "--registry", "http://localhost:1"]);
  assert.equal(a.name, NAME);
  assert.equal(a.timeoutMs, 300_000);
  assert.equal(a.registryUrl, "http://localhost:1");
});
