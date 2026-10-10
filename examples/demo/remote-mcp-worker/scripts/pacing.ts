// Pacing for the live battery against the hosted demo. The hosted demo sits behind a per-IP rate
// limit at the network edge (POSTs only), which answers 429 before the Worker runs. The battery
// therefore (1) keeps its POSTs under a rolling-window budget and (2) tells an edge 429 apart from
// the Worker's own answers, so an edge 429 can never be mistaken for a pass.
import type { Check, Send } from "./battery";

export const POST_BUDGET = 15; // stay well below the per-IP edge limit
export const WINDOW_MS = 10_000;
export const DEFAULT_RETRY_MS = 11_000;

export interface Clock {
  now(): number;
  sleep(ms: number): Promise<void>;
}

export const realClock: Clock = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

// Every response the Worker produces on /mcp and /run carries x-showcase-* headers; the edge 429
// does not. (The Worker itself never answers 429: its own rate-limit refusal is a 200 with
// rate_limit_exceeded in the body.)
export function isEdge429(res: Response): boolean {
  if (res.status !== 429) return false;
  for (const name of res.headers.keys()) if (name.startsWith("x-showcase-")) return false;
  return true;
}

export interface Paced {
  send: Send;
  /** Checks to append after the battery: fails if any request stayed an edge 429 after the retry. */
  finalChecks(): Check[];
}

export function paced(inner: Send, clock: Clock = realClock, log: (m: string) => void = console.error): Paced {
  const sent: number[] = []; // timestamps of POSTs inside the rolling window
  let unresolved = 0;

  async function throttle(): Promise<void> {
    for (;;) {
      const now = clock.now();
      while (sent.length > 0 && now - sent[0] >= WINDOW_MS) sent.shift();
      if (sent.length < POST_BUDGET) {
        sent.push(now);
        return;
      }
      await clock.sleep(sent[0] + WINDOW_MS - now);
    }
  }

  const send: Send = async (path, init) => {
    const isPost = (init?.method ?? "GET").toUpperCase() === "POST";
    if (!isPost) return inner(path, init);
    await throttle();
    const first = await inner(path, init);
    if (!isEdge429(first)) return first;
    const retryAfter = Number(first.headers.get("retry-after"));
    const waitMs = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : DEFAULT_RETRY_MS;
    log(`EDGE 429 (no x-showcase-* headers; not the Worker) on POST ${path}: waiting ${waitMs / 1000}s, retrying once`);
    await clock.sleep(waitMs);
    await throttle();
    const second = await inner(path, init);
    if (isEdge429(second)) {
      unresolved++;
      log(`EDGE 429 again on POST ${path}: this run FAILS`);
    }
    return second;
  };

  return {
    send,
    finalChecks: () => [
      {
        name: "no request was left answered by an edge 429 after one retry",
        ok: unresolved === 0,
        ...(unresolved === 0 ? {} : { detail: `${unresolved} request(s)` }),
      },
    ],
  };
}
