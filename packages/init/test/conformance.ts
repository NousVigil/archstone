// The `SourceAdapter` conformance suite (ADD-37 D-1, built now per §6 step 5's instruction to
// have the second adapter's interface conformance test in place BEFORE its implementation
// lands).
//
// It exists so that "adding an adapter must touch no file outside `adapters/`" is checkable
// rather than aspirational: an adapter that passes this suite is, by construction, one the
// emitter, the loop, the report and the harness can all consume without knowing what it read.
//
// Deliberately NOT exported from the package's public surface — it is a test contract between
// this package and its own adapters, not an API a third party should build against.

import { expect } from "vitest";
import { REASON_CODES, type DraftModel, type DraftNode, type Fact, type SourceAdapter, type SourceInput } from "@archstone/init";

const DERIVATIONS = new Set(["declared", "observed", "absent"]);

function checkFact(fact: Fact<unknown>, where: string): void {
  expect(DERIVATIONS.has(fact.derivation), `${where}: unknown derivation '${fact.derivation}'`).toBe(true);
  if (fact.derivation === "absent") {
    // The absent arm must carry no value at all — a `{derivation: "absent", value: …}` object
    // would type-check nowhere but could still be built by an adapter using a cast, and it
    // would make "we do not know" indistinguishable from "we know it is undefined".
    expect(Object.keys(fact), `${where}: an absent fact must carry no value`).not.toContain("value");
  } else {
    expect(fact, `${where}: a known fact must carry a value`).toHaveProperty("value");
  }
}

function checkNode(node: DraftNode, where: string): void {
  switch (node.kind) {
    case "scalar":
      checkFact(node.type, `${where}.type`);
      checkFact(node.nullable, `${where}.nullable`);
      checkFact(node.description, `${where}.description`);
      checkFact(node.example, `${where}.example`);
      return;
    case "object":
      checkFact(node.name, `${where}.name`);
      checkFact(node.description, `${where}.description`);
      for (const property of node.properties) {
        checkFact(property.declaredRequired, `${where}.${property.name}.declaredRequired`);
        if (property.presence) {
          expect(property.presence.items, `${where}.${property.name}.presence`).toBeGreaterThanOrEqual(0);
          expect(property.presence.presentNonNull).toBeLessThanOrEqual(property.presence.items);
        }
        checkNode(property.node, `${where}.${property.name}`);
      }
      return;
    case "array":
      checkNode(node.items, `${where}[]`);
      return;
    case "unknown":
      return;
  }
}

function checkModel(draft: DraftModel, adapter: SourceAdapter, input: SourceInput): void {
  expect(draft.version).toBe("0");
  expect(draft.source.adapter, "source.adapter must name the adapter that produced the model").toBe(adapter.id);
  expect(draft.source.origin, "source.origin must be the input's origin, unaltered").toBe(input.origin);

  checkFact(draft.company.id, "company.id");
  checkFact(draft.company.name, "company.name");
  checkFact(draft.company.description, "company.description");
  checkFact(draft.baseUrl, "baseUrl");

  const keys = new Set<string>();
  for (const operation of draft.operations) {
    // The Decision Record joins a human's answer to a candidate BY KEY, so a duplicate key
    // silently answers the wrong operation — the one failure in this file that would reach a
    // production manifest.
    expect(keys.has(operation.key), `duplicate operation key '${operation.key}'`).toBe(false);
    keys.add(operation.key);
    expect(operation.method, `${operation.key}: method must be non-empty`).not.toBe("");
    checkFact(operation.suggestedAction, `${operation.key}.suggestedAction`);
    checkFact(operation.description, `${operation.key}.description`);
    if (operation.effectHint) {
      // A guess must always be labelled as one, and must never wear a derivation (D-3).
      expect(operation.effectHint.derivation).toBe("heuristic");
      expect(operation.effectHint.rationale).not.toBe("");
    }
    for (const field of operation.input) {
      expect(["path", "query", "body", "param"]).toContain(field.in);
      checkFact(field.type, `${operation.key}.${field.name}.type`);
      checkFact(field.required, `${operation.key}.${field.name}.required`);
      checkFact(field.description, `${operation.key}.${field.name}.description`);
      checkFact(field.example, `${operation.key}.${field.name}.example`);
    }
    if (operation.sql) {
      // A database candidate (ADR-0012 D-10): the model must carry a database source, a finished
      // SELECT, and lookup columns that are bound parameters with facts like any other input.
      expect(draft.sql, `${operation.key}: a database candidate needs DraftModel.sql`).toBeDefined();
      expect(operation.sql.select, `${operation.key}: select`).toMatch(/^SELECT /);
      for (const { field, predicate } of operation.sql.lookupColumns) {
        expect(field.in).toBe("param");
        checkFact(field.type, `${operation.key}.${field.name}.type`);
        checkFact(field.required, `${operation.key}.${field.name}.required`);
        expect(predicate, `${operation.key}.${field.name}: predicate`).toMatch(/ = \$1$/);
      }
      for (const key of operation.sql.keyColumns) {
        expect(operation.sql.lookupColumns.map((c) => c.field.name), `${operation.key}: a suggested key must be a lookup column`).toContain(key);
      }
    }
    checkNode(operation.response, `${operation.key}.response`);
    for (const n of operation.notes) expect(REASON_CODES).toHaveProperty(n.code);
  }
  for (const n of draft.notes) expect(REASON_CODES).toHaveProperty(n.code);
}

/**
 * Assert that an adapter satisfies the `SourceAdapter` contract.
 *
 * @param adapter the adapter under test.
 * @param inputs  representative inputs, INCLUDING at least one the adapter cannot handle —
 *   "never throws, always reports" is half the contract, and it is the half that keeps the
 *   scope boundary honest (an unhandled construct must be a named reason code, not a crash).
 */
export function assertAdapterConformance(adapter: SourceAdapter, inputs: SourceInput[]): void {
  expect(adapter.id, "an adapter needs a stable id").not.toBe("");
  expect(adapter.summary, "an adapter needs a one-line summary for --help and the report").not.toBe("");

  for (const input of inputs) {
    const draft = adapter.adapt(input);
    expect(draft, "adapt() must be synchronous — a pure function of its input").not.toBeInstanceOf(Promise);
    checkModel(draft, adapter, input);

    // Determinism: same input, same model. A tool whose pitch is that you can re-run it in CI
    // and diff the result cannot have an inference stage that answers differently on Tuesday.
    expect(adapter.adapt(input)).toEqual(draft);
  }

  // Garbage in, notes out — never an exception.
  for (const hostile of [{ origin: "empty" }, { origin: "junk", document: "%%% not a document %%%" }, { origin: "no-observations", observations: [] }]) {
    expect(() => adapter.adapt(hostile)).not.toThrow();
  }
}
