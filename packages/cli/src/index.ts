#!/usr/bin/env node
// @archstone/cli — `archstone apply` (#1) + `archstone serve` (#7, + `--http` ADD-0008 #29)
//                  + `archstone verify` (#18-20) + `archstone build` (ADD-0008 #27)
//
// apply: parse → shape-validate (#2) → semantic-validate (#3) → compile IR (#4)
//        → index Registry (#5), and REPORT (human output, exits).
// serve: build the registry and expose it as an MCP server over stdio (#7),
//        so Claude/Cursor/ChatGPT can discover and invoke the tools. Blocks.
// serve --http: same registry, served over real Streamable-HTTP instead of stdio —
//        `@archstone/runtime/http`'s createHttpHandler (Web-standard Request/Response,
//        bearer-token gated, shared with @archstone/agent/mcp's mcpHandler(), ADD-0008 D-3)
//        behind a thin Node-http adapter. Blocks.
// verify: replay each bound capability's golden fixture against the LIVE backend
//         and report a per-binding health status (ADD-18). The only command that
//         makes a network call outside a real MCP invocation — on demand, never
//         scheduled by Archstone itself (wire it into your own CI/cron). A replay IS an
//         invocation, so a `write`/`irreversible` binding is skipped by default and
//         re-included only by `--sandbox`, an assertion the operator makes (#124).
// diff: compare two compiled declarations (ADD-309, #77) — each side a built artifact or a
//        manifest directory compiled on the spot — and classify every change for the agent by
//        `diffIR`'s table. Exit 1 iff anything is breaking. Reads declarations only; the
//        backend is `verify`'s question, and the report says so on its first line.
// build: run the same compile pipeline as `apply`, strip each tool's `contract`
//        (D-8 — the fingerprint/golden-fixture path is meaningless once the fixture
//        file isn't shipping), and write the IR as a standalone JSON artifact —
//        the substrate `@archstone/agent`'s `fromIR()` will consume (RFC-0008).
// init: read an existing API description, ask the human the questions no tool can answer
//        (is this a capability? is it `read`? what is it called?), and write a CDL manifest
//        the real compiler has already compiled (ADD-37). Thin by design — argv, the terminal
//        gate and report rendering only; everything of substance is in @archstone/init.

import { writeFileSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createRequire } from "node:module";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { load } from "@archstone/schema";
import { validateSemantics, compile, lintIR, diffIR, exposureOfIR, type IR, type IRDiff, type IRDiffEntry } from "@archstone/compiler";
import { Registry, buildRegistry, serveStdio } from "@archstone/runtime";
import { createHttpHandler } from "@archstone/runtime/http";
// ADR-0012 D-5: `runVerify`/`HealthStatus` now come from the dedicated `/verify` subpath, not
// the package root — see `packages/runtime/src/index.ts`'s header comment.
import { runVerify, type HealthStatus } from "@archstone/runtime/verify";
// ADR-0012 D-5: the CLI is a Node-only binary — it is the one place in this codebase allowed
// to import the FULL (`pg`-bearing) dispatcher as a VALUE, and it injects it ONLY into the
// stdio `serve` path's `connector` override (never into `serve --http`, which must stay
// edge-safe per D-5's literal exclusion of `@archstone/runtime`'s `/http` subpath).
import { invokeConnector, type ConnectorInvokeOptions } from "@archstone/runtime/connector";
import { checkSqlOverPrivilege, formatSqlPrivilegeFindings, sqlPrivilegeBlocksStartup } from "./sql-privilege";
import { INIT_USAGE, runInitCmd } from "./init";
import { runAuditCmd } from "./audit-cmd";
import { diagnose, formatReport } from "./doctor";
import { runAdoptCmd } from "./adopt";
import { formatExposure } from "./exposure-report";

/** `archstone --version` is the first thing a human types after installing, and until this
 *  existed it printed the usage block and exited 2 — which reads as "broken install" at the
 *  exact moment a new user is deciding whether this thing works.
 *
 *  `../package.json` resolves correctly from BOTH layouts without a build step knowing about
 *  it: in dev the entry is `src/index.ts`, and when published it is `dist/index.js` — both sit
 *  one level under the package root. npm always ships `package.json` regardless of the `files`
 *  allowlist, so the published resolution cannot break. */
function cliVersion(): string {
  try {
    return (createRequire(import.meta.url)("../package.json") as { version?: string }).version ?? "unknown";
  } catch {
    // Never let a version lookup be the thing that stops the CLI from running.
    return "unknown";
  }
}

/** One spelling of the usage block, shared by `--help` (stdout, exit 0 — the user asked) and by
 *  the no-verb-matched fallthrough (stderr, exit 2 — the user got it wrong). Which stream and
 *  which exit code is the ONLY difference between those two cases, and keeping the text in one
 *  place is what stops them drifting. */
function printUsage(opts?: { toStderr?: boolean }): void {
  const write = opts?.toStderr ? console.error : console.log;
  write(
    // `init` is named HERE, in the verb list, and not only in the block below it. It takes a
    // spec file rather than a manifest directory, so it cannot share the first line's shape —
    // which is exactly how it came to be missing from the one line a user actually scans.
    "usage: archstone <apply|serve|verify|build|diff|doctor|init|adopt|audit>\n\n" +
      "       archstone <apply|serve|verify|build> <manifest-dir> [--json] [--out path]\n" +
      "       archstone apply <manifest-dir> --exposure [--json]\n" +
      "         per capability: what a model receives, what it is shown, and what the backend was\n" +
      "         observed to return that it never sees — names and types only (--json: that report alone)\n" +
      "       archstone verify <manifest-dir> [--json] [--sandbox] [--identity-map <file>]\n" +
      "         --sandbox: also replay `write`/`irreversible` fixtures — they are skipped by default,\n" +
      "         because a replay is a real invocation. Only for a backend you know is a sandbox tenant.\n" +
      "       archstone serve [--http] <manifest-dir> [--port <n>] [--token <value>] [--identity-map <file>] [--sql-guc-prefix <prefix>]\n" +
      "         bearer token (--http only): --token <value>, or the ARCHSTONE_HTTP_TOKEN env var (required — never serves open)\n" +
      "         --identity-map <file> / ARCHSTONE_IDENTITY_MAP: a JSON file mapping a resolved caller\n" +
      "         principal to sql session identity claims (ADR-0012) — required for any sql-bound capability\n" +
      "         to be invocable at all; absent means every sql invocation refuses (fail-closed)\n" +
      "         --sql-guc-prefix <prefix> / ARCHSTONE_SQL_GUC_PREFIX: session GUC name prefix (default \"app.\")\n" +
      "       archstone diff <before> <after> [--json] [--all]\n" +
      "         what changed for an agent between two declarations; each side is a built .json\n" +
      "         artifact or a manifest dir. Exits 1 iff a change is breaking. --all lists compatible ones\n" +
      "       archstone doctor <manifest-dir> [--json]  — pre-production checks, offline\n" +
      "       archstone init <spec-file> --out <dir>   — start here if you have no manifest yet\n" +
      "       archstone adopt <manifest-dir>\n" +
      "         declare a field the backend started returning; asks before writing, needs a person\n\n" +
      "       archstone audit <file...> [--since <date>] [--format summary|jsonl|csv]\n" +
      "         read your own Execution audit records; nothing is uploaded (audit --help for filters)\n\n" +
      "       archstone --version | --help\n\n" +
      INIT_USAGE,
  );
}

/**
 * `exposure` adds ADD-309's exposure report after the registry line. `json` means something ONLY
 * alongside it: `{ exposure }` alone on stdout, and the human report held back — written to
 * stderr if the manifest does not compile, so the reason is never lost. Without `exposure`,
 * every line below is exactly what `apply` printed before the flag existed, `--json` or not
 * (pinned by `apply-exposure.test.ts`): this increment does not give the rest of `apply` a
 * structured form, and does not half-do it.
 */
function runApply(dir: string, exposure = false, json = false): void {
  const structured = exposure && json;
  const held: string[] = [];
  const say = (line: string): void => {
    if (structured) held.push(line);
    else console.log(line);
  };
  const res = load(dir);
  say(`\narchstone apply ${dir}\n`);

  if (res.capabilities) {
    const c = res.capabilities;
    say(`  company    ${c.company.name ?? c.company.id} (${c.company.id})`);
    say(`  providers  ${c.providers.join(", ")}`);
    say(`  declared   ${c.capabilities.length} capabilities`);
  }
  say(`  loaded     ${res.capabilityDocs.length} capability docs, ${res.bindings.length} bindings`);
  for (const d of res.capabilityDocs) {
    say(`    ✓ ${d.capability.id}  [${d.capability.effect}] → ${d.capability.provider ?? "?"}`);
  }
  // #43: a policy the author believes is enforced must never be invisible here — the whole
  // point of the semantic pass's scope diagnostics is that "attached to nothing" is loud.
  if (res.policyDocs.length > 0) {
    say(`  policies   ${res.policyDocs.length} policy document(s)`);
    for (const p of res.policyDocs) {
      const target =
        p.metadata.scope === "capability"
          ? `capability ${p.metadata.capabilityId ?? "?"}`
          : p.metadata.scope === "provider"
            ? `provider ${p.metadata.provider ?? "?"}`
            : "(no scope)";
      say(`    ✓ ${p.metadata.id}  → ${target}`);
    }
  }

  // Shape (schema) issues from #2 — "valid shapes" is not "deployable".
  if (res.issues.length > 0) {
    say(`\n  ✗ ${res.issues.length} shape issue(s):`);
    for (const i of res.issues) say(`    - ${i.file}: ${i.message}`);
  } else {
    say(`\n  ✓ shapes valid`);
  }

  // Semantic pass (#3) — cross-file resolution; errors block, warnings inform.
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  const warnings = diags.filter((d) => d.severity === "warning");

  const shapesAndSemanticsOk = res.ok && errors.length === 0;

  // Compile to IR (#4) — only when valid enough to emit — BEFORE the semantic line prints, so the
  // lint below (ADD-311 D-6) can be counted in it. The same IR feeds the Registry (#5).
  // ADD-30: a tool-name collision (two capability ids sanitizing to the same advertised
  // name) is checked below, before the final `ok`, alongside the semantic errors above —
  // 'apply' must refuse the same manifest 'build'/'serve' would refuse (D-2).
  const ir = shapesAndSemanticsOk ? compile(res) : undefined;

  // ADD-311: what an `irreversible` capability's declaration still lacks. Lint exists only for a
  // manifest that compiles; an invalid one prints exactly what it always did, BR-40 included.
  // Where a lint finding reports a (capability, token) pair, BR-40's line for that pair is
  // dropped — matched on the structured fields, never on prose — so each pair prints once.
  const lint = ir ? lintIR(ir, res) : [];
  const lintPairs = new Set(lint.filter((f) => f.token !== undefined).map((f) => `${f.capability}\0${f.token}`));
  const kept = warnings.filter((d) => !(d.code === "unenforced-policy-token" && lintPairs.has(`${d.capability}\0${d.token}`)));

  say(`  semantic   ${errors.length} error(s), ${kept.length + lint.length} warning(s)`);
  for (const d of errors) say(`    ✗ ${d.message}`);
  for (const d of kept) say(`    ⚠ ${d.message}`);
  for (const f of lint) say(`    ⚠ capability '${f.capability}' ${f.message} ${f.because}`);

  // Index into the Registry (#5).
  const registry = ir ? new Registry(ir) : undefined;
  const collisions = registry?.toolNameCollisions ?? [];
  if (collisions.length > 0) {
    say(`\n  ✗ ${collisions.length} tool-name collision(s):`);
    for (const c of collisions) {
      say(`    - tool name '${c.name}' is ambiguous — capabilities ${c.ids.join(", ")} all sanitize to it`);
    }
  }

  const ok = shapesAndSemanticsOk && collisions.length === 0;

  if (ok && registry) {
    const invocable = registry.listCapabilities().filter((t) => t.connector).length;
    say(`  registry   IR v${registry.ir.version} — ${registry.size} capabilities, ${invocable} invocable (bound)`);
    if (exposure) {
      const report = exposureOfIR(registry.ir);
      if (structured) {
        console.log(JSON.stringify({ exposure: report }, null, 2));
        process.exit(0);
      }
      for (const line of formatExposure(report)) say(line);
    }
    say(`\n  → run 'archstone serve ${dir}' to expose ${invocable} tool(s) to an AI agent over MCP`);
  }

  say("");
  if (structured) for (const line of held) console.error(line);
  process.exit(ok ? 0 : 1);
}

function runBuild(dir: string, outPath: string | undefined): void {
  const res = load(dir);
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  const ok = res.ok && errors.length === 0;

  if (!ok) {
    console.error(`archstone build ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    for (const i of res.issues) console.error(`  - ${i.file}: ${i.message}`);
    for (const d of errors) console.error(`  - ${d.message}`);
    process.exit(1);
  }

  const ir = compile(res);

  // ADD-30 R-2: `runBuild` didn't construct a Registry at all, so it could ship a broken
  // artifact whose ambiguous tool name only surfaces later, inside a third party's
  // `fromIR()` call. Refuse to write on a collision — fail at `build` time instead
  // (the same "ambiguous is a compile-time error, never a guess" pattern this repo already
  // applies to resource-name resolution, compiler/src/resolve.ts).
  const registry = new Registry(ir);
  if (registry.toolNameCollisions.length > 0) {
    console.error(`archstone build ${dir}: refusing to write artifact — tool-name collision(s):`);
    for (const c of registry.toolNameCollisions) {
      console.error(`  - tool name '${c.name}' is ambiguous — capabilities ${c.ids.join(", ")} all sanitize to it`);
    }
    process.exit(1);
  }

  // THE STRIP RULE, stated as a principle rather than a list (ADD-43 D-9), so the next field
  // added to `IRTool` is classified deliberately instead of by whichever example was copied:
  //
  //     strip what the INVOCATION PATH cannot use.
  //
  // `contract` qualifies (ADD-0008 D-8): it is verify-time-only and carries an fs path that is
  // meaningless once the golden fixture is not shipping alongside the artifact.
  //
  // `policyRules` (#43) is the exact opposite and MUST survive: it is invocation-path data, read
  // by the evaluator on every `execute()` call. Stripping it would ship an unpoliced embedded
  // SDK beside a policed MCP surface — the precise cross-path drift #43 exists to prevent, and
  // silent, because `fromIR` validates only `version` and treats the rest as opaque.
  const stripped: IR = { ...ir, tools: ir.tools.map(({ contract: _contract, ...t }) => t) };

  const outFile = resolve(process.cwd(), outPath ?? "archstone.ir.json");
  writeFileSync(outFile, `${JSON.stringify(stripped, null, 2)}\n`);
  console.log(`archstone build ${dir} → ${outFile} (${stripped.tools.length} tool(s))`);
  process.exit(0);
}

async function runServeHttp(dir: string, port: number, token: string | undefined, connectorOpts: ConnectorInvokeOptions | undefined): Promise<void> {
  // Rule #7 / ADD-0008 R-5: fail closed before touching the network — a missing token is a
  // startup error, never a silently-open endpoint. `--token` wins over the env var if both
  // are set; createHttpHandler itself would also throw on empty, but checking here first
  // gives a CLI-appropriate error message instead of an uncaught exception.
  if (!token) {
    console.error(
      "archstone serve --http: bearer token required — set ARCHSTONE_HTTP_TOKEN or pass --token <value>",
    );
    process.exit(1);
  }

  const built = buildRegistry(dir);
  if (!built.ok || !built.registry) {
    console.error(`archstone: cannot serve '${dir}' — manifest invalid:`);
    for (const i of built.issues) console.error(`  - ${i.file}: ${i.message}`);
    for (const d of built.diagnostics.filter((x) => x.severity === "error")) console.error(`  - ${d.message}`);
    process.exit(1);
  }

  // ADR-0012 D-9: eager, before this process ever accepts a connection — a superuser/
  // BYPASSRLS/owns-and-granted DSN is refused at startup, not on whichever request happens to
  // reach it first. (`serve --http` never actually dispatches to `sql` per this PR's edge-safety
  // fix, but the check costs nothing and stays correct if that changes.) A check that could not
  // complete refuses too, under its own header rather than as over-privileged (#133).
  const privilege = await checkSqlOverPrivilege(built.registry.listCapabilities(), connectorOpts);
  if (sqlPrivilegeBlocksStartup(privilege)) {
    for (const line of formatSqlPrivilegeFindings("archstone serve --http: refusing to start", privilege)) console.error(line);
    process.exit(1);
  }

  // ADR-0012: keep the historical, sink-free/callback-free call-site text intact on the
  // (still default) no-`--identity-map` path — `cli/test/audit-surface.test.ts` and
  // `cli/test/onresponse-surface.test.ts` pin `createHttpHandler(built.registry, { bearerToken:
  // token })` byte-for-byte as proof that no options bag reaches this call site by default.
  // Only WITH `--identity-map`/`ARCHSTONE_IDENTITY_MAP` configured does `invoke` appear at all.
  const handler = connectorOpts
    ? createHttpHandler(built.registry, { bearerToken: token, invoke: connectorOpts })
    : createHttpHandler(built.registry, { bearerToken: token });
  const server = createServer((req, res) => {
    // #49 belt-and-braces: this used to be `void handleHttpRequest(...)`. Fire-and-forget
    // means nothing is attached to the returned promise, so ANY rejection escaping the
    // function became an unhandled rejection — fatal under Node's default
    // `--unhandled-rejections=throw`, killing the server on one aborted client connection.
    // handleHttpRequest now contains its own failures, but this `.catch` is the seam that
    // makes the fix independent of that catch staying exhaustive: a future throw added
    // outside its `try` cannot resurrect the process-death bug.
    handleHttpRequest(handler, req, res).catch((err: unknown) => {
      console.error("archstone serve --http: request handling failed —", err);
      endResponseQuietly(res, 500);
    });
  });
  server.listen(port, () => {
    console.error(`archstone: serving MCP over HTTP on http://localhost:${port}/ (bearer-token gated)`);
  });
}

/**
 * Largest request body `archstone serve --http` will buffer, in bytes (#50).
 *
 * 4 MiB is not chosen by feel: it is the limit the MCP SDK itself applies to an MCP message
 * arriving over HTTP (`MAXIMUM_MESSAGE_SIZE = '4mb'` in the SDK's own Node SSE transport,
 * enforced via `raw-body`). Same protocol, same message class, same SDK version this package
 * already depends on — so the ceiling matches what an MCP client can reasonably expect to send
 * anywhere else in the ecosystem, rather than inventing an Archstone-specific number. The
 * Web-standard transport used here never reads the socket itself (this adapter hands it an
 * already-built `Request`), which is precisely why the SDK's limit does not apply on this path
 * and has to be reapplied here.
 *
 * For scale: an MCP `tools/call` body carries a capability's declared inputs as JSON. 4 MiB is
 * orders of magnitude above any manifest in `examples/`.
 */
const MAX_REQUEST_BODY_BYTES = 4 * 1024 * 1024;

/**
 * Bounds on the "lingering close" that `refuseOversizedBody` performs: how many bytes of an
 * already-refused body are read and thrown away, and how long the socket is kept around, before
 * the client is cut off for good.
 *
 * Both exist to bound a courtesy, not a capability. Nothing here is ever buffered — the bytes
 * are discarded as they arrive and `chunks` is emptied the moment the cap trips — so the
 * allocation bound #50 established is untouched. What is being spent is socket time on a client
 * that already misbehaved, so it is capped rather than run to completion.
 */
const MAX_REFUSED_BODY_DRAIN_BYTES = 64 * 1024 * 1024;
const REFUSED_BODY_LINGER_MS = 5_000;

/**
 * Refuse an oversized body with a 413 the client will actually receive, then let go of the
 * socket.
 *
 * Refusing turned out not to be the same as being heard. Ending the response the ordinary way
 * sets `Connection: close`, and Node then calls `destroySoon()` as soon as the response has
 * flushed — without waiting on the read side. The client is still mid-upload, so megabytes of
 * its body are sitting unread in this process's receive buffer, and a socket closed with unread
 * data does not send FIN, it sends RST. An RST makes the peer's stack DISCARD whatever is
 * already in its own receive buffer — the just-delivered 413 included. Measured against the
 * real CLI: 7 of 25 chunked oversize uploads ended in ECONNRESET/EPIPE with the response
 * destroyed in flight, and the rate climbed with machine load. The caller could not tell "your
 * body is too large" apart from "the server fell over" (measured 2026-08-26).
 *
 * Draining the body before closing is the obvious repair and it is not enough: under load the
 * event loop drains slower than the client fills, so the buffer is still dirty at close. It cut
 * the loss from 7/25 to 3/40 idle, and it was still 8/40 at load average 44.
 *
 * What is sufficient is to never call close() with the read side dirty. So the socket is taken
 * over from the response, the 413 is written by hand, and `socket.end()` issues a bare
 * shutdown(WR): the response and the FIN leave together, the read side stays open, and no RST
 * is ever generated. The remaining upload is then read and dropped until the client gives up,
 * the byte budget is spent, or the linger expires. This is nginx's `lingering_close`, and it is
 * why the caller may go on streaming without ever costing this process memory. Measured on the
 * same machine at load average 44: 60 of 60 uploads received their 413, including the
 * pathological client that never stops writing and never terminates its chunked body.
 *
 * Both refusal paths use this — the streaming guard and the declared-Content-Length fast path.
 * The fast path still decides on the header alone, before reading a byte; lingering afterwards
 * does not change what the decision was made from, only whether the caller gets to hear it.
 *
 * What this does NOT add is a cap on how many sockets may be lingering at once. Stated out
 * loud rather than left implicit, because #49/#50 treated this file's unauthenticated surface
 * carefully: a flood can now hold a refused connection for up to the bounds above where it
 * used to be dropped near-instantly. The exposure is file descriptors and time, never memory,
 * and it is what buys a caller the ability to learn why it was refused. If a global cap is
 * ever wanted it belongs at the server, alongside `maxConnections`, not here.
 *
 * Writing the status line by hand is deliberate. `res.detachSocket()` is the supported way to
 * take a socket out of Node's response machinery (it is what an HTTP upgrade does), and once
 * detached the ServerResponse must not be used — it no longer owns anything to write through.
 */
function refuseOversizedBody(res: ServerResponse): void {
  const socket = res.socket;
  // No socket to linger on, or the response is already committed: fall back to the ordinary
  // ending. It may be lost to an RST, which is strictly better than throwing from here (#49).
  if (!socket || res.headersSent || res.writableEnded || res.destroyed || socket.destroyed) {
    endResponseQuietly(res, 413, { closeConnection: true });
    return;
  }
  try {
    res.detachSocket(socket);
    // No `Date`, which Node's ServerResponse would have added. Deliberate, and the only header
    // that differs from the old path: RFC 9110 recommends rather than requires it, and this
    // connection closes immediately, so nothing downstream can cache or age the response.
    socket.write("HTTP/1.1 413 Payload Too Large\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
    socket.end(); // shutdown(WR) only — the read side deliberately stays open.

    let discarded = 0;
    socket.on("data", (chunk: Buffer) => {
      discarded += chunk.length;
      if (discarded > MAX_REFUSED_BODY_DRAIN_BYTES) socket.destroy();
    });
    socket.resume();
    // Client faults are never logged (#49 BF-1) and a dead peer must not leak a socket, so the
    // two remaining exits are silent: the budget above, and this deadline.
    socket.on("error", () => socket.destroy());
    const linger = setTimeout(() => socket.destroy(), REFUSED_BODY_LINGER_MS);
    linger.unref();
    socket.on("close", () => clearTimeout(linger));
  } catch {
    // The socket went away between the guard above and the write. Nothing to say, no one to
    // say it to — same contract as endResponseQuietly.
    try {
      socket.destroy();
    } catch {
      /* already gone */
    }
  }
}

/**
 * Terminate a response without ever throwing (#49). Every exit path out of the adapter goes
 * through here, including the ones reached after the client is already gone: on an aborted
 * connection the socket is destroyed, and a naive `res.end()` there is at best pointless and
 * at worst a second error thrown out of an error path. Ending is still attempted whenever the
 * socket survives — a truncated body on a keep-alive connection has a live socket that would
 * otherwise hang until the client's own timeout.
 */
function endResponseQuietly(
  res: ServerResponse,
  status: number,
  opts: { closeConnection?: boolean } = {},
): void {
  try {
    if (res.writableEnded || res.destroyed) return;
    if (!res.headersSent) {
      res.statusCode = status;
      // #50: on a refused oversized body the connection must not be reused. The client is
      // mid-upload and the rest of its bytes are still in flight, so a keep-alive socket
      // would leave that remainder to be misparsed as the next request. `Connection: close`
      // lets Node flush the response first and then close — destroying the socket here
      // instead would race the 413 and the client would see nothing.
      if (opts.closeConnection) res.setHeader("connection", "close");
    }
    res.end();
  } catch {
    // The socket went away between the checks above and the write. Nothing is left to
    // terminate and there is no one to tell — swallowing here is the whole point.
  }
}

// D-3's "~20-line wrapper": Node's http.IncomingMessage/ServerResponse <-> Web-standard
// Request/Response, so createHttpHandler (already Web-standard, shared with
// @archstone/agent/mcp's mcpHandler()) can serve real Node HTTP traffic without a second
// transport implementation. CLI-level plumbing only — HTTP itself still lives in
// providers/rest for business-backend calls; this adapter never touches a backend.
//
// #49 (P0, unauthenticated remote DoS): this function must never reject and must always
// reach a terminal `res.end()`. It is invoked from a Node `request` listener, where an
// escaping rejection is an unhandled rejection and therefore a fatal uncaught exception —
// one client that declares a Content-Length and disconnects mid-body used to kill the
// process, before any handler and therefore before any credential check ran.
async function handleHttpRequest(
  handler: (request: Request) => Promise<Response>,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  // #50: the body is buffered BEFORE authentication (the bearer check lives inside
  // createHttpHandler, reached only once the Request is built), so an unauthenticated client
  // controls how much memory this allocates. Measured server-side: the body is held ~4x over
  // simultaneously — the chunk array, `Buffer.concat`'s copy, and undici's own copies inside
  // `new Request` — so a 256 MiB body peaked at 1,081 MiB RSS, essentially all of it in
  // `external`/`arrayBuffers`. Being external is what makes it nasty: `--max-old-space-size`
  // does not bound it, and the terminal symptom is an uncatchable OOM abort.
  //
  // A declared Content-Length over the cap is refused before a single byte is read; the
  // running total is then enforced during streaming as well, because Content-Length can lie
  // and chunked encoding omits it entirely. Like every other client fault in this adapter the
  // 413 is NOT logged — an unauthenticated caller must not be able to drive log volume (#49
  // BF-1).
  const declared = Number(req.headers["content-length"]);
  if (Number.isFinite(declared) && declared > MAX_REQUEST_BODY_BYTES) {
    // Refused on the header, without reading a byte — then handed to the same lingering close
    // as the streaming guard below. Which bytes the SERVER chose to read is not what decides
    // whether the 413 survives: the RST is triggered by bytes sitting unread in the KERNEL
    // receive buffer when the write side closes, and a client that declares N and then sends N
    // — i.e. every real HTTP library — puts them there whether or not this function ever
    // looked. Measured on a warm server: 18/25 of these lost their 413 before this line
    // changed. (A fresh server loses none, which is why the test suite never caught it.)
    refuseOversizedBody(res);
    return;
  }

  const chunks: Buffer[] = [];
  // #134: this used to be `for await (const chunk of req)`, with the cap check inside the
  // loop body returning (and, for the aborted case, throwing out of the loop) to bail early.
  // Both a `break`/`return` and a `throw` out of a `for await...of` make the language runtime
  // call the async iterator's `return()` — which for a Node Readable, `req` included, destroys
  // the stream (documented Node behaviour, not a bug in the runtime). The comment that used to
  // sit here reasoned that this was harmless because `refuseOversizedBody` had already taken
  // `res`'s socket out of the response via `detachSocket()` — but `detachSocket` only unlinks
  // the RESPONSE's bookkeeping. `req.socket` is a separate live reference to the same shared
  // socket, and `IncomingMessage`'s own `_destroy` (run when the stream is torn down before
  // `end`) reaches through THAT reference and calls `this.socket.destroy(err)` — an immediate,
  // ungraceful close that can RST the connection out from under the 413 `refuseOversizedBody`
  // just wrote via a deliberate half-close (`socket.end()`, not `.destroy()`). Both closes are
  // scheduled back-to-back on the event loop, so which one actually reaches the kernel first —
  // whether the graceful FIN carrying the response, or the abort's hard RST — depends on
  // scheduling, which is exactly why this only ever showed up intermittently under real CPU
  // load and never in an isolated, idle run.
  //
  // Only the streaming guard (chunked framing, no declared Content-Length) can hit this: the
  // declared-oversize fast path above returns before `req` is ever iterated.
  //
  // The fix is to never let the runtime call `req`'s async-iterator `return()` in the first
  // place. Plain event listeners carry no such implicit-destroy contract — removing them is
  // just bookkeeping, not a stream teardown — so the accumulation below drives `req` by hand
  // instead of `for await`.
  const body = await new Promise<"ok" | "aborted" | "oversized">((settle) => {
    let received = 0;
    let done = false;
    const finish = (outcome: "ok" | "aborted" | "oversized"): void => {
      if (done) return;
      done = true;
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("error", onError);
      req.off("close", onClose);
      settle(outcome);
    };
    const onData = (chunk: Buffer): void => {
      received += chunk.length;
      if (received > MAX_REQUEST_BODY_BYTES) {
        // Nothing downstream will ever read these; drop them before handing the socket over.
        chunks.length = 0;
        finish("oversized");
        return;
      }
      chunks.push(chunk);
    };
    const onEnd = (): void => finish("ok");
    // Registered synchronously alongside `onData`/`onEnd`, so `req` never has a tick without an
    // 'error' listener attached — an unlistened 'error' event throws and is exactly the #49
    // failure mode (an escaping exception fatal under Node's default unhandled-rejection/
    // exception handling) this adapter exists to prevent.
    const onError = (): void => finish("aborted");
    // Belt-and-braces, not part of #134's reported failure: every abrupt-disconnect path this
    // adapter has actually observed also fires 'error' (ECONNRESET) on `req`, so `onClose` alone
    // would be redundant with it in practice. It exists so that if some Node-internal close ever
    // reached `req` without an 'error' first, this settles as "aborted" (400, unlogged) instead
    // of leaving the promise — and the request — hanging forever.
    const onClose = (): void => finish("aborted");
    req.on("data", onData);
    req.on("end", onEnd);
    req.on("error", onError);
    req.on("close", onClose);
  });

  if (body === "oversized") {
    // Takes the socket out of `res` and answers on it directly. `req` itself is left alone —
    // no destroy, no cascade — so the graceful close below is the only thing that touches the
    // socket from here on.
    refuseOversizedBody(res);
    return;
  }
  if (body === "aborted") {
    // The client went away mid-body (ECONNRESET / aborted), or delivered fewer bytes than
    // its declared Content-Length. On a public endpoint this is routine traffic — a closed
    // laptop, a cancelled fetch, a load-balancer health probe — NOT a server fault, so it is
    // deliberately not logged: turning an aborted-request flood into a log flood just trades
    // one denial of service for another.
    //
    // 400 is the deliberate status, not 500: the request was never completed, and nothing on
    // the server failed. In practice nobody reads it — this arm is reached only once the
    // socket is already dead. (Node does NOT surface a short body while the connection is
    // still open: it waits for the declared bytes until `server.requestTimeout`, 300 s by
    // default, and answers that itself.) The end is still attempted rather than skipped
    // because this code cannot tell from here whether `res` is writable — `req` erroring
    // does not by itself prove the response side is gone — and `endResponseQuietly` makes
    // the attempt free when it is.
    endResponseQuietly(res, 400);
    return;
  }

  // Translating the raw request into a Web `Request` is still CLIENT input handling, and it
  // runs BEFORE authentication (the bearer check lives inside createHttpHandler, reached only
  // at `handler(request)` below). `req.headers.host` and `req.url` are attacker-controlled and
  // a malformed value throws here — a bad `Host` was in fact a second unauthenticated kill
  // vector before #49's containment landed. So this gets its own client-fault arm, on exactly
  // the argument the body-read catch above makes: answering 500 and logging a stack trace per
  // request would hand an unauthenticated caller ~13x log amplification and trade the crash
  // for a disk-fill DoS. RFC 9112 §3.2 also makes 400 the required answer to an invalid Host.
  //
  // Classification is positional, not by error sniffing: what failed decides the class, so it
  // cannot drift when undici changes an error's shape between Node versions.
  let request: Request;
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers)) {
      if (value !== undefined) headers.set(key, Array.isArray(value) ? value.join(", ") : value);
    }
    const hasBody = req.method !== "GET" && req.method !== "HEAD" && chunks.length > 0;
    request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
      method: req.method ?? "GET",
      headers,
      body: hasBody ? Buffer.concat(chunks) : undefined,
    });
  } catch {
    endResponseQuietly(res, 400);
    return;
  }

  try {
    const response = await handler(request);
    res.statusCode = response.status;
    response.headers.forEach((value, key) => res.setHeader(key, value));
    res.end(response.body ? Buffer.from(await response.arrayBuffer()) : undefined);
  } catch (err) {
    // A genuine server-side failure: the handler rejected, or serialising its Response threw.
    // Unlike a malformed or abandoned request this IS worth surfacing, so it is logged — and
    // answered with a 500 rather than left to hang the caller. Nothing attacker-controlled
    // reaches this arm without first passing through the handler, so it cannot be used as a
    // log-amplification primitive the way the pre-auth construction path above could.
    console.error("archstone serve --http: request handling failed —", err);
    endResponseQuietly(res, 500);
  }
}

const HEALTH_ICON: Record<HealthStatus, string> = { green: "🟢", yellow: "🟡", red: "🔴" };

/** #124: deliberately NOT one of `HEALTH_ICON`'s three. A skipped binding was never inspected,
 *  so it must not be scannable as a colour — no colour is earned (ADD-124 D-2). */
const SKIP_ICON = "⏭";

/**
 * #124 / ADD-124 D-13 — printed once, only when something was skipped, and only to a human.
 *
 * It names the PATTERN and never a capability id: nothing in CDL or the IR links a `write`
 * capability to its `read` counterpart (`examples/manifests/bank`'s
 * `initiate-transfer`/`quote-transfer` pair is naming convention, not a declared relationship),
 * so guessing one would sometimes name the wrong capability with the same confidence as the
 * right one — worse than naming none (D-11). Same hedge as `doctor.ts`'s `no-contract-non-read`
 * advisory ("Not every write has one…") — these two must not drift apart.
 */
const READ_TWIN_TIP =
  "  Where one of these has a `read` capability against the same backend — the quote half of a\n" +
  "  quote → commit pair — verifying that instead hits the same host, auth and serialization,\n" +
  "  catching most infrastructure and schema drift at zero risk. Not every write has one, and\n" +
  "  Archstone cannot tell you which capability it is: nothing in CDL declares that relationship.\n" +
  "  If this backend really is a sandbox tenant, pass --sandbox.";

async function runVerifyCmd(dir: string, json: boolean, sandbox: boolean, connectorOpts: ConnectorInvokeOptions | undefined): Promise<void> {
  const res = load(dir);
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  const ok = res.ok && errors.length === 0;
  if (!ok) {
    if (json) {
      // ADD-20 D-2: this shape is strictly disjoint from the `{results}` shape below —
      // never add a shared "envelope" field (e.g. `ok`) to either.
      console.log(JSON.stringify({ error: "manifest_invalid", issues: res.issues, errors }));
    } else {
      console.error(`archstone verify ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    }
    process.exit(2);
  }

  const registry = new Registry(compile(res));

  // ADR-0012 D-9: eager, and — unlike `runVerify`'s own contract-bearing filter — over EVERY
  // `sql`-bound tool regardless of whether it has a recorded `contract`. A `sql` binding with no
  // contract is invisible to `runVerify`'s replay loop (nothing to replay), but an
  // over-privileged CONNECTION is a fact about the DSN, not about any one binding's fixture, and
  // must still fail this CI gate rather than silently never being checked at all. A check that
  // could not complete fails it too, reported as such rather than as over-privileged (#133).
  const privilege = await checkSqlOverPrivilege(registry.listCapabilities(), connectorOpts);
  if (sqlPrivilegeBlocksStartup(privilege)) {
    if (json) {
      // `error` names a refusal if there is one; `errors` stays the flat list existing consumers read.
      console.log(
        JSON.stringify({
          error: privilege.refused.length > 0 ? "sql_over_privileged" : "sql_privilege_check_incomplete",
          errors: [...privilege.refused, ...privilege.incomplete],
          refused: privilege.refused,
          incomplete: privilege.incomplete,
        }),
      );
    } else {
      for (const line of formatSqlPrivilegeFindings(`archstone verify ${dir}: refusing`, privilege)) console.error(line);
    }
    process.exit(1);
  }

  // Two literal call sites rather than one with a computed 5th argument (#124 / ADD-124 D-3).
  // The DEFAULT path — what CI and every non-sandbox operator runs — stays the exact
  // three-argument form the two CLI surface tests pin: no `InvokeOptions` bag at all, so no
  // audit sink and no per-response callback can reach it. The `--sandbox` path passes an
  // explicit `undefined` in that slot for the same reason, so the scope argument can never be
  // the reason such a bag starts being constructed here.
  // ADR-0012: when `--identity-map`/`ARCHSTONE_IDENTITY_MAP` (or `--sql-guc-prefix`) is
  // configured, forward it as the 4th argument. Absent either flag/env var, both call sites
  // stay BYTE-FOR-BYTE what they were before this ADR — `cli/test/audit-surface.test.ts` and
  // `cli/test/onresponse-surface.test.ts` pin the exact source text of both branches as proof
  // that no options bag (an audit sink, or any other programmatic-only callback) reaches
  // `runVerify` by default.
  const { results, skipped } = connectorOpts
    ? sandbox
      ? await runVerify(registry.listCapabilities(), dir, registry.ir.resources, connectorOpts, { includeNonRead: true })
      : await runVerify(registry.listCapabilities(), dir, registry.ir.resources, connectorOpts)
    : sandbox
      ? await runVerify(registry.listCapabilities(), dir, registry.ir.resources, undefined, { includeNonRead: true })
      : await runVerify(registry.listCapabilities(), dir, registry.ir.resources);

  // ADD-124 D-6: computed from `results` ONLY, exactly as before. A skip never fails the gate —
  // an all-skipped run exits 0, the same code an all-empty run already produced. Inventing a
  // failure mode for "every write/irreversible binding correctly declined to replay itself"
  // would punish the manifests doing the safe, default thing.
  const exitCode = results.some((r) => r.status === "red") ? 1 : 0;

  if (json) {
    // ADD-20 D-2: strictly disjoint from the `{error, issues, errors}` shape above.
    //
    // `skipped` and `sandbox` are ADDITIVE (ADD-124 D-7). A consumer filtering `results` for red
    // is unaffected: skipped bindings were never in `results` to begin with. `sandbox` records
    // HOW verify was invoked, so a dashboard can tell "nothing dangerous was replayed" from
    // "everything was replayed because someone asserted a sandbox".
    console.log(JSON.stringify({ results, skipped, sandbox }));
    process.exit(exitCode);
  }

  console.log(`\narchstone verify ${dir}\n`);
  if (results.length === 0 && skipped.length === 0) {
    console.log("  (no bindings declare a contract: — nothing to verify)\n");
    process.exit(0);
  }
  for (const r of results) {
    console.log(`  ${HEALTH_ICON[r.status]} ${r.capabilityId} — ${r.detail}`);
  }
  for (const s of skipped) {
    console.log(`  ${SKIP_ICON} ${s.capabilityId} — ${s.detail}`);
  }
  if (skipped.length > 0) {
    console.log(`\n  ${skipped.length} binding(s) were NOT verified against the backend.`);
    console.log(READ_TWIN_TIP);
  }
  console.log("");
  process.exit(exitCode);
}

/** Value of a `--name value` flag pair, plus the index it was found at (-1 if absent) —
 *  used both to read the value and to exclude both tokens from the positional args. */
function flagArg(argv: string[], name: string): { value?: string; idx: number } {
  const idx = argv.indexOf(name);
  return { value: idx !== -1 ? argv[idx + 1] : undefined, idx };
}

/**
 * ADR-0012 (open question #1 — "verify-time identity source"): the ADR itself leaves the exact
 * CLI/CI wiring for the deployer-supplied `identityAdapter` (SF-7) unresolved beyond "an env
 * var? a `--verify-caller` flag?". This CLI's answer: `--identity-map <file>` (or the
 * `ARCHSTONE_IDENTITY_MAP` env var, so CI needs no flag at all) names a JSON file mapping a
 * principal string to the identity claims `identityAdapter` would return for it —
 * `{"tenant-a-session": {"tenantId": "acme"}, "tenant-b-session": {"tenantId": "beta"}}`. This
 * is deliberately the SIMPLEST mechanism that satisfies D-3's "a pure function of the resolved
 * principal" contract from a static CLI invocation, not a general identity-provider
 * integration — a deployer embedding Archstone directly still supplies a real
 * `identityAdapter` function (SF-7 remains a programmatic, non-CLI surface there).
 *
 * The map is only the claims half of a verify-time identity: `archstone verify` supplies no
 * caller principal, so a `sql` fixture names the positive leg's principal itself in
 * `identity: { principal }`, beside `negativeIdentity` (ADR-0012 D-8; see `GoldenFixture`).
 *
 * `--sql-guc-prefix`/`ARCHSTONE_SQL_GUC_PREFIX` is the same treatment for D-4's
 * `sqlSessionGucPrefix` (default `"app."`, unchanged if neither is set).
 *
 * Returns `undefined` when neither is configured, so every existing CLI surface test pinning
 * "no `InvokeOptions` bag at all" on the default path is unaffected (`archstone verify` without
 * `--identity-map` still calls `runVerify` with its exact historical argument count).
 */
function resolveConnectorOptions(argv: string[]): ConnectorInvokeOptions | undefined {
  const identityMapPath = flagArg(argv, "--identity-map").value ?? process.env.ARCHSTONE_IDENTITY_MAP;
  const gucPrefix = flagArg(argv, "--sql-guc-prefix").value ?? process.env.ARCHSTONE_SQL_GUC_PREFIX;
  if (!identityMapPath && !gucPrefix) return undefined;

  let map: Record<string, Record<string, string>> = {};
  if (identityMapPath) {
    try {
      map = JSON.parse(readFileSync(resolve(process.cwd(), identityMapPath), "utf8")) as Record<string, Record<string, string>>;
    } catch (err) {
      console.error(`archstone: --identity-map '${identityMapPath}' could not be read/parsed — every sql invocation will refuse (fail-closed): ${(err as Error).message}`);
    }
  }
  const opts: ConnectorInvokeOptions = { identityAdapter: (principal) => (principal !== undefined ? map[principal] : undefined) };
  if (gucPrefix) opts.sqlSessionGucPrefix = gucPrefix;
  return opts;
}

/** One side of a `diff`: the IR, or the reason there is none. A `.json` argument is read as a
 *  built artifact; anything else is a manifest directory, compiled through the same
 *  load → validateSemantics → compile path `apply` runs, and refused with `apply`'s own
 *  messages when it does not get that far. */
type DiffSide = { ir: IR } | { error: string; lines: string[]; issues?: unknown; errors?: unknown };

function resolveDiffSide(arg: string): DiffSide {
  if (arg.endsWith(".json")) {
    let ir: IR;
    try {
      ir = JSON.parse(readFileSync(resolve(process.cwd(), arg), "utf8")) as IR;
    } catch (err) {
      return { error: "artifact_unreadable", lines: [`${arg}: could not be read as a built artifact — ${(err as Error).message}`] };
    }
    // `fromIR`'s own bar (version + a tool list); anything further is diffIR's business.
    if (!ir || typeof ir !== "object" || typeof ir.version !== "string" || !Array.isArray(ir.tools)) {
      return { error: "artifact_unreadable", lines: [`${arg}: not an Archstone IR artifact (no 'version' or 'tools')`] };
    }
    return { ir: { ...ir, resources: ir.resources ?? {} } };
  }
  const res = load(arg);
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  if (!res.ok || errors.length > 0) {
    return {
      error: "manifest_invalid",
      lines: [
        `${arg}: manifest invalid — run 'archstone apply ${arg}' for details`,
        ...res.issues.map((i) => `  - ${i.file}: ${i.message}`),
        ...errors.map((d) => `  ✗ ${d.message}`),
      ],
      issues: res.issues,
      errors,
    };
  }
  return { ir: compile(res) };
}

const DIFF_LABEL_WIDTH = "compatible".length;

function diffLine(e: IRDiffEntry): string {
  return `  ${e.severity.padEnd(DIFF_LABEL_WIDTH)} ${e.capabilityId ?? e.resource ?? "?"} — ${e.detail}`;
}

/**
 * `archstone diff <before> <after> [--json] [--all]` (ADD-309, #77).
 *
 * Exit codes: 1 iff any entry is `breaking` — `notable` never fails the gate (D-4); 2 when either
 * side could not be turned into an IR, or the two IR versions differ, so "cannot compare" is never
 * mistaken for "compared, and it breaks".
 *
 * `--json` prints the `IRDiff` alone. There is deliberately no aggregate `ok` field: the exit code
 * is the gate signal (ADD-20 D-2's precedent), and a refusal prints `{ error, … }`, a shape
 * strictly disjoint from `IRDiff`.
 */
function runDiff(beforeArg: string, afterArg: string, json: boolean, all: boolean): void {
  const refuse = (error: string, lines: string[], extra: Record<string, unknown> = {}): never => {
    if (json) console.log(JSON.stringify({ error, message: lines[0], ...extra }));
    else for (const l of lines) console.error(l.startsWith("  ") ? l : `archstone diff ${l}`);
    process.exit(2);
  };

  const sides = [resolveDiffSide(beforeArg), resolveDiffSide(afterArg)];
  for (const s of sides) {
    if ("error" in s) refuse(s.error, s.lines, s.issues !== undefined ? { issues: s.issues, errors: s.errors } : {});
  }
  const [before, after] = sides.map((s) => (s as { ir: IR }).ir) as [IR, IR];

  let diff: IRDiff;
  try {
    diff = diffIR(before, after);
  } catch (err) {
    return refuse("version_mismatch", [`${beforeArg} ${afterArg}: ${(err as Error).message}`]);
  }
  const exitCode = diff.summary.breaking > 0 ? 1 : 0;

  if (json) {
    console.log(JSON.stringify(diff));
    process.exit(exitCode);
  }

  // D-5 / R-2: the first line says which of the two questions this answers, so nobody reads
  // "compatible" as "the provider did not move".
  console.log("archstone diff compares declarations, not backends — run 'archstone verify' for the backend.\n");
  console.log(`  before  ${beforeArg} (${diff.before.company})`);
  console.log(`  after   ${afterArg} (${diff.after.company})\n`);

  const bySeverity = (s: IRDiffEntry["severity"]) => diff.entries.filter((e) => e.severity === s);
  const shown = [...bySeverity("breaking"), ...bySeverity("notable"), ...(all ? bySeverity("compatible") : [])];
  if (diff.entries.length === 0) console.log("  no changes");
  for (const e of shown) console.log(diffLine(e));
  if (!all && diff.summary.compatible > 0) {
    console.log(`  compatible ${diff.summary.compatible} change(s) — pass --all to list them`);
  }

  const { breaking, notable, compatible } = diff.summary;
  console.log(`\n  ${breaking} breaking, ${notable} notable, ${compatible} compatible — exit ${exitCode}\n`);
  process.exit(exitCode);
}

/**
 * #102 — A-7 §5's pre-production checklist, run instead of read. Offline by construction: it
 * compiles the manifest and inspects the IR plus what sits beside it on disk. Nothing is
 * invoked and no backend is contacted — that is `verify`, and this is the question you ask
 * before pointing anything at production.
 */
function runDoctor(dir: string, json: boolean): void {
  const res = load(dir);
  const diags = validateSemantics(res);
  const errors = diags.filter((d) => d.severity === "error");
  if (!res.ok || errors.length > 0) {
    console.error(`archstone doctor ${dir}: manifest invalid — run 'archstone apply ${dir}' for details`);
    process.exit(1);
  }

  const ir = compile(res);
  // ADD-311 D-8: lint is computed here, once, and handed to `diagnose` — which stays a function
  // of the IR plus what is on disk and never loads a manifest.
  const lint = lintIR(ir, res);
  // Compare drift against what `build` would actually write, which strips `contract` (ADD-43
  // D-9's strip rule) — comparing against the unstripped IR would report drift on every
  // manifest that records a fixture, i.e. on every well-configured one.
  const stripped: IR = { ...ir, tools: ir.tools.map(({ contract: _contract, ...t }) => t) };
  const report = diagnose(ir, dir, { builtIr: `${JSON.stringify(stripped, null, 2)}\n`, lint });

  console.log(json ? JSON.stringify(report, null, 2) : formatReport(report, dir));
  process.exit(report.ok ? 0 : 1);
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  // Before anything else: `--version`/`-V` and `--help`/`-h` are what a human types first, and
  // both used to fall through to the usage block with exit 2 — a non-zero exit for a question
  // that was answered correctly. Both now exit 0. `-V` is capitalised because `-v` is verbose
  // by long convention and should stay free.
  if (argv.includes("--version") || argv.includes("-V")) {
    console.log(cliVersion());
    return;
  }
  if (argv.includes("--help") || argv.includes("-h")) {
    printUsage();
    return;
  }

  const json = argv.includes("--json");
  const exposure = argv.includes("--exposure");
  const http = argv.includes("--http");
  // #124: boolean, takes no argument. NOT `--force`/`--yes`: those read as overriding a check
  // Archstone performed, and the honest situation is the opposite — Archstone performed no check
  // and structurally cannot (`doctor`'s own `env-baseurl` advisory already concedes that the
  // deployment, not the manifest, decides where `${VAR}` points). `--sandbox` is the operator
  // supplying the one fact only they hold. It takes no target string because a target would
  // imply Archstone validates it against something, and there is nothing to validate against.
  const sandbox = argv.includes("--sandbox");
  const all = argv.includes("--all");
  const out = flagArg(argv, "--out");
  const port = flagArg(argv, "--port");
  const token = flagArg(argv, "--token");
  const identityMap = flagArg(argv, "--identity-map");
  const sqlGucPrefix = flagArg(argv, "--sql-guc-prefix");

  const consumed = new Set<number>();
  for (const f of [out, port, token, identityMap, sqlGucPrefix]) {
    if (f.idx !== -1) {
      consumed.add(f.idx);
      consumed.add(f.idx + 1);
    }
  }
  const positional = argv.filter((a, i) => !consumed.has(i) && a !== "--json" && a !== "--exposure" && a !== "--http" && a !== "--sandbox" && a !== "--all");
  const [cmd, dir, other] = positional;

  if (cmd === "apply" && dir) {
    runApply(dir, exposure, json);
    return;
  }
  const connectorOpts = resolveConnectorOptions(argv);
  if (cmd === "serve" && dir && http) {
    // Bearer token: --token wins over ARCHSTONE_HTTP_TOKEN if both are set (Rule #7 —
    // required, never defaults open).
    await runServeHttp(dir, Number(port.value ?? 8787), token.value ?? process.env.ARCHSTONE_HTTP_TOKEN, connectorOpts);
    return; // blocks on the HTTP server
  }
  if (cmd === "serve" && dir) {
    // ADR-0012: same byte-for-byte-preservation discipline as `runServeHttp`/`runVerifyCmd`
    // above — `serveStdio(dir)` (no second argument) stays the exact call-site text on the
    // default, no-`--identity-map` path. D-5 lists stdio ("one child process per conversation")
    // as a `sql`-supporting surface (unlike `serve --http`), so once `--identity-map`/
    // `--sql-guc-prefix` signals intent to configure `sql` session identity at all, the stdio
    // path ALSO gets the FULL (Node-only) dispatcher injected as its `connector` override —
    // `serve --http`, below, deliberately never does.
    if (connectorOpts) {
      // D-9: eager, before the stdio transport ever connects — same discipline as
      // `runServeHttp`. `serveStdio` rebuilds the registry itself; building it once more here,
      // ahead of time, is the price of checking BEFORE the transport connects rather than
      // teaching `serveStdio` a new pre-check parameter.
      const built = buildRegistry(dir);
      if (built.ok && built.registry) {
        const privilege = await checkSqlOverPrivilege(built.registry.listCapabilities(), connectorOpts);
        if (sqlPrivilegeBlocksStartup(privilege)) {
          for (const line of formatSqlPrivilegeFindings("archstone serve: refusing to start", privilege)) console.error(line);
          process.exit(1);
        }
      }
      await serveStdio(dir, { ...connectorOpts, connector: invokeConnector });
    } else {
      await serveStdio(dir); // blocks on the stdio transport
    }
    return;
  }
  if (cmd === "verify" && dir) {
    await runVerifyCmd(dir, json, sandbox, connectorOpts);
    return;
  }
  if (cmd === "build" && dir) {
    runBuild(dir, out.value);
    return;
  }
  if (cmd === "diff" && dir && other) {
    runDiff(dir, other, json, all);
    return;
  }
  if (cmd === "doctor" && dir) {
    runDoctor(dir, json);
    return;
  }
  if (cmd === "adopt") {
    // Its own parser, and its own module: it is the only verb that WRITES a manifest a human
    // already owns, so keeping it apart from the read-only verbs above is deliberate.
    process.exit(await runAdoptCmd(argv));
  }
  if (cmd === "audit") {
    // Own parser, for the same reason `init` has one: this verb's flags outnumber the other
    // verbs' put together, and threading them through the positional logic above would make
    // both harder to read.
    process.exit(runAuditCmd(argv));
  }
  if (cmd === "init") {
    // Everything `init` needs is in its own argv parser: it has more flags than the other four
    // verbs put together, and threading them through this function's positional logic would
    // make both harder to read.
    process.exit(await runInitCmd(argv));
  }

  printUsage({ toStderr: true });
  process.exit(2);
}

main();
