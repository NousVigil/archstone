// @archstone/emitter-support — the one money-shape rule (#176, #182)
//
// A `money` value is an object with a finite numeric `amount` and a `currency` of three uppercase
// letters (the ISO 4217 FORM; no code list is kept). Both directions of the boundary call this:
// `mapping.ts` (provider → model) and `extraction.ts` (model → business system). It lives in its
// own file so neither imports the other and the two can never hold different rules.

const ISO_4217_SHAPE = /^[A-Z]{3}$/;

function hasOwn(o: Record<string, unknown>, k: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, k);
}

/** True when `value` is a plain object carrying an own finite-number `amount` and an own
 *  three-uppercase-letter `currency`. Extra keys do not fail it: each caller decides what to do
 *  with undeclared keys (drop and name them). */
export function isMoneyShape(value: unknown): value is { amount: number; currency: string } {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const o = value as Record<string, unknown>;
  return (
    hasOwn(o, "amount") &&
    typeof o.amount === "number" &&
    Number.isFinite(o.amount) &&
    hasOwn(o, "currency") &&
    typeof o.currency === "string" &&
    ISO_4217_SHAPE.test(o.currency)
  );
}
