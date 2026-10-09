- **A synthetic travel-agency example, `examples/showcase`.** An invented agency whose backend
  deliberately over-exposes (guest passports and phones at several nesting levels, a private margin,
  raw HTML, images and links on undeclared hosts, a DELETE endpoint), and the CDL manifests that
  contain it: all three effects, every lifecycle state, `authenticated` with `${caller.accessToken}`,
  a principal allow/deny rule, a rate limit, `onError` rows, nested projection, and the `image` and
  `web-page` types with declared origins. It ships a mis-declared payment variant that `archstone apply`
  warns about without blocking, a scenario table (`scenarios.json`), two public demo keys, and tests
  that run the real pipeline against the API in-process. Examples and tests only: no published package
  changes.
