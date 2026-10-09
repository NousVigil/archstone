# Examples

Valid CDL manifests — they pass schema validation and compile end to end.

---

## Manifests

Deployable CDL — `capabilities.yaml` + `*.capability.yaml` + `bindings/`.

| Manifest | What |
|---|---|
| [`manifests/tourism/`](manifests/tourism/) | Demo: one bound `tourism.search` capability |
| [`manifests/booking/`](manifests/booking/) | Fuller: 4 capabilities, provider mapping, bound + unbound |
| [`manifests/bank/`](manifests/bank/) | Banking capabilities incl. an irreversible transfer |
| [`showcase/manifest/`](showcase/manifest/) | A synthetic travel agency: 13 capabilities over a backend that over-exposes on purpose; see [`showcase/`](showcase/) |

---

## Runnable demos

| Demo | What |
|---|---|
| [`demo/extract-stay/`](demo/extract-stay/) | The other direction: a model *produces* a `tourism.Stay`, and Archstone judges it (ADR-0011). Deterministic — recorded responses, no API key. |

```bash
pnpm --filter archstone-demo-extract-stay start
```

---

## Apply

```bash
pnpm apply examples/manifests/tourism
```

---

*Examples follow schemas — not the other way around*
