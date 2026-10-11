// @archstone/init — Postgres adapter, SQL text (ADR-0012 D-10)
//
// Quoting a Postgres identifier is knowledge of the source, so it lives here and nowhere else in the
// package: the emitter is handed finished text and appends one of two fixed suffixes to it, and
// never composes or quotes an identifier. PURE: strings in, strings out.

/** Characters that cannot appear in an identifier this adapter will write into a YAML literal block
 *  (and, in a query a reviewer reads line by line, should not): the C0 and C1 controls and the
 *  Unicode line and paragraph separators. A name containing one is left out, not escaped. */
function hasUnsafeCharacter(name: string): boolean {
  for (const ch of name) {
    const c = ch.codePointAt(0)!;
    if (c <= 0x1f || (c >= 0x7f && c <= 0x9f) || c === 0x2028 || c === 0x2029) return true;
  }
  return false;
}

export function isSafeIdentifier(name: string): boolean {
  return name !== "" && !hasUnsafeCharacter(name);
}

/** `"name"`, with every `"` doubled — Postgres's own rule for a quoted identifier. */
export function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

export function quoteRelation(schema: string, name: string): string {
  return `${quoteIdent(schema)}.${quoteIdent(name)}`;
}

/** `SELECT "a", "b"\nFROM "s"."r"` — no `WHERE`, no `LIMIT`: the emitter appends one of those. */
export function renderSelect(schema: string, relation: string, columns: readonly string[]): string {
  return `SELECT ${columns.map(quoteIdent).join(", ")}\nFROM ${quoteRelation(schema, relation)}`;
}

/** The lookup predicate, with the key bound as the first parameter. */
export function renderLookupPredicate(column: string): string {
  return `${quoteIdent(column)} = $1`;
}
