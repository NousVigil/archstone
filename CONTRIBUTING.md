# Contributing to Archstone

Thanks for your interest in Archstone — a **compiler** for *zero manual integration*.

The full guide is in
**[`docs/ONBOARDING.md` → Contributor onboarding](docs/ONBOARDING.md#contributor-onboarding)**.
This page is the quick reference.

## Quick start

```bash
git clone https://github.com/NousVigil/archstone
cd archstone
pnpm install
pnpm lint             # eslint
pnpm typecheck        # tsc, strict
pnpm test             # vitest — includes the end-to-end MCP demo
pnpm demo:booking     # the pipeline, end to end
```

Node 22+ · pnpm 11+. When running a single test file directly with `pnpm exec vitest run`, build the affected package first — tests import by package name and resolve to `dist/`, so without rebuild you'll test stale code. Use `pnpm test` to build everything at once.

## Making a change

1. Fork and create a branch.
2. Keep `pnpm typecheck` and `pnpm test` green.
3. Record the change as a new file in [`changelog.d/`](changelog.d/README.md), named
   `<slug>.<category>.md`, or say why there is nothing to record — see
   [The changelog](#the-changelog). Don't edit `CHANGELOG.md`'s `[Unreleased]` section directly:
   every PR editing it conflicts with every other one, and the release folds the files in for you.
4. Sign off every commit with `git commit -s` — see
   [Licensing of contributions](#licensing-of-contributions).
5. Open a PR against `main`. CI runs typecheck, test and the release-script tests on every PR,
   plus the two changelog checks.

### Tests against a real Postgres

The `sql` provider's isolation guarantee is only as good as the database that enforces it, so the
`*.integration.test.ts` suites that cover it (`providers/sql/test/`,
`packages/runtime/test/verify-sql-isolation.integration.test.ts` and
`packages/cli/test/sql-postgres-e2e.integration.test.ts`) run against a real Postgres.

**In CI they are mandatory and are never skipped.** The `build` job runs the whole test suite against
the current Postgres major (18) and the `postgres-compat` job runs just these suites against an older
supported major (16). If `CI` is set and `ARCHSTONE_TEST_PG_URL` is not, or the server cannot be
reached, the suites fail with a message saying so — a skipped suite reports green, and a guarantee
nobody ran is not one.

**Locally they are opt-in**: with `ARCHSTONE_TEST_PG_URL` unset they skip, with the reason in the
suite's name, and `pnpm test` stays offline. To run them:

```bash
docker run -d --rm --name archstone-pg-it -e POSTGRES_PASSWORD=archstone -p 127.0.0.1:55432:5432 postgres:18
ARCHSTONE_TEST_PG_URL=postgres://postgres:archstone@127.0.0.1:55432/postgres pnpm test
docker stop archstone-pg-it
```

`pnpm test:postgres` builds and runs only the Postgres suites, which is what `postgres-compat` runs;
to try the older major, start `postgres:16` instead.

The URL must be an admin (superuser) role: it is used only to create, and drop afterwards, a
per-run database and the roles the tests connect as — never to run a provider call.

Small, focused PRs merge fastest. For anything larger (a new provider type, a change to the
IR or CDL), open an issue first so the design can be discussed.

## The changelog

`CHANGELOG.md` is the release notes. When a release is cut, every `changelog.d/` fragment is
folded into its `## [Unreleased]` section, that heading is renamed to the version number, and the
section is published as-is as the GitHub Release — nobody rewrites it afterwards from commit
subjects. So the entry is written by the PR that makes the change, and two CI checks hold every PR
to that:

- **`changelog entry or waiver`** — the PR adds a fragment under `changelog.d/` (see its
  [README](changelog.d/README.md) for the name and the style: what changed for someone using the
  published packages, and the package it is in). A line added under `## [Unreleased]` in
  `CHANGELOG.md` also counts, but conflicts with every other open PR. If nothing in the PR is
  visible to users — CI, tests, internal docs — say so instead, on a line of its own in a commit
  message **or** the PR description:

  ```
  Changelog: none — <why a user would not notice>
  ```

  A bare `Changelog: none` is refused; the reason is what the reviewer reads. The check re-reads
  the PR description when it runs, so after editing the description, re-run the check.

- **`released changelog sections are unchanged`** — never edit a `## [x.y.z]` section. It
  describes a version people may already be running. This usually fails *by accident*: you wrote
  entries under `## [Unreleased]`, a release renamed that heading on `main`, and when you rebased,
  git reattached your lines under the released heading — no conflict, nothing odd in the diff.
  Fragments in `changelog.d/` avoid this; if you did write in `CHANGELOG.md`, after any rebase
  across a release look at where your entries actually are, and move them into a fragment. If you really are correcting a released section,
  declare it (once per version touched, in a commit message or the PR description):

  ```
  Changelog-correction: <x.y.z> — <what was wrong>
  ```

Commits whose subject starts with `chore(release):` — the release-prepare stamp — are exempt from
the first check.

## Adding a dependency

Before adding a new dependency, or bumping an existing one, check its advisory history yourself —
`npm audit` locally after the change, or a quick look at the
[GitHub Advisory Database](https://github.com/advisories) for that package — rather than finding
out only when CI flags it. CI's dependency-audit gate (`.github/workflows/audit.yml`) is a
backstop, not the first line of defense: by the time it runs on your PR, you've already picked the
package and the version, and reworking that choice after a red build is more expensive than a
minute of checking beforehand. The gate does fail a PR that introduces a version carrying a known
advisory (moderate severity or above) that the base branch didn't already have — see that
workflow's own header comment for exactly what it checks — but don't rely on it to do your
research for you.

## Releasing

Cutting a release is a maintainer action, not a contributor one — it's covered here because the
whole flow lives in three workflows and nowhere else. It's three acts, two of them human:

1. **Dispatch `Release prepare`** (`workflow_dispatch` on `.github/workflows/release-prepare.yml`,
   run against `main`). Dispatching it is the decision to release — nothing does that on a
   schedule or on merge. The *number* is computed by default: with `bump: auto`,
   `scripts/classify-bump.mjs` reads the commits since the last `v*` tag by Conventional Commits
   (a `type!:` header or `BREAKING CHANGE:` footer beats `feat:`, which beats everything else;
   inside a squash body every listed commit counts) and the run summary lists each commit and
   names the ones that decided it. While the major is 0 a breaking change bumps the **minor**, so
   the default never produces 1.0.0; that takes `bump: major` or an explicit `version`, which —
   like `patch`/`minor` — override the computed number whenever you want to. It stamps
   the root `package.json`, every publishable package under `packages/` and `providers/`
   (discovered by `private: false`, not hardcoded), and `server.json`; folds every
   `changelog.d/` fragment into the CHANGELOG's `## [Unreleased]` section and deletes it; turns
   that heading into `## [X.Y.Z]` and opens a fresh, empty `Unreleased` above it; then pushes
   `release/prepare-X.Y.Z` and stops. It refuses to run if there is nothing to announce: no
   fragments and no entries under `[Unreleased]`. `Release tag` refuses a fragment merged after
   this step, because its change would ship without a release note.
2. **Open and merge that PR yourself.** The workflow deliberately doesn't open it: a PR raised
   with the default `GITHUB_TOKEN` still needs a manual "approve workflow run" click before CI
   runs on it, which is exactly as much human effort as opening the PR directly, without adding a
   stored PAT or GitHub App token this repo otherwise has no use for (npm publishing is OIDC —
   there is no `NPM_TOKEN`).
3. **Dispatch `Release tag`** (`.github/workflows/release-tag.yml`) with the version, once the
   prepare PR is merged and green. It re-verifies the merge commit is stamped and that the
   CHANGELOG has a non-empty `## [X.Y.Z]` section, pushes the `vX.Y.Z` tag, and explicitly
   dispatches `release.yml` — a tag pushed by `GITHUB_TOKEN` does not start a workflow on its own.
4. **`release.yml`** runs from the tag: lint, typecheck, the full test suite, and a release-only
   gate that packs and installs every package end to end — then publishes the 9 `@archstone/*`
   packages to npm via OIDC and creates the GitHub Release from that CHANGELOG section.

If a run stops partway, resume it via that same workflow's own `workflow_dispatch` with the same
version — never delete and re-push a tag.

## Conventions

- **Schema before core** — don't build a feature ahead of the schema that defines it.
- **CDL is business-only** — URLs, auth, and HTTP verbs belong in a `binding`, never in a
  `*.capability.yaml`.
- **Respect the layer boundaries** — the MCP SDK lives only in the emitter/runtime; HTTP
  lives only in `providers/`; the compiler and IR know neither.
- TypeScript strict · pnpm workspaces · Vitest.

## Generative AI

Using an AI assistant to write a contribution is fine. Submitting work you do not understand is
not. The project's own use of generative AI is described in the
[README](README.md#how-this-project-uses-generative-ai); this is what we ask of you.

**Required:**

- **Disclose it.** If a commit contains generated code, name the model and its version in the
  co-authorship trailer, and say in the PR description what was generated and what you wrote.
  Prose help — a reworded doc, a commit message — needs no ceremony.
- **Be able to explain every line you submit.** Review asks *why*, not just whether CI is green.
  "The model wrote it" is not an answer, and a PR whose author cannot defend its design is closed
  even if it passes.
- **Check the licence.** By contributing you assert the work is yours to license under
  Apache-2.0. Output reconstructed from incompatible sources is not, and neither of us can fix
  that after it merges.

**Read the specification before generating anything that touches these:**

- **`effect`** (`read` / `write` / `irreversible`). Getting it wrong is not a style defect — it is
  the difference between looking up a price and charging a card, and it reaches a customer through
  an agent.
- **The response-mapping boundary.** That an undeclared provider field never reaches a model is a
  stated guarantee, not an implementation detail
  ([ADR-0008](docs/adr/0008-undeclared-provider-data-never-reaches-a-model.md)).
- **Anything under `packages/schema/`.** The schema defines the language; a plausible-looking
  addition is a language change.

**Design decisions are not generated.** A change to CDL, the IR, or a compiler guarantee needs an
ADR — alternatives considered, argued by a person. Open an issue first.

## Code of Conduct

By participating you agree to our [Code of Conduct](CODE_OF_CONDUCT.md).

## Licensing of contributions

Archstone is licensed under the [Apache License 2.0](LICENSE). Under section 5 of that licence,
anything you submit is licensed under Apache-2.0 too ("inbound = outbound"). You keep the
copyright in your contribution: the project asks for no copyright assignment and no CLA.

Instead, every commit carries a sign-off certifying the
[Developer Certificate of Origin 1.1](https://developercertificate.org):

```
Signed-off-by: Your Name <you@example.com>
```

`git commit -s` adds it from your git config; `git rebase --signoff main` adds it to every commit
on a branch you already wrote. By signing off you certify that you wrote the contribution, or
otherwise have the right to submit it under Apache-2.0 — including any AI-generated material in it
(see [Generative AI](#generative-ai)). Use your real name, and don't sign off on code you cannot
vouch for. A PR with an unsigned commit is asked to fix it before it merges.
