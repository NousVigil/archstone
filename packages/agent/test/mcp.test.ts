import { describe, it, expect } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildRegistry } from "@archstone/runtime";
import type { CreateHttpHandlerOptions } from "@archstone/runtime/http";
import type { FetchLike } from "@archstone/provider-rest";
import { fromIR } from "../src/index";
import { mcpHandler, type CallerContext, type McpHandlerOptions } from "../src/mcp";

// #195: the declared input contract is enforced, so a tourism.search call must carry every
// required field (destination, dates, travelers) in its declared shape.
const NICE_SEARCH = { destination: "Nice", dates: { from: "2027-05-12", to: "2027-05-15" }, travelers: { adults: 2 } };


// Real Streamable-HTTP round trip against mcpHandler() itself (ADD-0008 #29 DoD) — Web-
// standard Request/Response, no Workers runtime needed (they work identically in Node's test
// runner). Modeled on runtime/test/http.test.ts (the bearer-token gate, already covered at
// the createHttpHandler layer) and examples/demo/remote-mcp-worker/test/worker.test.ts (the
// initialize -> tools/list shape) — extended here with tools/call, since #29 is specifically
// about proving the @archstone/agent/mcp wrapper (fromIR() -> mcpHandler()), not
// re-testing createHttpHandler's own gate logic.

const here = dirname(fileURLToPath(import.meta.url));
const tourism = resolve(here, "../../../examples/manifests/tourism");
// banking.list-accounts declares `policies: [authenticated]` and binds
// `Authorization: Bearer ${caller.accessToken}` — the one fixture where a caller credential is
// both required and observable on the outbound call (ADD-32 §6.9).
const bank = resolve(here, "../../../examples/manifests/bank");

/** `archstone build`'s artifact is IR round-tripped through JSON — simulate that exactly. */
function loadArtifact(manifestDir: string = tourism): unknown {
  const ir = buildRegistry(manifestDir).registry!.ir;
  return JSON.parse(JSON.stringify(ir));
}

function mcpRequest(body: unknown, headers: Record<string, string> = {}): Request {
  return new Request("http://test.local/mcp", {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
    body: JSON.stringify(body),
  });
}

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "vitest", version: "0" } },
};

describe("mcpHandler() — real Streamable-HTTP round trip (ADD-0008 #29)", () => {
  it("initialize -> tools/list -> tools/call, with a valid bearer token", async () => {
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const handler = mcpHandler(archstone, {
      bearerToken: "secret",
      invoke: { env: { STAYS_API_URL: "https://x.test" }, fetchImpl },
    });
    const auth = { authorization: "Bearer secret" };

    const init = await handler(mcpRequest(INITIALIZE, auth));
    expect(init.status).toBe(200);

    const list = await handler(mcpRequest({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }, auth));
    expect(list.status).toBe(200);
    const listBody = (await list.json()) as { result?: { tools: { name: string }[] } };
    const names = listBody.result?.tools.map((t) => t.name) ?? [];
    expect(names).toContain("tourism_search");

    const call = await handler(
      mcpRequest(
        { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "tourism_search", arguments: NICE_SEARCH } },
        auth,
      ),
    );
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as {
      result?: { structuredContent?: Record<string, unknown>; isError?: boolean };
    };
    expect(callBody.result?.isError).toBeFalsy();
    expect(callBody.result?.structuredContent).toEqual({
      stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }],
      totalMatches: 1,
    });
  });

  it("401s a request with no Authorization header — no tool information in the body", async () => {
    const archstone = fromIR(loadArtifact());
    const handler = mcpHandler(archstone, { bearerToken: "secret" });
    const res = await handler(mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }));
    expect(res.status).toBe(401);
    const text = await res.text();
    expect(text).not.toMatch(/tourism_search/);
  });

  it("401s a request with the wrong bearer token", async () => {
    const archstone = fromIR(loadArtifact());
    const handler = mcpHandler(archstone, { bearerToken: "secret" });
    const res = await handler(
      mcpRequest({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }, { authorization: "Bearer wrong" }),
    );
    expect(res.status).toBe(401);
  });

  // Issue #39 / ADD-31 (BR-15/OQ-4/S-US6.2): mcpHandler is a thin, unchanged wrapper over
  // createHttpHandler — this dedicated test confirms onResponse already works at THIS public
  // export with zero additional code, rather than only inferring it from createHttpHandler's
  // own coverage (a consumer may reach mcpHandler without ever importing createHttpHandler).
  it("S-US6.2: mcpHandler forwards invoke.onResponse into a real tools/call round-trip, firing exactly once", async () => {
    const calls: { capabilityId: string; status: number; data: unknown }[] = [];
    const archstone = fromIR(loadArtifact());
    const fetchImpl: FetchLike = async () =>
      new Response(
        JSON.stringify({ stays: [{ name: "Hotel Azur", location: "Nice", pricePerNight: 118, rating: 4.5 }], totalMatches: 1 }),
        { status: 200 },
      );
    const handler = mcpHandler(archstone, {
      bearerToken: "secret",
      invoke: { env: { STAYS_API_URL: "https://x.test" }, fetchImpl, onResponse: (info) => { calls.push(info); } },
    });
    const auth = { authorization: "Bearer secret" };

    await handler(mcpRequest(INITIALIZE, auth));
    const call = await handler(
      mcpRequest(
        { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "tourism_search", arguments: NICE_SEARCH } },
        auth,
      ),
    );
    expect(call.status).toBe(200);
    const callBody = (await call.json()) as { result?: { isError?: boolean } };
    expect(callBody.result?.isError).toBeFalsy();
    expect(calls).toHaveLength(1);
    expect(calls[0].capabilityId).toBe("tourism.search");
    expect(calls[0].status).toBe(200);
  });

  it("throws at construction when bearerToken is missing/empty (Rule #7 / R-5) — mcpHandler does not relax createHttpHandler's gate", () => {
    const archstone = fromIR(loadArtifact());
    expect(() => mcpHandler(archstone, { bearerToken: "" })).toThrow();
    expect(() => mcpHandler(archstone, { bearerToken: undefined as unknown as string })).toThrow();
  });
});

// ---------------------------------------------------------------------------------------
// #46 — McpHandlerOptions.resolveCaller (ADD-42 G-1/R-7, the seam ADD-32 §6.6 shipped at the
// runtime layer). mcpHandler already forwarded `opts` verbatim, so the defect was type-level:
// no TYPED consumer could supply a per-request caller, and the only identity reachable from
// here was `invoke.caller`, which is process-wide. These tests pin the runtime behaviour the
// widened type now makes expressible — on the exact topology the bank pilot mounts.

function callTool(name: string, id: number, args: Record<string, unknown> = {}): unknown {
  return { jsonrpc: "2.0", id, method: "tools/call", params: { name, arguments: args } };
}

async function toolResult(res: Response): Promise<{ isError?: boolean; content?: { text: string }[] }> {
  const body = (await res.json()) as { result?: { isError?: boolean; content?: { text: string }[] } };
  return body.result ?? {};
}

describe("mcpHandler() — resolveCaller: per-request caller identity (#46)", () => {
  /** Exactly the shape a consumer writes once `resolveCaller` is factored out of the options
   *  literal — and the reason `CallerContext` is re-exported from this subpath. */
  function endUserFromHeader(request: Request): CallerContext | undefined {
    const token = request.headers.get("x-end-user-token");
    return token ? { accessToken: token } : undefined;
  }

  it("forwards resolveCaller and calls it PER REQUEST — two requests with different end-user credentials never share an identity", async () => {
    const outboundAuth: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      outboundAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    };
    const archstone = fromIR(loadArtifact(bank));
    const handler = mcpHandler(archstone, {
      bearerToken: "endpoint-secret", // gates the endpoint — orthogonal to resolveCaller (R-2)
      invoke: { env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl },
      resolveCaller: endUserFromHeader,
    });

    // One handler instance, two end users — the pilot's actual topology (one mounted handler,
    // many customers). A construction-time `invoke.caller` could not tell these two apart.
    const alice = await handler(
      mcpRequest(callTool("banking_list-accounts", 1), {
        authorization: "Bearer endpoint-secret",
        "x-end-user-token": "alice-token",
      }),
    );
    const bob = await handler(
      mcpRequest(callTool("banking_list-accounts", 2), {
        authorization: "Bearer endpoint-secret",
        "x-end-user-token": "bob-token",
      }),
    );

    expect(alice.status).toBe(200);
    expect(bob.status).toBe(200);
    expect((await toolResult(alice)).isError).toBeFalsy();
    expect((await toolResult(bob)).isError).toBeFalsy();
    expect(outboundAuth).toEqual(["Bearer alice-token", "Bearer bob-token"]);
  });

  // Pins SHIPPED behaviour that both #46 and ADD-42 G-1/R-7 describe incorrectly: they assume a
  // deployer who reaches for `invoke.caller` on this surface gets a working, process-wide
  // identity ("the worst possible failure mode, because it *works*"). They do not.
  // createHttpHandler rebuilds the per-request bag as `{ ...invoke, caller: resolveCaller?.(req) }`
  // (`runtime/src/http.ts:66`), so with no resolveCaller the explicit `caller: undefined` key
  // overwrites the spread — `invoke.caller` is inert on the HTTP/MCP path and the call fails
  // closed loudly instead. If runtime ever changes that merge, this test must fail, so that
  // `McpHandlerOptions.invoke`'s doc comment gets updated with it rather than going stale.
  it("a static invoke.caller is inert on this surface — it is overwritten per request, so an `authenticated` capability still fails closed", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the request must fail closed before any HTTP call");
    };
    const archstone = fromIR(loadArtifact(bank));
    const handler = mcpHandler(archstone, {
      bearerToken: "endpoint-secret",
      invoke: {
        env: { CORE_BANKING_URL: "https://core.example" },
        fetchImpl,
        caller: { accessToken: "static-process-wide-token" },
      },
      // no resolveCaller — so the static caller above never reaches invokeRest
    });

    const res = await handler(
      mcpRequest(callTool("banking_list-accounts", 1), { authorization: "Bearer endpoint-secret" }),
    );
    expect(res.status).toBe(200);
    const result = await toolResult(res);
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/requires policies:\[authenticated\]/);
  });

  it("a valid bearerToken does not itself supply a caller — an `authenticated` capability still fails closed with no resolveCaller (ADD-32 R-2)", async () => {
    const fetchImpl: FetchLike = async () => {
      throw new Error("must not be called — the caller-less request must fail closed first");
    };
    const archstone = fromIR(loadArtifact(bank));
    const handler = mcpHandler(archstone, {
      bearerToken: "endpoint-secret",
      invoke: { env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl },
      // no resolveCaller at all — endpoint access granted, caller identity absent
    });

    const res = await handler(
      mcpRequest(callTool("banking_list-accounts", 1), { authorization: "Bearer endpoint-secret" }),
    );
    expect(res.status).toBe(200); // the MCP transport succeeds; the tool call surfaces isError
    const result = await toolResult(res);
    expect(result.isError).toBe(true);
    expect(result.content?.[0]?.text).toMatch(/requires policies:\[authenticated\]/);
  });
});

// ---------------------------------------------------------------------------------------
// #46 decision: an option-surface parity guard, so the NEXT field added to
// CreateHttpHandlerOptions cannot silently go missing from McpHandlerOptions the way
// `resolveCaller` did between #32 and #46.
//
// Deliberately NOT plain structural assignability: `McpHandlerOptions` stays assignable to
// `CreateHttpHandlerOptions` in BOTH directions even when a field is missing, because every
// added field is optional and excess-property checks do not apply to non-literal assignment.
// An assignability assertion would therefore pass through the exact defect it claims to catch.
// Key-set containment is the invariant that actually holds the wrapper to its contract.
//
// Placement: here, next to the surface it guards, and NOT in test/boundary.test.ts — that file
// is a source-scan of the ROOT entry's import graph (ADD-0008 R-1), and putting a type import
// of @archstone/runtime/http inside the file that asserts the root entry has no such edge would
// blur two unrelated invariants.

type Expect<T extends true> = T;
type IsNever<T> = [T] extends [never] ? true : false;

/** Fails `pnpm typecheck` ("Type 'false' does not satisfy the constraint 'true'") the moment a
 *  key of `CreateHttpHandlerOptions` has no counterpart in `McpHandlerOptions` — i.e. the
 *  moment a runtime option becomes unreachable from typed embedded-MCP code. */
type _EveryRuntimeOptionIsExpressibleHere = Expect<
  IsNever<Exclude<keyof CreateHttpHandlerOptions, keyof McpHandlerOptions>>
>;
/** The other direction: a wrapper-only key would be silently dropped by `createHttpHandler`,
 *  since `mcpHandler` forwards `opts` verbatim and never reads it. */
type _NoWrapperOnlyOption = Expect<
  IsNever<Exclude<keyof McpHandlerOptions, keyof CreateHttpHandlerOptions>>
>;

// ---------------------------------------------------------------------------------------
// #46 rules on the escape hatch the omission left open, and the ruling is LEGITIMIZE, not
// close. TS2353 fires only on fresh object literals, so before this change a deployer could
// already pass `resolveCaller` by assigning it to a `CreateHttpHandlerOptions`-typed variable
// first and handing THAT to mcpHandler: structurally assignable, clean compile, and correct
// per-request behaviour, because the wrapper forwards the object without inspecting it.
// Widening `McpHandlerOptions` makes the honest spelling the typed one; it does not withdraw
// the laundered one. Proving the literal now typechecks would not protect anyone already on
// that path — so this test pins the laundered path's RUNTIME behaviour, and will fail if the
// options type is ever narrowed (exact/branded shape, `Omit`, a runtime key check).
// It doubles as the runtime companion to the compile-time parity guard above.

describe("mcpHandler() — the pre-#46 variable-laundering path stays supported (#46 decision)", () => {
  it("options laundered through a CreateHttpHandlerOptions-typed variable still resolve a FRESH caller per request", async () => {
    const outboundAuth: (string | undefined)[] = [];
    const fetchImpl: FetchLike = async (_url, init) => {
      outboundAuth.push((init?.headers as Record<string, string> | undefined)?.Authorization);
      return new Response(JSON.stringify({ accounts: [] }), { status: 200 });
    };
    // The exact spelling that compiled before #46: typed as the WIDER runtime options, never as
    // McpHandlerOptions, so no excess-property check ever fired on it.
    const laundered: CreateHttpHandlerOptions = {
      bearerToken: "endpoint-secret",
      invoke: { env: { CORE_BANKING_URL: "https://core.example" }, fetchImpl },
      resolveCaller: (request) => {
        const token = request.headers.get("x-end-user-token");
        return token ? { accessToken: token } : undefined;
      },
    };
    const opts: McpHandlerOptions = laundered; // still assignable — the hatch is not closed
    const handler = mcpHandler(fromIR(loadArtifact(bank)), opts);

    const carol = await handler(
      mcpRequest(callTool("banking_list-accounts", 1), {
        authorization: "Bearer endpoint-secret",
        "x-end-user-token": "carol-token",
      }),
    );
    const dave = await handler(
      mcpRequest(callTool("banking_list-accounts", 2), {
        authorization: "Bearer endpoint-secret",
        "x-end-user-token": "dave-token",
      }),
    );

    expect(carol.status).toBe(200);
    expect(dave.status).toBe(200);
    expect((await toolResult(carol)).isError).toBeFalsy();
    expect((await toolResult(dave)).isError).toBeFalsy();
    expect(outboundAuth).toEqual(["Bearer carol-token", "Bearer dave-token"]);
  });
});
