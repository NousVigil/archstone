import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { FetchLike } from "@archstone/provider-rest";
import { REASON_CODES, emit, openApiAdapter, type DecisionRecord, type SourceInput } from "@archstone/init";
import { runInit } from "@archstone/init/loop";
import { reportingDraft } from "./pg-catalog";

// ADD-37 §6 step 8 — ONE TEST PER NON-EMISSION, asserting the key is ABSENT.
//
// These exist because a convention would not survive. Each of the four is a thing a careful
// generator would plausibly do, each one is ship-stopping in THIS codebase for a reason that
// is not visible from the emitter, and each would be re-added by a contributor who does not
// know the coupling. A comment saying "don't" is not a control; a failing test is.
//
// Asserted over the WHOLE emitted file set, on BOTH the un-probed and the probed path — the
// probed path is the one that writes a `contract:` legitimately, and is therefore the one
// where a forbidden key is most likely to be smuggled in beside it.

const here = dirname(fileURLToPath(import.meta.url));
const FIXTURES = resolve(here, "fixtures/openapi");

function loadSpec(primary = "catalog.yaml"): SourceInput {
  const input: SourceInput = { origin: primary, document: readFileSync(join(FIXTURES, primary), "utf8"), documents: {} };
  const unreadable = new Set<string>();
  for (let i = 0; i < 8; i += 1) {
    const wanted = openApiAdapter.references!(input).filter((k) => input.documents![k] === undefined && !unreadable.has(k));
    if (wanted.length === 0) break;
    for (const key of wanted) {
      try {
        input.documents![key] = readFileSync(join(FIXTURES, key), "utf8");
      } catch {
        unreadable.add(key);
      }
    }
  }
  return input;
}

const spec = openApiAdapter.adapt(loadSpec());
const quirks = openApiAdapter.adapt(loadSpec("quirks.yaml"));
const rowErrors = openApiAdapter.adapt(loadSpec("row-errors.yaml"));

const specDecisions: DecisionRecord = {
  version: "0",
  company: { id: "acme", name: "Acme Parts" },
  provider: "acme-api",
  decisions: [
    { operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read", responseLocus: "$.items[*]" },
    { operation: "GET /api/v2/parts/{id}/price", keep: true, capabilityId: "catalog.estimate-part-price", effect: "read" },
    // The bearer-protected one, so the auth path is in scope: it is the operation whose
    // header a contributor would most plausibly write as `${caller.accessToken}`.
    { operation: "GET /api/v2/admin/parts", keep: true, capabilityId: "catalog.admin-list-parts", effect: "read", responseLocus: "$.items[*]" },
  ],
};

/** Every emitted file, on the path that does NOT probe. */
const unprobed = emit(spec, specDecisions).files;

function forEachFile(files: ReadonlyMap<string, string>, assert: (path: string, content: string) => void): void {
  expect(files.size).toBeGreaterThan(0);
  for (const [path, content] of files) assert(path, content);
}

describe("Challenge 2, item 1 — never `lifecycle:`", () => {
  it("is absent from every emitted file", () => {
    // ADD-24's `lifecycleExposure()` HIDES `experimental` from `tools/list` (invocable by id
    // only). A generator writing `lifecycle: experimental` as honest caution would make a
    // developer's first `archstone serve` after `init` show an EMPTY TOOL LIST — and they
    // would have no reason to suspect the manifest. Absent = `stable`, which is what a
    // freshly-scaffolded capability actually is.
    forEachFile(unprobed, (path, content) => expect(content, path).not.toMatch(/^\s*lifecycle:/m));
  });
});

describe("Challenge 2, item 2 — never `policies:`", () => {
  it("is absent from every emitted file, even for a bearer-protected operation", () => {
    // Since #43, `evaluatePolicy` gates `callTool`, `executeCapability` AND `verifyTool`, and
    // neither `archstone serve` (stdio) nor `archstone verify` has a caller-injection surface.
    // `policies: [authenticated]` on a spec that declares a security scheme would compile,
    // pass `apply`, and then fail EVERY probe and EVERY CLI invocation.
    forEachFile(unprobed, (path, content) => expect(content, path).not.toMatch(/^\s*policies:/m));
  });

  it("auth is surfaced instead as a connector header with an `${ENV}` placeholder", () => {
    // The non-emission is only half the rule; the other half is that the fact does not vanish.
    expect(unprobed.get("bindings/catalog.admin-list-parts.binding.yaml")).toMatch(/Authorization: "Bearer \$\{ACME_API_TOKEN\}"/);
  });
});

describe("Challenge 2, item 3 — never a `contract:` without a recorded fixture", () => {
  it("is absent from every emitted file when no probe ran", () => {
    // `contract.schema.json` requires `source: const "recorded"`, `fingerprint` and
    // `probe.fixture`; a fingerprint cannot exist without a real response. The block is
    // all-or-nothing and its absence is schema-legal — so nobody may add a "placeholder
    // fingerprint", which would make `archstone verify` green against a fiction.
    forEachFile(unprobed, (path, content) => {
      expect(content, path).not.toMatch(/^\s*contract:/m);
      expect(content, path).not.toMatch(/fingerprint/);
    });
    expect([...unprobed.keys()].some((k) => k.startsWith("fixtures/"))).toBe(false);
  });

  it("says so out loud, per capability, rather than leaving it as an omission", () => {
    const emitted = emit(spec, specDecisions);
    const unprobedIds = emitted.notes.filter((n) => n.code === "contract-not-recorded").map((n) => n.target);
    expect(unprobedIds).toEqual(expect.arrayContaining(["catalog.list-parts", "catalog.estimate-part-price"]));
  });
});

describe("Challenge 2, item 4 — never `${caller.…}` (Amendment 1 §A-5)", () => {
  it("no emitted file anywhere contains a caller placeholder", () => {
    // The OTHER plausible auth default, and the one a contributor is most likely to copy —
    // because the shipped `bank` manifest uses it. `invokeRest` returns
    // `missing caller credential(s)` when a `${caller.…}` placeholder has none, and the CLI
    // supplies no caller: it fails every `archstone serve` (stdio) and every
    // `archstone verify`. Identical failure to `policies: [authenticated]`, reached from a
    // different direction. `bank` is not a counter-example — it is an HTTP-transport manifest,
    // and `createHttpHandler` is the one surface that does supply a caller.
    forEachFile(unprobed, (path, content) => expect(content, path).not.toMatch(/\$\{caller\./));
  });
});

describe("all four, on the PROBED path — where a `contract:` is legitimate", () => {
  it("a recorded contract appears, and none of the four forbidden keys comes with it", async () => {
    const ws = mkdtempSync(join(tmpdir(), "archstone-non-emission-"));
    const target = join(ws, "out");
    const body = { items: [{ id: "AC45", name: "Bracket", description: null, material: "steel", widthMm: 40, finish: "matte", pricePerUnit: 12.5, profileType: "flat", webThicknessMm: 2, photos: [] }], total: 1, page: 1, limit: 20 };
    const fetchImpl: FetchLike = async () => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });

    const result = await runInit(
      spec,
      {
        ...specDecisions,
        decisions: [{ operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.list-parts", effect: "read", probe: true, responseLocus: "$.items[*]" }],
      },
      { targetDir: target, probe: true, interactive: false, invoke: { env: { ACME_API_URL: "https://api.acme.test" }, fetchImpl } },
    );

    expect(result.ok, JSON.stringify(result.failures)).toBe(true);
    const binding = readFileSync(join(target, "bindings/catalog.list-parts.binding.yaml"), "utf8");
    expect(binding).toMatch(/^\s*contract:/m);
    expect(binding).toMatch(/source: recorded/);

    for (const file of readdirSync(target, { recursive: true, withFileTypes: true })) {
      if (!file.isFile() || !file.name.endsWith(".yaml")) continue;
      const content = readFileSync(join(file.parentPath ?? target, file.name), "utf8");
      expect(content, file.name).not.toMatch(/^\s*lifecycle:/m);
      expect(content, file.name).not.toMatch(/^\s*policies:/m);
      expect(content, file.name).not.toMatch(/^\s*failures:/m);
      expect(content, file.name).not.toMatch(/\$\{caller\./);
    }
    rmSync(ws, { recursive: true, force: true });
  });
});

describe("`failures:` is not emitted either", () => {
  it("even though the source declares 4xx/5xx responses, and says so in the report", () => {
    // A 404's BUSINESS meaning is not derivable, and `failures:` keys must match
    // `^[a-z][a-z0-9-]*$` — they would be invented prose. Reported as an unmapped affordance
    // instead, which is where scope creep would otherwise enter (R-6).
    forEachFile(unprobed, (path, content) => expect(content, path).not.toMatch(/^\s*failures:/m));
    expect(emit(spec, specDecisions).notes.some((n) => n.code === "failures-not-emitted")).toBe(true);
  });
});

describe("§A-5 step 8 (ii) — an enum carrying `null` emits `values` without it", () => {
  it("and the file passes the loop's own shape validation", () => {
    // `cdl.schema.json` declares `values.items: {type: string}` with `minItems: 1`. A `null`
    // there makes the emitted file shape-invalid, the loop's compile check fails, D-7 refuses,
    // and the run writes NOTHING — loud rather than silent, but it costs the whole run for one
    // enum. Asserted on the emitted bytes so a regression is legible, not just red.
    const resource = [...unprobed].find(([k]) => k.endsWith("PartListItem.resource.yaml"))![1];
    // `PartFinish` is the nullable enum; `PartMaterial` is the non-nullable one beside it, and
    // both must be intact — the null is dropped from `values`, not the whole set.
    const valueLines = resource.split("\n").filter((l) => l.includes("values:")).map((l) => l.trim());
    expect(valueLines).toContain("values: [matte, brushed, anodised]");
    expect(valueLines).toContain("values: [steel, aluminium, composite]");
    for (const line of valueLines) expect(line).not.toContain("null");
  });
});

describe("D-7 — refuse, never half-emit", () => {
  it("an empty confirmed set writes zero files, because `capabilities: []` is shape-invalid", () => {
    // §4 caveat 1: `capabilities.schema.json` sets `minItems: 1` on BOTH `capabilities` and
    // `providers`. Refusing here means the invariant is discovered by design rather than by a
    // developer whose generated manifest does not load.
    const nothing = emit(spec, { ...specDecisions, decisions: spec.operations.map((o) => ({ operation: o.key, keep: false as const })) });
    expect(nothing.files.size).toBe(0);
    expect(nothing.notes.some((n) => n.code === "empty-confirmed-set")).toBe(true);
  });

  it("an empty confirmed set leaves the target directory untouched, through the whole loop", async () => {
    // The refusal has to survive the ORCHESTRATION, not just the emitter: `runInit` must treat
    // an empty file map as a refusal and never reach `commitFileSet`. A caller that read
    // "wrote zero files" as "carry on" would create the directory and leave the developer
    // wondering what happened.
    const ws = mkdtempSync(join(tmpdir(), "archstone-non-emission-refuse-"));
    const target = join(ws, "out");
    const result = await runInit(
      spec,
      { ...specDecisions, decisions: spec.operations.map((o) => ({ operation: o.key, keep: false as const })) },
      { targetDir: target, interactive: false },
    );
    expect(result.ok).toBe(false);
    expect(result.written).toEqual([]);
    expect(readdirSync(ws)).toEqual([]);
    rmSync(ws, { recursive: true, force: true });
  });
});

// A negative control for the whole file: if `emit` ever stopped producing files, every
// `not.toMatch` above would pass vacuously.
describe("the assertions above are not vacuous", () => {
  it("the emitted set is non-empty and contains the shapes being checked", () => {
    expect([...unprobed.keys()].sort()).toEqual([
      "bindings/catalog.admin-list-parts.binding.yaml",
      "bindings/catalog.estimate-part-price.binding.yaml",
      "bindings/catalog.list-parts.binding.yaml",
      "capabilities.yaml",
      "catalog.PartListItem.resource.yaml",
      "catalog.PriceEstimate.resource.yaml",
      "catalog.admin-list-parts.capability.yaml",
      "catalog.estimate-part-price.capability.yaml",
      "catalog.list-parts.capability.yaml",
    ]);
  });
});


// ---------------------------------------------------------------------------------------
// The systemic gap the review found: every code that CLAIMS to skip an operation must be
// shown to withhold the FILES, not merely to raise a note.
//
// A note is an observation; `skipsOperation: true` is a promise about the file system. The
// suite tested the first and inferred the second, which is exactly the shape of assumption
// that lets a "skipped" candidate quietly emit a capability nobody confirmed.
// ---------------------------------------------------------------------------------------

/** Files an emit produced that belong to a given capability id, by the emitter's own naming. */
function filesFor(files: ReadonlyMap<string, string>, capabilityId: string): string[] {
  return [...files.keys()].filter((p) => p.includes(capabilityId));
}

describe("every `skipsOperation: true` code withholds FILES, not just raises a note", () => {
  it("the closed enum is fully partitioned by these tests — no skipping code is unexercised", () => {
    // A roll-call, so that adding a member to the enum without a negative test fails HERE
    // rather than silently widening the set of things that can claim to skip without proof.
    const skipping = Object.entries(REASON_CODES)
      .filter(([, v]) => v.skipsOperation)
      .map(([k]) => k)
      .sort();
    expect(skipping).toEqual(
      [
        "ambiguous-collection",
        "capability-id-conflict",
        "capability-id-invalid",
        "company-id-not-derivable",
        "declined",
        "empty-confirmed-set",
        "no-expressible-columns",
        "oneof-error-fields-unresolved",
        "oneof-no-discriminator",
        "oneof-non-object-branch",
        "oneof-outside-collection",
        "oneof-too-many-branches",
        "resource-name-conflict",
        "resource-name-not-derivable",
        "unknown-candidate",
        "unknown-lookup-column",
        "unsupported-composition",
        "unsupported-connector",
        "unsupported-free-form-map",
        "unsupported-media-type",
        "unsupported-operation-shape",
        "unsupported-parameter-location",
        "unsupported-ref",
        "unsupported-security-scheme",
      ].sort(),
    );
  });

  const cases: { code: string; make: () => ReturnType<typeof emit>; capabilityId: string }[] = [
    {
      code: "declined",
      capabilityId: "catalog.list-parts",
      make: () => emit(spec, { ...specDecisions, decisions: [{ operation: "GET /api/v2/parts", keep: false }] }),
    },
    {
      code: "unknown-candidate",
      capabilityId: "catalog.list-parts",
      make: () =>
        emit(spec, {
          ...specDecisions,
          decisions: [{ operation: "GET /nope", keep: true, capabilityId: "catalog.list-parts", effect: "read", responseLocus: "$.items[*]" }],
        }),
    },
    {
      code: "capability-id-invalid",
      capabilityId: "NotAnId",
      make: () => emit(spec, { ...specDecisions, decisions: [{ operation: "GET /api/v2/parts", keep: true, capabilityId: "NotAnId", effect: "read", responseLocus: "$.items[*]" }] }),
    },

    {
      code: "unsupported-composition",
      capabilityId: "catalog.discriminated",
      make: () => emit(quirks, { ...specDecisions, decisions: [{ operation: "GET /api/v2/discriminated", keep: true, capabilityId: "catalog.discriminated", effect: "read" }] }),
    },
    // ADD-12 §8.1: every two-branch `oneOf` that is not the ratified `oneOf[success, error]`
    // form, and that form anywhere but a mapped collection's items (see row-errors.test.ts).
    {
      code: "oneof-no-discriminator",
      capabilityId: "catalog.poly",
      make: () => emit(quirks, { ...specDecisions, decisions: [{ operation: "GET /api/v2/polymorphic", keep: true, capabilityId: "catalog.poly", effect: "read" }] }),
    },
    {
      code: "oneof-too-many-branches",
      capabilityId: "pricing.too-many",
      make: () => emit(rowErrors, { ...specDecisions, decisions: [{ operation: "GET /v1/too-many", keep: true, capabilityId: "pricing.too-many", effect: "read" }] }),
    },
    {
      code: "oneof-non-object-branch",
      capabilityId: "pricing.scalar-branch",
      make: () => emit(rowErrors, { ...specDecisions, decisions: [{ operation: "GET /v1/scalar-branch", keep: true, capabilityId: "pricing.scalar-branch", effect: "read" }] }),
    },
    {
      code: "oneof-error-fields-unresolved",
      capabilityId: "pricing.message-ambiguous",
      make: () =>
        emit(rowErrors, { ...specDecisions, decisions: [{ operation: "GET /v1/message-ambiguous", keep: true, capabilityId: "pricing.message-ambiguous", effect: "read" }] }),
    },
    {
      code: "oneof-outside-collection",
      capabilityId: "pricing.page-prices",
      make: () =>
        emit(rowErrors, {
          ...specDecisions,
          decisions: [
            { operation: "GET /v1/paged-prices", keep: true, capabilityId: "pricing.page-prices", effect: "read", responseLocus: "root" },
            // Something else must survive, or the run refuses as a whole (D-7) and the table
            // would be measuring `empty-confirmed-set` instead.
            { operation: "GET /v1/quotes", keep: true, capabilityId: "pricing.list-quotes", effect: "read" },
          ],
        }),
    },
    {
      code: "unsupported-security-scheme",
      capabilityId: "catalog.query-key",
      make: () => emit(quirks, { ...specDecisions, decisions: [{ operation: "GET /api/v2/query-key", keep: true, capabilityId: "catalog.query-key", effect: "read" }] }),
    },
    {
      code: "unsupported-parameter-location",
      capabilityId: "catalog.header-param",
      make: () =>
        emit(quirks, { ...specDecisions, decisions: [{ operation: "GET /api/v2/header-param", keep: true, capabilityId: "catalog.header-param", effect: "read" }] }),
    },
    // ADR-0012 D-10 — the database adapter's two skipping codes. A surviving list capability keeps
    // the run from refusing as a whole (D-7), so the table measures the code and not `empty-confirmed-set`.
    {
      code: "no-expressible-columns",
      capabilityId: "reporting.blobs",
      make: () =>
        emit(reportingDraft(), {
          ...specDecisions,
          decisions: [
            { operation: "SELECT app.blobs", keep: true, capabilityId: "reporting.blobs", effect: "read" },
            { operation: "SELECT app.accounts", keep: true, capabilityId: "reporting.list-accounts", effect: "read", resourceName: "Account" },
          ],
        }),
    },
    {
      code: "unknown-lookup-column",
      capabilityId: "reporting.get-position",
      make: () =>
        emit(reportingDraft(), {
          ...specDecisions,
          decisions: [
            { operation: "SELECT app.positions_v", keep: true, capabilityId: "reporting.get-position", effect: "read", lookupColumn: "nope", resourceName: "Position" },
            { operation: "SELECT app.accounts", keep: true, capabilityId: "reporting.list-accounts", effect: "read", resourceName: "Account" },
          ],
        }),
    },
  ];

  for (const { code, make, capabilityId } of cases) {
    it(`${code}: the candidate contributes no capability file, no binding and no resource`, () => {
      const result = make();
      expect(filesFor(result.files, capabilityId), `${code} emitted files for a skipped candidate`).toEqual([]);
      expect(result.capabilities.map((c) => c.capabilityId)).not.toContain(capabilityId);
      // And the files were withheld FOR THIS REASON — a case whose fixture stopped raising its
      // code would otherwise keep passing on some other refusal.
      expect(result.notes.map((n) => n.code), `${code} was not raised`).toContain(code);
    });
  }

  it("capability-id-conflict: the SECOND claimant contributes nothing, and the first is untouched", () => {
    // Checked separately from the table because the first claimant legitimately DOES emit
    // files under that id — the promise is about the loser of the conflict, not the name.
    const result = emit(spec, {
      ...specDecisions,
      decisions: [
        { operation: "GET /api/v2/parts", keep: true, capabilityId: "catalog.dupe", effect: "read", responseLocus: "$.items[*]" },
        { operation: "GET /api/v2/parts/{id}", keep: true, capabilityId: "catalog.dupe", effect: "read" },
      ],
    });
    expect(result.capabilities).toHaveLength(1);
    expect(result.capabilities[0]!.operation).toBe("GET /api/v2/parts");
    expect(result.skipped.map((s) => s.code)).toContain("capability-id-conflict");
    // One capability file, one binding — not two of either.
    expect(filesFor(result.files, "catalog.dupe")).toHaveLength(2);
  });

  it("a skipped candidate that is the ONLY candidate refuses the whole run (D-7)", () => {
    // The composition of the two rules: withholding a candidate's files must not leave a
    // `capabilities: []` manifest behind, which is shape-invalid and would fail its own
    // compile check.
    const only = emit(quirks, { ...specDecisions, decisions: [{ operation: "GET /api/v2/polymorphic", keep: true, capabilityId: "catalog.poly", effect: "read" }] });
    expect(only.files.size).toBe(0);
    expect(only.notes.some((n) => n.code === "empty-confirmed-set")).toBe(true);
  });
});
