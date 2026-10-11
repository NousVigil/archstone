// The Postgres adapter (ADR-0012 D-10; issue #87).
//
// The SECOND `SourceAdapter`. Its input is a catalog snapshot the HOST read over the runtime role's
// own connection — `adapt` opens no socket, exactly as the OpenAPI adapter reads no file. The
// snapshot is already scoped to what the role may SELECT (the filter is in the host's query), so
// nothing here can propose a relation or a column the role cannot read.
//
// It proposes ONE candidate per relation and decides nothing a human must decide: not whether the
// capability is a bounded list or a lookup (the Decision Record says), not the `effect` (its hint is
// a guess the gate pre-fills and the emitter cannot see), not the capability id. It records the
// catalog's single-column key as a suggestion and nothing more.
//
// NO LLM. Every fact is read out of the catalog or reported as absent.

import { absent, declared, type CatalogRelation, type CatalogSnapshot, type DraftInputField, type DraftModel, type DraftOperation, type DraftProperty, type SourceAdapter, type SourceInput } from "../../model";
import { propertyAccessor } from "../../d9";
import { note, type Note } from "../../reasons";
import { isRequiredColumn, mapColumnType } from "./columns";
import { isSafeIdentifier, renderLookupPredicate, renderSelect } from "./render";

/** The name a capability input may carry: letters, digits and underscores, starting with a letter.
 *  A column whose name is anything else is still selected; it just cannot be keyed on. */
const LOOKUP_FIELD_RE = /^[A-Za-z][A-Za-z0-9_]*$/;
const ENV_VAR_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

const KIND_WORDS: Record<CatalogRelation["kind"], string> = {
  table: "table",
  partitioned_table: "partitioned table",
  view: "view",
  materialized_view: "materialized view",
};

function companyOf(): DraftModel["company"] {
  return {
    id: absent<string>("no catalog construct carries a company id — the Decision Record supplies it"),
    name: absent<string>(),
    description: absent<string>(),
  };
}

function emptyModel(origin: string, notes: Note[], dsnEnvVar?: string): DraftModel {
  return {
    version: "0",
    source: { adapter: "postgres", origin },
    company: companyOf(),
    baseUrl: absent<string>("a database has no base URL"),
    ...(dsnEnvVar !== undefined ? { sql: { engine: "postgres" as const, dsnEnvVar } } : {}),
    operations: [],
    notes,
  };
}

/** A slug for the action half of a capability id, or absent when the name does not make one. */
function suggestedActionOf(relation: string): DraftOperation["suggestedAction"] {
  const slug = relation.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z][a-z0-9-]*$/.test(slug) ? declared(`read-${slug}`) : absent<string>();
}

function operationOf(relation: CatalogRelation): DraftOperation {
  const path = `${relation.schema}.${relation.name}`;
  const key = `SELECT ${path}`;
  const notes: Note[] = [];

  const base = {
    key,
    method: "SELECT",
    path,
    suggestedAction: suggestedActionOf(relation.name),
    description: declared(`Read rows of the ${KIND_WORDS[relation.kind]} ${path}.`),
    // A guess, never a fact (D-3): the gate pre-fills it and the human still answers. A SELECT in a
    // READ ONLY transaction is the strongest case for `read` there is — and still not an `effect`.
    effectHint: { value: "read" as const, derivation: "heuristic" as const, rationale: "a database SELECT runs in a READ ONLY transaction" },
    input: [] as DraftInputField[],
  };

  if (!isSafeIdentifier(relation.schema) || !isSafeIdentifier(relation.name)) {
    notes.push(note("unsupported-connector", "operation", key, "the schema or relation name contains a control character, which cannot be written into a binding"));
    return { ...base, response: { kind: "unknown" }, notes };
  }

  const properties: DraftProperty[] = [];
  const lookupColumns: NonNullable<DraftOperation["sql"]>["lookupColumns"] = [];
  const selected: string[] = [];
  for (const column of relation.columns) {
    const source = `${path}.${column.name}`;
    const target = `${key}#${column.name}`;
    if (!isSafeIdentifier(column.name)) {
      notes.push(note("column-type-not-expressible", "field", target, "the column name contains a control character, which cannot be written into a binding — left out of the select"));
      continue;
    }
    const mapped = mapColumnType(column.dataType, column.name);
    if (!mapped.ok) {
      notes.push(note(mapped.reasonCode, "field", target, mapped.detail));
      continue;
    }
    if (propertyAccessor(column.name) === undefined) {
      notes.push(note("field-path-not-expressible", "field", target, "no JSONPath can address this column name — left out of the select"));
      continue;
    }
    selected.push(column.name);
    properties.push({
      name: column.name,
      declaredRequired: declared(isRequiredColumn(column.isNullable), source),
      node: {
        kind: "scalar",
        type: declared(mapped.type, source),
        nullable: declared(column.isNullable === "YES", source),
        description: absent<string>(),
        example: absent<unknown>(),
      },
    });
    if (LOOKUP_FIELD_RE.test(column.name)) {
      lookupColumns.push({
        field: {
          name: column.name,
          in: "param",
          type: declared(mapped.type, source),
          required: declared(true, source),
          description: absent<string>(),
          example: absent<unknown>(),
        },
        predicate: renderLookupPredicate(column.name),
      });
    }
  }

  if (selected.length === 0) {
    notes.push(note("no-expressible-columns", "operation", key, `${relation.columns.length} selectable column(s), none of which can be expressed`));
    return { ...base, response: { kind: "unknown" }, notes };
  }

  const suggestedKeys = relation.keyColumns.filter((k) => lookupColumns.some((c) => c.field.name === k));
  return {
    ...base,
    response: {
      kind: "array",
      items: { kind: "object", name: declared(relation.name, path), description: absent<string>(), properties },
    },
    sql: {
      relation: { schema: relation.schema, name: relation.name, kind: relation.kind },
      select: renderSelect(relation.schema, relation.name, selected),
      lookupColumns,
      keyColumns: suggestedKeys,
    },
    notes,
  };
}

export const postgresAdapter: SourceAdapter = {
  id: "postgres",
  summary: "a Postgres catalog the host read as the runtime role: one candidate per relation it can SELECT",

  adapt(input: SourceInput): DraftModel {
    const notes: Note[] = [];
    const snapshot: CatalogSnapshot | undefined = input.catalog;
    if (snapshot === undefined) {
      notes.push(note("unsupported-operation-shape", "manifest", undefined, "this adapter needs a catalog snapshot; none was supplied"));
      return emptyModel(input.origin, notes);
    }
    if (input.dsnEnvVar === undefined || !ENV_VAR_RE.test(input.dsnEnvVar)) {
      // Never echoed: a value in this slot that is not a variable name may be a connection string.
      notes.push(note("unsupported-operation-shape", "manifest", undefined, "this adapter needs the NAME of the environment variable that carries the connection string"));
      return emptyModel(input.origin, notes);
    }

    for (const f of snapshot.deferred) {
      notes.push(
        note("foreign-table-deferred", "manifest", `${f.schema}.${f.name}`, "row-level security cannot be enabled on a foreign table, and reading one reaches a third host"),
      );
    }

    const operations: DraftOperation[] = [];
    const keys = new Set<string>();
    for (const relation of snapshot.relations) {
      const operation = operationOf(relation);
      if (keys.has(operation.key)) {
        notes.push(note("unsupported-operation-shape", "manifest", operation.key, "two relations share this candidate key — the second was left out"));
        continue;
      }
      keys.add(operation.key);
      operations.push(operation);
    }

    return {
      version: "0",
      source: { adapter: "postgres", origin: input.origin },
      company: companyOf(),
      baseUrl: absent<string>("a database has no base URL"),
      sql: { engine: "postgres", dsnEnvVar: input.dsnEnvVar },
      operations,
      notes,
    };
  },
};
