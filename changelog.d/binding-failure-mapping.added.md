- **A binding can map a provider error to a declared failure token.** A REST binding's new
  `failures:` list maps a 4xx status, optionally narrowed by one JSONPath `body` test, to one of
  the capability's declared `failures` tokens; the first matching entry wins. A matched response
  reaches the model as `token: description` with
  `_meta["dev.archstone/business_failure"]`, and nothing from the response body or the status
  code is passed on; the audit message becomes the token. `@archstone/agent` `execute()` returns
  a new `status: "failure"` outcome with `failure` and `description` for it, so an exhaustive
  `switch` on `ExecuteResult.status` needs a new case. A 5xx and an unmapped status are
  unchanged. The compiler checks the mappings (`failure-mapping-*` and
  `bad-failure-mapping-path`), the IR carries them only when declared, so existing IR is
  byte-identical, and `archstone diff` reports a mapping change as breaking on a `write` or
  `irreversible` capability (RFC-0011).
