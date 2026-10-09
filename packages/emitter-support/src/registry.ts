// @archstone/emitter-support — IR indexing (Registry)
//
// Index-only: no disk I/O, no @archstone/schema. Moved out of @archstone/runtime's
// registry.ts (ADD-0008 #27) — `buildRegistry`, the file-backed pipeline
// (load → validateSemantics → compile → Registry), stays in @archstone/runtime, which
// re-exports this class for back-compat.
//
// ADD-30 (#30): a second index, `byName`, keyed by the sanitized tool name (`toolName()`,
// same lowering `buildToolDefs`/`toolDefinitions` already use to advertise a name) — built
// once here, over invocable (`.connector`-bearing) tools only, so `getCapability` resolves
// both the raw CDL id (`byId`) and the sanitized name `tools()`/`buildToolDefs` hand an
// agent. Two distinct capability ids that resolve to the identical name are recorded in
// `toolNameCollisions` rather than one silently overwriting the other; a collided name
// resolves to `undefined` from `getCapability` (defense in depth — D-2/BR-6) even if a
// caller skips the boundary-level gate (`fromIR`/`buildRegistry`, which refuse to proceed
// at all when this list is non-empty).
//
// D-1 ("byId first, always authoritative") holds for every id containing a character
// `toolName()` rewrites (e.g. any dotted CDL id — the sanitized-name index never contains
// such a string, since toolName() strips exactly those characters), which is the
// overwhelming common case. The one narrow exception, spelled out by the ADD's own worked
// example: a raw id that is ALREADY shaped like a sanitized name (no character toolName()
// rewrites — e.g. "tourism_search") can collide with ANOTHER capability's sanitized form
// (e.g. bound "tourism.search" also sanitizes to "tourism_search"). Left unchecked, that
// would let a raw-id lookup silently shadow the capability `tools()` actually advertised
// under that name — exactly the silent misroute BR-6 forbids — so this construction also
// treats that case as ambiguous, even though it costs the shadowed capability its own
// otherwise-valid raw-id lookup. This one case is the reason `byId` is cross-checked
// while building `byName` below, not just `byName` against itself.
//
// ADD-24 (#24): a third computed value, `exposureById` — every tool's lifecycle (+ optional
// health) lowered to a neutral `{listed, invocable, hint}` exposure via @archstone/emitter-
// support's own `exposure.ts` (never re-derived elsewhere, ADD-24 D-6). Orthogonal to
// boundness: `invocableTools()`/`byName` above are unaffected by lifecycle/health, exactly as
// before this ADD.

import type { IR, IRField, IRTool } from "@archstone/compiler";
import { toolName } from "./lowering";
import { lifecycleExposure, combineExposure, surfaceOf, type Exposure, type HealthStatus, type Surface } from "./exposure";

export interface ToolNameCollision {
  /** The sanitized name (`toolName()` output) two or more capabilities share. */
  name: string;
  /** The colliding capabilities' raw ids (deduped, insertion order). */
  ids: string[];
}

/** One invocable capability, paired with the sanitized name it's advertised under —
 *  the shared surface `buildToolDefs` (@archstone/agent) and `toolDefinitions`
 *  (@archstone/runtime) both read instead of hand-rolling their own filter+map (ADD-30 D-3). */
export interface NamedTool {
  name: string;
  tool: IRTool;
}

export class Registry {
  private readonly byId: Map<string, IRTool>;
  private readonly byName: Map<string, IRTool>; // never holds an ambiguous name — see ambiguousNames
  private readonly ambiguousNames: Set<string>;
  private readonly invocable: NamedTool[];
  // ADD-24: one exposure per tool (lifecycle + optional health), computed ONCE here so
  // listing (toolDefinitions) and invocation (callTool) read the identical value — never
  // recomputed independently in two places (ADD-24 §7 step 5, mirrors ADD-30 D-3).
  private readonly exposureById: Map<string, Exposure>;

  readonly toolNameCollisions: ReadonlyArray<ToolNameCollision>;

  /**
   * @param health An optional, already-parsed capabilityId -> HealthStatus map (e.g. from
   *   `archstone verify --json`'s `{results: ToolVerification[]}`, ADD-20). Fs-free here —
   *   the caller (runtime's buildRegistry) is the one place that reads a snapshot file. Health
   *   NEVER lowers into the IR (ADD-24 D-7) and NEVER gates `invocable` (ADD-24 D-9) — it only
   *   ever raises a tool's hint severity, composed with its lifecycle-derived exposure below.
   */
  constructor(public readonly ir: IR, health?: ReadonlyMap<string, HealthStatus>) {
    this.byId = new Map(ir.tools.map((t) => [t.id, t]));

    this.byName = new Map();
    this.ambiguousNames = new Set();
    const collisionIds = new Map<string, Set<string>>();
    const invocable: NamedTool[] = [];

    const markAmbiguous = (name: string, ids: Iterable<string>): void => {
      this.ambiguousNames.add(name);
      this.byName.delete(name);
      const set = collisionIds.get(name) ?? new Set<string>();
      for (const id of ids) set.add(id);
      collisionIds.set(name, set);
    };

    for (const t of ir.tools) {
      if (!t.connector) continue; // unbound — no advertised name to index (BR-5/EC-3)
      const name = toolName(t.id);

      if (this.ambiguousNames.has(name)) {
        markAmbiguous(name, [t.id]);
        continue;
      }

      // A different capability may already own this exact string as its raw id (byId —
      // see header comment) or as a previously seen sanitized name (byName).
      const idOwner = this.byId.get(name);
      const nameOwner = this.byName.get(name);
      const others = new Set<string>();
      if (idOwner && idOwner.id !== t.id) others.add(idOwner.id);
      if (nameOwner && nameOwner.id !== t.id) others.add(nameOwner.id);

      if (others.size > 0) {
        others.add(t.id);
        markAmbiguous(name, others);
      } else {
        this.byName.set(name, t);
        invocable.push({ name, tool: t });
      }
    }

    this.toolNameCollisions = [...collisionIds.entries()].map(([name, ids]) => ({ name, ids: [...ids] }));
    // A name that turned out ambiguous is never advertised as invocable — advertising a
    // name that can never resolve would itself be a silent-misroute risk (BR-6).
    this.invocable = invocable.filter((nt) => !this.ambiguousNames.has(nt.name));

    // ADD-24: exposure is computed for EVERY tool (bound or not) — lifecycle is a fact of
    // the capability itself, independent of whether a binding exists. Boundness continues to
    // gate `invocableTools()`/`byName` above, unaffected by lifecycle/health.
    this.exposureById = new Map(
      ir.tools.map((t) => [t.id, combineExposure(lifecycleExposure(t.lifecycle), health?.get(t.id))]),
    );
  }

  /** A tool's combined exposure (lifecycle + optional health, ADD-24) — the single value
   *  both `toolDefinitions` (listing) and `callTool` (invocation) read. Every `ir.tools`
   *  entry has one.
   *
   *  ADD-56 D-4: an unknown id (absent from `exposureById` entirely — no tool exists) falls
   *  back to `{listed:false, invocable:false}`, fail-closed — flipped from the previous
   *  `{listed:true, invocable:true}`. Verified SAFE (never reached) for all three internal
   *  call sites (`callTool`, `executeCapability`, `toolDefinitions`/`buildToolDefs`'s listing
   *  paths): each resolves `id` via `getCapability`/`listCapabilities` first, sourced from the
   *  identical `ir.tools` this map is built from, so the key is always present by construction.
   *  Flipped anyway as defense in depth: this is a PUBLIC method, and a host embedding
   *  `@archstone/agent`/`@archstone/runtime` can call `registry.getExposure(anyString)`
   *  directly, bypassing `getCapability` entirely — an authorization-adjacent accessor should
   *  not default an unresolved id to full access. No `blockedReason` is set here: this is a
   *  distinct "no such tool" state, never conflated with either lifecycle refusal reason
   *  (`"retired"` / `"unevaluatable"`), both of which require a resolved tool to report on. */
  getExposure(id: string): Exposure {
    return this.exposureById.get(id) ?? { listed: false, invocable: false };
  }

  /** All capabilities (bound or not), for MCP tool listing / reporting. */
  listCapabilities(): IRTool[] {
    return [...this.byId.values()];
  }

  /** Invocable (bound) capabilities paired with their advertised, sanitized tool name —
   *  the single source `buildToolDefs`/`toolDefinitions` read (ADD-30 D-3). */
  invocableTools(): ReadonlyArray<NamedTool> {
    return this.invocable;
  }

  /** The tools a discovery listing advertises: invocable (bound) AND `listed` by their combined
   *  exposure. The one predicate behind MCP `tools/list` (`toolDefinitions`), `buildToolDefs`
   *  and `apply --exposure`'s totals (#173) — a listing and a report of what is listed cannot
   *  disagree because they read this, not two copies of the filter. */
  listedTools(): ReadonlyArray<NamedTool> {
    return this.invocable.filter(({ tool: t }) => this.getExposure(t.id).listed);
  }

  /** Where one declared capability stands on the surface a model sees (#173): `exposed` (in
   *  `listedTools()`), `unlisted` (callable by id, not advertised) or `not_exposed` (refused, or
   *  no binding), with the reason. Derived from the same exposure + boundness `listedTools()`
   *  reads. */
  surface(id: string): Surface {
    const bound = this.invocable.some(({ tool }) => tool.id === id);
    return surfaceOf(this.getExposure(id), bound);
  }

  /**
   * Resolve one capability by its raw CDL id OR its advertised (sanitized) tool name.
   * A name flagged in `toolNameCollisions` never resolves here (`undefined`, same as
   * unknown), checked before either index (D-2's defense-in-depth layer — see header
   * comment for why this can, in one narrow case, pre-empt an otherwise-valid raw-id
   * match). Otherwise `byId` resolves the raw CDL id (BR-2) and `byName` resolves the
   * sanitized name `tools()`/`buildToolDefs` handed the caller (BR-1). No case-folding,
   * no re-sanitizing the input (EC-6/EC-7).
   */
  getCapability(idOrName: string): IRTool | undefined {
    if (this.ambiguousNames.has(idOrName)) return undefined;
    const byId = this.byId.get(idOrName);
    if (byId) return byId;
    return this.byName.get(idOrName);
  }

  /**
   * A resource's declared fields, by canonical name — `undefined` when the IR has no such
   * resource. Added for the extraction surface (ADR-0011), which needs to fail closed on an
   * unknown resource name rather than lower an empty field list into a schema that accepts
   * `{}`. `ir.resources` was always reachable through the public `ir` property; this exists so
   * a consumer asks the Registry a question instead of indexing its internals, exactly as
   * `getCapability` does for tools.
   */
  getResource(name: string): IRField[] | undefined {
    return this.ir.resources[name];
  }

  /** Every declared resource name, in IR order. The listing counterpart to `getResource`. */
  listResources(): string[] {
    return Object.keys(this.ir.resources);
  }

  get size(): number {
    return this.byId.size;
  }
}
