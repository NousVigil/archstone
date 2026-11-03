- **`archstone record` records a `contract:` for a manifest that already exists
  (`@archstone/cli`).** Until now only `archstone init --probe` recorded one, and only while
  writing a new manifest. `archstone record <dir>` sends ONE live request per `read` REST binding
  without a contract, using the input in `fixtures/<capabilityId>.golden.json`, and writes the
  `contract:` block into the binding without touching its other lines. `--rerecord <id>` replaces
  an existing contract's fingerprint, shape and `verifiedAt`. Every request and every write is a
  y/N a person answers: there is no `--yes`, and with stdin closed it sends and writes nothing.
  `write` and `irreversible` capabilities are never recorded, and `sql` bindings are left to
  `archstone init --probe`.
