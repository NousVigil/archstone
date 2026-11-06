// @archstone/cli — the surgical half of `archstone adopt` (ADD-117).
//
// These manifests are REVIEW SURFACES a human owns, and their comments were written by that
// human. A YAML library would re-emit them and lose every one — trading the reviewability the
// product sells for the convenience of the tool that sells it. So this appends text to two
// known blocks and touches nothing else, byte for byte.
//
// Correctness is not argued from the edit; it is PROVED after it. The caller runs the real
// loader, compiler and probe over the result and keeps nothing if any of them fails, exactly as
// `init` already works. The blast radius of a bug in here is a refused run.

import { yamlKey, yamlScalar } from "@archstone/init";
import type { SemanticType } from "@archstone/compiler";

export interface AdoptionEdit {
  /** The resource field name (`"resource-field"`) or output field name (`"output-array"`,
   *  #82), e.g. `boardType` or `warnings`. */
  field: string;
  /** The path written into the binding's `response.map` (relative to a collection item) or,
   *  for `"output-array"`, into `extract:` (body-root, all-matches — `$.foo[*]`). */
  itemPath: string;
  semantic: SemanticType;
  /** Typed by a human at the gate — never generated (ADD-117 D-4). */
  description: string;
  /** Mirrors `AdoptableField.kind` (#82, `@archstone/runtime`'s `planAdoption`) — which file(s)
   *  this edit targets and how. `"resource-field"` (pre-#82, the default): the mapped
   *  RESOURCE gains a `type:` field, the binding's `response.map` gains an entry.
   *  `"output-array"`: the CAPABILITY's own `output:` gains a `list:` field, the binding's
   *  `extract:` (created if the binding declares none yet) gains an entry. */
  kind: "resource-field" | "output-array";
}

export type ApplyResult =
  | { ok: true; resource: string; binding: string; capability: string }
  | { ok: false; problem: string };

/** One document in, one document out — `applyAdoption`'s two-file result would leave a caller
 *  holding an empty `resource` that means nothing. */
export type RewriteResult = { ok: true; binding: string } | { ok: false; problem: string };

/** A located block: where its body ends, and the indent its children sit at. */
interface Block {
  /** Index of the first line AFTER the block's body — where an append goes. */
  end: number;
  /** The exact leading whitespace a child of this block carries. */
  indent: string;
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/**
 * Locate `key:` as a block header within `[from, to)`, and find where its body ends.
 *
 * REFUSES on anything but exactly one match. Appending to the first of two `map:` blocks
 * would corrupt a manifest in a way that still parses — the failure mode this whole module is
 * built to avoid — so ambiguity is an error, never a choice.
 */
function locate(lines: string[], from: number, to: number, key: string): Block | { problem: string } {
  const header = new RegExp(`^(\\s*)${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}:\\s*(#.*)?$`);
  const hits: number[] = [];
  for (let i = from; i < to; i++) if (header.test(lines[i])) hits.push(i);
  if (hits.length === 0) return { problem: `could not find a '${key}:' block to append to` };
  if (hits.length > 1) return { problem: `found ${hits.length} '${key}:' blocks; refusing to guess which one to extend` };

  const start = hits[0];
  const own = indentOf(lines[start]);
  let end = to;
  for (let i = start + 1; i < to; i++) {
    if (lines[i].trim() === "") continue;
    if (indentOf(lines[i]) <= own) {
      end = i;
      break;
    }
  }
  // Back off over trailing blank lines so the append lands inside the block, not after the gap
  // that separates it from whatever follows.
  while (end > start + 1 && lines[end - 1].trim() === "") end--;

  // Children set the indent; an empty block falls back to the convention every manifest uses.
  let indent = " ".repeat(own + 2);
  for (let i = start + 1; i < end; i++) {
    if (lines[i].trim() === "") continue;
    indent = lines[i].slice(0, indentOf(lines[i]));
    break;
  }
  return { end, indent };
}

function nest(lines: string[], path: string[]): Block | { problem: string } {
  let from = 0;
  let to = lines.length;
  let block: Block | { problem: string } = { problem: "empty path" };
  for (const key of path) {
    block = locate(lines, from, to, key);
    if ("problem" in block) return block;
    // Descend: the next key must live inside this block's body.
    to = block.end;
    for (let i = from; i < to; i++) {
      const header = new RegExp(`^\\s*${key}:\\s*(#.*)?$`);
      if (header.test(lines[i])) {
        from = i + 1;
        break;
      }
    }
  }
  return block;
}

function insert(lines: string[], at: number, added: string[]): string[] {
  return [...lines.slice(0, at), ...added, ...lines.slice(at)];
}

/**
 * Locate `path` as a nested block, or CREATE it as a fresh, empty child of the block one level
 * up when it does not exist yet (#82) — a binding with no `extract:` at all is the ordinary
 * case (most bindings only ever needed `response:`), and refusing to adopt a scalar-array
 * candidate for that reason would make `archstone adopt` offer something it cannot do.
 *
 * Only the LAST path segment is created; every segment before it must already exist (a binding
 * missing `binding:` itself is not this function's problem to solve).
 */
function nestOrCreate(lines: string[], path: string[]): { lines: string[]; block: Block } | { problem: string } {
  const parentPath = path.slice(0, -1);
  const key = path[path.length - 1];

  const existing = nest(lines, path);
  if (!("problem" in existing)) return { lines, block: existing };

  const parent = parentPath.length === 0 ? { end: lines.length, indent: "" } : nest(lines, parentPath);
  if ("problem" in parent) return parent;

  // The new header joins the parent's other direct children, so it MUST be inserted before the
  // parent's own body ends — `parent.end` is exactly that boundary.
  const headerIndent = parent.indent.length > 0 ? parent.indent : "  ";
  const withHeader = insert(lines, parent.end, [`${headerIndent}${key}:`]);
  const block = nest(withHeader, path);
  if ("problem" in block) return block; // defensive — the header we just wrote should always resolve
  return { lines: withHeader, block };
}

/**
 * Append adopted fields to a resource document, a capability document, and a binding.
 *
 * `required: false` is written unconditionally (ADD-117 D-3): one observation is not evidence
 * the provider always returns the field, and a wrongly-required field turns the next absent
 * value into a fail-closed VIOLATION on a capability that worked yesterday.
 *
 * Branches on `edit.kind` (#82): a `"resource-field"` edit appends a `type:` field to the
 * RESOURCE document and an entry to the binding's `response.map`; an `"output-array"` edit
 * appends a `list:` field to the CAPABILITY document's `output:` and an entry to the binding's
 * `extract:` (created via `nestOrCreate` if the binding declares none yet). The two kinds never
 * mix within one call in practice (`archstone adopt` batches by tool), but nothing here assumes
 * that — each edit is routed by its own `kind`.
 */
export function applyAdoption(resourceYaml: string, bindingYaml: string, capabilityYaml: string, edits: AdoptionEdit[]): ApplyResult {
  if (edits.length === 0) return { ok: true, resource: resourceYaml, binding: bindingYaml, capability: capabilityYaml };

  const resourceEdits = edits.filter((e) => e.kind === "resource-field");
  const arrayEdits = edits.filter((e) => e.kind === "output-array");

  let resourceLines = resourceYaml.split("\n");
  let bindingLines = bindingYaml.split("\n");
  let capabilityLines = capabilityYaml.split("\n");

  if (resourceEdits.length > 0) {
    const fields = nest(resourceLines, ["resource", "fields"]);
    if ("problem" in fields) return { ok: false, problem: `resource: ${fields.problem}` };
    const added: string[] = [];
    for (const e of resourceEdits) {
      added.push(
        `${fields.indent}${yamlKey(e.field)}:`,
        `${fields.indent}  type: ${yamlScalar(e.semantic)}`,
        `${fields.indent}  required: false`,
        `${fields.indent}  description: ${yamlScalar(e.description)}`,
      );
    }
    resourceLines = insert(resourceLines, fields.end, added);

    const map = nest(bindingLines, ["binding", "response", "map"]);
    if ("problem" in map) return { ok: false, problem: `binding: ${map.problem}` };
    bindingLines = insert(
      bindingLines,
      map.end,
      resourceEdits.map((e) => `${map.indent}${yamlKey(e.field)}: ${yamlScalar(e.itemPath)}`),
    );
  }

  if (arrayEdits.length > 0) {
    const output = nestOrCreate(capabilityLines, ["capability", "output"]);
    if ("problem" in output) return { ok: false, problem: `capability: ${output.problem}` };
    capabilityLines = output.lines;
    const added: string[] = [];
    for (const e of arrayEdits) {
      added.push(
        `${output.block.indent}${yamlKey(e.field)}:`,
        `${output.block.indent}  list: ${yamlScalar(e.semantic)}`,
        `${output.block.indent}  required: false`,
        `${output.block.indent}  description: ${yamlScalar(e.description)}`,
      );
    }
    capabilityLines = insert(capabilityLines, output.block.end, added);

    const extract = nestOrCreate(bindingLines, ["binding", "extract"]);
    if ("problem" in extract) return { ok: false, problem: `binding: ${extract.problem}` };
    bindingLines = insert(
      extract.lines,
      extract.block.end,
      arrayEdits.map((e) => `${extract.block.indent}${yamlKey(e.field)}: ${yamlScalar(e.itemPath)}`),
    );
  }

  return { ok: true, resource: resourceLines.join("\n"), binding: bindingLines.join("\n"), capability: capabilityLines.join("\n") };
}

/**
 * Replace a binding's recorded `fingerprint` and `shape` with a fresh recording.
 *
 * Same surgical posture as `applyAdoption`: these two values are the only ones in the file
 * written by machine rather than by a human, so they are the only ones rewritten. `verifiedAt`
 * is left alone — it is the human-meaningful "when did we last check", and `recordContract`
 * already owns stamping it through `init`.
 *
 * Both values come from ONE response (ADD-117 R-4). Recording them from a second probe would
 * let a backend that changed between the two produce a contract describing neither.
 */
export function applyContractRecording(bindingYaml: string, fingerprint: string, shape: Record<string, string>): RewriteResult {
  const lines = bindingYaml.split("\n");
  const fpIdx = lines.findIndex((l) => /^\s*fingerprint:\s/.test(l));
  if (fpIdx === -1) return { ok: false, problem: "binding: no contract fingerprint to update" };

  const indent = lines[fpIdx].slice(0, indentOf(lines[fpIdx]));
  const rendered = [
    `${indent}fingerprint: ${yamlScalar(fingerprint)}`,
    `${indent}shape:`,
    // Sorted, so re-adopting against an unchanged backend is a no-op diff rather than a
    // reshuffle a reviewer has to read.
    ...Object.keys(shape)
      .sort()
      .map((k) => `${indent}  ${yamlKey(k)}: ${yamlScalar(shape[k])}`),
  ];

  // Drop the previous `shape:` block if there is one, so re-adoption replaces rather than
  // accumulates. Its body is every following line indented deeper than the header.
  const removeFrom = fpIdx;
  let removeTo = fpIdx + 1;
  const shapeIdx = lines.findIndex((l, i) => i > fpIdx && /^\s*shape:\s*$/.test(l));
  if (shapeIdx !== -1 && lines.slice(fpIdx + 1, shapeIdx).every((l) => l.trim() === "" || l.trim().startsWith("#"))) {
    removeTo = shapeIdx + 1;
    const own = indentOf(lines[shapeIdx]);
    while (removeTo < lines.length && (lines[removeTo].trim() === "" || indentOf(lines[removeTo]) > own)) removeTo++;
    // Keep any comment lines that sat between the fingerprint and the shape header.
    const preserved = lines.slice(fpIdx + 1, shapeIdx);
    return {
      ok: true,
      binding: [...lines.slice(0, removeFrom), rendered[0], ...preserved, ...rendered.slice(1), ...lines.slice(removeTo)].join("\n"),
    };
  }

  return { ok: true, binding: [...lines.slice(0, fpIdx), ...rendered, ...lines.slice(fpIdx + 1)].join("\n") };
}

/** What `insertContract` writes — one recording, as `recordContract` returned it. */
export interface ContractBlock {
  fingerprint: string;
  /** Optional, as in `emit.ts`: a recording with no shape writes no `shape:` block. */
  shape?: Record<string, string>;
  /** The recording's own timestamp (`fixture.recordedAt`), never "now" at write time. */
  verifiedAt: string;
  /** Manifest-relative path of the golden fixture the recording replayed. */
  fixture: string;
}

/**
 * Append a `contract:` block to a binding that has none (`archstone record`).
 *
 * Rendered as `@archstone/init`'s `emit.ts` renders one — the same comment, the same keys in the
 * same order, `shape` sorted — so a recorded contract reads the same whichever verb wrote it, and
 * a later `adopt`/`record --rerecord` finds it where `applyContractRecording` expects it.
 *
 * It goes at the END of the top-level `binding:` block, at that block's child indent, and every
 * other byte of the file is left exactly as it was. REFUSES when a `contract:` already exists
 * (replacing one is `applyContractRecording`'s job, and a second key would be a document the
 * loader rejects or, worse, silently resolves) or when the `binding:` block is not exactly one
 * top-level key.
 */
export function insertContract(bindingYaml: string, contract: ContractBlock): RewriteResult {
  const lines = bindingYaml.split("\n");
  const block = locate(lines, 0, lines.length, "binding");
  if ("problem" in block) return { ok: false, problem: `binding: ${block.problem}` };
  const start = lines.findIndex((l) => /^binding:\s*(#.*)?$/.test(l));
  if (start === -1) return { ok: false, problem: "binding: the 'binding:' block is not at the top level; refusing to guess where a contract goes" };

  const child = block.indent;
  const existing = new RegExp(`^${child}contract\\s*:`);
  if (lines.slice(start + 1, block.end).some((l) => existing.test(l))) {
    return { ok: false, problem: "binding: already declares a contract: — replace it with --rerecord, never a second one" };
  }

  const deeper = `${child}  `;
  const added = [
    "",
    `${child}# What we recorded the live backend returning, at the time shown. \`archstone verify\``,
    `${child}# replays this fixture's \`request\` and compares the response shape — that is how you`,
    `${child}# find out the backend changed before an agent does.`,
    `${child}contract:`,
    `${deeper}source: recorded`,
    `${deeper}fingerprint: ${yamlScalar(contract.fingerprint)}`,
    ...(contract.shape
      ? [
          `${deeper}shape:`,
          ...Object.keys(contract.shape)
            .sort()
            .map((k) => `${deeper}  ${yamlKey(k)}: ${yamlScalar(contract.shape![k])}`),
        ]
      : []),
    `${deeper}verifiedAt: ${yamlScalar(contract.verifiedAt)}`,
    `${deeper}probe:`,
    `${deeper}  fixture: ${yamlScalar(contract.fixture)}`,
  ];
  return { ok: true, binding: insert(lines, block.end, added).join("\n") };
}

/**
 * Re-stamp an existing contract's `verifiedAt` (`archstone record --rerecord`).
 *
 * `applyContractRecording` deliberately leaves it alone for `adopt`, whose act is declaring a
 * field. `record --rerecord`'s act IS the check `verifiedAt` dates, so there it moves with the
 * fingerprint. A contract with no `verifiedAt:` line is returned unchanged — adding a key the
 * author left out is not this function's call. Only the value changes: the line's indent and any
 * trailing comment are kept.
 */
export function stampVerifiedAt(bindingYaml: string, verifiedAt: string): RewriteResult {
  const lines = bindingYaml.split("\n");
  const contract = nest(lines, ["binding", "contract"]);
  if ("problem" in contract) return { ok: false, problem: `binding: ${contract.problem}` };
  const header = lines.findIndex((l) => /^\s*contract:\s*(#.*)?$/.test(l));
  const re = new RegExp(`^(${contract.indent}verifiedAt:\\s*)("[^"]*"|[^\\s#]+)(.*)$`);
  const hits: number[] = [];
  for (let i = header + 1; i < contract.end; i++) if (re.test(lines[i])) hits.push(i);
  if (hits.length === 0) return { ok: true, binding: bindingYaml };
  if (hits.length > 1) return { ok: false, problem: `binding: found ${hits.length} 'verifiedAt:' lines in the contract; refusing to guess` };
  lines[hits[0]] = lines[hits[0]].replace(re, (_m, key: string, _old: string, rest: string) => `${key}${yamlScalar(verifiedAt)}${rest}`);
  return { ok: true, binding: lines.join("\n") };
}
