# @archstone/agent

Embedded agent SDK (RFC-0008 / ADD-0008): load a compiled Archstone IR artifact, generate typed
tool definitions (Anthropic · OpenAI Chat Completions · OpenAI Responses · Gemini · JSON-Schema),
invoke capabilities with
fail-closed response mapping, and judge model-produced documents at the extraction boundary —
all without running a separate MCP server process.

**Two entry points:**

- **Root** (`@archstone/agent`): `fromIR(json)` constructs an embedded instance; `tools(format)`
  generates typed tool defs; `execute(capabilityId, input)` invokes a capability with mapping
  applied; `extractor(resource, format)` binds one declared resource to one target — the schema
  a model is given and the boundary its answer passes through, as one object (ADR-0011). Zero
  MCP SDK, zero `node:fs` — safe to bundle and run anywhere (browser, Worker, native app).
- **`/mcp` subpath** (`@archstone/agent/mcp`): `mcpHandler(archstone, {bearerToken})` — a
  mountable, fail-closed Streamable-HTTP MCP endpoint for consumers who want to expose an
  embedded instance as an MCP server (e.g., Claude API `mcp_servers`, ChatGPT connectors).

## Quick start

```typescript
import { fromIR } from "@archstone/agent";
import { readFileSync } from "node:fs";

// Load a compiled IR (produced by `archstone build manifest/`)
const ir = JSON.parse(readFileSync("archstone.ir.json", "utf-8"));
const archstone = fromIR(ir);

// Get tool definitions in your preferred format
const anthropicTools = archstone.tools("anthropic");
const openaiChatTools = archstone.tools("openai-chat");        // Chat Completions
const openaiResponsesTools = archstone.tools("openai-responses"); // Responses API
const geminiTools = archstone.tools("gemini");
// "openai" still works but is a deprecated alias of "openai-chat" — migrate explicitly.

// Invoke a capability — accepts both raw dotted id or sanitized tool name
const result = await archstone.execute("tourism.search", {
  location: "Paris",
  checkInDate: "2026-08-01",
});
// Same call with sanitized tool name (as returned by tools()):
// const result = await archstone.execute("tourism_search", {...});

if (result.status === "ok") {
  console.log("Success:", result.data);
} else if (result.status === "degraded") {
  console.log("Partial:", result.data, "Missing:", result.degraded);
} else if (result.status === "violation") {
  console.log("Contract violation:", result.missing);
} else {
  console.log("Error:", result.error);
}
```

**Extracting business data from unstructured input (ADR-0011):**

A Resource Definition already says what a provider's response is mapped into. The same
definition says what a model must *produce*, and `extractor()` carries both halves — the closed
schema the model is given, and the validator its answer is judged by — so the two cannot drift
apart.

```typescript pseudocode
const stay = archstone.extractor("tourism.Stay", "anthropic");

// Give the model the schema — either axis, same schema underneath.
stay.structuredOutput;   // native structured output, in the envelope your provider expects:
                         //   Anthropic:        output_config.format
                         //   OpenAI-chat:      response_format.json_schema (Chat Completions)
                         //   OpenAI-responses: text.format (Responses API)
                         //   Gemini:           response_format

// ...or extraction as a forced tool call, in the same envelopes tools() emits. The
// instruction is required and never defaulted: it says what to DO on this occasion, which
// no Resource Definition can know.
stay.tool("Record the stay described in this booking email.");

// Judge what comes back, at a boundary Archstone owns.
const result = stay.validate(modelOutput);

if (result.status === "ok") {
  save(result.data);
} else if (result.status === "degraded") {
  save(result.data); // declared optional fields absent: result.degraded
} else {
  reject(result.missing, result.invalid); // withheld whole — result.data is absent
}

// Undeclared keys never reach `result.data`, at any depth, and are named in
// `result.undeclared`. There is no passthrough option, for the same reason there is none
// in ADR-0008.
```

`status` proves *shape*, never truth: a model that invents a plausible, correctly-typed value
returns `ok`, and nothing at this boundary can tell that apart from a real one. Error messages
never echo a value from the document — the extraction input is by construction the most
sensitive text in the deployment.

**For HTTP-based MCP:**

```typescript pseudocode
import { mcpHandler } from "@archstone/agent/mcp";

const handler = mcpHandler(archstone, {
  bearerToken: process.env.ARCHSTONE_TOKEN,
  invoke: { env: process.env }, // optional: env injection for REST connectors
});

// Mount on your framework (e.g., Hono, Express, fetch-based)
const response = await handler(new Request(...));
```

Part of [Archstone](https://github.com/NousVigil/archstone), an open-source
Capability Platform. For full documentation, see [`archstone/packages/agent`](../) and the
main [`README.md`](../../README.md).

## License

Apache-2.0
