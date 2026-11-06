// RFC-0011 D-3/D-6/D-7: `matchFailure`, the one matcher the runtime and the agent share.

import { describe, it, expect } from "vitest";
import type { IRFailureMapping } from "@archstone/compiler";
import { matchFailure } from "../src/mapping";

const M: IRFailureMapping[] = [
  { status: 404, body: { path: "$.error.code", equals: "game_not_found" }, failure: "game-not-found", description: "No such game." },
  { status: 404, failure: "other-404", description: "Any other 404." },
  { status: 409, body: { path: "$.code", equals: 7 }, failure: "seven", description: "Seven." },
  { status: 409, body: { path: "$.flag", equals: true }, failure: "flagged", description: "Flagged." },
];

describe("matchFailure", () => {
  it("first match wins, in authored order", () => {
    expect(matchFailure(M, 404, { error: { code: "game_not_found" } })?.failure).toBe("game-not-found");
    expect(matchFailure(M, 404, { error: { code: "something_else" } })?.failure).toBe("other-404");
  });

  it("a body test compares a scalar with ===, type included", () => {
    expect(matchFailure(M, 409, { code: 7 })?.failure).toBe("seven");
    expect(matchFailure(M, 409, { code: "7" })).toBeUndefined();
    expect(matchFailure(M, 409, { flag: true })?.failure).toBe("flagged");
    expect(matchFailure(M, 409, { flag: "true" })).toBeUndefined();
  });

  it("a non-JSON body, a missing path or a non-scalar value is no match", () => {
    const bodyOnly = M.filter((m) => m.body);
    expect(matchFailure(bodyOnly, 404, "Not Found")).toBeUndefined(); // invokeRest's raw-text fallback
    expect(matchFailure(bodyOnly, 404, null)).toBeUndefined();
    expect(matchFailure(bodyOnly, 404, {})).toBeUndefined();
    expect(matchFailure(bodyOnly, 404, { error: { code: { nested: "game_not_found" } } })).toBeUndefined();
    expect(matchFailure(bodyOnly, 404, { error: { code: ["game_not_found"] } })).toBeUndefined();
  });

  it("a body-less entry matches any body, including non-JSON", () => {
    expect(matchFailure(M, 404, "<html>gone</html>")?.failure).toBe("other-404");
  });

  it("never matches a 2xx, a 5xx, status 0 or an unmapped 4xx", () => {
    const any: IRFailureMapping[] = [{ status: 500, failure: "x", description: "x" }, { status: 200, failure: "y", description: "y" }];
    expect(matchFailure(any, 500, {})).toBeUndefined();
    expect(matchFailure(any, 200, {})).toBeUndefined();
    expect(matchFailure(M, 0, {})).toBeUndefined();
    expect(matchFailure(M, 400, {})).toBeUndefined();
  });

  it("no mappings is no match", () => {
    expect(matchFailure(undefined, 404, {})).toBeUndefined();
    expect(matchFailure([], 404, {})).toBeUndefined();
  });
});
