// @archstone/schema — Schema Loader (#2)
//
// Loads deployable CDL manifests from disk and validates their *shape* against
// the JSON Schemas in schemas/. Structure only — meaning (does the
// provider resolve? do declared IDs match files?) is the Semantic Validator (#3).
//
// The only capability format is CDL 0.2 (`capability:` root, cdl.schema.json),
// which keeps REST/HTTP/JSON-Schema out of the authoring surface.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";

// Schema compilation touches the filesystem (schema JSON files) and `import.meta.url`.
// Deferred to first `load()` call (not module-import time) so a consumer that only needs
// OTHER exports of this module (e.g. types, or code that never calls `load()`) can be
// imported in an environment with no real filesystem — a bundler, a Workers/edge runtime —
// without crashing merely from being imported transitively.
interface Validators {
  capabilities: ValidateFunction;
  capability: ValidateFunction;
  binding: ValidateFunction;
  resource: ValidateFunction;
  policy: ValidateFunction;
  execution: ValidateFunction;
}

let validators: Validators | undefined;

function getValidators(): Validators {
  if (validators) return validators;

  const here = dirname(fileURLToPath(import.meta.url));
  const SCHEMAS_DIR = process.env.ARCHSTONE_SCHEMAS_DIR ?? resolve(here, "../schemas");

  function readSchema(name: string): Record<string, unknown> {
    return JSON.parse(readFileSync(join(SCHEMAS_DIR, name), "utf8"));
  }

  // `verbose` only so an `enum` error carries the refused value (see `rejectedEnumValue`).
  const ajv = new Ajv2020({ allErrors: true, strict: false, verbose: true });
  // Env placeholders (${BOOKING_API_URL}) are valid at authoring time; real
  // URL/format checks belong to the binding resolver (#6), not the loader.
  for (const f of ["uri", "uri-reference", "date", "date-time", "email"]) {
    ajv.addFormat(f, () => true);
  }
  ajv.addSchema(readSchema("connector.schema.json")); // referenced by binding.schema.json

  const capabilities: ValidateFunction = ajv.compile(readSchema("capabilities.schema.json"));
  // cdl.schema.json is compiled (and thus registered by its $id) before the resource and
  // response validators, whose $refs into cdl.schema.json#/$defs/{resourceName,fieldMap} resolve.
  const capability: ValidateFunction = ajv.compile(readSchema("cdl.schema.json"));
  ajv.addSchema(readSchema("response.schema.json")); // referenced by binding.schema.json; refs cdl (registered above)
  ajv.addSchema(readSchema("extract.schema.json")); // referenced by binding.schema.json (per the accepted architecture decision extending ADD-12)
  ajv.addSchema(readSchema("contract.schema.json")); // referenced by binding.schema.json
  const binding: ValidateFunction = ajv.compile(readSchema("binding.schema.json"));
  const resource: ValidateFunction = ajv.compile(readSchema("resource.schema.json"));
  // #43 / ADD-43 §8.1: policy.schema.json joins the compiled set UNMODIFIED (BR-3). Every
  // additional policy requirement is cross-file (does `capabilityId` resolve? is `*` present in
  // an entry?) and therefore inexpressible in JSON Schema — those live in the semantic pass.
  const policy: ValidateFunction = ajv.compile(readSchema("policy.schema.json"));
  // #44: execution.schema.json joins the compiled set the way policy.schema.json did in #43.
  // Unlike every other schema here it validates nothing on disk — an `Execution` record is
  // MACHINE-EMITTED at invocation time, never authored — so it is reached through
  // `validateExecution` below rather than through `load()`.
  const execution: ValidateFunction = ajv.compile(readSchema("execution.schema.json"));

  validators = { capabilities, capability, binding, resource, policy, execution };
  return validators;
}

export interface ExecutionValidation {
  ok: boolean;
  /** Human-readable, semicolon-joined ajv errors; `""` when `ok`. */
  errors: string;
}

/**
 * Validate one emitted `Execution` audit record against the shipped `execution.schema.json`
 * (#44). The record's producers live in `@archstone/emitter-support` and cannot call this —
 * that package is deliberately fs-free and this one reads schema files from disk — so this is
 * the seam a consumer (and Archstone's own test suite) uses to check the emitter against the
 * published contract rather than against a hand-written object literal.
 *
 * The schema is `additionalProperties: false` at all four levels, so this also proves no
 * undeclared key was written, and `status.denialReason` carries a seven-member `enum`, so free
 * text is rejected here rather than only by a TypeScript union.
 *
 * **Known limitation, stated rather than assumed:** this loader registers `date-time` (and
 * `uri`/`date`/`email`) as always-true formats, because authoring-time documents legitimately
 * carry `${ENV}` placeholders where a format would otherwise apply. An `Execution` record has
 * no placeholders, so `metadata.startedAt`/`completedAt` are shape-checked as strings here and
 * their RFC-3339 well-formedness is asserted by the emitter's own tests, not by this call.
 */
export function validateExecution(record: unknown): ExecutionValidation {
  const validate = getValidators().execution;
  const ok = validate(record) as boolean;
  return { ok, errors: ok ? "" : formatErrors(validate.errors, false) }; // machine-emitted: echo no value
}

export interface CapabilitiesFile {
  company: { id: string; name?: string; description?: string };
  capabilities: string[];
  providers: string[];
}

export interface CapabilityDoc {
  file: string;
  capability: {
    id: string;
    description: string;
    effect: "read" | "write" | "irreversible";
    input?: Record<string, unknown>;
    output?: Record<string, unknown>;
    policies?: string[];
    provider?: string;
    lifecycle?: string; // "experimental"|"beta"|"stable"|"deprecated"|"retired"; shape-validated
    // by cdl.schema.json (RFC-0001 v0.4 §5.5/D-11); the compiler applies the "stable" default
    // and narrows to the closed set (ADD-24 D-4/D-5).
    [k: string]: unknown;
  };
}

export interface BindingDoc {
  file: string;
  binding: {
    capabilityId: string;
    connector: Record<string, unknown>;
    response?: Record<string, unknown>; // optional response mapping (ADD-12); resolution/lowering is the compiler's
    extract?: Record<string, unknown>; // optional scalar output extraction (extends ADD-12); resolution/lowering is the compiler's
    contract?: Record<string, unknown>; // optional contract snapshot (ADD-18); lowering is the compiler's
    origins?: { pages?: string[]; images?: string[] }; // optional origin lists for origin-bound output types; entry syntax is the semantic pass's
  };
}

export interface ResourceDoc {
  file: string;
  resource: {
    name: string; // optionally domain-qualified: banking.Account or Account
    description?: string;
    fields: Record<string, unknown>; // a fieldMap — resolution/lowering is the compiler's job
  };
}

/**
 * A Policy document (`*.policy.yaml`, `kind: Policy`) — #43 / ADD-43 §8.1.
 *
 * Shape only: `metadata.scope`/`provider`/`capabilityId` are all optional in
 * `policy.schema.json`, so a scope-less policy is shape-valid and semantically meaningless.
 * Resolving the scope (and refusing what this version cannot evaluate) is the semantic pass's
 * job, exactly as with `*.resource.yaml` names.
 *
 * NOT the same vocabulary as a capability's `policies: [authenticated, …]` CDL token list
 * (AC §0.1 / BR-38): a policy document cannot express `authenticated`, and `spec.rateLimit`
 * is not the `rate-limited` token — the token is an authoring-time hint on the capability;
 * `spec.rateLimit` here is the document that is actually enforced (#45 / ADD-45).
 */
export interface PolicyDoc {
  file: string;
  apiVersion: string;
  kind: string;
  metadata: {
    id: string;
    name: string;
    description?: string;
    provider?: string;
    scope?: "provider" | "capability";
    capabilityId?: string;
  };
  spec: {
    allow?: string[];
    deny?: string[];
    // #45 / ADD-45 D-1: enforced. `maxInvocations`/`windowSeconds` are required TOGETHER by the
    // compiler's semantic pass (`policy-ratelimit-invalid`) — `policy.schema.json` itself makes
    // neither required on its own, so this type stays permissive at the shape layer and the
    // stricter rule lives where the rest of this file's cross-field rules do.
    rateLimit?: { maxInvocations?: unknown; windowSeconds?: unknown };
    constraints?: Record<string, unknown>; // non-empty refused (BR-23); empty stripped (D-3)
  };
}

export interface LoadIssue {
  file: string;
  message: string;
}

export interface LoadResult {
  ok: boolean;
  dir: string;
  capabilities?: CapabilitiesFile;
  capabilityDocs: CapabilityDoc[];
  bindings: BindingDoc[];
  resourceDocs: ResourceDoc[];
  policyDocs: PolicyDoc[];
  issues: LoadIssue[];
}

/** For an `enum` failure on a string, name the value that was refused — "must be equal to one of
 *  the allowed values" alone does not tell an author that `list: web-page` failed because of
 *  `web-page`. Only an authored manifest's own text is echoed (never a machine-emitted record's),
 *  and only for this keyword. */
function rejectedEnumValue(e: ErrorObject): string {
  if (e.keyword !== "enum" || typeof e.data !== "string") return "";
  // JSON-quoted, so a newline or control character prints escaped instead of breaking a terminal
  // or CI log line; truncated, so a pasted blob cannot flood one.
  const quoted = JSON.stringify(e.data);
  return ` (got ${quoted.length > 80 ? `${quoted.slice(0, 77)}…` : quoted})`;
}

function formatErrors(errors: ErrorObject[] | null | undefined, authored = true): string {
  if (!errors || errors.length === 0) return "invalid";
  return errors
    .map((e) => `${e.instancePath || "/"} ${e.message ?? ""}${authored ? rejectedEnumValue(e) : ""}`.trim())
    .join("; ");
}

/** Load and shape-validate a manifest directory (capabilities.yaml + *.capability.yaml + bindings/). */
export function load(dir: string): LoadResult {
  const { capabilities: validateCapabilities, capability: validateCapability, binding: validateBinding, resource: validateResource, policy: validatePolicy } = getValidators();
  const issues: LoadIssue[] = [];
  const capabilityDocs: CapabilityDoc[] = [];
  const bindings: BindingDoc[] = [];
  const resourceDocs: ResourceDoc[] = [];
  const policyDocs: PolicyDoc[] = [];
  let capabilities: CapabilitiesFile | undefined;

  if (!existsSync(dir) || !statSync(dir).isDirectory()) {
    return {
      ok: false,
      dir,
      capabilityDocs,
      bindings,
      resourceDocs,
      policyDocs,
      issues: [{ file: dir, message: "directory not found" }],
    };
  }

  // 1. capabilities.yaml — the iconic manifest
  const capsPath = join(dir, "capabilities.yaml");
  if (!existsSync(capsPath)) {
    issues.push({ file: "capabilities.yaml", message: "missing (required manifest)" });
  } else {
    try {
      const parsed = parseYaml(readFileSync(capsPath, "utf8"));
      if (validateCapabilities(parsed)) capabilities = parsed as CapabilitiesFile;
      else issues.push({ file: "capabilities.yaml", message: formatErrors(validateCapabilities.errors) });
    } catch (err) {
      issues.push({ file: "capabilities.yaml", message: `parse error: ${(err as Error).message}` });
    }
  }

  // 2. *.capability.yaml — CDL 0.2
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".capability.yaml")).sort()) {
    try {
      const parsed = parseYaml(readFileSync(join(dir, name), "utf8"));
      if (validateCapability(parsed)) capabilityDocs.push({ file: name, ...(parsed as object) } as CapabilityDoc);
      else issues.push({ file: name, message: formatErrors(validateCapability.errors) });
    } catch (err) {
      issues.push({ file: name, message: `parse error: ${(err as Error).message}` });
    }
  }

  // 3. bindings/*.binding.yaml — implementation, separate from CDL
  const bindingsDir = join(dir, "bindings");
  if (existsSync(bindingsDir)) {
    for (const name of readdirSync(bindingsDir).filter((f) => f.endsWith(".binding.yaml")).sort()) {
      try {
        const parsed = parseYaml(readFileSync(join(bindingsDir, name), "utf8"));
        if (validateBinding(parsed)) bindings.push({ file: `bindings/${name}`, ...(parsed as object) } as BindingDoc);
        else issues.push({ file: `bindings/${name}`, message: formatErrors(validateBinding.errors) });
      } catch (err) {
        issues.push({ file: `bindings/${name}`, message: `parse error: ${(err as Error).message}` });
      }
    }
  }

  // 4. *.resource.yaml — named business entities (shape only; name resolution is the compiler's).
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".resource.yaml")).sort()) {
    try {
      const parsed = parseYaml(readFileSync(join(dir, name), "utf8"));
      if (validateResource(parsed)) resourceDocs.push({ file: name, ...(parsed as object) } as ResourceDoc);
      else issues.push({ file: name, message: formatErrors(validateResource.errors) });
    } catch (err) {
      issues.push({ file: name, message: `parse error: ${(err as Error).message}` });
    }
  }

  // 5. *.policy.yaml — Policy documents (#43 / BR-1, BR-2). Discovered by SUFFIX from the
  // manifest ROOT only, mirroring *.resource.yaml above: `capabilities.schema.json` is
  // `additionalProperties: false` with no slot to declare one, so there is deliberately no
  // "declared-without-file"/"file-not-declared" cross-check for policies (BR-2). A policy under
  // bindings/ is not discovered and is inert (EC-2) — documented in ONBOARDING as a placement
  // rule so it is not mistaken for a bug.
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".policy.yaml")).sort()) {
    try {
      const parsed = parseYaml(readFileSync(join(dir, name), "utf8"));
      if (validatePolicy(parsed)) policyDocs.push({ file: name, ...(parsed as object) } as PolicyDoc);
      else issues.push({ file: name, message: formatErrors(validatePolicy.errors) });
    } catch (err) {
      issues.push({ file: name, message: `parse error: ${(err as Error).message}` });
    }
  }

  return { ok: issues.length === 0, dir, capabilities, capabilityDocs, bindings, resourceDocs, policyDocs, issues };
}
