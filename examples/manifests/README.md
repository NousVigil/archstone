# Deployable Manifests

> Like Kubernetes `deployment.yaml` — but for business capabilities.

---

## The iconic file

Every ecosystem has one file developers recognize:

| Ecosystem | Iconic file |
|---|---|
| OpenAPI | `openapi.yaml` |
| Terraform | `main.tf` |
| Docker | `docker-compose.yaml` |
| Kubernetes | `deployment.yaml` |
| **Archstone** | **`capabilities.yaml`** |

---

## File types

| Pattern | Schema | Role |
|---|---|---|
| **`capabilities.yaml`** | [`capabilities.schema.json`](../../packages/schema/schemas/capabilities.schema.json) | **Iconic company contract with the AI world** |
| `*.capability.yaml` | [`cdl.schema.json`](../../packages/schema/schemas/cdl.schema.json) | **One deployable capability** |
| `bindings/*.binding.yaml` | [`binding.schema.json`](../../packages/schema/schemas/binding.schema.json) | Implementation (how) |

---

## Two example companies (CDL 0.2)

- **`booking/`** — the original tourism example, now on CDL 0.2 (`effect`, `failures`, `ref`).
- **`bank/`** — the regulated-domain showcase: all three `effect` values, `failures`,
  `human-approval`, `lifecycle`, and `*.resource.yaml` Resource Definitions whose
  state is a `status` enum field + `date` timestamps.

- **`sql-reporting/`** — the same shape on a `sql` binding: a capability backed by Postgres, with
  isolation enforced by the database and checked by `archstone verify`. Needs a Postgres container
  to run end to end ([README](sql-reporting/README.md)); `apply` is offline.

All manifests validate against the [schemas](../../packages/schema/schemas/) — 17/17, both valid-accept and invalid-reject checks pass.

```
booking/                              bank/
├── capabilities.yaml                 ├── capabilities.yaml
├── tourism.search.capability.yaml    ├── banking.list-accounts.capability.yaml
├── tourism.book.capability.yaml      ├── banking.quote-transfer.capability.yaml
├── tourism.cancel.capability.yaml    ├── banking.initiate-transfer.capability.yaml
├── tourism.invoice.capability.yaml   ├── banking.generate-statement.capability.yaml
└── bindings/                         ├── banking.Account.resource.yaml
    └── tourism.search.binding.yaml   ├── banking.Beneficiary.resource.yaml
                                      ├── banking.Transfer.resource.yaml
                                      ├── banking.TransferQuote.resource.yaml
                                      ├── banking.Statement.resource.yaml
                                      └── bindings/
                                          └── banking.initiate-transfer.binding.yaml
```

### Company contract

[`capabilities.yaml`](booking/capabilities.yaml) declares:

- **Who:** `company.id: booking`
- **What:** list of capability IDs
- **Providers:** backend systems (`booking-api`, `crm`, `payment`)

This is the **catalog** — the company's promise to AI agents.

### Deploy workflow (planned)

```bash
# Validate all manifests in a company directory
archstone validate ./booking/

# Deploy company contract + capabilities to registry
archstone apply ./booking/capabilities.yaml
archstone apply ./booking/*.capability.yaml

# Or apply entire directory
archstone apply ./booking/
```

Like `kubectl apply -f deployment.yaml` — but you start with `capabilities.yaml`.

---

## Legacy CDL examples

Pre-manifest examples: [`../cdl/`](../cdl/) — superseded by `manifests/` layout.

---

*Manifests are deployable · `capabilities.yaml` is the iconic Archstone file*
