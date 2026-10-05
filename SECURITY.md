# Security Policy

Archstone is early-stage software. We take security issues seriously and appreciate
responsible disclosure.

## Reporting a vulnerability

**Please do not open a public issue for security vulnerabilities.**

Instead, report privately via GitHub's
[**Report a vulnerability**](https://github.com/NousVigil/archstone/security/advisories/new)
form (Security → Advisories), or email the maintainers at **security@archstone.dev**.

Please include:

- a description of the issue and its impact,
- steps to reproduce (a minimal CDL manifest or command is ideal),
- affected version / commit.

We aim to acknowledge reports within a few business days and will keep you updated on
remediation.

## Scope

Archstone compiles capability definitions (CDL) into agent-callable tools. Security-relevant
areas include:

- **Binding resolution** — how `${VAR}` secrets and endpoints are read and injected.
- **Provider adapters** (`providers/`) — outbound HTTP request construction.
- **The MCP runtime** — what a connected agent can and cannot reach.

Manifests are treated as trusted input authored by the operator, not as untrusted
user-supplied data. If you find a way for manifest content or a compiled tool to reach
beyond its declared binding, that is in scope.

## Supported versions

Pre-1.0: only the latest `main` is supported. Please reproduce against `main` before
reporting.
