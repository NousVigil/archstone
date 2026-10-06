import { describe, it, expect } from "vitest";
import { terminalSafe, MAX_PRINTED_NAME } from "../src/terminal-safe";

describe("terminalSafe — a provider-chosen key name on the operator's terminal (#146)", () => {
  it("leaves an ordinary dotted name alone", () => {
    expect(terminalSafe("host.internalNote")).toBe("host.internalNote");
    expect(terminalSafe("gäste.zimmer")).toBe("gäste.zimmer");
  });

  it("strips ANSI CSI and OSC sequences (colour, cursor moves, title, hyperlink)", () => {
    expect(terminalSafe("host.\u001b[31mred\u001b[0m")).toBe("host.red");
    expect(terminalSafe("host.\u001b[2K\u001b[1Ax")).toBe("host.x");
    expect(terminalSafe("host.\u001b]0;pwned\u0007x")).toBe("host.x");
    expect(terminalSafe("host.\u001b]8;;https://evil.example\u001b\\link\u001b]8;;\u001b\\")).toBe("host.link");
  });

  it("strips C0 and C1 controls and bidi overrides", () => {
    expect(terminalSafe("host.a\rb\nc\u0000d\u0007e")).toBe("host.abcde");
    expect(terminalSafe("host.\u009b31mx\u0085y")).toBe("host.31mxy");
    expect(terminalSafe("host.‮gnp.exe")).toBe("host.gnp.exe");
  });

  it("truncates a long name to the cap, ending in …", () => {
    const out = terminalSafe(`host.${"a".repeat(500)}`);
    expect([...out]).toHaveLength(MAX_PRINTED_NAME);
    expect(out.endsWith("…")).toBe(true);
    expect(terminalSafe("x".repeat(MAX_PRINTED_NAME))).toBe("x".repeat(MAX_PRINTED_NAME));
  });
});
