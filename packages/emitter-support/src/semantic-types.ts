// @archstone/emitter-support — the load-time semantic-type check (#214)
//
// An IR is produced by one version of the compiler and consumed by whatever runtime is
// installed. A runtime older than the compiler can meet a semantic type it has never heard of.
// Lowering that type as `string` advertises a contract the runtime cannot honour and rejects
// valid values with "expected string"; refusing the artifact when it is LOADED names the real
// problem. `assertKnownSemanticTypes` is that refusal, called from the `Registry` constructor,
// which every IR entry point (the MCP runtime, the embedded agent, the CLI) constructs.
// The lowering, the input validator and the response mapper also throw this same error on a type
// they do not recognise, so no code path can treat an unknown type as a string.

import { SEMANTIC_TYPES, type IR, type IRField, type SemanticType } from "@archstone/compiler";

/** Thrown when an IR (or a lowering, validator or mapper given one) names a semantic type this
 *  build does not know. `type` is the offending name exactly as it appears in the artifact;
 *  `path` locates the field, e.g. `tools[tourism.search].input.guests`. */
export class UnknownSemanticTypeError extends Error {
  readonly type: string;
  readonly path: string;
  constructor(type: string, path: string) {
    super(
      `unknown semantic type '${type}' at ${path} — this runtime does not know it; ` +
        `the IR was likely produced by a newer compiler. Use the same Archstone version for the compiler and the runtime`,
    );
    this.name = "UnknownSemanticTypeError";
    this.type = type;
    this.path = path;
  }
}

/** Whether this build knows `type`. The one predicate every default branch asks. */
export function isKnownSemanticType(type: unknown): type is SemanticType {
  return typeof type === "string" && SEMANTIC_TYPES.has(type as SemanticType);
}

/** Always throws: the terminal statement of a default branch that must never be reached. */
export function refuseSemanticType(type: unknown, path: string): never {
  throw new UnknownSemanticTypeError(String(type), path);
}

/** Throw `UnknownSemanticTypeError` unless `type` is known. */
export function assertKnownSemanticType(type: unknown, path: string): asserts type is SemanticType {
  if (!isKnownSemanticType(type)) throw new UnknownSemanticTypeError(String(type), path);
}

function checkFields(fields: IRField[] | undefined, base: string): void {
  for (const f of fields ?? []) {
    const t = f.type;
    if (t?.kind === "scalar") assertKnownSemanticType(t.semantic, `${base}.${f.name}`);
    else if (t?.kind === "list") assertKnownSemanticType(t.items, `${base}.${f.name}[]`);
  }
}

/** Walk every field of every tool (input and output) and every resource, scalar and list-item
 *  types alike, and throw `UnknownSemanticTypeError` on the first unknown one. */
export function assertKnownSemanticTypes(ir: IR): void {
  for (const tool of ir.tools ?? []) {
    checkFields(tool.input, `tools[${tool.id}].input`);
    checkFields(tool.output, `tools[${tool.id}].output`);
  }
  for (const [name, fields] of Object.entries(ir.resources ?? {})) {
    checkFields(fields, `resources[${name}]`);
  }
}
