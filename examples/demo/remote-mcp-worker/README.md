# The demo Worker: the live Showcase on one origin

This Worker is a **demo prop** for the website's live sections. It is **not product hosting**: it
serves one fixed, already-compiled example, over a public endpoint, with invented data, and nobody's
manifest is compiled or run here. Hosting generated MCP servers for real users would be a separate
design, not an extension of this folder.

It is deployed as `archstone-demo-tourism-mcp` at `https://demo.archstone.dev`. The name and the URL
have not changed, so MCP client configurations saved against the earlier single-tool version keep
working.

## What it serves

Everything below comes from one origin and one script. The capabilities and the synthetic agency API
live in [`examples/showcase`](../../showcase/); this Worker only wires them to HTTP.

| Route | What |
|---|---|
| `POST /mcp` | The Showcase over remote MCP (Streamable HTTP, stateless, JSON responses). POST only: `GET` and `DELETE` are `405`. No CORS. Adds `x-showcase-backend-calls: <n>`, the number of requests this call made to the synthetic API. |
| `POST /run/{scenarioId}` | The browser path behind "Run it live". One fixed tool call per live scenario in [`scenarios.json`](../../showcase/scenarios.json). CORS: see below. |
| `GET /img/...`, `/v1/...` | The synthetic agency's images and API, on the same origin as the tools. No CORS. |
| anything else | `404` |

`tourism_search` is still there and still answers. It is advertised as **deprecated** for one release
(its description says so); the Showcase tools replace it.

### `POST /run/{scenarioId}`

The body is ignored. The tool, its arguments and the key come from the scenario table, so the
endpoint cannot be used to call anything else. A scenario that needs a quote first (S-06, S-07, S-09)
makes that call itself. Unknown ids, and scenarios that are not `live`, are `404`.

```json
{
  "scenario": "S-07",
  "tool": "wanderlust_book",
  "arguments": { "...": "the fixed arguments, quote id filled in" },
  "caller": "none | demo key A | demo key B",
  "result": { "content": [], "structuredContent": {}, "_meta": {}, "isError": true }
}
```

For the rate-limited capability (S-11) the body also has a top-level `rateLimit` string saying the
limit is approximate; no other scenario has it.

`result` is what the tool call returned, unedited: no prose is added. It is **a direct tool call, not
a model's answer**; it shows the call an AI would make and what came back.

### CORS (`/run` only)

- `Access-Control-Allow-Origin` is exactly one origin: `https://archstone.dev`, plus any origins listed
  in the `CORS_ORIGINS` variable (comma separated; for `wrangler dev`, for example
  `wrangler dev --var CORS_ORIGINS:http://localhost:4321`). Matching is by exact string. `Vary: Origin`
  is always set.
- A `POST` from any other origin gets no allow header and a `403`; the call is not made.
- `OPTIONS` from an allowed origin is `204` with the allow headers. From any other origin (or none) it
  is `403` with no allow header.
- `/mcp` and the API carry no CORS headers: they are for MCP clients and `curl`, not for pages.

## The two demo keys are public

| Key | Principal | Effect |
|---|---|---|
| `demo-public-key-visitor-0000` | `demo:visitor` | accepted by the agency, allowed to book |
| `demo-public-key-blocked-0000` | `demo:blocked` | accepted by the agency, denied by the booking policy (`principal_denied`) |

They are published here, in [`credentials.mjs`](../../showcase/credentials.mjs) and on the site, on
purpose. Anyone may use them. They unlock invented data and nothing else.

Send one as `Authorization: Bearer <key>` on `/mcp`:

- no header: no caller, so a call that needs a credential is refused (`authenticated_no_credential`);
- any other bearer: a credential is present but there is no principal;
- a header that is not `Bearer ...`: the Worker cannot resolve the caller, and the call is refused as
  `policy_unevaluatable`.

The principal is asserted by this Worker from a two-entry table lookup. The Worker verifies nothing
else, and Archstone treats the principal as an opaque string.

## Rate limit (approximate)

`wanderlust.availability` allows 3 calls per 60 seconds. The count is a fixed window held in memory
**per isolate**: another isolate, another location or a restart starts a new count, and a reset is
silent. So the limit is **approximate**, and every `/mcp` and `/run` response says so in the
`x-showcase-rate-limit` header. Other capabilities are not limited.

On `/mcp` the count is shared by every caller without a principal. On `/run`, for S-11 only, the
counter key is a per-visitor value (8 hex of a SHA-256 over the client IP and the UTC date) so one
visitor's taps do not use up another's. It exists only as a key in the isolate's memory and is never
logged or returned.

The real abuse control is **Cloudflare's rate limiting on this Worker's route**, a dashboard setting,
not code in this folder. It must be configured before pointing real traffic at the Worker.

## No per-visitor state

`wrangler.jsonc` declares no storage, queue or object binding. Nothing a visitor does is kept, apart
from the in-memory rate-limit counter above.

The synthetic API is deliberately unsafe: it returns more than a contract should allow, and it has a
`DELETE` route no capability exposes (it deletes nothing, because nothing is stored). All of it is
invented; see the Showcase README for what each over-exposed field is for. That a backend sits behind
Archstone does not make it safe: the manifests decide what a model may see, and the rest of the
backend is as it was.

## How it works

1. `pnpm build:ir` runs the real pipeline (load, validate, compile) on Node against
   [`examples/showcase/manifest`](../../showcase/manifest/) and writes the IR to
   `src/ir.generated.json` (git-ignored, rebuilt on every build and deploy).
2. At the edge, `src/worker.ts` builds a `Registry` from that IR and reuses `createMcpServer` and
   `callTool` from `@archstone/runtime` unchanged. The REST connector's `fetch` is replaced by an
   in-process call to the synthetic API's handler for requests to the Worker's own origin (Cloudflare
   refuses a Worker fetching its own zone). Any other destination is refused.
3. `src/index.ts` is only the default export: the Workers runtime does not start a Worker whose entry
   module exports anything but handlers.

## Commands

```bash
pnpm install                                                  # from the repository root
pnpm --filter archstone-demo-remote-mcp-worker dev            # wrangler dev on :8787
pnpm --filter archstone-demo-remote-mcp-worker test           # rebuilds the IR, runs vitest
pnpm --filter archstone-demo-remote-mcp-worker typecheck
pnpm --filter archstone-demo-remote-mcp-worker test:workerd   # runs the Worker under workerd and compares it to Node
pnpm --filter archstone-demo-remote-mcp-worker live-battery https://demo.archstone.dev
```

## Tests

- `test/worker.test.ts`: routes, the two keys and the policy, the rate limit, the retired capability,
  `/run`, no storage binding, the in-process run of the live battery.
- `test/cors.test.ts`: the allowed origin, other origins, preflight, `CORS_ORIGINS`, no CORS elsewhere.
- `test/deploy-workflow.test.ts`: the deploy workflow's path filters and its gate.
- `scripts/battery.ts`: the **live battery**, plain `fetch` checks (no wrangler, no credentials) that
  run in-process, under workerd (`scripts/workerd-parity.ts`, which also compares every live `/run`
  result with the Node result) and against the deployed URL (`scripts/live-battery.ts`).

## Deploying

[`deploy-demo-worker.yml`](../../../.github/workflows/deploy-demo-worker.yml) has two jobs. `deploy-gate`
runs the Showcase test suite (including the negative scenarios), this Worker's tests and the workerd
parity check; it runs on pull requests that touch the Worker or the Showcase too. `deploy` needs
`deploy-gate`, so a failing suite means no deploy, then deploys on pushes to `main` and runs the live
battery against `https://demo.archstone.dev`. A red battery does not roll anything back automatically:
look, then `wrangler rollback` and revert.

The workflow reads the repository secrets `CLOUDFLARE_API_TOKEN` (Workers Scripts:Edit on the account
that owns the Worker) and `CLOUDFLARE_ACCOUNT_ID`. Create the token in the Cloudflare dashboard; never
paste a token value into a workflow file, an issue or a pull request.
