// CORS for the browser path (`/run/...`) only. `/mcp` and the synthetic API carry no CORS headers.
export const DEFAULT_ORIGIN = "https://archstone.dev";

/** The default origin plus any extra ones from the `CORS_ORIGINS` var (comma separated; this is
 *  how `wrangler dev` allows a localhost page). Compared by exact string. */
export function allowedOrigins(extra: string | undefined): string[] {
  const more = (extra ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  return [DEFAULT_ORIGIN, ...more];
}

export const EXPOSED_HEADERS = "x-showcase-backend-calls, x-showcase-rate-limit";

/** Headers for a request from an allowed origin; `Vary: Origin` is always present so a cache never
 *  serves one origin's answer to another. */
export function corsHeaders(origin: string | null, allowed: string[]): Headers {
  const h = new Headers({ vary: "Origin" });
  if (origin !== null && allowed.includes(origin)) {
    h.set("access-control-allow-origin", origin);
    h.set("access-control-expose-headers", EXPOSED_HEADERS);
  }
  return h;
}
