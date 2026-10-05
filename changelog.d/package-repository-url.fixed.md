- **Published packages pointed `repository.url` at the old GitHub owner.** The repository now lives at
  `NousVigil/archstone`, and npm rejects a provenance-signed publish whose `package.json`
  `repository.url` disagrees with the repository that built it (E422), so 0.27.0 could not be
  published. All nine packages now name `https://github.com/NousVigil/archstone.git`.
- Links to the repository in the package READMEs, `server.json`, `SECURITY.md`, `SUPPORT.md`,
  `CONTRIBUTING.md` and the issue-template config now point at `NousVigil/archstone`.
- **The MCP Registry name moves to `io.github.NousVigil/archstone`.** The registry verifies a
  namespace against the GitHub owner publishing it, which is now `NousVigil`. `mcpName` in
  `@archstone/cli` and `name` in `server.json` change together. Clients that pinned the old
  `io.github.Archstone-Romania/archstone` entry (last published at 0.26.0) must switch to the new name.
