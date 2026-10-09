// A small Node `http` wrapper that serves the SAME handler the tests and a Workers runtime use.
//
//   node examples/showcase/api/serve.mjs            # listens on :8788 (PORT to change it)
//   SHOWCASE_NOW=2027-05-01T10:07:00Z node ...      # pin the clock (quotes expire per 15 minutes)
//
// Point a manifest at it with SHOWCASE_API_URL=http://localhost:8788.
/* global Request, Buffer */
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";
import { handle } from "./wanderlust-api.mjs";

/**
 * @param {{ port?: number, now?: number | (() => number), imageBase?: string }} [options]
 * @returns {import("node:http").Server}
 */
export function createApiServer(options = {}) {
  return createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const method = req.method ?? "GET";
      const hasBody = method !== "GET" && method !== "HEAD";
      let request;
      try {
        request = new Request(`http://${req.headers.host ?? "localhost"}${req.url ?? "/"}`, {
          method,
          headers: Object.fromEntries(Object.entries(req.headers).filter(([, v]) => typeof v === "string")),
          body: hasBody ? Buffer.concat(chunks) : undefined,
        });
      } catch {
        // A malformed Host or request target: refuse this request, keep the server up.
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "bad_request", message: "Malformed request." }));
        return;
      }
      handle(request, { now: options.now, imageBase: options.imageBase })
        .then(async (response) => {
          res.writeHead(response.status, Object.fromEntries(response.headers));
          res.end(Buffer.from(await response.arrayBuffer()));
        })
        .catch(() => {
          res.writeHead(500, { "content-type": "application/json" });
          res.end(JSON.stringify({ error: "internal" }));
        });
    });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const port = Number(process.env.PORT ?? 8788);
  const pinned = process.env.SHOWCASE_NOW ? Date.parse(process.env.SHOWCASE_NOW) : undefined;
  createApiServer({ now: pinned }).listen(port, () =>
    console.error(`Wanderlust Agency (synthetic) on http://localhost:${port}`),
  );
}
