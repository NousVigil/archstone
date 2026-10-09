import { InMemoryRateLimitCounter } from "@archstone/emitter-support";
import { handle } from "../../../showcase/api/wanderlust-api.mjs";
import { createWorker, type Env } from "../src/worker";

export const ORIGIN = "http://demo.local";
export const SITE = "https://archstone.dev";
export const KEY_A = "demo-public-key-visitor-0000";
export const KEY_B = "demo-public-key-blocked-0000";
export const POLICY_META = "dev.archstone/policy_denied";

export interface Rpc {
  status: number;
  headers: Headers;
  result?: {
    content?: { type: string; text: string }[];
    structuredContent?: Record<string, unknown>;
    _meta?: Record<string, { reason?: string; error?: string }>;
    isError?: boolean;
    tools?: { name: string; description?: string }[];
    serverInfo?: { name: string };
  };
}

/** A Worker with a spy around the in-process synthetic API and a clock the test moves by hand. */
export function newWorker() {
  const apiCalls: string[] = [];
  let nowMs = Date.parse("2027-05-01T10:00:00Z");
  const counter = new InMemoryRateLimitCounter(() => nowMs);
  const worker = createWorker({
    api: (request) => {
      apiCalls.push(`${request.method} ${new URL(request.url).pathname}`);
      return handle(request);
    },
    counter,
    now: () => nowMs,
  });
  return {
    apiCalls,
    advance: (ms: number) => (nowMs += ms),
    fetch: (path: string, init?: RequestInit, env?: Env) => worker.fetch(new Request(`${ORIGIN}${path}`, init), env),
    async rpc(method: string, params: unknown, authorization?: string, extra: Record<string, string> = {}): Promise<Rpc> {
      const headers: Record<string, string> = {
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        ...extra,
      };
      if (authorization !== undefined) headers.authorization = authorization;
      const res = await worker.fetch(
        new Request(`${ORIGIN}/mcp`, { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }),
      );
      const body = (await res.json()) as { result?: Rpc["result"] };
      return { status: res.status, headers: res.headers, result: body.result };
    },
    call(name: string, args: Record<string, unknown>, authorization?: string) {
      return this.rpc("tools/call", { name, arguments: args }, authorization);
    },
  };
}
