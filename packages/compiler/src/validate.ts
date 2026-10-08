// @archstone/compiler — Semantic Validator (#3)
//
// Runs on the Semantic Model (the loaded, shape-valid manifest from #2), not on
// YAML. Semantic-type validity is already enforced structurally by cdl.schema.json
// in #2, so this pass is strictly CROSS-FILE: does the provider resolve? do
// declared IDs match files? do bindings resolve? Errors block; warnings inform.

import type { LoadResult, CapabilityDoc, PolicyDoc } from "@archstone/schema";
import { domainOf, referencedResourceName, resolveResourceName, resourceIndex } from "./resolve";
import { parsePath } from "./path";
import { policyScopesCapability } from "./compile";
import { UNENFORCED_POLICY_TOKENS } from "./unenforced-tokens";
import { originListOf, type IROrigins, type SemanticType } from "./ir";

export type Severity = "error" | "warning";

export interface Diagnostic {
  severity: Severity;
  code: string;
  message: string;
  /** Set by BR-40 only (ADD-311 D-5): which (capability, token) pair the warning reports, so a
   *  renderer that replaces it with a richer finding matches on structure, never on prose. */
  capability?: string;
  token?: string;
}

export function validateSemantics(model: LoadResult): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const { capabilities: caps, capabilityDocs: docs, bindings, resourceDocs } = model;

  // Index capability docs by id (and catch duplicates).
  const byId = new Map<string, CapabilityDoc>();
  for (const d of docs) {
    const id = d.capability.id;
    const existing = byId.get(id);
    if (existing) {
      diags.push({
        severity: "error",
        code: "duplicate-capability",
        message: `capability '${id}' is defined in more than one file (${existing.file}, ${d.file})`,
      });
    } else {
      byId.set(id, d);
    }
  }

  const providers = new Set(caps?.providers ?? []);
  const declared = new Set(caps?.capabilities ?? []);

  // 1. Provider resolution — every capability.provider must exist in capabilities.yaml.
  for (const d of docs) {
    const p = d.capability.provider;
    if (!p) {
      diags.push({ severity: "error", code: "missing-provider", message: `capability '${d.capability.id}' (${d.file}) declares no provider` });
    } else if (caps && !providers.has(p)) {
      diags.push({ severity: "error", code: "unknown-provider", message: `capability '${d.capability.id}' references provider '${p}' not listed in capabilities.yaml` });
    }
  }

  // 2. Declared <-> files consistency (only meaningful when capabilities.yaml loaded).
  if (caps) {
    for (const id of declared) {
      if (!byId.has(id)) {
        diags.push({ severity: "error", code: "declared-without-file", message: `capabilities.yaml declares '${id}' but no *.capability.yaml defines it` });
      }
    }
    for (const d of docs) {
      if (!declared.has(d.capability.id)) {
        diags.push({ severity: "error", code: "file-not-declared", message: `capability '${d.capability.id}' (${d.file}) is not declared in capabilities.yaml` });
      }
    }
    const usedProviders = new Set(docs.map((d) => d.capability.provider).filter((p): p is string => Boolean(p)));
    for (const p of providers) {
      if (!usedProviders.has(p)) {
        diags.push({ severity: "warning", code: "unused-provider", message: `provider '${p}' is declared but no capability uses it` });
      }
    }
  }

  // 3. Binding resolution + capability-without-binding (NF-1).
  const boundIds = new Set<string>();
  for (const b of bindings) {
    const cid = b.binding.capabilityId;
    boundIds.add(cid);
    if (!byId.has(cid)) {
      diags.push({ severity: "error", code: "binding-without-capability", message: `binding ${b.file} references capability '${cid}' which is not defined` });
    }
  }
  for (const d of docs) {
    if (!boundIds.has(d.capability.id)) {
      diags.push({ severity: "warning", code: "capability-without-binding", message: `capability '${d.capability.id}' has no binding — not invocable until one is added` });
    }
  }

  // 3b. ADD-32 step 8 — advisory: an `authenticated` capability whose REST binding never
  // references a caller placeholder will always fail closed at invoke time (providers/rest's
  // fail-closed gate, D-3). Purely a string-pattern check over the raw binding shape already
  // loaded (`model.bindings`) — no HTTP/auth-scheme interpretation, and NOT a hard schema
  // requirement (warning, not error — R-4: this stays advisory until proven useful in anger).
  for (const b of bindings) {
    const cid = b.binding.capabilityId;
    const cap = byId.get(cid);
    if (!cap || !(cap.capability.policies ?? []).includes("authenticated")) continue;
    const connector = b.binding.connector as { type?: unknown; rest?: Record<string, unknown> } | undefined;
    if (connector?.type !== "rest" || !connector.rest) continue;
    const rest = connector.rest;
    const stringValues: string[] = [];
    if (typeof rest.body === "string") stringValues.push(rest.body);
    for (const map of [rest.headers, rest.query]) {
      if (map && typeof map === "object") {
        for (const v of Object.values(map as Record<string, unknown>)) {
          if (typeof v === "string") stringValues.push(v);
        }
      }
    }
    const hasCallerPlaceholder = stringValues.some((v) => v.includes("${caller."));
    if (!hasCallerPlaceholder) {
      diags.push({
        severity: "warning",
        code: "authenticated-capability-no-caller-placeholder",
        message: `capability '${cid}' declares policies:[authenticated] but its binding never references a caller credential (\${caller.…}) — invocation will always fail closed unless one is added`,
      });
    }
  }

  // 3c. Security-hardening follow-up to ADD-32 step 8, same pattern: a binding whose REST
  // baseUrl references a caller placeholder will always fail closed at invoke time (providers/
  // rest's allowlist guard) unless the invoker configures InvokeOptions.allowedHosts — that
  // configuration is invoke-context, not something the compiler can see or enforce. Purely
  // advisory (warning, never blocks apply/build) and a string-pattern check over the raw binding
  // shape, no HTTP interpretation here either.
  for (const b of bindings) {
    const connector = b.binding.connector as { type?: unknown; rest?: Record<string, unknown> } | undefined;
    if (connector?.type !== "rest" || !connector.rest) continue;
    const baseUrl = connector.rest.baseUrl;
    if (typeof baseUrl === "string" && baseUrl.includes("${caller.")) {
      diags.push({
        severity: "warning",
        code: "caller-influenced-baseurl-no-allowlist",
        message: `binding ${b.file} (capability '${b.binding.capabilityId}')'s baseUrl references a caller credential (\${caller.…}) — invocation will always fail closed unless the invoker configures InvokeOptions.allowedHosts`,
      });
    }
  }

  // 3d. ADR-0012 D-2/BR-9 — a pre-existing gap this ADR's dispatch work makes visible, not new
  // scope for the `sql` provider itself: `graphql`/`grpc`/`soap` are reserved, unimplemented
  // connector `type` enum members that today compile, are treated as invocable, and fail only
  // at the moment of invocation with an opaque error. Refuse at `apply` instead — the one place
  // `invokeConnector` (ADR-0012 D-6) already has to know the closed set of implemented types.
  const UNIMPLEMENTED_CONNECTOR_TYPES = new Set(["graphql", "grpc", "soap"]);
  for (const b of bindings) {
    const type = (b.binding.connector as { type?: unknown } | undefined)?.type;
    if (typeof type === "string" && UNIMPLEMENTED_CONNECTOR_TYPES.has(type)) {
      diags.push({
        severity: "error",
        code: "connector-type-not-implemented",
        message: `binding ${b.file} (capability '${b.binding.capabilityId}') declares connector.type: '${type}', which is not implemented — it would compile as invocable and fail only at the moment of invocation`,
      });
    }
  }

  // 3e. ADR-0012 D-1/D-9 layer 1 — static, offline validation of a `sql` binding's own
  // declared query text, params/CDL-input consistency, and dsn placeholder discipline. No
  // network call — `apply` stays fully offline for `sql` exactly as it already is for `rest`.
  const SQL_LEADING_KEYWORD_RE = /^\s*(?:--[^\n]*\n\s*|\/\*[\s\S]*?\*\/\s*)*(select|with)\b/i;
  const POSITIONAL_PARAM_RE = /\$(\d+)/g;
  for (const b of bindings) {
    const connector = b.binding.connector as { type?: unknown; sql?: Record<string, unknown> } | undefined;
    if (connector?.type !== "sql" || !connector.sql) continue;
    const cid = b.binding.capabilityId;
    const cap = byId.get(cid);
    const sql = connector.sql;
    const at = `binding ${b.file} (capability '${cid}')`;

    // BR-4 / D-9 layer 1 — the query's own leading keyword must agree with `statementKind`.
    const query = typeof sql.query === "string" ? sql.query : "";
    const match = SQL_LEADING_KEYWORD_RE.exec(query);
    const leadingKeyword = match?.[1]?.toLowerCase();
    if (leadingKeyword !== "select" && leadingKeyword !== "with") {
      diags.push({
        severity: "error",
        code: "sql-statement-not-read-only",
        message: `${at}: connector.sql.query must begin with SELECT or WITH … SELECT (after stripping leading whitespace/comments) — statementKind: select does not match the query's own leading keyword`,
      });
    } else if (leadingKeyword === "with" && !/\bselect\b/i.test(query)) {
      // A WITH … that never actually SELECTs is not a read-only CTE.
      diags.push({
        severity: "error",
        code: "sql-statement-not-read-only",
        message: `${at}: connector.sql.query begins with WITH but contains no SELECT — a CTE must terminate in a read-only SELECT`,
      });
    }

    // BR-5 — every `params` entry must be a declared CDL input field; every positional
    // placeholder ($1, $2, …) in `query` must have a corresponding `params` entry, and vice
    // versa. "Ambiguous is a refusal, not a guess" (compiler/src/resolve.ts's existing
    // discipline for resource names, applied here to positional binding).
    const params = Array.isArray(sql.params) ? sql.params.filter((p): p is string => typeof p === "string") : [];
    const declaredInputs = new Set(Object.keys((cap?.capability.input ?? {}) as Record<string, unknown>));
    for (const p of params) {
      if (cap && !declaredInputs.has(p)) {
        diags.push({
          severity: "error",
          code: "sql-param-unresolved",
          message: `${at}: connector.sql.params references '${p}', which is not a declared input field of capability '${cid}'`,
        });
      }
    }
    const placeholderIndices = new Set<number>();
    for (const m of query.matchAll(POSITIONAL_PARAM_RE)) placeholderIndices.add(Number(m[1]));
    const maxPlaceholder = placeholderIndices.size > 0 ? Math.max(...placeholderIndices) : 0;
    if (maxPlaceholder > params.length) {
      diags.push({
        severity: "error",
        code: "sql-param-count-mismatch",
        message: `${at}: connector.sql.query references $${maxPlaceholder}, but params has only ${params.length} entr${params.length === 1 ? "y" : "ies"}`,
      });
    }
    // A declared params entry that the query never references is equally a mismatch — the two
    // must agree in both directions (BR-5).
    for (let i = 1; i <= params.length; i++) {
      if (!placeholderIndices.has(i)) {
        diags.push({
          severity: "error",
          code: "sql-param-count-mismatch",
          message: `${at}: connector.sql.params[${i - 1}] ('${params[i - 1]}') has no corresponding $${i} placeholder in the query`,
        });
      }
    }

    // BR-2 — `dsn` must be an environment-variable placeholder ONLY, never a literal
    // connection string. connector.schema.json's pattern already enforces the exact `${VAR}`
    // shape at shape-validation time (#2); this is the semantic-layer restatement so the error
    // is reported alongside every other `sql` diagnostic with a consistent, named message, and
    // so a schema bypass (e.g. a hand-built IR) is still caught here.
    const dsn = typeof sql.dsn === "string" ? sql.dsn : "";
    if (!/^\$\{[A-Za-z_][A-Za-z0-9_]*\}$/.test(dsn)) {
      diags.push({
        severity: "error",
        code: "sql-dsn-not-env-placeholder",
        message: `${at}: connector.sql.dsn must be a single \${VAR} environment-variable placeholder — a literal connection string is not permitted`,
      });
    }
  }

  // 4. Resource resolution (P-7) — every `ref`/`collection`/resource-typed name in a
  // capability's input/output AND in a resource's fields (transitively, since every
  // resource's fields are checked here) must resolve to a loaded resource.
  const index = resourceIndex(resourceDocs);

  // Duplicate resource definitions (same canonical name in more than one file) → warn.
  const seen = new Map<string, string>();
  for (const r of resourceDocs) {
    const name = r.resource.name;
    const first = seen.get(name);
    if (first) {
      diags.push({ severity: "warning", code: "duplicate-resource", message: `resource '${name}' is defined in more than one file (${first}, ${r.file})` });
    } else {
      seen.set(name, r.file);
    }
  }

  const checkFields = (fields: Record<string, unknown> | undefined, domain: string, where: string) => {
    if (!fields) return;
    for (const [fieldName, raw] of Object.entries(fields)) {
      const ref = referencedResourceName((raw ?? {}) as Record<string, unknown>);
      if (!ref) continue;
      const res = resolveResourceName(ref, domain, index);
      if (res.ok) continue;
      const detail =
        res.reason === "ambiguous"
          ? `resource '${ref}' is ambiguous — it matches both ${res.candidates[0]} and ${res.candidates[1]}; qualify it`
          : `resource '${ref}' is not defined by any *.resource.yaml`;
      diags.push({ severity: "error", code: "unknown-resource", message: `${where} field '${fieldName}' references ${detail}` });
    }
  };

  for (const d of docs) {
    const domain = domainOf(d.capability.id);
    checkFields(d.capability.input, domain, `capability '${d.capability.id}' (${d.file}) input`);
    checkFields(d.capability.output, domain, `capability '${d.capability.id}' (${d.file}) output`);
  }
  for (const r of resourceDocs) {
    checkFields(r.resource.fields, domainOf(r.resource.name), `resource '${r.resource.name}' (${r.file})`);
  }

  // 5. Response/extract-mapping resolution (ADD-12, extended by the accepted architecture
  // decision that added `extract:`) — for each binding `response:` and/or `extract:`: the
  // resource resolves (P-7); every `map`/`extract` key is a real field (of the resource, or of
  // the capability's `output:`, respectively); every path parses; the bound capability has
  // exactly one output field referencing a mapped resource (D-7 output binding); and — the
  // generalized form of #61's original "at most one output field" refusal — every declared
  // `output:` field is reachable by exactly one of {response:, extract:}.
  const fieldsByResource = new Map<string, Set<string>>();
  for (const r of resourceDocs) {
    fieldsByResource.set(r.resource.name, new Set(Object.keys(r.resource.fields ?? {})));
  }

  /** A `map:`/`extract:` entry value is either a bare JSONPath string or `{path, required}`. */
  const pathOf = (value: unknown): string | undefined =>
    typeof value === "string" ? value : typeof (value as Record<string, unknown>)?.path === "string" ? (value as Record<string, string>).path : undefined;

  for (const b of bindings) {
    const resp = b.binding.response;
    const extract = b.binding.extract;
    if (!resp && !extract) continue; // no output-populating mechanism declared: today's raw pass-through, unchanged
    const cid = b.binding.capabilityId;
    const cap = byId.get(cid);
    if (!cap) continue; // binding-without-capability already reported above
    const domain = domainOf(cid);
    const outputRaw = (cap.capability.output ?? {}) as Record<string, unknown>;

    // `response:` (ADD-12, unchanged) — tracks WHICH output field it covers (`responseField`),
    // consumed by the coverage pass below instead of the old blanket "> 1 output field" refusal.
    let responseField: string | undefined;
    let responseUnresolved = false; // a response:-side error already named the problem; the
    // coverage pass below would only pile on a confusing second diagnostic for the same cause.
    if (resp) {
      const at = `binding ${b.file} response`;
      const rawResource = resp.resource;
      if (typeof rawResource !== "string") {
        responseUnresolved = true; // shape-guaranteed by schema; defensive
      } else {
        const resolved = resolveResourceName(rawResource, domain, index);
        if (!resolved.ok) {
          const detail =
            resolved.reason === "ambiguous"
              ? `is ambiguous — it matches both ${resolved.candidates[0]} and ${resolved.candidates[1]}; qualify it`
              : `is not defined by any *.resource.yaml`;
          diags.push({ severity: "error", code: "unknown-response-resource", message: `${at} maps to resource '${rawResource}' which ${detail}` });
          responseUnresolved = true;
        } else {
          const canonical = resolved.canonical;
          const resourceFields = fieldsByResource.get(canonical);

          // Every map key must be a field of the resolved resource; every path must parse.
          const map = (resp.map ?? {}) as Record<string, unknown>;
          for (const [key, value] of Object.entries(map)) {
            if (resourceFields && !resourceFields.has(key)) {
              diags.push({ severity: "error", code: "unknown-response-field", message: `${at} maps '${key}', not a field of resource '${canonical}'` });
            }
            const path = pathOf(value);
            if (typeof path === "string") {
              const p = parsePath(path);
              if (!p.ok) diags.push({ severity: "error", code: "bad-response-path", message: `${at} field '${key}' has an invalid JSONPath '${path}': ${p.error}` });
            }
          }
          if (typeof resp.collection === "string") {
            const p = parsePath(resp.collection);
            if (!p.ok) diags.push({ severity: "error", code: "bad-response-path", message: `${at} collection has an invalid JSONPath '${resp.collection}': ${p.error}` });
          }

          // #81 (ADD-12 §8.1) — `onError`: `errorResource` resolves (P-7), `when.path` parses,
          // and the block is meaningless without a `collection` (there is no "row" to classify
          // for a single-object response).
          const onError = (resp as Record<string, unknown>).onError as Record<string, unknown> | undefined;
          if (onError) {
            if (typeof resp.collection !== "string") {
              diags.push({ severity: "error", code: "response-onerror-without-collection", message: `${at} declares onError but no collection — onError classifies rows of a collection, and this mapping has none` });
            }
            const rawErrorResource = onError.errorResource;
            if (typeof rawErrorResource !== "string") {
              diags.push({ severity: "error", code: "bad-response-onerror", message: `${at} onError is missing errorResource` });
            } else {
              const resolvedErr = resolveResourceName(rawErrorResource, domain, index);
              if (!resolvedErr.ok) {
                const detail =
                  resolvedErr.reason === "ambiguous"
                    ? `is ambiguous — it matches both ${resolvedErr.candidates[0]} and ${resolvedErr.candidates[1]}; qualify it`
                    : `is not defined by any *.resource.yaml`;
                diags.push({ severity: "error", code: "unknown-response-onerror-resource", message: `${at} onError.errorResource '${rawErrorResource}' ${detail}` });
              } else if (resolvedErr.canonical === canonical) {
                diags.push({ severity: "error", code: "bad-response-onerror", message: `${at} onError.errorResource must differ from resource '${canonical}'` });
              } else {
                // onError.map — same shape/validation as the top-level `map:` (a delta ratified
                // after §8.1's initial shipment): every key must be a field of `errorResource`,
                // every path must parse. Optional — an entry-less field falls back to a
                // same-named key on the item (`applyResponseMapping`'s existing default).
                const errorResourceFields = fieldsByResource.get(resolvedErr.canonical);
                const onErrorMap = (onError.map ?? {}) as Record<string, unknown>;
                for (const [key, value] of Object.entries(onErrorMap)) {
                  if (errorResourceFields && !errorResourceFields.has(key)) {
                    diags.push({ severity: "error", code: "unknown-response-onerror-field", message: `${at} onError.map maps '${key}', not a field of resource '${resolvedErr.canonical}'` });
                  }
                  const path = pathOf(value);
                  if (typeof path === "string") {
                    const p = parsePath(path);
                    if (!p.ok) diags.push({ severity: "error", code: "bad-response-path", message: `${at} onError.map field '${key}' has an invalid JSONPath '${path}': ${p.error}` });
                  }
                }
              }
            }
            const when = onError.when as Record<string, unknown> | undefined;
            const whenPath = when?.path;
            if (typeof whenPath !== "string") {
              diags.push({ severity: "error", code: "bad-response-onerror", message: `${at} onError.when is missing path` });
            } else {
              const p = parsePath(whenPath);
              if (!p.ok) diags.push({ severity: "error", code: "bad-response-path", message: `${at} onError.when has an invalid JSONPath '${whenPath}': ${p.error}` });
            }
          }

          // D-7: exactly one output field must reference the mapped resource, so the mapped
          // result has one unambiguous home in the tool's output (structuredContent = outputSchema).
          const targets = Object.entries(outputRaw).filter(([, raw]) => {
            const ref = referencedResourceName((raw ?? {}) as Record<string, unknown>);
            if (!ref) return false;
            const r = resolveResourceName(ref, domain, index);
            return r.ok && r.canonical === canonical;
          });
          if (targets.length !== 1) {
            const detail = targets.length === 0 ? `no output field references resource '${canonical}'` : `${targets.length} output fields reference resource '${canonical}' (need exactly one)`;
            diags.push({ severity: "error", code: "response-output-mismatch", message: `${at}: ${detail}` });
            responseUnresolved = true;
          } else {
            responseField = targets[0][0];
          }
        }
      }
    }

    // `extract:` — a sibling binding block (per the accepted architecture decision extending
    // ADD-12) that populates additional SCALAR output fields straight from the raw provider
    // body root. Every key must name a real output field; that field must be scalar-typed
    // (never resource/collection — those still require `response:`); every path must parse.
    const extractCovered = new Set<string>();
    if (extract) {
      const at = `binding ${b.file} extract`;
      for (const [key, value] of Object.entries(extract)) {
        const fieldRaw = outputRaw[key] as Record<string, unknown> | undefined;
        if (!fieldRaw) {
          diags.push({ severity: "error", code: "unknown-extract-field", message: `${at} extracts '${key}', not a declared output field of capability '${cid}'` });
          continue;
        }
        // A real field — counts toward coverage below even if it turns out to be wrong-kind
        // (one diagnostic per problem: extract-field-wrong-kind already names this exact field).
        extractCovered.add(key);
        if (referencedResourceName(fieldRaw) !== undefined) {
          diags.push({
            severity: "error",
            code: "extract-field-wrong-kind",
            message: `${at} extracts '${key}', a resource/collection-typed output field — extract: reaches only scalar/semantic-typed fields; map '${key}' with response: instead`,
          });
        }
        const path = pathOf(value);
        if (typeof path === "string") {
          const p = parsePath(path);
          if (!p.ok) diags.push({ severity: "error", code: "bad-extract-path", message: `${at} field '${key}' has an invalid JSONPath '${path}': ${p.error}` });
        }
      }
    }

    // D-5 (generalizing #61's Option B / response-output-extra-fields): every declared output
    // field must be reachable by exactly one of {response:, extract:}. `applyResponseMapping`
    // only ever populates the fields these two mechanisms name, while `objectJsonSchema` builds
    // `outputSchema` from EVERY declared `output:` field — a field reachable by neither ships an
    // `outputSchema` property `structuredContent` never carries, which crashes the reference MCP
    // SDK client (ADD-19 Rev 2 D-3'/D-6's precedent). Skipped when `response:` itself already
    // failed to resolve — that error already names the problem; this pass would only add noise.
    if (!responseUnresolved) {
      const covered = new Set(extractCovered);
      if (responseField) covered.add(responseField);
      for (const fieldName of Object.keys(outputRaw)) {
        if (covered.has(fieldName)) continue;
        diags.push({
          severity: "error",
          code: "unbound-output-field",
          message: `binding ${b.file}: capability '${cid}' declares output field '${fieldName}', which is reachable by neither response: nor extract: — outputSchema would advertise it while structuredContent never carries it, crashing the reference MCP client (ADD-19). Map it with response: (resource/collection fields) or extract: (scalar fields), or remove the field.`,
        });
      }
    }
  }

  // 5b. Origin-bound output types (`web-page`). See `checkOriginBound` below for the rules.
  diags.push(...checkOriginBound(model, byId, index));

  // 6. Policy documents (#43 / ADD-43 §8.4). Every policy diagnostic lives here — the compiler
  // resolves scope and lowers verbatim, this pass decides what is authorable at all. Errors
  // block `apply`/`build`/`serve`; warnings inform and never block. Nothing here evaluates a
  // policy against a caller: that is the runtime evaluator's single job (BR-7).
  const policies = model.policyDocs ?? [];

  // BR-4 — two documents sharing metadata.id. Mirrors the shipped `duplicate-capability` rule
  // above rather than inventing a new severity.
  const policyById = new Map<string, PolicyDoc>();
  for (const p of policies) {
    const existing = policyById.get(p.metadata.id);
    if (existing) {
      diags.push({
        severity: "error",
        code: "duplicate-policy",
        message: `policy '${p.metadata.id}' is defined in more than one file (${existing.file}, ${p.file})`,
      });
    } else {
      policyById.set(p.metadata.id, p);
    }
  }

  for (const p of policies) {
    const at = `policy '${p.metadata.id}' (${p.file})`;
    const spec = p.spec ?? {};

    // BR-5 — the scope must resolve. `policy.schema.json` marks scope/provider/capabilityId all
    // optional (metadata requires only id/name), so a scope-less policy is shape-valid and
    // semantically meaningless. Refusing it is what prevents the failure this rule is named for:
    // a policy silently applied to nothing while its author believed it was enforced.
    if (p.metadata.scope === undefined) {
      diags.push({
        severity: "error",
        code: "policy-scope-unresolvable",
        message: `${at} declares no metadata.scope, so it applies to nothing — set scope: capability (with capabilityId) or scope: provider (with provider)`,
      });
    } else if (p.metadata.scope === "capability") {
      const cid = p.metadata.capabilityId;
      if (!cid) {
        diags.push({
          severity: "error",
          code: "policy-scope-unresolvable",
          message: `${at} declares scope: capability but no metadata.capabilityId, so it applies to nothing`,
        });
      } else {
        const target = byId.get(cid);
        if (!target) {
          diags.push({
            severity: "error",
            code: "policy-scope-unresolvable",
            message: `${at} scopes capability '${cid}', which no *.capability.yaml defines`,
          });
        } else if (p.metadata.provider !== undefined && target.capability.provider !== p.metadata.provider) {
          // EC-3: a capability-scoped policy may carry a redundant `provider`. When the two
          // agree it is ignored; when they disagree the author's intent is genuinely unknown,
          // so this is an error rather than a silent precedence rule.
          diags.push({
            severity: "error",
            code: "policy-scope-conflict",
            message: `${at} scopes capability '${cid}' but also declares provider '${p.metadata.provider}', while that capability's provider is '${target.capability.provider ?? "?"}' — remove the provider or correct it`,
          });
        }
      }
    } else {
      const prov = p.metadata.provider;
      if (!prov) {
        diags.push({
          severity: "error",
          code: "policy-scope-unresolvable",
          message: `${at} declares scope: provider but no metadata.provider, so it applies to nothing`,
        });
      } else if (caps && !providers.has(prov)) {
        diags.push({
          severity: "error",
          code: "policy-scope-unresolvable",
          message: `${at} scopes provider '${prov}', which is not listed in capabilities.yaml`,
        });
      }
    }

    // BR-10/BR-11 — the pattern grammar is exact, byte-for-byte string equality (BR-9), so two
    // entry shapes must be refused rather than silently matching nothing.
    for (const [key, list] of [
      ["allow", spec.allow],
      ["deny", spec.deny],
    ] as const) {
      for (const entry of list ?? []) {
        if (entry === "") {
          diags.push({
            severity: "error",
            code: "policy-empty-entry",
            message: `${at} has an empty-string entry in ${key} — an empty principal is always an authoring accident (policy.schema.json sets no minLength)`,
          });
        } else if (entry.includes("*")) {
          // The reason this is an ERROR and not a warning: under exact matching, `deny: ["*"]`
          // reads to a human reviewer as "deny everyone" and would in fact deny NO ONE — a
          // silent fail-open in the one list where intent is most safety-critical. Refusing the
          // character also keeps `*` unclaimed, so a future wildcard grammar is a pure widening.
          diags.push({
            severity: "error",
            code: "policy-wildcard-entry",
            message: `${at} has ${key} entry '${entry}' containing '*' — '*' is not a wildcard in this version; principal matching is exact, case-sensitive string equality`,
          });
        }
      }
    }

    // #45 (ADD-45 D-2) — `rateLimit` is now enforced by the same evaluation point as
    // `allow`/`deny` (the state lives outside the pure evaluator, behind a deployer-supplied
    // `RateLimitCounter` — see ADD-45). Both `maxInvocations` and `windowSeconds` are required
    // together: `policy.schema.json` makes neither required on its own, so a document declaring
    // only one is shape-valid but semantically unusable — refusing here, at authoring time, is
    // strictly better than lowering a half-formed rule and denying every call at runtime with a
    // message nobody can act on.
    if (spec.rateLimit !== undefined) {
      const maxInvocations = (spec.rateLimit as Record<string, unknown>).maxInvocations;
      const windowSeconds = (spec.rateLimit as Record<string, unknown>).windowSeconds;
      const validMax = typeof maxInvocations === "number" && Number.isInteger(maxInvocations) && maxInvocations >= 1;
      const validWindow = typeof windowSeconds === "number" && Number.isInteger(windowSeconds) && windowSeconds >= 1;
      if (!validMax || !validWindow) {
        diags.push({
          severity: "error",
          code: "policy-ratelimit-invalid",
          message: `${at} declares spec.rateLimit but is missing (or has an invalid) maxInvocations/windowSeconds — both are required, positive integers`,
        });
      }
    }

    // BR-23 — a NON-EMPTY `constraints` is refused. `policy.schema.json` declares it
    // `additionalProperties: true` with one illustrative key and no grammar whatsoever: nothing
    // states which input field a constraint bounds, with what operator, in what units, or how
    // two compose. Implementing it is not writing an evaluator, it is inventing a permanent
    // comparison language (Rule #11) as a side-task of a plumbing increment. An EMPTY
    // `constraints: {}` is accepted and simply never lowered (ADD-43 D-3).
    if (spec.constraints !== undefined && Object.keys(spec.constraints).length > 0) {
      diags.push({
        severity: "error",
        code: "policy-constraints-unsupported",
        message: `${at} declares spec.constraints, which are not evaluated in this version — no constraint grammar exists yet; remove them or the manifest advertises a control that does not exist`,
      });
    }

    const allow = spec.allow ?? [];
    const deny = spec.deny ?? [];

    // EC-5 — a rule-less policy is evaluable and imposes nothing, but is almost certainly
    // unfinished authoring. Warning, not error: it is legal.
    if (allow.length === 0 && deny.length === 0 && spec.rateLimit === undefined && Object.keys(spec.constraints ?? {}).length === 0) {
      diags.push({
        severity: "warning",
        code: "policy-without-rules",
        message: `${at} declares no allow and no deny — it imposes nothing`,
      });
    }

    // BR-17 — the footgun this warning exists for: an author writes `deny: [...]` and believes
    // the capability is now protected. An ABSENT principal matches no deny entry (ADD-42 D-4),
    // so an anonymous caller proceeds. The rule is correct; the warning is what stops it being
    // a surprise discovered in production.
    if (deny.length > 0 && allow.length === 0) {
      diags.push({
        severity: "warning",
        code: "policy-deny-only",
        message: `${at} declares deny but no allow — an anonymous caller (no principal) matches no deny entry and is therefore ALLOWED; add an allow list to require an identified caller`,
      });
    }

    // EC-7 — the same principal in both lists of one policy. Deny wins (BR-15), so the
    // behaviour is defined; it is still almost certainly an authoring error.
    const contradictions = allow.filter((a) => deny.includes(a));
    if (contradictions.length > 0) {
      diags.push({
        severity: "warning",
        code: "policy-allow-deny-contradiction",
        message: `${at} lists ${contradictions.map((c) => `'${c}'`).join(", ")} in both allow and deny — deny wins, so ${contradictions.length === 1 ? "it is" : "they are"} denied`,
      });
    }
  }

  // BR-46 / ADD-43 D-13 — under intersection semantics, two policies whose non-empty `allow`
  // sets are disjoint make the capability invocable by NOBODY. That is legal and fail-closed
  // (a deployer may genuinely want it during a lockdown), which is why this warns rather than
  // erroring — but without it the author learns of it from a production denial rather than
  // from `apply`.
  for (const d of docs) {
    const scoped = policies.filter(
      (p) => policyScopesCapability(p.metadata, d.capability.id, d.capability.provider ?? "") && (p.spec?.allow?.length ?? 0) > 0,
    );
    if (scoped.length < 2) continue;
    const intersection = scoped
      .map((p) => p.spec.allow ?? [])
      .reduce((acc, list) => acc.filter((entry) => list.includes(entry)));
    if (intersection.length === 0) {
      diags.push({
        severity: "warning",
        code: "policy-disjoint-allow",
        message: `capability '${d.capability.id}' resolves policies ${scoped.map((p) => `'${p.metadata.id}'`).join(", ")} whose allow sets have no principal in common — every policy's allow must be satisfied (intersection, not union), so this capability is invocable by nobody`,
      });
    }
  }

  // 7. BR-40 — declared-but-unenforced CDL policy tokens. The minimum honest fix for #43's own
  // opening complaint, generalized: after this increment and #45, three of the five tokens
  // still have no enforcement and no issue. A warning costs no new primitive (Rule #10) and
  // stops `policies:` reading as a list of shipped guarantees.
  //
  // There is deliberately no suppression flag (AC OQ-H — a mechanism whose only purpose is to hide
  // a true statement), and the list shrinks as tokens gain enforcement.
  //
  // Each (capability, token) pair is reported exactly once: here, or — for a non-retired
  // `irreversible` capability — by `lintIR`'s `irreversible-unenforced-policy` (ADD-311 D-5),
  // which the renderer swaps in for the matching diagnostic. This pass still emits every pair,
  // so an invalid manifest (no lint) prints what it always did.
  for (const d of docs) {
    for (const token of d.capability.policies ?? []) {
      const entry = UNENFORCED_POLICY_TOKENS[token];
      if (!entry) continue;
      diags.push({
        severity: "warning",
        code: "unenforced-policy-token",
        message: `capability '${d.capability.id}' (${d.file}) declares policies:[${token}], which is not enforced in this version — ${entry.why}`,
        capability: d.capability.id,
        token,
      });
    }
  }

  return diags;
}

// ---------------------------------------------------------------------------------------------
// Origin-bound output types (`web-page`, `image`)
//
// A `web-page` or `image` value is a link a person will be shown. A `string` field can carry any
// URL, so these types promise more: the value points at an origin the binding declares
// (`origins.pages`, `origins.images` — two lists, never shared), and the shared response mapper
// withholds anything else (a `list:` of one withholds per item). Each rule below closes one way that promise
// could be made without being kept:
//
//   web-page-in-input               error    the model would be the one supplying the link
//   web-page-no-origins             error    nothing to check a value against
//   web-page-needs-mapping          error    a pass-through binding never runs the mapper
//   origins-malformed               error    an entry that is not a bare https origin, or a duplicate
//   origins-unused                  warning  origins declared, no origin-bound field reachable
//   web-page-required-in-collection warning  one off-origin row fails the whole response
//
// Every code is derived from the semantic type's own name, so a further origin-bound type gets
// the same six rules from the `ORIGIN_BOUND_TYPES` table without a second copy of this pass.
// Pure and syntactic: no URL is parsed or fetched here.
// ---------------------------------------------------------------------------------------------

/** One origin-bound field a capability's input or output reaches. */
interface OriginBoundHit {
  semantic: SemanticType;
  list: keyof IROrigins;
  /** The field name, dotted through any resource it is reached by (`stays.host.profileUrl`). */
  path: string;
  /** The first resource the walk went through, if any — named in input refusals. */
  via?: string;
  /** Required at its own level. */
  required: boolean;
  /** The field is a `list:` of the type (per-item withholding), not a scalar. */
  isList: boolean;
  /** Reached through a `collection:` somewhere on the way. */
  inCollection: boolean;
  /** Directly a field of the resource a `response:` maps (one level below the output field). */
  topField?: string;
}

/**
 * Every origin-bound field reachable from a field map: directly, or through a resource carried by
 * representation (`type: Resource`, `collection: Resource`), recursively. A `ref:` field is a bare
 * identifier and carries no resource fields, so it is not walked — the same rule the lowering and
 * the exposure report apply.
 */
function originBoundFields(
  fields: Record<string, unknown> | undefined,
  domain: string,
  index: ReadonlySet<string>,
  resourceFields: ReadonlyMap<string, Record<string, unknown>>,
  prefix = "",
  via: string | undefined = undefined,
  inCollection = false,
  visited: ReadonlySet<string> = new Set(),
  depth = 0,
): OriginBoundHit[] {
  const hits: OriginBoundHit[] = [];
  for (const [name, value] of Object.entries(fields ?? {})) {
    const raw = (value ?? {}) as Record<string, unknown>;
    const path = prefix ? `${prefix}.${name}` : name;
    // A `list:` field has no `type:`; its item type is what is origin-bound.
    const boundType = typeof raw.type === "string" ? raw.type : typeof raw.list === "string" ? raw.list : undefined;
    if (boundType !== undefined) {
      const list = originListOf(boundType as SemanticType);
      if (list) {
        hits.push({
          semantic: boundType as SemanticType,
          list,
          path,
          ...(via ? { via } : {}),
          required: typeof raw.required === "boolean" ? raw.required : true,
          isList: typeof raw.list === "string",
          inCollection,
          ...(depth === 1 ? { topField: name } : {}),
        });
        continue;
      }
    }
    if (typeof raw.ref === "string") continue; // by identity — a bare id, never expanded
    const ref = referencedResourceName(raw);
    if (!ref) continue;
    const resolved = resolveResourceName(ref, domain, index);
    if (!resolved.ok || visited.has(resolved.canonical)) continue; // unknown-resource reports the first; a cycle adds nothing new
    hits.push(
      ...originBoundFields(
        resourceFields.get(resolved.canonical),
        domainOf(resolved.canonical),
        index,
        resourceFields,
        path,
        via ?? resolved.canonical,
        inCollection || typeof raw.collection === "string",
        new Set(visited).add(resolved.canonical),
        depth + 1,
      ),
    );
  }
  return hits;
}

/** Per-type nouns for the message wording (the codes are derived from the type name itself). */
const ORIGIN_NOUNS: Readonly<Record<string, { link: string; things: string }>> = {
  "web-page": { link: "link", things: "pages" },
  "image": { link: "image URL", things: "images" },
};
function originNoun(semantic: SemanticType): { link: string; things: string } {
  return ORIGIN_NOUNS[semantic] ?? { link: "link", things: "values" };
}

/** `https://` + host + optional port, nothing else. Host labels are letters (any script, so an
 *  internationalised name may be written as such), digits and inner hyphens; no empty label and no
 *  trailing dot. Anything a URL could add — path, query, fragment, userinfo, a wildcard, a `${VAR}`
 *  placeholder, another scheme — fails the pattern. */
const ORIGIN_ENTRY_RE = /^https:\/\/([^/?#@\s:*$[\]\\{}]+)(?::(\d{1,5}))?$/u;
const HOST_LABEL_RE = /^[\p{L}\p{N}](?:[\p{L}\p{N}-]*[\p{L}\p{N}])?$/u;

/** The comparison key of a well-formed origin entry (lower-cased host, default port elided), or
 *  `undefined` when the entry is malformed. Syntactic only — the mapper does the full WHATWG
 *  normalisation (including punycode) when it compares a value. */
export function originEntryKey(entry: string): string | undefined {
  const m = ORIGIN_ENTRY_RE.exec(entry);
  if (!m) return undefined;
  const host = m[1].toLowerCase();
  if (!host.split(".").every((label) => HOST_LABEL_RE.test(label))) return undefined;
  if (m[2] !== undefined) {
    const port = Number(m[2]);
    if (port < 1 || port > 65535) return undefined;
    return port === 443 ? `https://${host}` : `https://${host}:${port}`;
  }
  return `https://${host}`;
}

function checkOriginBound(
  model: LoadResult,
  byId: ReadonlyMap<string, CapabilityDoc>,
  index: ReadonlySet<string>,
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  const resourceFields = new Map(model.resourceDocs.map((r) => [r.resource.name, (r.resource.fields ?? {}) as Record<string, unknown>]));

  // web-page-in-input — output-only, wherever in the input it appears.
  for (const d of model.capabilityDocs) {
    const cid = d.capability.id;
    for (const hit of originBoundFields(d.capability.input, domainOf(cid), index, resourceFields)) {
      const through = hit.via ? ` through resource '${hit.via}'` : "";
      diags.push({
        severity: "error",
        code: `${hit.semantic}-in-input`,
        message: `capability '${cid}' (${d.file}) input field '${hit.path}'${through} is of type ${hit.isList ? `list: ${hit.semantic}` : hit.semantic}, which is output-only — a ${originNoun(hit.semantic).link} the model supplies is exactly what the type exists to prevent`,
      });
    }
  }

  for (const b of model.bindings) {
    const cid = b.binding.capabilityId;
    const at = `binding ${b.file} (capability '${cid}')`;
    const origins = (b.binding.origins ?? {}) as Record<string, unknown>;

    // origins-malformed — entry syntax and duplicates, per declared list.
    const declared = new Set<keyof IROrigins>();
    for (const [list, entries] of Object.entries(origins)) {
      if (!Array.isArray(entries)) continue;
      if (entries.length > 0) declared.add(list as keyof IROrigins);
      const seen = new Map<string, string>();
      for (const entry of entries) {
        const shown = typeof entry === "string" ? entry : JSON.stringify(entry);
        const key = typeof entry === "string" ? originEntryKey(entry) : undefined;
        if (!key) {
          diags.push({
            severity: "error",
            code: "origins-malformed",
            message: `${at}: origins.${list} entry '${shown}' is not a bare https origin — write https://host or https://host:port, with no path, query, fragment, userinfo, trailing slash, wildcard or \${VAR} placeholder`,
          });
          continue;
        }
        const first = seen.get(key);
        if (first !== undefined) {
          diags.push({
            severity: "error",
            code: "origins-malformed",
            message: `${at}: origins.${list} entry '${shown}' duplicates '${first}' (the same origin once normalised)`,
          });
        } else {
          seen.set(key, shown);
        }
      }
    }

    const cap = byId.get(cid);
    if (!cap) continue; // binding-without-capability already reported
    const domain = domainOf(cid);
    const hits = originBoundFields(cap.capability.output, domain, index, resourceFields);

    // An error row is mapped against `onError.errorResource` and lands in the same output field,
    // so an origin-bound field there is reached exactly like one in the success resource.
    const resp = b.binding.response as Record<string, unknown> | undefined;
    const onError = resp?.onError as Record<string, unknown> | undefined;
    if (onError && typeof onError.errorResource === "string") {
      const resolved = resolveResourceName(onError.errorResource, domain, index);
      if (resolved.ok) {
        hits.push(
          ...originBoundFields(resourceFields.get(resolved.canonical), domainOf(resolved.canonical), index, resourceFields, "", resolved.canonical, typeof resp?.collection === "string", new Set([resolved.canonical]), 1),
        );
      }
    }

    const mapped = Boolean(b.binding.response || b.binding.extract);
    const reachedLists = new Set(hits.map((h) => h.list));
    for (const semantic of new Set(hits.map((h) => h.semantic))) {
      const fieldsOf = hits.filter((h) => h.semantic === semantic).map((h) => h.path);
      const named = [...new Set(fieldsOf)].map((f) => `'${f}'`).join(", ");
      const list = originListOf(semantic)!;
      if (!mapped) {
        diags.push({
          severity: "error",
          code: `${semantic}-needs-mapping`,
          message: `${at}: output reaches ${semantic} field(s) ${named}, but the binding declares neither response: nor extract: — a pass-through response is never checked, so the origin guarantee could not hold. Map the output with response: or extract:`,
        });
      }
      if (!declared.has(list)) {
        diags.push({
          severity: "error",
          code: `${semantic}-no-origins`,
          message: `${at}: output reaches ${semantic} field(s) ${named}, but the binding declares no origins.${list} — there is nothing to check a value against. Declare the origin(s) these ${originNoun(semantic).things} live on`,
        });
      }
    }

    // origins-unused — a declared list no origin-bound field reaches.
    for (const list of declared) {
      if (reachedLists.has(list)) continue;
      diags.push({
        severity: "warning",
        code: "origins-unused",
        message: `${at}: declares origins.${list}, but capability '${cid}''s output reaches no field whose type is checked against it`,
      });
    }

    // web-page-required-in-collection — without onError, one off-origin row fails every row.
    if (!onError) {
      const loosened = new Set(
        Object.entries((resp?.map ?? {}) as Record<string, unknown>)
          .filter(([, v]) => typeof v === "object" && v !== null && (v as Record<string, unknown>).required === false)
          .map(([k]) => k),
      );
      const reported = new Set<string>();
      for (const hit of hits) {
        if (!hit.inCollection || !hit.required) continue;
        if (hit.isList) continue; // a list withholds per item: an off-origin item never fails a row
        if (hit.topField !== undefined && loosened.has(hit.topField)) continue;
        if (reported.has(hit.path)) continue;
        reported.add(hit.path);
        diags.push({
          severity: "warning",
          code: `${hit.semantic}-required-in-collection`,
          message: `${at}: ${hit.semantic} field '${hit.path}' is required inside a collection and the response mapping has no onError — one row whose value is outside the declared origins fails the whole response. Consider making the field optional (required: false), so that row only loses the ${originNoun(hit.semantic).link}`,
        });
      }
    }
  }
  return diags;
}
