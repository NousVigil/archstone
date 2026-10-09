// What a client is given to call (AC-2.16, AC-2.3, AC-2.10): the exposed tool list over a real MCP
// client, its annotations, and the absence of anything for deletion or for the over-exposed fields.

import { describe, it, expect } from "vitest";
import { toolDefinitions } from "@archstone/runtime";
import { FORBIDDEN_FIELDS, installGlobalInvariants, registry, session } from "./negatives-support";

// Listing tools never touches the agency; the invariants still hold over whatever is requested.
installGlobalInvariants({ expectTraffic: false });

const EXPECTED_TOOLS = [
  "tourism_search",
  "wanderlust_availability",
  "wanderlust_book",
  "wanderlust_cancel",
  "wanderlust_pay",
  "wanderlust_quote",
  "wanderlust_room-status",
  "wanderlust_search",
  "wanderlust_stay-details",
  "wanderlust_stay-page",
  "wanderlust_stay-photos",
];

describe("AC-2.16: the exposed tool list has no deletion tool", () => {
  it("lists exactly the eleven callable tools to a real client; none is for deletion", async () => {
    await session().withClient("none", async (client) => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
      expect(tools.filter((t) => /delet|remov|eras|destroy|purge|drop|wipe/i.test(`${t.name} ${t.description ?? ""}`)).map((t) => t.name)).toEqual([]);
    });
  });

  it("the list is the same for a client holding a key: a credential adds no tool", async () => {
    for (const key of ["A", "B"] as const) {
      await session().withClient(key, async (client) => {
        expect((await client.listTools()).tools.map((t) => t.name).sort()).toEqual(EXPECTED_TOOLS);
      });
    }
  });

  it("no capability is bound to a DELETE, so no tool can reach the backend's delete endpoint", () => {
    const methods = registry().ir.tools.map((t) => t.connector?.rest?.method);
    expect(methods).not.toContain("DELETE");
    expect(registry().ir.tools.map((t) => t.connector?.rest?.path).filter((p) => /guests/.test(p ?? ""))).toEqual([]);
  });

  it("neither the experimental nor the retired capability is listed", () => {
    const names = toolDefinitions(registry()).map((d) => d.name);
    expect(names).not.toContain("wanderlust_neighbourhood");
    expect(names).not.toContain("tourism_search-classic");
  });

  it("a client that calls a tool named for deletion is answered unknown tool; nothing reaches the agency", async () => {
    const s = session();
    await s.withClient("A", async (client) => {
      for (const name of ["wanderlust_delete-booking", "wanderlust_delete-guest-bookings"]) {
        const result = await client.callTool({ name, arguments: { name: "Ana Pop" } }).catch((e: Error) => e);
        const text = result instanceof Error ? result.message : JSON.stringify(result);
        expect(text, name).toMatch(/unknown tool/i);
      }
    });
    expect(s.spy.requests).toEqual([]);
  });
});

describe("AC-2.3 / AC-2.2: no advertised output schema names an over-exposed field", () => {
  it("over the wire, no tool's outputSchema or input schema names any of them", async () => {
    await session().withClient("none", async (client) => {
      const { tools } = await client.listTools();
      for (const t of tools) {
        const schema = JSON.stringify({ input: t.inputSchema, output: t.outputSchema });
        for (const field of FORBIDDEN_FIELDS) expect(schema, `${t.name}: ${field}`).not.toMatch(new RegExp(`"${field}"`, "i"));
      }
    });
  });
});

describe("AC-2.10: effects are advertised as MCP annotations", () => {
  it("each tool carries the hint its effect implies, and the hints are the whole of what is claimed", async () => {
    await session().withClient("none", async (client) => {
      const byName = new Map((await client.listTools()).tools.map((t) => [t.name, t.annotations]));
      for (const read of ["wanderlust_search", "wanderlust_stay-details", "wanderlust_stay-photos", "wanderlust_stay-page", "wanderlust_availability", "wanderlust_room-status", "tourism_search"]) {
        expect(byName.get(read), read).toEqual({ readOnlyHint: true });
      }
      for (const write of ["wanderlust_quote", "wanderlust_book"]) expect(byName.get(write), write).toEqual({ destructiveHint: false });
      for (const irreversible of ["wanderlust_cancel", "wanderlust_pay"]) {
        expect(byName.get(irreversible), irreversible).toEqual({ destructiveHint: true, idempotentHint: false });
      }
    });
  });

  it("no tool description says Archstone pauses or approves anything", () => {
    for (const d of toolDefinitions(registry())) {
      expect(d.description, d.name).not.toMatch(/archstone[^.]{0,60}(pauses|asks|waits|approves)/i);
    }
    const cancel = toolDefinitions(registry()).find((d) => d.name === "wanderlust_cancel")!;
    expect(cancel.description).toMatch(/does not enforce that/);
  });
});
