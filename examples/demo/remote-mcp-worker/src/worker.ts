// Demo Worker: a prop for the website's "try it live" sections, not product hosting. It serves
// the Showcase over remote MCP (`POST /mcp`), a browser path that makes one fixed tool call per
// published scenario (`POST /run/{scenarioId}`), and the synthetic agency API and its images on the
// same origin. It holds no storage and no per-visitor state beyond an in-memory rate-limit counter
// that lives and dies with the isolate. See README.md.
import { Registry, createMcpServer, callTool, toolDefinitions, type CallResult } from "@archstone/runtime";
import { InMemoryRateLimitCounter, type RateLimitCounter } from "@archstone/emitter-support";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import type { IR } from "@archstone/compiler";
import ir from "./ir.generated.json";
import scenarioDoc from "../../../showcase/scenarios.json";
import { handle as handleApi } from "../../../showcase/api/wanderlust-api.mjs";
import { allowedOrigins, corsHeaders } from "./cors";
import { callerName, resolveCaller, scenarioCaller, type KeyLabel } from "./callers";

export interface Env {
  /** Extra browser origins for `/run`, comma separated. Unset in production. */
  CORS_ORIGINS?: string;
}

/** Stated on every `/mcp` and `/run` response: the limit is real but not exact. */
export const RATE_LIMIT_NOTE =
  "approximate: 3 calls per 60 seconds on wanderlust.availability, counted per isolate in a fixed window; a different isolate or a restart starts a new count";

interface ScenarioRow {
  id: string;
  mode: string;
  tool: string | null;
  arguments: Record<string, unknown> | null;
  key: KeyLabel;
  setup?: { tool: string; key: KeyLabel; arguments: Record<string, unknown>; capture?: Record<string, string> }[];
  /** More fixed calls made after the main one, each reported on its own (S-13's wrong-format price). */
  alsoRun?: { label: string; tool: string; key: KeyLabel; arguments: Record<string, unknown> }[];
  /** A fact the card relies on that lives in the tool list, not in a result (S-12's deprecation note). */
  evidence?: { kind: "tool-description"; tool: string; where: string; phrase: string };
}
const scenarios = (scenarioDoc as unknown as { scenarios: ScenarioRow[] }).scenarios;

const registry = new Registry(ir as IR);
const descriptions = new Map(toolDefinitions(registry).map((d) => [d.name, d.description ?? ""]));

/** The sentences of a tool description that contain `phrase` (case-insensitive): the excerpt a card relies on. */
function excerptOf(description: string, phrase: string): string {
  const hits = description.split(/(?<=[.!?])\s+/).filter((sentence) => sentence.toLowerCase().includes(phrase.toLowerCase()));
  return hits.length > 0 ? hits.join(" ") : description;
}

// One counter per isolate (module scope). Approximate by construction; see RATE_LIMIT_NOTE.
// It never prunes keys: per-visitor S-11 keys accumulate until the isolate is recycled (bounded by
// the isolate's lifetime).
const moduleCounter = new InMemoryRateLimitCounter();

export interface WorkerOptions {
  /** Replaces the in-process synthetic API (tests). Defaults to the real handler. */
  api?: (request: Request) => Promise<Response>;
  /** Replaces the module-scope counter (tests). */
  counter?: RateLimitCounter;
  /** Epoch milliseconds, for the per-visitor date in `/run`'s S-11 key. */
  now?: () => number;
}

const MCP_ONLY_POST =
  "archstone demo: this endpoint is POST-only (stateless MCP, no SSE stream, no sessions)";

function plain(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

async function visitorKey(request: Request, nowMs: number): Promise<string> {
  const ip = request.headers.get("cf-connecting-ip") ?? "unknown";
  const day = new Date(nowMs).toISOString().slice(0, 10);
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${ip}|${day}`));
  const hex = [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `demo:anon:${hex.slice(0, 8)}`;
}

function atPath(value: unknown, path: string): unknown {
  return path
    .split(".")
    .reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), value);
}

function fill(value: unknown, captured: Record<string, unknown>): unknown {
  if (typeof value === "string") {
    const m = /^\{\{(\w+)\}\}$/.exec(value);
    return m ? captured[m[1]] : value;
  }
  if (Array.isArray(value)) return value.map((v) => fill(v, captured));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fill(v, captured)]));
  }
  return value;
}

export function createWorker(options: WorkerOptions = {}) {
  const api = options.api ?? ((request: Request) => handleApi(request));
  const counter = options.counter ?? moduleCounter;
  const clock = options.now ?? (() => Date.now());

  /** A fetch that only ever answers from the synthetic API on this Worker's own origin, counting
   *  the requests. Cloudflare blocks a Worker's fetch from looping back to its own zone (error
   *  1042), and nothing here should reach the network anyway. */
  function inProcessFetch(origin: string) {
    const state = { calls: 0 };
    const fetchImpl: typeof fetch = async (input, init) => {
      const req = new Request(input as string | URL, init);
      if (new URL(req.url).origin !== origin) {
        throw new Error("demo worker: the capabilities only reach the synthetic API on this origin");
      }
      state.calls += 1;
      return api(req);
    };
    return { state, fetchImpl };
  }

  async function mcp(request: Request, url: URL): Promise<Response> {
    // POST-only, on purpose: the transport would open a standalone SSE stream on GET that nothing
    // ever writes to or closes, and DELETE is session teardown on a server with no sessions.
    if (request.method !== "POST") {
      return plain(405, MCP_ONLY_POST, { Allow: "POST" });
    }
    const { state, fetchImpl } = inProcessFetch(url.origin);
    let caller: ReturnType<typeof resolveCaller>;
    let callerResolutionFailed: true | undefined;
    try {
      caller = resolveCaller(request.headers.get("authorization"));
    } catch {
      callerResolutionFailed = true;
    }
    const server = createMcpServer(registry, {
      env: { SHOWCASE_API_URL: url.origin },
      fetchImpl,
      ...(caller ? { caller } : {}),
      ...(callerResolutionFailed ? { callerResolutionFailed } : {}),
      rateLimitCounter: counter,
    });
    // Stateless, JSON responses: a freshly built server per request has nothing to stream.
    const transport = new WebStandardStreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    await server.connect(transport);
    const res = await transport.handleRequest(request);
    const out = new Response(res.body, res);
    out.headers.set("x-showcase-backend-calls", String(state.calls));
    out.headers.set("x-showcase-rate-limit", RATE_LIMIT_NOTE);
    return out;
  }

  async function run(request: Request, url: URL, id: string, env: Env): Promise<Response> {
    const allowed = allowedOrigins(env.CORS_ORIGINS);
    const origin = request.headers.get("origin");
    const cors = corsHeaders(origin, allowed);
    const finish = (res: Response): Response => {
      for (const [k, v] of cors) res.headers.set(k, v);
      return res;
    };

    if (request.method === "OPTIONS") {
      if (origin === null || !allowed.includes(origin)) {
        return finish(plain(403, "archstone demo: origin not allowed"));
      }
      const res = new Response(null, { status: 204 });
      res.headers.set("access-control-allow-methods", "POST, OPTIONS");
      res.headers.set("access-control-allow-headers", "content-type");
      res.headers.set("access-control-max-age", "600");
      return finish(res);
    }
    if (request.method !== "POST") {
      return finish(plain(405, "archstone demo: POST only", { Allow: "POST, OPTIONS" }));
    }
    // A browser page on another origin cannot read the answer, and is not given the call either.
    if (origin !== null && !allowed.includes(origin)) {
      return finish(plain(403, "archstone demo: origin not allowed"));
    }

    const row = scenarios.find((s) => s.id === id);
    if (!row || row.mode !== "live" || !row.tool || !row.arguments) {
      return finish(plain(404, "archstone demo: no such live scenario"));
    }
    // The request body is ignored entirely: the call is fixed by the scenario table.

    const { state, fetchImpl } = inProcessFetch(url.origin);
    let caller = scenarioCaller(row.key);
    // Availability is the one rate-limited capability. Taps from different visitors on the shared
    // public path must not trip each other, so for S-11 the counter key is a per-visitor principal:
    // 8 hex of SHA-256(client IP + UTC date), used only as a Map key, never logged or returned.
    // Availability has no allow list, so the principal cannot affect any policy.
    if (row.id === "S-11") caller = { principal: await visitorKey(request, clock()) };
    const invoke = {
      env: { SHOWCASE_API_URL: url.origin },
      fetchImpl,
      ...(caller ? { caller } : {}),
      rateLimitCounter: counter,
    };

    const captured: Record<string, unknown> = {};
    for (const step of row.setup ?? []) {
      const stepCaller = scenarioCaller(step.key);
      const r = await callTool(registry, step.tool, fill(step.arguments, captured) as Record<string, unknown>, {
        ...invoke,
        caller: stepCaller,
      });
      if (r.isError) return finish(plain(502, "archstone demo: a setup step of this scenario failed"));
      for (const [name, path] of Object.entries(step.capture ?? {})) captured[name] = atPath(r.structuredContent, path);
    }
    const args = fill(row.arguments, captured) as Record<string, unknown>;
    const result: CallResult = await callTool(registry, row.tool, args, invoke);
    // Extra fixed calls of the same scenario. Each is reported on its own and never changes `result`.
    const alsoRun = [];
    for (const extra of row.alsoRun ?? []) {
      const extraResult = await callTool(registry, extra.tool, extra.arguments, { ...invoke, caller: scenarioCaller(extra.key) });
      alsoRun.push({
        label: extra.label,
        tool: extra.tool,
        arguments: extra.arguments,
        caller: callerName(extra.key),
        result: {
          content: extraResult.content,
          ...(extraResult.structuredContent !== undefined ? { structuredContent: extraResult.structuredContent } : {}),
          ...(extraResult._meta !== undefined ? { _meta: extraResult._meta } : {}),
          isError: extraResult.isError,
        },
      });
    }

    const body = {
      scenario: row.id,
      tool: row.tool,
      arguments: args,
      caller: callerName(row.key),
      // The limited capability's own responses say the limit is approximate; `result` stays raw.
      ...(row.tool === "wanderlust_availability" ? { rateLimit: RATE_LIMIT_NOTE } : {}),
      result: {
        content: result.content,
        ...(result.structuredContent !== undefined ? { structuredContent: result.structuredContent } : {}),
        ...(result._meta !== undefined ? { _meta: result._meta } : {}),
        isError: result.isError,
      },
      ...(alsoRun.length > 0 ? { alsoRun } : {}),
      // Requests that reached the synthetic agency during this run, setup steps included. The same
      // number as the `x-showcase-backend-calls` header, in the body for a page that cannot read headers.
      backendCalls: state.calls,
      ...(row.evidence
        ? {
            evidence: {
              kind: row.evidence.kind,
              tool: row.evidence.tool,
              where: row.evidence.where,
              excerpt: excerptOf(descriptions.get(row.evidence.tool) ?? "", row.evidence.phrase),
            },
          }
        : {}),
    };
    const res = Response.json(body);
    res.headers.set("x-showcase-backend-calls", String(state.calls));
    res.headers.set("x-showcase-rate-limit", RATE_LIMIT_NOTE);
    return finish(res);
  }

  return {
    async fetch(request: Request, env: Env = {}): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/mcp") return mcp(request, url);

      const runMatch = /^\/run\/([^/]+)$/.exec(path);
      if (runMatch) {
        let id: string;
        try {
          id = decodeURIComponent(runMatch[1]);
        } catch {
          return plain(404, "archstone demo: not found");
        }
        return run(request, url, id, env);
      }

      // The synthetic agency and its images, same origin as the tools (no CORS here).
      if (path.startsWith("/v1/") || path.startsWith("/img/")) {
        return api(request);
      }

      return plain(404, "archstone demo: not found");
    },
  };
}

