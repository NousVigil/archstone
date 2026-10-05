// @archstone/compiler — IR diff (ADD-309 §4, #77).
//
// Pure comparison of two compiled IRs: what changed FOR THE AGENT between two declarations.
// No I/O, no clock, no fs (ADD-309 D-8) — the CLI compiles, renders and exits.
//
// Two rules are load-bearing rather than tidy:
//
//   - `contract` is never read (D-5). A diff describes two declarations; `verify` describes one
//     backend. `build` strips `contract`, so a diff over two built artifacts must be complete
//     without it.
//   - The severity of every entry is decided by §4's table and nothing else. `IRDiffKind` is a
//     closed set with one member per row; a consumer filtering on one is permanent, so a row
//     changes only by an amendment to the ADD, never by a fix commit here (R-1).

import type { IR, IRField, IRPolicyRule, IRTool, IRType, Lifecycle } from "./ir";

export type IRDiffSeverity = "breaking" | "notable" | "compatible";

/** One member per row of ADD-309 §4, in the table's order. `resource-field-changed` and
 *  `binding-changed` are the two kinds whose severity is not fixed by the kind alone — see
 *  `diffResources` and `diffBinding`. */
export type IRDiffKind =
  | "capability-removed" // breaking
  | "capability-added" // compatible
  | "effect-changed" // breaking, any direction (D-3)
  | "lifecycle-retired" // breaking
  | "lifecycle-deprecated" // notable
  | "lifecycle-forward" // compatible — experimental → beta → stable
  | "lifecycle-reversed" // breaking — any other move; see `diffLifecycle`
  | "input-added-required" // breaking
  | "input-added-optional" // compatible
  | "input-removed" // breaking
  | "input-now-required" // breaking — optional → required
  | "input-now-optional" // compatible — required → optional
  | "input-retyped" // breaking
  | "output-removed" // breaking
  | "output-added" // compatible
  | "output-now-optional" // breaking — required → optional
  | "output-now-required" // compatible — optional → required
  | "output-retyped" // breaking
  | "resource-field-changed" // as the field row it implies, reported once on the resource
  | "policy-narrowed" // breaking — `allow` narrowed, or `deny` gained a principal
  | "policy-widened" // notable — `allow` widened, or `deny` lost a principal
  | "policy-rate-limit-changed" // notable — tightened, loosened, added or removed
  | "policy-tokens-changed" // notable
  | "description-changed" // compatible
  | "binding-changed"; // compatible, except a removed connector — see `diffBinding`

export interface IRDiffEntry {
  severity: IRDiffSeverity;
  kind: IRDiffKind;
  capabilityId?: string; // absent on a resource entry
  resource?: string; // present on a resource entry
  affects?: string[]; // resource entry: capability ids whose declared shape reaches it, sorted
  path?: string; // the field, when the row is about one
  before?: unknown;
  after?: unknown;
  detail: string; // one sentence, composed here, rendered verbatim
}

export interface IRDiff {
  before: { company: string; version: "0" };
  after: { company: string; version: "0" };
  entries: IRDiffEntry[]; // sorted: capabilityId (or resource name), then path
  summary: { breaking: number; notable: number; compatible: number };
}

// ---------------------------------------------------------------------------------------------
// Normalisation (R-5): an older artifact lacks members a newer compiler emits. Absent is empty,
// so a pre-`policyRules` artifact diffed against itself — or against a newer one that carries
// `policyRules: []` — reports nothing spurious.
// ---------------------------------------------------------------------------------------------

interface NormTool {
  id: string;
  description: string;
  effect: IRTool["effect"];
  provider: string;
  policies: string[];
  policyRules: IRPolicyRule[];
  lifecycle: Lifecycle;
  input: IRField[];
  output: IRField[];
  connector: IRTool["connector"];
  response: IRTool["response"];
  extract: NonNullable<IRTool["extract"]>;
  origins: IRTool["origins"];
}

function normalise(t: IRTool): NormTool {
  return {
    id: t.id,
    description: t.description ?? "",
    effect: t.effect,
    provider: t.provider ?? "",
    policies: t.policies ?? [],
    policyRules: t.policyRules ?? [],
    lifecycle: t.lifecycle ?? "stable", // ADD-24 D-4's compiler default
    input: t.input ?? [],
    output: t.output ?? [],
    connector: t.connector,
    response: t.response,
    extract: t.extract ?? [],
    origins: t.origins,
    // `contract` deliberately not copied (D-5).
  };
}

/** Key-order-independent serialisation, for deep equality of plain JSON data. */
function canonical(v: unknown): string {
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const entries = Object.entries(v as Record<string, unknown>)
      .filter(([, x]) => x !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, x]) => `${JSON.stringify(k)}:${canonical(x)}`).join(",")}}`;
  }
  return JSON.stringify(v);
}

/** An enum's `values` are a set: reordering them changes nothing an agent can send or read. */
function typeKey(t: IRType): string {
  const values = "values" in t && t.values ? [...t.values].sort() : undefined;
  return canonical({ ...t, values });
}

function renderType(t: IRType): string {
  switch (t.kind) {
    case "scalar":
      return t.values ? `${t.semantic}(${t.values.join("|")})` : t.semantic;
    case "list":
      return t.values ? `list of ${t.items}(${t.values.join("|")})` : `list of ${t.items}`;
    case "collection":
      return `collection of ${t.of}`;
    case "resource":
      return t.identity ? `ref ${t.name}` : t.name;
  }
}

function cmp(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedSet(xs: Iterable<string>): string[] {
  return [...new Set(xs)].sort(cmp);
}

function quoteList(xs: string[]): string {
  return xs.map((x) => `'${x}'`).join(", ");
}

/** The fixed severity of every kind but `resource-field-changed`, which takes the row it implies.
 *  `binding-changed` is `compatible` here; `diffBinding` overrides it for one case. */
const SEVERITY: Record<Exclude<IRDiffKind, "resource-field-changed">, IRDiffSeverity> = {
  "capability-removed": "breaking",
  "capability-added": "compatible",
  "effect-changed": "breaking",
  "lifecycle-retired": "breaking",
  "lifecycle-deprecated": "notable",
  "lifecycle-forward": "compatible",
  "lifecycle-reversed": "breaking",
  "input-added-required": "breaking",
  "input-added-optional": "compatible",
  "input-removed": "breaking",
  "input-now-required": "breaking",
  "input-now-optional": "compatible",
  "input-retyped": "breaking",
  "output-removed": "breaking",
  "output-added": "compatible",
  "output-now-optional": "breaking",
  "output-now-required": "compatible",
  "output-retyped": "breaking",
  "policy-narrowed": "breaking",
  "policy-widened": "notable",
  "policy-rate-limit-changed": "notable",
  "policy-tokens-changed": "notable",
  "description-changed": "compatible",
  "binding-changed": "compatible",
};

type Emit = (e: Omit<IRDiffEntry, "severity"> & { severity?: IRDiffSeverity }) => void;

// ---------------------------------------------------------------------------------------------
// Field rows (§4: input / output). Shared by capability fields and resource fields: a resource
// field change is classified "as the output row it implies" (and, where an input reaches the
// resource, the input row too — the worse of the two wins).
// ---------------------------------------------------------------------------------------------

type FieldChange =
  | { change: "added"; field: IRField }
  | { change: "removed"; field: IRField }
  | { change: "now-required" | "now-optional"; field: IRField }
  | { change: "retyped"; field: IRField; from: IRType; to: IRType }
  | { change: "description"; field: IRField; from?: string; to?: string };

function fieldChanges(before: IRField[], after: IRField[]): FieldChange[] {
  const b = new Map(before.map((f) => [f.name, f]));
  const a = new Map(after.map((f) => [f.name, f]));
  const out: FieldChange[] = [];
  for (const [name, bf] of b) {
    const af = a.get(name);
    if (!af) {
      out.push({ change: "removed", field: bf });
      continue;
    }
    if (typeKey(bf.type) !== typeKey(af.type)) out.push({ change: "retyped", field: af, from: bf.type, to: af.type });
    if (bf.required !== af.required) out.push({ change: af.required ? "now-required" : "now-optional", field: af });
    if ((bf.description ?? "") !== (af.description ?? "")) {
      out.push({ change: "description", field: af, from: bf.description, to: af.description });
    }
  }
  for (const [name, af] of a) if (!b.has(name)) out.push({ change: "added", field: af });
  return out;
}

function inputKind(c: FieldChange): IRDiffKind {
  switch (c.change) {
    case "added":
      return c.field.required ? "input-added-required" : "input-added-optional";
    case "removed":
      return "input-removed";
    case "now-required":
      return "input-now-required";
    case "now-optional":
      return "input-now-optional";
    case "retyped":
      return "input-retyped";
    case "description":
      return "description-changed";
  }
}

function outputKind(c: FieldChange): IRDiffKind {
  switch (c.change) {
    case "added":
      return "output-added";
    case "removed":
      return "output-removed";
    case "now-required":
      return "output-now-required";
    case "now-optional":
      return "output-now-optional";
    case "retyped":
      return "output-retyped";
    case "description":
      return "description-changed";
  }
}

function fieldSentence(c: FieldChange, role: string): string {
  const n = `'${c.field.name}'`;
  switch (c.change) {
    case "added":
      return `${role} ${n} added (${c.field.required ? "required" : "optional"}, ${renderType(c.field.type)})`;
    case "removed":
      return `${role} ${n} removed`;
    case "now-required":
      return `${role} ${n} changed from optional to required`;
    case "now-optional":
      return `${role} ${n} changed from required to optional`;
    case "retyped":
      return `${role} ${n} type changed: ${renderType(c.from)} → ${renderType(c.to)}`;
    case "description":
      return `${role} ${n} description changed`;
  }
}

function fieldValues(c: FieldChange): { before?: unknown; after?: unknown } {
  switch (c.change) {
    case "added":
      return { after: { required: c.field.required, type: c.field.type } };
    case "removed":
      return { before: { required: c.field.required, type: c.field.type } };
    case "now-required":
      return { before: false, after: true };
    case "now-optional":
      return { before: true, after: false };
    case "retyped":
      return { before: c.from, after: c.to };
    case "description":
      return { before: c.from, after: c.to };
  }
}

function diffFields(id: string, role: "input" | "output", before: IRField[], after: IRField[], emit: Emit): void {
  for (const c of fieldChanges(before, after)) {
    emit({
      kind: role === "input" ? inputKind(c) : outputKind(c),
      capabilityId: id,
      path: `${role}.${c.field.name}`,
      ...fieldValues(c),
      detail: fieldSentence(c, role),
    });
  }
}

// ---------------------------------------------------------------------------------------------
// Lifecycle (§4 rows 4–6)
// ---------------------------------------------------------------------------------------------

const FORWARD_RANK: Partial<Record<Lifecycle, number>> = { experimental: 0, beta: 1, stable: 2 };

/**
 * → `retired` is breaking, → `deprecated` notable, and a forward step along
 * `experimental → beta → stable` compatible. §4 has no row for any other move (`stable → beta`,
 * `deprecated → stable`, `retired → stable`, …); R-1 resolves an unlisted case toward
 * `breaking`, so those are `lifecycle-reversed` rather than being folded into a row that does not
 * describe them. A human reading the report overrides a strict gate; nobody overrides a silent one.
 */
function diffLifecycle(id: string, before: Lifecycle, after: Lifecycle, emit: Emit): void {
  if (before === after) return;
  const base = { capabilityId: id, path: "lifecycle", before, after };
  const move = `${before} → ${after}`;
  if (after === "retired") {
    emit({ ...base, kind: "lifecycle-retired", detail: `lifecycle changed: ${move} — no longer invocable` });
  } else if (after === "deprecated") {
    emit({ ...base, kind: "lifecycle-deprecated", detail: `lifecycle changed: ${move} — still invocable` });
  } else if ((FORWARD_RANK[before] ?? Infinity) < (FORWARD_RANK[after] ?? -Infinity)) {
    emit({ ...base, kind: "lifecycle-forward", detail: `lifecycle changed: ${move}` });
  } else {
    emit({ ...base, kind: "lifecycle-reversed", detail: `lifecycle changed: ${move} — a move the classification table does not list` });
  }
}

// ---------------------------------------------------------------------------------------------
// Policy (§4 rows 19–22). Per rule id, with the evaluator's own composition in mind
// (`@archstone/emitter-support` `evaluatePolicy`): a non-empty `allow` is a restriction and an
// absent or empty one is none, so `[] → ['a']` narrows and `['a'] → []` widens; a rule that
// appears or disappears is compared against an empty rule.
// ---------------------------------------------------------------------------------------------

function diffPolicyRules(id: string, before: IRPolicyRule[], after: IRPolicyRule[], emit: Emit): void {
  const b = new Map(before.map((r) => [r.id, r]));
  const a = new Map(after.map((r) => [r.id, r]));
  for (const ruleId of sortedSet([...b.keys(), ...a.keys()])) {
    const br = b.get(ruleId) ?? { id: ruleId };
    const ar = a.get(ruleId) ?? { id: ruleId };
    const at = (m: string) => `policyRules.${ruleId}.${m}`;

    const ba = sortedSet(br.allow ?? []);
    const aa = sortedSet(ar.allow ?? []);
    if (canonical(ba) !== canonical(aa)) {
      const lost = ba.filter((p) => !aa.includes(p));
      const gained = aa.filter((p) => !ba.includes(p));
      const values = { before: ba, after: aa };
      if (ba.length === 0) {
        emit({ kind: "policy-narrowed", capabilityId: id, path: at("allow"), ...values, detail: `policy '${ruleId}' now restricts callers: allow set to ${quoteList(aa)}` });
      } else if (aa.length === 0) {
        emit({ kind: "policy-widened", capabilityId: id, path: at("allow"), ...values, detail: `policy '${ruleId}' no longer restricts callers: allow list ${quoteList(ba)} removed` });
      } else {
        if (lost.length > 0) {
          emit({ kind: "policy-narrowed", capabilityId: id, path: at("allow"), ...values, detail: `policy '${ruleId}' narrowed: allow lost ${quoteList(lost)}` });
        }
        if (gained.length > 0) {
          emit({ kind: "policy-widened", capabilityId: id, path: at("allow"), ...values, detail: `policy '${ruleId}' widened: allow gained ${quoteList(gained)}` });
        }
      }
    }

    const bd = sortedSet(br.deny ?? []);
    const ad = sortedSet(ar.deny ?? []);
    const denyGained = ad.filter((p) => !bd.includes(p));
    const denyLost = bd.filter((p) => !ad.includes(p));
    if (denyGained.length > 0) {
      emit({ kind: "policy-narrowed", capabilityId: id, path: at("deny"), before: bd, after: ad, detail: `policy '${ruleId}' narrowed: deny gained ${quoteList(denyGained)}` });
    }
    if (denyLost.length > 0) {
      emit({ kind: "policy-widened", capabilityId: id, path: at("deny"), before: bd, after: ad, detail: `policy '${ruleId}' widened: deny lost ${quoteList(denyLost)}` });
    }

    const bl = br.rateLimit;
    const al = ar.rateLimit;
    if (canonical(bl) !== canonical(al)) {
      const fmt = (l: { maxInvocations: number; windowSeconds: number }) => `${l.maxInvocations} per ${l.windowSeconds}s`;
      let how: string;
      if (!bl && al) how = `added: ${fmt(al)}`;
      else if (bl && !al) how = `removed (was ${fmt(bl)})`;
      else {
        const tighter = al!.maxInvocations <= bl!.maxInvocations && al!.windowSeconds >= bl!.windowSeconds;
        const looser = al!.maxInvocations >= bl!.maxInvocations && al!.windowSeconds <= bl!.windowSeconds;
        how = `${tighter ? "tightened" : looser ? "loosened" : "changed"}: ${fmt(bl!)} → ${fmt(al!)}`;
      }
      emit({ kind: "policy-rate-limit-changed", capabilityId: id, path: at("rateLimit"), before: bl, after: al, detail: `policy '${ruleId}' rate limit ${how}` });
    }
  }
}

function diffPolicyTokens(id: string, before: string[], after: string[], emit: Emit): void {
  const b = sortedSet(before);
  const a = sortedSet(after);
  if (canonical(b) === canonical(a)) return;
  const gained = a.filter((p) => !b.includes(p));
  const lost = b.filter((p) => !a.includes(p));
  const parts: string[] = [];
  if (gained.length > 0) parts.push(`gained ${quoteList(gained)}`);
  if (lost.length > 0) parts.push(`lost ${quoteList(lost)}`);
  emit({ kind: "policy-tokens-changed", capabilityId: id, path: "policies", before: b, after: a, detail: `policy tokens ${parts.join(" and ")}` });
}

// ---------------------------------------------------------------------------------------------
// Binding (§4 last row). The agent never sees a connector, so every change is `compatible` —
// with one exception: a connector that DISAPPEARS leaves a capability that is still advertised
// but no longer invocable, which is "an agent that worked against before can fail against
// after" (D-2) exactly. §4 does not separate it out; R-1 resolves it toward `breaking`.
//
// The response mapping, `extract`, `origins` and the capability's `provider` are binding-side facts the
// agent never sees either, and are reported under the same kind rather than dropped.
// ---------------------------------------------------------------------------------------------

function diffBinding(id: string, b: NormTool, a: NormTool, emit: Emit): void {
  if (canonical(b.connector) !== canonical(a.connector)) {
    if (b.connector && !a.connector) {
      emit({ kind: "binding-changed", severity: "breaking", capabilityId: id, path: "connector", before: b.connector.type, detail: "binding removed — still advertised, no longer invocable" });
    } else if (!b.connector && a.connector) {
      emit({ kind: "binding-changed", capabilityId: id, path: "connector", after: a.connector.type, detail: `binding added (${a.connector.type}) — now invocable` });
    } else {
      emit({ kind: "binding-changed", capabilityId: id, path: "connector", detail: "binding connector changed" });
    }
  }
  if (canonical(b.response) !== canonical(a.response)) {
    emit({ kind: "binding-changed", capabilityId: id, path: "response", detail: "binding response mapping changed" });
  }
  if (canonical(b.extract) !== canonical(a.extract)) {
    emit({ kind: "binding-changed", capabilityId: id, path: "extract", detail: "binding extract mapping changed" });
  }
  if (canonical(b.origins) !== canonical(a.origins)) {
    emit({ kind: "binding-changed", capabilityId: id, path: "origins", detail: "binding origins changed" });
  }
  if (b.provider !== a.provider) {
    emit({ kind: "binding-changed", capabilityId: id, path: "provider", before: b.provider, after: a.provider, detail: `provider changed: ${b.provider} → ${a.provider}` });
  }
}

// ---------------------------------------------------------------------------------------------
// Resources (§4 row 18). A resource is an output shape by reference, so one edit is reported
// once, on the resource, with `affects` naming every capability whose declared shape reaches it.
// ---------------------------------------------------------------------------------------------

/** The resource a type expands into, if any. A `ref:` (`identity: true`) is a bare id and is
 *  never expanded (ADD-25 R-2), so it reaches nothing. */
function expands(t: IRType): string | undefined {
  if (t.kind === "collection") return t.of;
  if (t.kind === "resource" && !t.identity) return t.name;
  return undefined;
}

/** resource name → capability ids reaching it, transitively through resource fields, split by
 *  whether the path starts at an input or an output (the response's `onError.errorResource` is
 *  part of the output schema too — `emitter-support`'s lowering puts it there). */
function reach(ir: IR): { input: Map<string, Set<string>>; output: Map<string, Set<string>> } {
  const resources = ir.resources ?? {};
  const walk = (roots: string[], id: string, into: Map<string, Set<string>>) => {
    const stack = [...roots];
    const seen = new Set<string>();
    while (stack.length > 0) {
      const r = stack.pop()!;
      if (seen.has(r)) continue;
      seen.add(r);
      if (!into.has(r)) into.set(r, new Set());
      into.get(r)!.add(id);
      for (const f of resources[r] ?? []) {
        const next = expands(f.type);
        if (next) stack.push(next);
      }
    }
  };
  const input = new Map<string, Set<string>>();
  const output = new Map<string, Set<string>>();
  for (const t of ir.tools) {
    const n = normalise(t);
    walk(n.input.map((f) => expands(f.type)).filter((x): x is string => x !== undefined), n.id, input);
    const outRoots = n.output.map((f) => expands(f.type)).filter((x): x is string => x !== undefined);
    if (n.response?.onError?.errorResource) outRoots.push(n.response.onError.errorResource);
    walk(outRoots, n.id, output);
  }
  return { input, output };
}

const RANK: Record<IRDiffSeverity, number> = { compatible: 0, notable: 1, breaking: 2 };

function diffResources(before: IR, after: IR, emit: Emit): void {
  const br = before.resources ?? {};
  const ar = after.resources ?? {};
  const rb = reach(before);
  const ra = reach(after);
  for (const name of sortedSet([...Object.keys(br), ...Object.keys(ar)])) {
    const changes = fieldChanges(br[name] ?? [], ar[name] ?? []);
    if (changes.length === 0) continue;
    const viaOutput = sortedSet([...(rb.output.get(name) ?? []), ...(ra.output.get(name) ?? [])]);
    const viaInput = sortedSet([...(rb.input.get(name) ?? []), ...(ra.input.get(name) ?? [])]);
    const affects = sortedSet([...viaOutput, ...viaInput]);
    const reachedBy = affects.length > 0 ? ` (reaches ${affects.join(", ")})` : " (reached by no capability)";
    for (const c of changes) {
      if (c.change === "description") {
        emit({ kind: "description-changed", resource: name, affects, path: c.field.name, ...fieldValues(c), detail: `${fieldSentence(c, "field")}${reachedBy}` });
        continue;
      }
      // "As the output row it implies" (§4). A resource reached by nothing is still classified
      // that way — R-1: an unreached resource today is one edit away from a reached one, and the
      // table does not exempt it. Where an input also reaches the resource, the input row applies
      // too and the worse severity wins, since a resource-typed input is the same shape by the
      // same reference.
      let severity = SEVERITY[outputKind(c) as keyof typeof SEVERITY];
      if (viaInput.length > 0) {
        const s = SEVERITY[inputKind(c) as keyof typeof SEVERITY];
        if (RANK[s] > RANK[severity]) severity = s;
      }
      emit({ kind: "resource-field-changed", severity, resource: name, affects, path: c.field.name, ...fieldValues(c), detail: `${fieldSentence(c, "field")}${reachedBy}` });
    }
  }
}

// ---------------------------------------------------------------------------------------------
// The whole diff
// ---------------------------------------------------------------------------------------------

function diffTool(b: NormTool, a: NormTool, emit: Emit): void {
  const id = a.id;
  if (b.effect !== a.effect) {
    emit({ kind: "effect-changed", capabilityId: id, path: "effect", before: b.effect, after: a.effect, detail: `effect changed: ${b.effect} → ${a.effect}` });
  }
  diffLifecycle(id, b.lifecycle, a.lifecycle, emit);
  diffFields(id, "input", b.input, a.input, emit);
  diffFields(id, "output", b.output, a.output, emit);
  diffPolicyRules(id, b.policyRules, a.policyRules, emit);
  diffPolicyTokens(id, b.policies, a.policies, emit);
  if (b.description !== a.description) {
    emit({ kind: "description-changed", capabilityId: id, path: "description", before: b.description, after: a.description, detail: "description changed" });
  }
  diffBinding(id, b, a, emit);
}

/**
 * Sort key (D-9): the capability id, or — for a resource entry, which has none — the resource
 * name, compared in the same code-unit order. Resource names are domain-qualified
 * (`banking.Account`), so a resource's entries land among its own domain's capabilities. Then
 * path (an entry without one sorts first), then kind and detail, so two entries on one path are
 * still in a fixed order.
 */
function byKey(x: IRDiffEntry, y: IRDiffEntry): number {
  return (
    cmp(x.capabilityId ?? x.resource ?? "", y.capabilityId ?? y.resource ?? "") ||
    cmp(x.path ?? "", y.path ?? "") ||
    cmp(x.kind, y.kind) ||
    cmp(x.detail, y.detail)
  );
}

/**
 * Compare two compiled IRs as declarations (ADD-309). Every change the agent — or the operator —
 * could notice produces one entry; unchanged members produce none, so a self-diff is empty.
 *
 * Throws on two IRs of different `version`, before any row is evaluated: today there is only
 * `"0"`, and the refusal exists so the first bump is a decision rather than a surprise.
 */
export function diffIR(before: IR, after: IR): IRDiff {
  if (before.version !== after.version) {
    throw new Error(
      `cannot diff IR version '${String(before.version)}' against IR version '${String(after.version)}' — both artifacts must be compiled to the same IR version`,
    );
  }

  const entries: IRDiffEntry[] = [];
  const emit: Emit = (e) => {
    const severity = e.severity ?? SEVERITY[e.kind as keyof typeof SEVERITY];
    entries.push({ ...e, severity });
  };

  const b = new Map(before.tools.map((t) => [t.id, normalise(t)]));
  const a = new Map(after.tools.map((t) => [t.id, normalise(t)]));
  for (const [id, bt] of b) {
    const at = a.get(id);
    if (!at) emit({ kind: "capability-removed", capabilityId: id, detail: "capability removed" });
    else diffTool(bt, at, emit);
  }
  for (const [id, at] of a) {
    if (!b.has(id)) emit({ kind: "capability-added", capabilityId: id, after: { effect: at.effect }, detail: `capability added (${at.effect})` });
  }
  diffResources(before, after, emit);

  entries.sort(byKey);
  const summary = { breaking: 0, notable: 0, compatible: 0 };
  for (const e of entries) summary[e.severity]++;
  return {
    before: { company: before.company.id, version: before.version },
    after: { company: after.company.id, version: after.version },
    entries,
    summary,
  };
}
