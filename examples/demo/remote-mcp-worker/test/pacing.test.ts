import { describe, expect, it } from "vitest";
import { paced, type Clock } from "../scripts/pacing";

function fakeClock(): Clock & { t: number } {
  const c = { t: 0, now: () => c.t, sleep: async (ms: number) => void (c.t += ms) };
  return c;
}
const post = { method: "POST" };

describe("battery pacing", () => {
  it("keeps POSTs at or below 15 per rolling 10 s, leaves GETs alone", async () => {
    const clock = fakeClock();
    const times: number[] = [];
    const p = paced(async (_p, init) => {
      if (init?.method === "POST") times.push(clock.t);
      return new Response("{}");
    }, clock, () => {});
    for (let i = 0; i < 40; i++) await p.send("/x", post);
    for (let i = 0; i < 50; i++) await p.send("/x");
    for (let i = 0; i < times.length; i++) {
      expect(times.filter((t) => t > times[i] - 10_000 && t <= times[i]).length).toBeLessThanOrEqual(15);
    }
    expect(clock.t).toBeGreaterThanOrEqual(20_000);
  });

  it("retries an edge 429 once after Retry-After and passes if the retry succeeds", async () => {
    const clock = fakeClock();
    let n = 0;
    const p = paced(async () => (n++ === 0 ? new Response("", { status: 429, headers: { "retry-after": "7" } }) : new Response("{}")), clock, () => {});
    expect((await p.send("/x", post)).status).toBe(200);
    expect(clock.t).toBe(7000);
    expect(p.finalChecks()[0].ok).toBe(true);
  });

  it("fails the run when the retry is still an edge 429 (default wait 11 s)", async () => {
    const clock = fakeClock();
    const p = paced(async () => new Response("", { status: 429 }), clock, () => {});
    await p.send("/x", post);
    expect(clock.t).toBe(11_000);
    expect(p.finalChecks()[0].ok).toBe(false);
  });

  it("does not treat a 429 carrying Worker headers as the edge", async () => {
    const clock = fakeClock();
    let n = 0;
    const p = paced(async () => (n++, new Response("", { status: 429, headers: { "x-showcase-rate-limit": "approximate" } })), clock, () => {});
    expect((await p.send("/x", post)).status).toBe(429);
    expect(n).toBe(1);
    expect(p.finalChecks()[0].ok).toBe(true);
  });
});
