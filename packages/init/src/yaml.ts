// @archstone/init — a deliberately small, deterministic YAML writer.
//
// Why not a YAML library: the emitted files are REVIEW SURFACES, not data dumps. Their value
// is the comment on each `response.map` line naming the source field and an observed example
// (product §5's legibility requirement — the only mitigation that exists for a mapping that is
// structurally right and semantically wrong). Interleaving comments with keys, in a fixed
// order, byte-stable across runs, is the whole job here; a general serializer makes that
// harder rather than easier, and would add a dependency to a module whose purity is the point.
//
// Why that is safe: quoting is CONSERVATIVE (plain style only for strings that cannot be
// anything else; `JSON.stringify` otherwise, which is always a valid YAML double-quoted
// scalar), and nothing this writer produces is trusted — the loop parses every emitted file
// back through the real `@archstone/schema` loader before a single byte reaches the target
// directory. An escaping bug here is a refused run, never a corrupt manifest.

export type YamlScalar = string | number | boolean;

/** Strings that would round-trip as a non-string if written plain. */
const PLAIN_UNSAFE_WORD = /^(?:true|false|null|yes|no|on|off|y|n|~)$/i;
/** A leading character that YAML reads as an indicator, that starts an env placeholder, or
 *  anything numeric-looking. */
const PLAIN_UNSAFE_START = /^[-?:,[\]{}#&*!|>'"%@`$\s\d+.]/;
/**
 * Sequences that end a plain scalar, start a comment mid-line, or merely READ as structure.
 *
 * ANY colon, not just `: `. A value ending in one (`"foo:"` — a real description, and a real
 * provider field name) renders plain as `key: foo:`, which is not a string with a trailing
 * colon: it is a nested mapping, and the parser rejects the document outright. That case was
 * found by fuzzing this function against the real parser, not by reading the spec, which is
 * the argument for keeping the rule blunt: `http://x` and `a:b` would be legal plain, and are
 * quoted anyway, because "quote every colon" is a rule that cannot have a third exception
 * nobody thought of.
 *
 * The flow indicators (`[`, `]`, `{`, `}`, `,`) are likewise legal inside a block-context plain
 * scalar, so quoting them is not strictly required — but every JSONPath (`$.items[*]`) and
 * every env placeholder (`${ACME_API_URL}`) in this codebase's hand-written manifests is
 * quoted, and a generated file that looks different from a hand-written one for no reason is a
 * file a reviewer has to think about.
 */
const PLAIN_UNSAFE_INNER = /[:\n\r\t[\]{},]|\s#/;

/** Render a scalar. Plain style only when it is provably unambiguous; double-quoted otherwise. */
export function yamlScalar(value: YamlScalar): string {
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : JSON.stringify(String(value));
  if (value === "") return '""';
  if (PLAIN_UNSAFE_WORD.test(value) || PLAIN_UNSAFE_START.test(value) || PLAIN_UNSAFE_INNER.test(value) || /\s$/.test(value)) {
    return JSON.stringify(value);
  }
  return value;
}

/** Render a mapping key. Same rules as a scalar — resource field names come from real payloads
 *  and are not constrained by any Archstone grammar. */
export function yamlKey(key: string): string {
  return yamlScalar(key);
}

/** Flatten a comment to a single line: a stray newline would otherwise emit an uncommented
 *  line into the middle of a document. */
function commentText(text: string): string {
  return text.replace(/[\r\n]+/g, " ").replace(/\s+$/, "");
}

/**
 * A line-oriented builder. Indentation is two spaces per level, the convention every shipped
 * manifest uses.
 */
export class YamlWriter {
  private readonly lines: string[] = [];
  private depth = 0;

  private pad(): string {
    return "  ".repeat(this.depth);
  }

  /** A `#` comment at the current indent. Multi-line input becomes multiple comment lines. */
  comment(text: string | string[]): this {
    for (const raw of Array.isArray(text) ? text : [text]) {
      for (const line of raw.split("\n")) {
        const body = commentText(line);
        this.lines.push(body === "" ? `${this.pad()}#` : `${this.pad()}# ${body}`);
      }
    }
    return this;
  }

  blank(): this {
    this.lines.push("");
    return this;
  }

  /** `key: value`, with an optional trailing `# comment`. */
  entry(key: string, value: YamlScalar, trailingComment?: string): this {
    const suffix = trailingComment ? `  # ${commentText(trailingComment)}` : "";
    this.lines.push(`${this.pad()}${yamlKey(key)}: ${yamlScalar(value)}${suffix}`);
    return this;
  }

  /** `key:` opening a nested block; `body` is written one level deeper. */
  block(key: string, body: (w: YamlWriter) => void): this {
    this.lines.push(`${this.pad()}${yamlKey(key)}:`);
    this.depth += 1;
    body(this);
    this.depth -= 1;
    return this;
  }

  /** `- value` sequence item. */
  item(value: YamlScalar): this {
    this.lines.push(`${this.pad()}- ${yamlScalar(value)}`);
    return this;
  }

  /** `key: |` and the text as a literal block — for a SQL statement, where the line breaks are the
   *  point. Every line is indented one level under the key; the text must not contain a line that
   *  is blank or starts with whitespace, so no relation or column name can break out of the scalar. */
  literal(key: string, text: string): this {
    this.lines.push(`${this.pad()}${yamlKey(key)}: |`);
    this.depth += 1;
    for (const line of text.split("\n")) this.lines.push(`${this.pad()}${line}`);
    this.depth -= 1;
    return this;
  }

  /** `key: [a, b, c]` — flow style, used only for a closed `values:` set. */
  flowList(key: string, values: YamlScalar[]): this {
    this.lines.push(`${this.pad()}${yamlKey(key)}: [${values.map(yamlScalar).join(", ")}]`);
    return this;
  }

  toString(): string {
    // Exactly one trailing newline, no trailing blank lines — so a re-run of `init` produces a
    // byte-identical file and `git diff` stays honest.
    const body = this.lines.join("\n").replace(/\n+$/, "");
    return `${body}\n`;
  }
}
