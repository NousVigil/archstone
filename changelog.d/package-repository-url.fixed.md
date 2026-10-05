- **Published packages pointed `repository.url` at the old GitHub owner.** The repository now lives at
  `NousVigil/archstone`, and npm rejects a provenance-signed publish whose `package.json`
  `repository.url` disagrees with the repository that built it (E422), so 0.27.0 could not be
  published. All nine packages now name `https://github.com/NousVigil/archstone.git`.
- Links to the repository in the package READMEs, `server.json`, `SECURITY.md`, `SUPPORT.md`,
  `CONTRIBUTING.md` and the issue-template config now point at `NousVigil/archstone`.
