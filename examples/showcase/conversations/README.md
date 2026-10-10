# Conversation check

A local smoke check: a real model drives the Showcase's MCP endpoint with the prompts a visitor
would type, and the script reads the tool traffic back and flags what looks wrong.

```bash
pnpm showcase:conversations                          # against https://demo.archstone.dev/mcp
pnpm showcase:conversations --url http://localhost:8787/mcp
DEMO_MCP_URL=http://localhost:8787/mcp pnpm showcase:conversations --only V-cat
pnpm showcase:conversations --report /tmp/report.md  # write the report where you choose
```

It needs the `claude` CLI on your path and signed in. Each prompt runs headless with Haiku
(`claude -p ... --model haiku --output-format stream-json --verbose --strict-mcp-config`), from an
empty temporary directory, with no built-in tools: the only tools the model can reach are the demo's.
Your user-level Claude settings still apply.

**Prompts.** Every suggested prompt of a live scenario in [`../scenarios.json`](../scenarios.json),
plus variants: "Lisbon, Portugal", "with my cat", "next weekend", a Romanian phrasing, a city that is
not in the catalogue, and a total-stay budget.

**Serial and paced.** One prompt at a time, spaced so the estimated POSTs stay under 15 per 10
seconds, below the hosted demo's per-IP edge limit. A full run takes several minutes.

**What it flags** (and exits non-zero on):

- a tool error the prompt did not intend (S-07, S-14, the key-needing scenarios, S-11's rate limit
  and S-13's unwell properties are tolerated, and the report says so),
- a stay name or id that is not in the catalogue (imported from `api/wanderlust-api.mjs`, so there
  is no second list),
- a price per night above a budget the prompt states,
- an id the model used that the endpoint could not resolve,
- a run that timed out, failed, or could not connect to the MCP server.

Raw streams are kept in `runs/<timestamp>/` next to `report.md` (git-ignored). It is not part of CI or
of `pnpm test`: a model's phrasing varies from run to run. The deterministic counterpart that CI runs
is [`../test/conversations.test.ts`](../test/conversations.test.ts).

**Input refusals.** The runtime validates a tool's arguments against its declared input contract
before any backend call and refuses a mismatch (`_meta["dev.archstone/input_invalid"]`). The report
counts these per prompt in their own column and section, with each refused path and what was
expected, and they are always flagged: a visitor's natural phrasing was refused, which is a reason to
widen the showcase's declared inputs or sharpen their descriptions (never to loosen the runtime).
The `claude` CLI's stream keeps only a tool result's text, so unless a stream carries the `_meta`,
the script recognises a refusal from the runtime's fixed refusal text; if that wording changes the
refusals still show up as ordinary tool-error flags until `inputProblems` in `run.mjs` is updated.
