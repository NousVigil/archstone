- **List items of origin-bound types are withheld per-item instead of all-or-nothing.** A
  `list: web-page` is still refused by the schema (unchanged), but the infrastructure for
  `list:` of origin-bound types now withholds items individually: off-origin items are dropped,
  item positions are named by 0-based index in `withheld` (e.g. `photos[2]`), other items keep
  their order, and the result is DEGRADED if any items were withheld (even if the list is
  required; an empty list is present, not omitted). Non-origin lists (`list: string`, etc.)
  remain all-or-nothing. The shared response mapper in `@archstone/emitter-support`
  (`applyResponseMapping`) and `@archstone/agent`'s `ExecuteResult` inherit this for all future
  origin-bound types, starting with `image`.
