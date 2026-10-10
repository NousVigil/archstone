// Shared support for the negative-scenario suites (`negatives.test.ts`, `denial-reasons.test.ts`,
// `tool-list.test.ts`). Nothing here is an assertion about Archstone, except `installGlobalInvariants`,
// which every suite registers.
//
// Three things live here:
//   1. A request spy around the in-process synthetic API. It records every outbound request by
//      method and full URL, answers only for the API's own origin, and refuses (404) anything else.
//      So "the runtime never opened an image or a page" is a counter over a real fetch seam, not a
//      claim.
//   2. `findLeaks`, the ONE absence check. The suites run it over what the runtime returns, and the
//      positive control runs the very same function over a raw passthrough double, which proves the
//      checks cannot pass on a typo (AC-2.19).
//   3. Sessions over the real runtime: `callTool` (the MCP tool path), the embedded
//      `fromIR(...).execute` (the SDK path) and a real MCP client over an in-memory transport.

import { afterAll, expect } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { fromIR, type ExecuteResult } from "@archstone/agent";
import { InMemoryRateLimitCounter, type CallerContext, type Registry } from "@archstone/emitter-support";
import { callTool, createMcpServer, type CallResult } from "@archstone/runtime";
import { handle } from "../api/wanderlust-api.mjs";
import { CLOCK_MS, callerForLabel, fill, openRegistry, type KeyLabel, type ScenarioRow } from "./harness";

export const API_ORIGIN = "http://api.showcase.example";
export const API_HOST = new URL(API_ORIGIN).host;
const ENV = { SHOWCASE_API_URL: API_ORIGIN };

// ---------------------------------------------------------------------------------------------
// The request spy
// ---------------------------------------------------------------------------------------------

export interface SeenRequest {
  method: string;
  url: string;
  host: string;
  pathname: string;
}

/** Every request any session in this test file made, in order. Read by the global invariants. */
const everyRequest: SeenRequest[] = [];
export const allRequests = (): readonly SeenRequest[] => everyRequest;

/** A mutable clock the synthetic API and the rate-limit counter both read. */
export interface Clock {
  t: number;
}

export interface Spy {
  requests: SeenRequest[];
  /** `METHOD /path` of each request to the API's own origin. */
  apiCalls: () => string[];
  /** Requests to any other origin. The runtime must never make one. */
  foreign: () => SeenRequest[];
  fetchImpl: typeof fetch;
}

export type Intercept = (request: Request) => Response | undefined;

export function makeSpy(clock: Clock, intercept?: Intercept): Spy {
  const requests: SeenRequest[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const request = new Request(input as string | URL, init);
    const url = new URL(request.url);
    const seen: SeenRequest = { method: request.method, url: request.url, host: url.host, pathname: url.pathname };
    requests.push(seen);
    everyRequest.push(seen);
    // Only the API's own origin is ever answered. An image or a page host gets a 404 so a runtime
    // that tried to open one fails loudly, and the attempt is on the record either way.
    if (url.host !== API_HOST) return new Response("not found", { status: 404 });
    const injected = intercept?.(request);
    if (injected) return injected;
    return handle(request, { now: () => clock.t });
  }) as typeof fetch;
  return {
    requests,
    apiCalls: () => requests.filter((r) => r.host === API_HOST).map((r) => `${r.method} ${r.pathname}`),
    foreign: () => requests.filter((r) => r.host !== API_HOST),
    fetchImpl,
  };
}

/** The suite-wide invariants (cross-cutting rules): registered by every negative suite. */
export function installGlobalInvariants(opts: { expectTraffic?: boolean } = {}): void {
  afterAll(() => {
    const seen = allRequests();
    if (opts.expectTraffic ?? true) expect(seen.length, "the suite made no request at all: the spy is not wired").toBeGreaterThan(0);
    // No request to any origin but the API's own: no image host, no page host, no partner host.
    expect(seen.filter((r) => r.host !== API_HOST).map((r) => r.url)).toEqual([]);
    // No image ever fetched, even from the API's own image route.
    expect(seen.filter((r) => r.pathname.startsWith("/img/")).map((r) => r.url)).toEqual([]);
    // No DELETE, ever: the endpoint exists on the backend and no capability reaches it.
    expect(seen.filter((r) => r.method === "DELETE").map((r) => `${r.method} ${r.url}`)).toEqual([]);
  });
}

// ---------------------------------------------------------------------------------------------
// The absence check (one function; also run over the raw double as the positive control)
// ---------------------------------------------------------------------------------------------

/** Field names the backend over-exposes. Compared whole and case-insensitively, never as a substring. */
export const FORBIDDEN_FIELDS = [
  "margin",
  "net",
  "commission",
  "passport",
  "phone",
  "email",
  "guests",
  "description_html",
  "hostContact",
  "lastUsedBy",
  "history",
  "host",
] as const;

/** Value shapes that only ever come from the over-exposed material. */
export const FORBIDDEN_VALUES: readonly RegExp[] = [
  /DEMO-PASS-/,
  /\+00 0/,
  /@guest\.example/,
  /<img|<a /i,
  /unknown-host\.example/,
  /partner-photos\.example/,
  /partner-hotels\.example/,
];

export interface Leak {
  kind: "field" | "value";
  /** Dotted path with `[]` for array items, e.g. `rooms[].guests[].passport`. */
  path: string;
  /** Number of object levels above the leaking key (the top level is 0). */
  depth: number;
  /** Which forbidden name or pattern matched. */
  matched: string;
}

/** Walk `value`; report every forbidden field name and every forbidden value, at any depth. */
export function findLeaks(value: unknown): Leak[] {
  const forbidden = new Set<string>(FORBIDDEN_FIELDS.map((f) => f.toLowerCase()));
  const leaks: Leak[] = [];
  const walk = (v: unknown, path: string, depth: number): void => {
    if (typeof v === "string") {
      for (const re of FORBIDDEN_VALUES) if (re.test(v)) leaks.push({ kind: "value", path, depth, matched: String(re) });
      return;
    }
    if (Array.isArray(v)) {
      for (const item of v) walk(item, `${path}[]`, depth);
      return;
    }
    if (v && typeof v === "object") {
      for (const [k, child] of Object.entries(v)) {
        const here = path === "" ? k : `${path}.${k}`;
        if (forbidden.has(k.toLowerCase())) leaks.push({ kind: "field", path: here, depth, matched: k });
        walk(child, here, depth + 1);
      }
    }
  };
  walk(value, "", 0);
  return leaks;
}

/** What a model is given back from a call: the structured answer and every text block. */
export function modelFacing(r: { content?: { text: string }[]; structuredContent?: unknown; data?: unknown }): unknown {
  return { structured: r.structuredContent ?? r.data ?? null, text: (r.content ?? []).map((c) => c.text) };
}

/** Assert the absence check finds nothing in what a model is given back, text blocks included. */
export function expectNoLeaks(what: unknown, label: string): void {
  // Text blocks are JSON documents or notes: parse what parses so field NAMES are checked too.
  const asObjects = (what as { structured: unknown; text: string[] });
  const parsed = asObjects.text.map((t) => {
    try {
      return JSON.parse(t) as unknown;
    } catch {
      return t;
    }
  });
  expect(findLeaks(asObjects.structured), `${label}: structured`).toEqual([]);
  expect(findLeaks(parsed), `${label}: text`).toEqual([]);
}

// ---------------------------------------------------------------------------------------------
// The raw double used as the positive control (AC-2.19)
// ---------------------------------------------------------------------------------------------

/** A hand-written passthrough: forwards the raw API answer to the "model" unfiltered. It is what
 *  Archstone's output contract exists to prevent, so it must leak. */
export async function rawPassthrough(path: string, init?: RequestInit): Promise<unknown> {
  const response = await handle(new Request(`${API_ORIGIN}${path}`, init), { now: CLOCK_MS });
  return response.json();
}

// ---------------------------------------------------------------------------------------------
// Sessions over the real runtime
// ---------------------------------------------------------------------------------------------

let sharedRegistry: Registry | undefined;
/** The compiled showcase manifest, built once per test file. */
export function registry(): Registry {
  sharedRegistry ??= openRegistry();
  return sharedRegistry;
}

export interface SessionOptions {
  intercept?: Intercept;
  registry?: Registry;
}

export interface Session {
  registry: Registry;
  clock: Clock;
  spy: Spy;
  counter: InMemoryRateLimitCounter;
  /** The MCP tool path: `callTool`, with a real caller context for the key label. */
  call(tool: string, args: Record<string, unknown>, key?: KeyLabel, extra?: { callerResolutionFailed?: boolean }): Promise<CallResult>;
  /** The embedded SDK path: `fromIR(ir).execute`, the surface that reports `ok | degraded | violation | error`. */
  execute(capabilityId: string, args: Record<string, unknown>, key?: KeyLabel): Promise<ExecuteResult>;
  /** Run a scenario row's setup chain, then its own call (or overrides) on the MCP tool path. */
  run(row: ScenarioRow, overrides?: { key?: KeyLabel; arguments?: Record<string, unknown>; tool?: string }): Promise<{ result: CallResult; captured: Record<string, unknown>; args: Record<string, unknown> }>;
  /** A real MCP client on an in-memory transport to the real MCP server (arms outputSchema validation). */
  withClient<T>(key: KeyLabel, fn: (client: Client) => Promise<T>): Promise<T>;
}

function atPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), value);
}

export function session(opts: SessionOptions = {}): Session {
  const reg = opts.registry ?? registry();
  const clock: Clock = { t: CLOCK_MS };
  const spy = makeSpy(clock, opts.intercept);
  const counter = new InMemoryRateLimitCounter(() => clock.t);
  const sdk = fromIR(JSON.parse(JSON.stringify(reg.ir)) as unknown);

  const invoke = (key: KeyLabel): { env: Record<string, string>; fetchImpl: typeof fetch; caller: CallerContext | undefined; rateLimitCounter: InMemoryRateLimitCounter } => ({
    env: ENV,
    fetchImpl: spy.fetchImpl,
    caller: callerForLabel(key),
    rateLimitCounter: counter,
  });

  const s: Session = {
    registry: reg,
    clock,
    spy,
    counter,
    call: (tool, args, key = "none", extra) =>
      callTool(reg, tool, args, { ...invoke(key), ...(extra?.callerResolutionFailed ? { callerResolutionFailed: true } : {}) }),
    execute: (capabilityId, args, key = "none") => sdk.execute(capabilityId, args, invoke(key)),
    run: async (row, overrides = {}) => {
      const captured: Record<string, unknown> = {};
      for (const step of row.setup ?? []) {
        const r = await s.call(step.tool, fill(step.arguments, captured) as Record<string, unknown>, step.key);
        if (r.isError) throw new Error(`setup step ${step.tool} of ${row.id} failed: ${JSON.stringify(r)}`);
        for (const [name, path] of Object.entries(step.capture ?? {})) captured[name] = atPath(r.structuredContent, path);
      }
      const args = fill(overrides.arguments ?? row.arguments ?? {}, captured) as Record<string, unknown>;
      const result = await s.call(overrides.tool ?? row.tool ?? "", args, overrides.key ?? row.key);
      return { result, captured, args };
    },
    withClient: async (key, fn) => {
      const server = createMcpServer(reg, invoke(key));
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      const client = new Client({ name: "showcase-negatives", version: "0" }, { capabilities: {} });
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      try {
        await client.listTools(); // arms the client's outputSchema validation, as in production
        return await fn(client);
      } finally {
        await client.close();
        await server.close();
      }
    },
  };
  return s;
}

// ---------------------------------------------------------------------------------------------
// Reading a refusal
// ---------------------------------------------------------------------------------------------

type Meta = Record<string, unknown> | undefined;

/** The named reason a refused MCP call carries in `_meta`, whichever gate refused it. */
export function reasonOf(meta: Meta): string | undefined {
  const policy = meta?.["dev.archstone/policy_denied"] as { reason?: string } | undefined;
  if (policy?.reason) return policy.reason;
  const lifecycle = meta?.["dev.archstone/lifecycle_blocked"] as { error?: string } | undefined;
  if (lifecycle?.error) return lifecycle.error;
  const input = meta?.["dev.archstone/input_invalid"] as { error?: string } | undefined;
  if (input?.error) return input.error;
  const violation = meta?.["dev.archstone/contract_violation"] as { error?: string } | undefined;
  return violation?.error;
}
