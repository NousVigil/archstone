// Provider-controlled text on the operator's terminal (#146). `verify` prints the names of the
// undeclared keys a provider sent — names the provider chose. Printed raw, a name can carry ANSI
// escapes (recolour or rewrite the report, set the window title, emit a hyperlink), C0/C1
// controls (a carriage return that overwrites the verdict line) or bidi overrides, and can be
// arbitrarily long. This makes one such name safe to print: escape sequences and control or
// bidi-format characters removed, the rest truncated.

/** Longest name printed; longer ones end in `…`. */
export const MAX_PRINTED_NAME = 64;

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?|\u001b[@-Z\\-_]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;

export function terminalSafe(name: string, max = MAX_PRINTED_NAME): string {
  const clean = name.replace(ANSI, "").replace(CONTROL, "");
  const chars = [...clean];
  return chars.length > max ? `${chars.slice(0, max - 1).join("")}…` : clean;
}
