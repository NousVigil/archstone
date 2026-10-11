// @archstone/init — capability inference from an existing API (#37 / ADD-37).
//
// A compiler needs a manifest, and a stranger's first manifest is the friction. `init` reads
// whatever a company already has (a spec, a recorded response), asks a human the questions no
// tool can answer for them — is this a capability? is it `read`? what is it called? — and
// writes a manifest the REAL compiler has already compiled.
//
// THIS ROOT EXPORT IS PURE. No `node:fs`, no HTTP, no terminal, no clock, nothing under
// `providers/`, and no MCP SDK. Two things follow, and both are the reason for the split:
//   - `@archstone/init/loop` owns the filesystem, and only it;
//   - a hosted "point us at your spec" flow can call this identical core with bytes it
//     obtained however it likes, with no second implementation of the inference (§9).
//
// THERE IS NO LLM HERE. Not in this increment, not behind a flag, not on any path. Everything
// this package emits is derived mechanically from a source, or supplied by a human, or not
// emitted at all — which is why the same input produces the same output on every run, and why
// a user can put `init` in CI and diff the result.

export {
  absent,
  declared,
  isKnown,
  observed,
  valueOr,
  valueOrUndefined,
  type CatalogColumn,
  type CatalogRelation,
  type CatalogSnapshot,
  type Derivation,
  type DraftArrayNode,
  type DraftAuth,
  type DraftOperationAuth,
  type DraftInputField,
  type DraftModel,
  type DraftNode,
  type DraftObjectNode,
  type DraftOperation,
  type DraftProperty,
  type DraftRowErrors,
  type DraftScalarNode,
  type DraftSqlOperation,
  type DraftUnknownNode,
  type Effect,
  type EffectHint,
  type Fact,
  type InputLocation,
  type ObservedPresence,
  type SourceAdapter,
  type SourceInput,
  type SourceObservation,
  type SqlRelationKind,
} from "./model";

export {
  authEnvVar,
  baseUrlEnvVar,
  keptDecisions,
  providerId,
  validateDecisionRecord,
  type CapabilityDecision,
  type DecisionRecord,
  type DecisionRecordValidation,
} from "./decisions";

export {
  REASON_CODES,
  note,
  reasonSummary,
  skipsOperation,
  type Note,
  type NoteScope,
  type ReasonCode,
} from "./reasons";

export {
  classifyRequired,
  locusCandidates,
  locusLeaves,
  propertyAccessor,
  selectLocus,
  type LocusCandidate,
  type LocusCensus,
  type LocusLeaf,
  type LocusSelection,
  type NullabilityEvidence,
  type RequiredBasis,
  type RequiredClassification,
} from "./d9";

export { emit, type EmitResult, type EmittedCapability, type RecordedContract, type SkippedCandidate } from "./emit";

export { formatReport, type ReportInput, type ReportedProbe } from "./report";

export {
  diffIR,
  formatDiff,
  type EffectDivergence,
  type FieldSetDivergence,
  type IRDiff,
  type KnownMiss,
  type NamingDelta,
  type RequiredDivergence,
  type ToolMatch,
  type ToolRef,
} from "./diff";

export {
  CAPABILITY_ID_RE,
  COMPANY_ID_RE,
  RESOURCE_NAME_RE,
  domainOfCapabilityId,
  localResourceName,
  outputFieldName,
  qualifyResourceName,
} from "./names";

// ---------------------------------------------------------------------------------------
// Adapters (D-1). Exported from the ROOT because `adapt()` is pure — the whole reason the
// adapter boundary sits where it does is that a hosted flow can call this with bytes it
// obtained however it likes, with no second implementation of the inference.
// ---------------------------------------------------------------------------------------

export { openApiAdapter } from "./adapters/openapi";
export { postgresAdapter } from "./adapters/postgres";

// The YAML scalar/key quoting rules, shared rather than re-implemented.
//
// `archstone adopt` (ADD-117) appends to a manifest a human already owns, and it has to quote
// what it writes by exactly the same conservative rules `init` uses — a second copy is how the
// two drift, and an escaping bug on a review surface is the failure this package's `yaml.ts`
// header exists to argue against. Exported as-is; no behaviour change.
export { yamlKey, yamlScalar, type YamlScalar } from "./yaml";
