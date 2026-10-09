- **Recorded Showcase scenarios, `examples/showcase` S-15 to S-21.** A recorder (`pnpm showcase:record`,
  `pnpm showcase:record:check`) runs the workspace CLI and the embedded SDK against the synthetic agency
  and writes one stable JSON transcript per scenario to `examples/showcase/transcripts/`: a SQL report from
  a local Postgres that the live manifest does not serve, `apply --exposure`, `verify` and `adopt` on a
  backend that gains a field, `diff` with the backend stopped, `audit` and `doctor` with no outbound
  connection (enforced by a preload that makes any attempt fail), `init` from the OpenAPI document, and the
  `@archstone/agent` SDK in three vendor shapes. Each scenario asserts its expected outcome and its
  negative and exits non-zero otherwise; `--check` fails CI on any byte that differs from a fresh
  recording. Examples and tests only: no published package changes.
