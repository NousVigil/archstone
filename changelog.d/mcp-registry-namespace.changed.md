- **The MCP Registry name is now `io.github.NousVigil/archstone`.** The repository moved to the
  `NousVigil` GitHub organisation, and the registry only lets a workflow publish under
  `io.github.<owner>/*` for the owner of the repository it runs in, so the release could no longer
  update `io.github.Archstone-Romania/archstone`. `server.json` and `mcpName` in `@archstone/cli`
  carry the new name. The old entry stays at 0.26.0; install through `npx @archstone/cli` as before.
