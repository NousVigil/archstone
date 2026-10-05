# Support

## Getting help

- **Questions, bugs, feature ideas** — [open an issue](https://github.com/NousVigil/archstone/issues).
- **Security vulnerabilities** — do **not** open a public issue. Follow [SECURITY.md](SECURITY.md).
- **Commercial support** (a named counterparty, response times, backports on a version you pin) —
  `hello@archstone.dev`.

Everything Archstone compiles and runs is Apache-2.0 and always will be. `archstone build` and
`archstone serve` never require a network call, an account or a key — pin a version, vendor your
manifest, and it keeps working with no relationship to us.

---

## Which versions are supported

| Line | Meaning | Receives |
|---|---|---|
| **Current** | The latest minor | Features, fixes, security |
| **Maintenance** | The previous minor | Security fixes and fail-closed correctness defects |
| **LTS** | A minor designated under a commercial agreement, maintained on its own `release/X.Y.x` branch | Security fixes and fail-closed correctness defects, for 12 months from your go-live on that line. Published under the `lts-X.Y` dist-tag, never `latest` |
| **End of life** | Everything older | Nothing. The code keeps working — it cannot be switched off remotely — but we do not fix it |

### Today

| Line | Version | Status |
|---|---|---|
| Current | `0.27.x` | ✅ Supported · `main` |
| Maintenance | `0.26.x` | ✅ Security and fail-closed fixes · `release/0.26.x`, cut when the first backport needs it |
| LTS | `0.27.x` | 🟢 **Available for designation** under a support agreement — the current minor, so a line designated today starts at the newest code rather than one already superseded |
| End of life | `≤ 0.25.x` | ⛔ |

---

## What gets backported

To Maintenance and to every designated LTS line:

- Security fixes.
- **Fail-closed correctness defects** — a governance path that permits what it should deny.
- Contract-integrity defects — a response that should have failed closed passing through, or an
  audit record that misattributes or omits an attempt.
- Data loss or corruption in anything you persist (the compiled IR artifact, audit records).

Not backported: features, new emitters or CDL primitives, performance work, CLI ergonomics,
dependency bumps without an advisory, refactors. Those live on Current — upgrading is the way to
get them.

---

## Versions: CDL is 1.0, the packages are not

**The language you author in is 1.0 and frozen.** Every CDL primitive is Canonical: none will be
removed or redefined, so a manifest that compiles today compiles against every later CDL 1.x.
New primitives may be added — that is additive and breaks nothing. This is the guarantee that
protects your actual investment, because the manifest is your source code and it lives in your
repository.

**The packages are `0.x`**, and a minor release may contain breaking changes. Each one states
them in [CHANGELOG.md](CHANGELOG.md). That is what an LTS line is for: pin a version, receive
security and fail-closed fixes on it, upgrade when you choose.

The two version numbers are deliberately independent. Freezing a TypeScript surface this young
would mean a major version every time an argument name improves; freezing the language costs
nothing, because its meaning was already committed.

**Your compiled IR** is the third piece: `archstone build` writes an artifact you commit to your
own repository and rebuild in your own CI, so an upgrade that changes anything agent-visible
shows up as a diff in your pipeline — before production, not as a surprise after.

---

## npm dist-tags

| Tag | Points at |
|---|---|
| `latest` | The Current line — what `npm install @archstone/cli` gives you |
| `lts-<major>.<minor>` | The head of that LTS line, e.g. `lts-0.11` |

A backport is **never** published as `latest`, so a patch on an older line can never change what
a default install resolves to.
