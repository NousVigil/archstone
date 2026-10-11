// @archstone/init — the Decision Record (ADD-37 D-4).
//
// THE HUMAN GATE PRODUCES DATA, NEVER SIDE EFFECTS. The interactive layer (a terminal, in
// `cli`) asks the questions and writes one of these; a hosted flow (§9's forward constraint)
// supplies the identical structure from a web form and reuses this package verbatim. Nothing
// in this file knows what a terminal is.
//
// Consequence-bearing is asymmetric (product §2): the developer runs `init`, but the business
// bears the cost of a wrong `effect` months later, through an agent, in front of a customer.
// That is why `effect` lives here — confirmed, per capability — and not in the Draft Model.

import type { Effect } from "./model";

/**
 * One answered candidate.
 *
 * A DISCRIMINATED UNION, not an optional-field bag, and that is the whole point (D-3): on the
 * `keep: true` arm `effect` and `capabilityId` are REQUIRED, so there is no way to construct a
 * kept decision without a confirmed effect. "No `effect` without human confirmation" is
 * therefore enforced by the type system rather than by a runtime check that a later
 * non-interactive code path could route around.
 */
export type CapabilityDecision =
  | {
      /** The `DraftOperation.key` this answers. */
      operation: string;
      keep: false;
      /** Free text from the human, for the report only. */
      note?: string;
    }
  | {
      operation: string;
      keep: true;
      /** The full CDL id: `domain.action`. The domain half is a human judgement — no source
       *  construct carries it (§1's table). */
      capabilityId: string;
      /** CONFIRMED, never inferred. An adapter's `EffectHint` may have pre-filled the prompt;
       *  it can never reach this field on its own. */
      effect: Effect;
      /**
       * D-14 — WHICH part of the response this capability returns: `"root"`, or a collection
       * JSONPath (`"$.items[*]"`).
       *
       * Required iff the adapter found two or more candidate loci; absent otherwise, and
       * absent when there is nothing to choose. It cannot be made type-required, because the
       * obligation is conditional on the response's shape and a discriminated union cannot
       * express "required iff ≥2 candidates" — so the enforcement is a refusal
       * (`ambiguous-collection`, zero files), not the type system.
       *
       * Asked BEFORE `resourceName`: they are the same question at two altitudes, and the name
       * is unanswerable until the locus is fixed, because the name names the locus.
       */
      responseLocus?: string;
      /** The resource name for this capability's response, when D-9 step 3 could not derive
       *  one and asked. Domain-qualified or bare (`framing.FrameProfile` / `FrameProfile`). */
      resourceName?: string;
      /** Did the human consent to a live probe? Read by the probe leg (§6 step 6), never by
       *  the pure emitter — `init` opens no socket in steps 1–4. */
      probe?: boolean;
      /**
       * A SECOND, separate confirmation for probing a non-`GET`/`HEAD` method (R-8).
       *
       * `GET`-only is the wrong gate — `tourism.search` is a `POST /v1/search` with
       * `effect: read`, the canonical search shape — so the method rule is a second condition
       * ON TOP of the confirmed read, not a substitute for it. Non-interactive mode must
       * refuse a non-`GET`/`HEAD` probe outright: there is deliberately no flag that enables
       * one.
       */
      probeNonReadMethodConfirmed?: boolean;
      /** Business input for the probe — the fixture's `request` is capability input, not an
       *  HTTP request (§1.3), and a document usually cannot supply it. */
      sampleInput?: Record<string, unknown>;
      /**
       * A database candidate only (ADR-0012 D-10): make this capability a LOOKUP by the named
       * column. Absent, it is a list bounded by a literal `LIMIT 100`.
       *
       * The adapter proposes one candidate per relation and the human says what it does: a view has
       * no key the catalog can name, and which column identifies a row is an answer only a person
       * has. A name the candidate does not offer refuses that candidate (`unknown-lookup-column`).
       */
      lookupColumn?: string;
    };

/**
 * Everything the human decided, in one serializable object.
 *
 * Serializable on purpose: non-interactive mode (CI) accepts one of these as a file or refuses
 * to run at all — it never defaults an `effect` (product DoD-5(d)), and a file the human wrote
 * once is the only way that is possible.
 */
export interface DecisionRecord {
  version: "0";
  /** `company.id` must match `^[a-z][a-z0-9-]*$`; nothing derives it reliably from a source
   *  document, so the human supplies it (or the run is refused). */
  company: {
    id: string;
    name?: string;
    description?: string;
  };
  /** The provider identifier every emitted capability points at (`^[a-z][a-z0-9-]*$`).
   *  Defaults to `<company.id>-api` when absent (`-db` for a database source). */
  provider?: string;
  /** The environment variable the emitted `baseUrl` placeholder references. Defaults to
   *  `<COMPANY_ID>_API_URL`. Credentials never appear in an emitted file (product §5 rule 3). */
  baseUrlEnvVar?: string;
  /**
   * The environment variable the emitted auth header placeholder references. Defaults to
   * `<COMPANY_ID>_API_TOKEN`.
   *
   * Here rather than in the Draft Model (Amendment 1 §A-5 gap 4) for the same reason
   * `baseUrlEnvVar` is: no source construct names the variable a company's deployment happens
   * to use, so it is a human answer with a sane default, confirmable at the gate. The VALUE
   * never appears anywhere — only the variable's name, inside a `${…}` placeholder.
   */
  authEnvVar?: string;
  /**
   * A database source only (ADR-0012 D-10): the two principals the isolation test needs, named by
   * the human. Both must be keys of the `--identity-map` the run was given; `init` reads the map
   * and never copies it into the manifest.
   *
   * `principal` is the identity that owns the lookup's sample row; `negativePrincipal` is a
   * different one that must see none of it. A contract is recorded only when both resolve (D-8) —
   * otherwise the capability is emitted with no contract and the report says which part was missing.
   */
  identities?: { principal?: string; negativePrincipal?: string };
  decisions: CapabilityDecision[];
}

/** The kept decisions, in the order the human confirmed them. */
export function keptDecisions(record: DecisionRecord): Extract<CapabilityDecision, { keep: true }>[] {
  return record.decisions.filter((d): d is Extract<CapabilityDecision, { keep: true }> => d.keep);
}

/** The provider id an emitted manifest will declare: `<company>-api` for a REST source, `<company>-db`
 *  for a database. */
export function providerId(record: DecisionRecord, kind: "api" | "db" = "api"): string {
  return record.provider ?? `${record.company.id}-${kind}`;
}

/** The env var an emitted `baseUrl` placeholder will reference. */
export function baseUrlEnvVar(record: DecisionRecord): string {
  return record.baseUrlEnvVar ?? `${envPrefix(record)}_API_URL`;
}

/** The env var an emitted auth header placeholder will reference. */
export function authEnvVar(record: DecisionRecord): string {
  return record.authEnvVar ?? `${envPrefix(record)}_API_TOKEN`;
}

function envPrefix(record: DecisionRecord): string {
  return record.company.id.replace(/-/g, "_").toUpperCase();
}

// ---------------------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------------------

/**
 * Parse an untrusted value into a Decision Record, or say exactly what is wrong with it.
 *
 * WHY THIS EXISTS AT ALL, stated plainly because the omission was embarrassing: the Decision
 * Record is the ONE input `init` used to trust completely. Every other input — a spec
 * document, a backend response, a resource name — is shape-checked, refused with a named
 * reason, or fails closed. The record was `JSON.parse(...) as DecisionRecord`, an unchecked
 * cast, and a missing `company` produced a raw `TypeError: Cannot read properties of
 * undefined` with a stack trace.
 *
 * It matters most on the path where it is worst: `--non-interactive` is CI, where a stack
 * trace is the least actionable possible output, and where a human is not standing by to
 * re-read the docs.
 *
 * PURE and in this package rather than in `cli`, for the same reason `emit` and `formatReport`
 * are: a hosted flow (§9) accepts the identical structure from a web form and must get the
 * identical guarantees, not a second, laxer implementation of them.
 */
export type DecisionRecordValidation = { ok: true; record: DecisionRecord } | { ok: false; problems: string[] };

const EFFECTS = new Set<Effect>(["read", "write", "irreversible"]);
/** `capabilities.schema.json` — `company.id` and each `providers[]` entry. Duplicated from
 *  `names.ts` deliberately: `decisions.ts` must not depend on emission. */
const ID_RE = /^[a-z][a-z0-9-]*$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function validateDecisionRecord(value: unknown): DecisionRecordValidation {
  const problems: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ["the Decision Record must be a JSON object"] };

  if (value["version"] !== "0") problems.push(`version: expected "0", got ${JSON.stringify(value["version"])}`);

  const company = value["company"];
  if (!isRecord(company)) {
    problems.push("company: required — an object with an `id` (and optionally `name`, `description`)");
  } else {
    const id = company["id"];
    if (typeof id !== "string") problems.push("company.id: required — a lowercase kebab-case string");
    else if (!ID_RE.test(id)) problems.push(`company.id: '${id}' does not match ^[a-z][a-z0-9-]*$`);
    for (const key of ["name", "description"]) {
      if (company[key] !== undefined && typeof company[key] !== "string") problems.push(`company.${key}: must be a string when present`);
    }
  }

  for (const key of ["provider", "baseUrlEnvVar", "authEnvVar"]) {
    if (value[key] !== undefined && typeof value[key] !== "string") problems.push(`${key}: must be a string when present`);
  }
  if (typeof value["provider"] === "string" && !ID_RE.test(value["provider"])) {
    problems.push(`provider: '${value["provider"]}' does not match ^[a-z][a-z0-9-]*$`);
  }

  const identities = value["identities"];
  if (identities !== undefined) {
    if (!isRecord(identities)) {
      problems.push("identities: must be an object with `principal` and `negativePrincipal` when present");
    } else {
      for (const key of ["principal", "negativePrincipal"]) {
        const v = identities[key];
        if (v !== undefined && (typeof v !== "string" || v === "")) problems.push(`identities.${key}: must be a non-empty string when present`);
      }
      for (const key of Object.keys(identities)) {
        if (key !== "principal" && key !== "negativePrincipal") problems.push(`identities.${key}: unknown — expected \`principal\` and \`negativePrincipal\``);
      }
    }
  }

  const decisions = value["decisions"];
  if (!Array.isArray(decisions)) {
    problems.push("decisions: required — an array (possibly empty) of per-candidate answers");
    return { ok: false, problems };
  }

  decisions.forEach((entry, index) => {
    const at = `decisions[${index}]`;
    if (!isRecord(entry)) {
      problems.push(`${at}: must be an object`);
      return;
    }
    if (typeof entry["operation"] !== "string" || entry["operation"] === "") {
      problems.push(`${at}.operation: required — the candidate key, "<METHOD> <path>"`);
    }
    if (typeof entry["keep"] !== "boolean") {
      problems.push(`${at}.keep: required — true or false`);
      return;
    }
    if (entry["keep"] !== true) {
      if (entry["note"] !== undefined && typeof entry["note"] !== "string") problems.push(`${at}.note: must be a string when present`);
      return;
    }
    // The `keep: true` arm is where the type system does the work at compile time and can do
    // nothing at all for a file read at runtime — so every field the discriminated union makes
    // mandatory has to be checked by hand here, or the union's guarantee stops at the boundary.
    if (typeof entry["capabilityId"] !== "string" || entry["capabilityId"] === "") {
      problems.push(`${at}.capabilityId: required when keep is true — "domain.action"`);
    }
    if (typeof entry["effect"] !== "string" || !EFFECTS.has(entry["effect"] as Effect)) {
      problems.push(`${at}.effect: required when keep is true — one of read, write, irreversible. \`init\` never defaults this.`);
    }
    for (const key of ["resourceName", "responseLocus", "lookupColumn"]) {
      if (entry[key] !== undefined && typeof entry[key] !== "string") problems.push(`${at}.${key}: must be a string when present`);
    }
    if (entry["lookupColumn"] === "") problems.push(`${at}.lookupColumn: must not be empty — omit it for a bounded list`);
    for (const key of ["probe", "probeNonReadMethodConfirmed"]) {
      if (entry[key] !== undefined && typeof entry[key] !== "boolean") problems.push(`${at}.${key}: must be a boolean when present`);
    }
    if (entry["sampleInput"] !== undefined && !isRecord(entry["sampleInput"])) {
      problems.push(`${at}.sampleInput: must be an object of capability input values when present`);
    }
  });

  return problems.length === 0 ? { ok: true, record: value as unknown as DecisionRecord } : { ok: false, problems };
}
