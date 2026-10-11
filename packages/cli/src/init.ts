// `archstone init` — THIN (ADD-37 §6 step 7, D-5).
//
// This file owns exactly three things: argv, the terminal gate, and rendering the report.
// Every decision of substance lives elsewhere and is testable without a terminal:
//   - what a document says            → `@archstone/init`'s adapters
//   - what becomes a manifest         → `emit`, pure
//   - whether anything is written     → `@archstone/init/loop`, one of two terminal states
//   - whether a request is ever made  → the probe gate, two independent conditions
//
// The gate produces DATA — a Decision Record — and nothing else. That is what lets a hosted
// "point us at your spec" flow (§9's forward constraint) supply the identical structure from a
// web form and reuse the core verbatim, and it is why this file has no business logic to test.

import { createInterface } from "node:readline/promises";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  CAPABILITY_ID_RE,
  COMPANY_ID_RE,
  formatReport,
  isKnown,
  locusCandidates,
  openApiAdapter,
  postgresAdapter,
  valueOrUndefined,
  type CapabilityDecision,
  type CatalogSnapshot as InitCatalogSnapshot,
  validateDecisionRecord,
  type DecisionRecord,
  type DraftModel,
  type DraftOperation,
  type Effect,
  type SourceAdapter,
  type SourceInput,
} from "@archstone/init";
import { runInit } from "@archstone/init/loop";
import type { RecordContractOptions } from "@archstone/runtime/verify";
import { introspectCatalog, type CatalogSnapshot as SqlCatalogSnapshot, type SqlInvokeOptions } from "@archstone/provider-sql";

/** Bounded so a malformed or hostile document cannot make the host loop forever fetching. */
const MAX_REFERENCE_ROUNDS = 8;

/**
 * `init` never imports a provider, so the catalog snapshot type is defined twice: once by the SQL
 * provider that reads it and once by `init` that consumes it. This is the one place both are in
 * scope, and it fails to compile if either drifts from the other — in either direction.
 */
type Agree<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const CATALOG_TYPES_AGREE: Agree<SqlCatalogSnapshot, InitCatalogSnapshot> = true;

export interface InitArgs {
  /** The OpenAPI document. Empty for `--source postgres`, which reads a database and takes none. */
  spec: string;
  /** Where the capabilities come from. Absent means `openapi`, which is what every invocation
   *  before `--source` existed meant. */
  source?: "openapi" | "postgres";
  /** `--dsn-env`: the NAME of the environment variable holding the connection string. Never a
   *  connection string — that would be in shell history and the process list. */
  dsnEnv?: string;
  /** `--identity-map`: principal → session claims, the same file `verify` and `serve` take. */
  identityMap?: string;
  /** The principals the identity map names, in file order. Filled by the verb after it reads the
   *  map, never by argv; the gate offers them as defaults. */
  principals?: string[];
  out: string;
  domain?: string;
  company?: string;
  probe: boolean;
  decisionsFile?: string;
  interactive: boolean;
  force: boolean;
  reportFile?: string;
}

export const INIT_USAGE = [
  "usage: archstone init <spec-file> --out <dir> [options]",
  "       archstone init --source postgres --dsn-env <VAR> --out <dir> [options]",
  "",
  "  Read an API description (or a Postgres catalog), ask you the questions no tool can answer,",
  "  and write a CDL manifest the real compiler has already compiled. No LLM is involved, on any path.",
  "",
  "  --source postgres      read the catalog of a Postgres database instead of a spec file. One",
  "                         candidate per relation the runtime role can SELECT; you choose whether",
  "                         each is a list (LIMIT 100) or a lookup by one column. The connection is",
  "                         made as the runtime role and refused if it is over-privileged.",
  "  --dsn-env <VAR>        (postgres) the NAME of the environment variable holding the connection",
  "                         string. Never the string itself; it is written into the manifest as ${VAR}.",
  "  --identity-map <file>  (postgres, with --probe) principal -> session claims, as for `verify`.",
  "                         A contract is recorded only for a lookup, replayed as two principals from",
  "                         this file; `init` reads it and never copies it into the manifest.",
  "  --out <dir>            where the manifest goes (required)",
  "  --domain <name>        the domain half of every capability id (e.g. 'framing')",
  "  --company <id>         company id, lowercase kebab (e.g. 'acme')",
  "  --decisions <file>     a Decision Record JSON file, instead of the interactive gate.",
  "                         Each entry's `operation` is the CANDIDATE KEY, which is",
  "                         `<METHOD> <path>` with the path INCLUDING the server base path",
  "                         from `servers[0].url` — so a document whose `paths:` reads",
  "                         `/catalog/frames` under a server of `https://api.x.test/api/v1`",
  "                         has the key `GET /api/v1/catalog/frames`. Run without --decisions",
  "                         once to see the real keys, or read them off a failed run's report.",
  "                         Not combinable with --company or --domain, which it answers.",
  "  --report <file>        also write the report here (default: <out>/INIT-REPORT.md)",
  "  --probe                OPT-IN, READ-ONLY. Record a golden fixture by making ONE live",
  "                         request per capability you consent to. Never issued for a",
  "                         capability whose confirmed effect is not `read`; a non-GET/HEAD",
  "                         method needs a second, separate confirmation, and is refused",
  "                         outright when there is no terminal. Off by default.",
  "  --non-interactive      no prompts. Requires --decisions: `init` never defaults an",
  "                         `effect`, so with no human and no record there is nothing to do.",
  "  --force                write into a non-empty directory",
].join("\n");

// ---------------------------------------------------------------------------------------
// D-11's host half: the host fetches, the adapter stays pure.
// ---------------------------------------------------------------------------------------

/**
 * Resolve one adapter-requested reference to a real path, or refuse.
 *
 * SUBTREE ONLY. The adapter already refuses to emit a `..`, and this refuses to follow one —
 * two independent checks, because the thing being prevented is a spec file turning into an
 * arbitrary file-read primitive, and one check is one bug away from none.
 */
export function resolveReference(specFile: string, key: string): string | undefined {
  if (isAbsolute(key) || key.split(/[\\/]/).includes("..")) return undefined;
  const root = dirname(resolve(specFile));
  const target = resolve(root, key);
  if (target !== root && !target.startsWith(root + sep)) return undefined;
  return existsSync(target) && statSync(target).isFile() ? target : undefined;
}

/** Read the primary document and everything the adapter asks for, to closure. */
export function loadSource(adapter: SourceAdapter, specFile: string): { input: SourceInput; unresolved: string[] } {
  const input: SourceInput = { origin: relative(process.cwd(), specFile) || specFile, document: readFileSync(specFile, "utf8"), documents: {} };
  const unresolved: string[] = [];
  if (!adapter.references) return { input, unresolved };

  for (let round = 0; round < MAX_REFERENCE_ROUNDS; round += 1) {
    const wanted = adapter.references(input).filter((key) => input.documents![key] === undefined && !unresolved.includes(key));
    if (wanted.length === 0) break;
    for (const key of wanted) {
      const path = resolveReference(specFile, key);
      // Unresolvable is NOT fatal here. The adapter reports what it is still missing and fails
      // closed on the operations that needed it — that division of labour is the whole point
      // of `references()` being a question rather than a demand.
      if (path === undefined) unresolved.push(key);
      else input.documents![key] = readFileSync(path, "utf8");
    }
  }
  return { input, unresolved };
}

/**
 * The host half of a database source (ADR-0012 D-10): read the catalog as the runtime role, so the
 * adapter stays pure. The connection string is read from the environment variable `--dsn-env` names
 * and goes nowhere but `introspectCatalog`; an over-privileged role is refused there with D-9's own
 * message and nothing is read. Returns the adapter's input, or the refusal to print.
 */
export async function loadCatalogSource(
  dsnEnvVar: string,
  env: NodeJS.ProcessEnv,
  sql: SqlInvokeOptions = {},
): Promise<{ ok: true; input: SourceInput } | { ok: false; error: string; code: number }> {
  const dsn = env[dsnEnvVar];
  if (dsn === undefined || dsn === "") {
    return { ok: false, error: `the environment variable ${dsnEnvVar} is not set`, code: 2 };
  }
  const read = await introspectCatalog(dsnEnvVar, dsn, { ...sql, env });
  if (!read.ok) {
    return { ok: false, error: read.incomplete ? `could not read the catalog: ${read.error}` : read.error, code: 1 };
  }
  const catalog: InitCatalogSnapshot = read.snapshot;
  return { ok: true, input: { origin: `postgres catalog via ${dsnEnvVar}`, catalog, dsnEnvVar } };
}

/** `--identity-map`: the same file `verify` and `serve` take. `init` reads it for the principals
 *  and the claims, and never writes either into the manifest. */
export function readIdentityMap(path: string): { ok: true; map: Record<string, Record<string, string>> } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    return { ok: false, error: `--identity-map '${path}' could not be read/parsed: ${(err as Error).message}` };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: `--identity-map '${path}' must be a JSON object mapping a principal to its claims` };
  }
  for (const [principal, claims] of Object.entries(parsed)) {
    if (typeof claims !== "object" || claims === null || Array.isArray(claims) || Object.values(claims).some((v) => typeof v !== "string")) {
      return { ok: false, error: `--identity-map '${path}': the claims for '${principal}' must be an object of string values` };
    }
  }
  return { ok: true, map: parsed as Record<string, Record<string, string>> };
}

// ---------------------------------------------------------------------------------------
// The gate
// ---------------------------------------------------------------------------------------

/** Everything the gate needs to ask, so the asking itself is trivial and the ORDER is
 *  reviewable. Product §11.1: the minimum keystroke path for a large spec is the design. */
export interface Ask {
  question(text: string, fallback?: string): Promise<string>;
}

/**
 * Why the gate can no longer ask anything — or `undefined` if this is an ordinary bug.
 *
 * Both members end the run the same way (nothing written, one line, non-zero) and are kept
 * apart only so the line is true.
 *
 *   `no-more-input`   — `AbortError`. Ctrl+D at a TTY raises it from `_ttyWrite`
 *                       (`AbortError: Aborted with Ctrl+D`), and so does the signal
 *                       `terminalAsk` ties to the interface's `close` — which is the case a
 *                       question PENDING when stdin ends takes, i.e. the ordinary piped/CI one.
 *   `terminal-closed` — `ERR_USE_AFTER_CLOSE`. Strictly the NEXT question after readline has
 *                       already closed.
 *
 * NAMED CAREFULLY, because the obvious split is wrong. "Cancelled" would read as "the user
 * changed their mind", and the same `AbortError` covers both that and a stdin that simply ran
 * out — which is the more common one in practice. The two are indistinguishable at this point,
 * so the label and the message say only what is actually known: there is no more input.
 *
 * Detected by `name`/`code` rather than `instanceof`, because the classes Node throws are
 * internal and not exported; the name and the code are the documented parts.
 *
 * Returning `undefined` for everything else is deliberate. Swallowing a real bug as "the user
 * changed their mind" would be a worse silence than the stack trace this replaces.
 */
export function promptFailureKind(error: unknown): "no-more-input" | "terminal-closed" | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: string }).code;
  if (error.name === "AbortError" || code === "ABORT_ERR") return "no-more-input";
  if (code === "ERR_USE_AFTER_CLOSE") return "terminal-closed";
  return undefined;
}

/**
 * The REAL terminal `Ask` — and the reason it has to exist.
 *
 * `readline/promises`' signature is `question(query[, options])`, where `options` is
 * `{signal}`. Passing a fallback STRING as the second argument is silently ignored: the call
 * type-checks against a `readline.Interface` — which structurally satisfies `Ask`, since
 * `question(text, anything?)` is assignable — resolves with `""` on an empty line, and drops the
 * default on the floor.
 *
 * That is exactly what shipped: `runGate` was handed the `Interface` itself, so EVERY default in
 * the gate was dead. `--company` and `--domain` did nothing interactively, the
 * `${COMPANY}_API_URL` suggestion never appeared, and a computed capability id had to be retyped
 * in full. The minimum-keystroke path product §11.1 calls "the design" did not exist.
 *
 * It stayed invisible because the tests drive a fake `Ask` that honours the fallback — so they
 * implement the INTERFACE, and the interface is not where the bug is. The call site passes the
 * fallback correctly; it is dropped at the boundary. Nothing that substitutes for the boundary
 * can see a bug in the boundary.
 *
 * Two things this does, and both are load-bearing:
 *   - SHOWS the default, the way `confirm` already shows `[Y/n]`. A default the user cannot see
 *     is not a default, it is a coincidence.
 *   - Treats an empty line as the default — the identical rule `confirm` applies at its own
 *     prompt, which is precisely the logic every other prompt assumed someone else was doing.
 */
export function terminalAsk(rl: TerminalInterface): Ask {
  // A question already PENDING when stdin reaches EOF NEVER SETTLES — readline neither resolves
  // it nor rejects it. With no handle left to wait on, Node then drains the event loop and the
  // process exits 0, having asked a question nobody answered and written nothing. Exit 0 is the
  // worst available outcome: a script that pipes answers in reports success.
  //
  // That is exactly what `printf 'a\nb\n…' | archstone init` did, and the reason is structural
  // rather than a race: `question` registers a ONE-SHOT line handler, and readline has no queue,
  // so every line that arrives while no question is pending is discarded. A pipe delivers all
  // its lines in one chunk, so answer 1 is consumed and answers 2..n are dropped. Piping answers
  // into the gate has never worked and cannot be made to work here — `--decisions` is the
  // supported way to answer without a human.
  //
  // Tying a signal to the interface's own `close` turns that silent exit-0 into the same clean
  // refusal Ctrl+D gets: one line, nothing written, non-zero. It cannot fire on a healthy
  // terminal, where stdin stays open until the user closes it. `MAX_PROMPT_ATTEMPTS` cannot help
  // here — a bound on ATTEMPTS never fires when the first attempt never returns.
  const controller = new AbortController();
  rl.once?.("close", () => controller.abort());
  return {
    async question(text: string, fallback?: string): Promise<string> {
      const suggestion = fallback !== undefined && fallback !== "" ? fallback : undefined;
      const prompt = suggestion === undefined ? text : `${text.trimEnd()} [${suggestion}] `;
      let answer: string;
      try {
        answer = await rl.question(prompt, { signal: controller.signal });
      } catch (error) {
        // TRANSLATED AT THE BOUNDARY, not at the caller. `runGateOverTerminal` used to classify
        // whatever escaped the whole of `runGate`, which meant a future `AbortController`
        // anywhere inside it — a fetch with a timeout, say — would have its abort silently
        // relabelled as "the user pressed Ctrl+D" and reported as a clean refusal. Throwing a
        // private sentinel makes that impossible by construction: only this boundary can produce
        // one, so only this boundary's failures can be read as "no more input".
        const kind = promptFailureKind(error);
        if (kind === undefined) throw error;
        throw new PromptUnavailable(kind);
      }
      return answer.trim() === "" && suggestion !== undefined ? suggestion : answer;
    },
  };
}

/** The gate cannot ask anything further. Private to this module on purpose — see `terminalAsk`. */
class PromptUnavailable extends Error {
  constructor(readonly kind: "no-more-input" | "terminal-closed") {
    super(kind);
    this.name = "PromptUnavailable";
  }
}

/** The slice of `readline.Interface` this file uses. Narrow on purpose: a wider type is what
 *  let the interface itself be passed as an `Ask` in the first place. */
export interface TerminalInterface {
  question(query: string, options?: { signal?: AbortSignal }): Promise<string>;
  once?(event: "close", listener: () => void): unknown;
}

/**
 * Run the gate against a REAL readline interface, translating cancellation into a value.
 *
 * Extracted from the command so both halves of the terminal boundary are reachable by a test
 * that constructs an actual `readline.Interface` — which is the only kind of test that could
 * have caught either of the two defects here, since both live on the far side of `Ask` and a
 * substitute for `Ask` is by construction blind to them.
 */
export async function runGateOverTerminal(
  draft: DraftModel,
  rl: TerminalInterface,
  args: InitArgs,
): Promise<DecisionRecord | "no-more-input" | "terminal-closed" | undefined> {
  try {
    // `terminalAsk`, NEVER the interface itself: `rl` structurally satisfies `Ask` and silently
    // ignores the fallback, which is how every default in the gate came to be dead.
    return await runGate(draft, terminalAsk(rl), args);
  } catch (error) {
    // ONLY the sentinel, which only `terminalAsk` can throw. An abort raised by anything else
    // inside `runGate` is a bug and must keep looking like one.
    if (error instanceof PromptUnavailable) return error.kind;
    throw error;
  }
}

/**
 * How many times a prompt re-asks before the gate gives up.
 *
 * NOT politeness — a bound on REPEATED INVALID ANSWERS, so a `while (!valid)` loop cannot spin.
 * Found by a test whose script ran out of answers: the worker hit an OOM abort rather than
 * failing.
 *
 * CORRECTED: this comment used to justify the bound with "`readline.question` resolves with `""`
 * forever once stdin reaches EOF". That is not what `readline/promises` does — verified against
 * the real interface rather than the test double that stood in for it. At EOF a PENDING question
 * never settles at all, and a question asked AFTER the close throws `ERR_USE_AFTER_CLOSE`.
 * Neither is a spin, and neither is something a bound on attempts could ever have caught: the
 * first never returns, and the second is a rejection. `terminalAsk` handles both — see there.
 * The bound is still right, for the reason above and not for the reason it used to give.
 */
const MAX_PROMPT_ATTEMPTS = 5;

/**
 * Ask until the answer validates, or give up.
 *
 * Giving up returns `undefined` and the gate refuses the whole run — which is the correct
 * terminal state, because the alternative is defaulting a value nobody supplied, and every
 * question this gate asks exists precisely because it must not be defaulted.
 */
async function askUntil<T>(
  ask: Ask,
  question: string,
  parse: (answer: string) => T | undefined,
  onInvalid: () => void,
  fallback?: string,
): Promise<T | undefined> {
  for (let attempt = 0; attempt < MAX_PROMPT_ATTEMPTS; attempt += 1) {
    const parsed = parse((await ask.question(question, fallback)).trim());
    if (parsed !== undefined) return parsed;
    onInvalid();
  }
  return undefined;
}

/** `y`/`n` with an explicit default. Anything unrecognized takes the default — a gate that
 *  re-asks forever on a typo is a gate people learn to `--non-interactive` around. */
async function confirm(ask: Ask, text: string, fallback: boolean): Promise<boolean> {
  const answer = (await ask.question(`${text} [${fallback ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
  if (answer === "") return fallback;
  return answer.startsWith("y");
}

const EFFECTS = new Set<Effect>(["read", "write", "irreversible"]);

/**
 * The interactive gate. Produces a Decision Record and NOTHING else — no files, no requests.
 *
 * Two rules from product §11.1 shape the keystrokes, and both are about a 40-operation spec:
 * DEFAULT-SKIP with a bulk-keep escape (`a`), because most operations in a spec are not
 * capabilities; and `effect` PRE-FILLED ONLY FOR `GET`, blank and mandatory for everything
 * else. A pre-filled `read` on a `DELETE` is the exact keystroke that would make the
 * consequence-bearing asymmetry — the developer runs `init`, the business pays for a wrong
 * `effect` months later, through an agent, in front of a customer — land on the wrong person.
 */
export async function runGate(draft: DraftModel, ask: Ask, args: InitArgs): Promise<DecisionRecord | undefined> {
  const companyId = (await ask.question("Company id (lowercase, kebab-case) ", args.company)).trim();
  if (!COMPANY_ID_RE.test(companyId)) {
    console.error(`archstone init: '${companyId}' is not a valid company id (^[a-z][a-z0-9-]*$).`);
    return undefined;
  }
  const companyName = (await ask.question("Company name (for the manifest header) ", valueOrUndefined(draft.company.name))).trim();
  const domain = (await ask.question("Domain for these capabilities (the first half of every id) ", args.domain)).trim();

  // Amendment 1 §A-5 gap 4, and NF-A from the re-review: the env-var names are not derivable
  // from any source construct, so they are human answers with sane defaults — the same shape
  // as every other question here. Asked once per run, not per capability, and only for auth
  // when the source actually declared a scheme, so a public API costs zero extra keystrokes.
  const envPrefix = companyId.replace(/-/g, "_").toUpperCase();
  // A database has no base URL and no credential header: its connection string is named by
  // `--dsn-env`, so these two questions have no answer to give.
  const baseUrlEnvVar = draft.sql ? "" : (await ask.question("Env var holding the backend base URL ", `${envPrefix}_API_URL`)).trim();
  const declaresAuth = draft.auth !== undefined || draft.operations.some((o) => o.auth?.kind === "header");
  const authEnvVar = declaresAuth
    ? (await ask.question("Env var holding the API credential (never its value) ", `${envPrefix}_API_TOKEN`)).trim()
    : "";

  const decisions: CapabilityDecision[] = [];
  let keepAll = false;

  for (const [index, candidate] of draft.operations.entries()) {
    const operation: DraftOperation = candidate;
    const summary = valueOrUndefined(operation.description) ?? "";
    console.log("");
    console.log(`[${index + 1}/${draft.operations.length}] ${operation.key}`);
    if (summary) console.log(`        ${summary}`);
    const blocking = operation.notes.filter((n) => n.code.startsWith("unsupported") || n.code === "declined" || n.code === "no-expressible-columns");
    for (const n of blocking) console.log(`        ! ${n.code}${n.detail ? `: ${n.detail}` : ""}`);

    let keep = keepAll;
    if (!keep) {
      const answer = (await ask.question("        keep as a capability? [y/N/a=keep all remaining] ")).trim().toLowerCase();
      if (answer === "a") {
        keepAll = true;
        keep = true;
      } else keep = answer.startsWith("y");
    }
    if (!keep) {
      decisions.push({ operation: operation.key, keep: false });
      continue;
    }

    const action = valueOrUndefined(operation.suggestedAction);
    const suggestedId = domain !== "" && action !== undefined ? `${domain}.${action}` : undefined;
    const capabilityId = (await ask.question("        capability id (domain.action) ", suggestedId)).trim();
    if (!CAPABILITY_ID_RE.test(capabilityId)) {
      console.error(`        '${capabilityId}' is not a valid capability id — skipping this candidate.`);
      decisions.push({ operation: operation.key, keep: false, note: `invalid id '${capabilityId}' supplied at the gate` });
      continue;
    }

    // PRE-FILLED ONLY FOR `GET`. `effectHint` exists solely to fill this prompt, and the
    // emitter cannot see it — "no `effect` without human confirmation" is a property of the
    // emission signature, not a runtime check someone can route around.
    // A database candidate is the same case as a GET: a SELECT in a READ ONLY transaction. The human
    // still answers; this only fills the prompt.
    const prefill = (operation.method.toUpperCase() === "GET" || operation.sql !== undefined) && operation.effectHint ? operation.effectHint.value : undefined;
    const effect = await askUntil<Effect>(
      ask,
      "        effect (read | write | irreversible) ",
      (answer) => (EFFECTS.has(answer as Effect) ? (answer as Effect) : undefined),
      () => console.error("        must be one of: read, write, irreversible"),
      prefill,
    );
    if (effect === undefined) {
      console.error("archstone init: no valid `effect` after several attempts — refusing rather than defaulting one.");
      return undefined;
    }

    // D-14 — THE LOCUS, ASKED BEFORE THE NAME. They are the same question at two altitudes:
    // "it returns a PartQuote" IS the root answer, "it returns a list of QuoteWarning" IS the
    // array answer, and the name is unanswerable until the locus is fixed because the name
    // names the locus.
    //
    // Only asked when a choice exists. On a nine-operation spec that is three questions, not
    // nine — the census is what keeps the keystroke cost proportional.
    let responseLocus: string | undefined;
    const census = locusCandidates(operation.response);
    if (census.candidates.length > 1) {
      // R-11 IS WHY THIS PROMPT LOOKS LIKE THIS, and it is the piece the architect is least
      // confident in: a badly-worded question yields confirmed-but-wrong loci that are WORSE
      // than the silent ones they replace, because a human signed them. Nobody can answer
      // "$.warnings[*] or root?" on an endpoint they did not write. They can answer
      // "a list of (code, message)" versus "one thing with (quotedPrice, currency)".
      // Count-agnostic. The fixed string "two ways" was wrong the moment a response carried
      // root scalars plus two lists — a real shape, not a hypothetical one — and it shipped
      // because nothing in the suite reached three candidates.
      console.log(`        this response could be read ${census.candidates.length} ways — which one does this capability return?`);
      for (const [index, candidate] of census.candidates.entries()) {
        const shape = candidate.kind === "root" ? "one object, with fields" : `a list, each with fields`;
        console.log(`          ${index + 1}. ${shape}: ${candidate.fields.join(", ")}`);
        console.log(`             (${candidate.id})`);
      }
      // Pre-filled with the sole array-of-objects when there is exactly one — today's answer,
      // so a paginated list costs one keypress. A PROPOSAL, never a decision: the emitter
      // reads the selection and can never re-derive it.
      const collections = census.candidates.filter((c) => c.kind === "collection");
      // Pre-filled ONLY when there is exactly one list — that is today's answer, so a
      // paginated list costs one keypress. With two or more lists there is no defensible
      // pre-fill, and offering one would be the branch-order guess D-14 exists to remove.
      const prefill = collections.length === 1 ? String(census.candidates.indexOf(collections[0]!) + 1) : undefined;
      const picked = await askUntil<number>(
        ask,
        `        which one? [1-${census.candidates.length}] `,
        (answer) => {
          const index = Number(answer);
          return Number.isInteger(index) && index >= 1 && index <= census.candidates.length ? index : undefined;
        },
        () => console.error(`        answer with a number from 1 to ${census.candidates.length}`),
        prefill,
      );
      if (picked === undefined) {
        console.error("archstone init: no response locus chosen after several attempts — refusing rather than guessing one.");
        return undefined;
      }
      responseLocus = census.candidates[picked - 1]!.id;
    }

    // ADR-0012 D-10: one candidate per relation, and what it DOES is the human's answer — a lookup
    // by one named column, or a list bounded by a literal LIMIT. The catalog's single-column key is
    // offered as the default and applied only if the answer is given; a view has none to offer.
    let lookupColumn: string | undefined;
    if (operation.sql) {
      const offered = operation.sql.lookupColumns.map((c) => c.field.name);
      console.log(`        lookup by one column, or a list bounded to 100 rows? columns: ${offered.join(", ") || "(none can be keyed on)"}`);
      const picked = await askUntil<string>(
        ask,
        "        lookup column, or 'list' ",
        (answer) => (answer === "list" || offered.includes(answer) ? answer : undefined),
        () => console.error(`        answer with 'list' or one of: ${offered.join(", ")}`),
        operation.sql.keyColumns[0] ?? "list",
      );
      if (picked === undefined) {
        console.error("archstone init: no lookup column chosen after several attempts — refusing rather than guessing one.");
        return undefined;
      }
      if (picked !== "list") lookupColumn = picked;
    }

    const resourceName = (await ask.question("        resource name (blank = derive from the source) ")).trim();

    const decision: Extract<CapabilityDecision, { keep: true }> = {
      operation: operation.key,
      keep: true,
      capabilityId,
      effect: effect as Effect,
      ...(responseLocus !== undefined ? { responseLocus } : {}),
      ...(resourceName !== "" ? { resourceName } : {}),
      ...(lookupColumn !== undefined ? { lookupColumn } : {}),
    };

    if (operation.sql && lookupColumn === undefined && args.probe) {
      console.log("        a list cannot carry a contract (its isolation replay returns the other identity's own rows) — no probe offered.");
    } else if (args.probe && decision.effect === "read") {
      decision.probe = await confirm(
        ask,
        operation.sql
          ? "        record a golden fixture with ONE read-only SELECT against the database?"
          : `        record a golden fixture with ONE live ${operation.method} to the real backend?`,
        false,
      );
      if (decision.probe) {
        const method = operation.method.toUpperCase();
        if (!operation.sql && method !== "GET" && method !== "HEAD") {
          // R-8's second, SEPARATE confirmation. Worded so the thing being confirmed is the
          // method and not the effect again — a re-phrasing of the same question is not a
          // second condition.
          decision.probeNonReadMethodConfirmed = await confirm(
            ask,
            `        ${method} is not a GET. Confirm again that this request changes nothing on the backend:`,
            false,
          );
        }
        // D-13: pre-fill from the document's own `example`/`default`, and make the human
        // confirm every value. A probe carries a value to a production backend, and an
        // `example` may name a real customer's record — `init` cannot tell.
        //
        // THE FALLBACK IS KEPT HERE DELIBERATELY, against this gate's usual rule that a
        // consequence-bearing answer is typed rather than Entered (`effect` carries no
        // fallback; a non-`GET` probe needs its own second confirmation). By the time this
        // prompt appears the operator has ALREADY authorised a live read of this capability:
        // `--probe` is opt-in and off by default, consent is per capability, and a non-`GET`
        // method has already been confirmed separately. A sample value is a parameter of a call
        // already authorised, not a fresh authorisation.
        //
        // What makes Enter-to-accept legitimate is that the value is on screen AND ITS ORIGIN
        // IS NAMED. D-13's own worry is that a spec example may name a real customer's record —
        // `id.example: AV45` is a real product code, `artwork_id.example` is a made-up UUID, and
        // `init` cannot tell them apart. Only the human can, and only if they know the value
        // came from the API description rather than from their own last run. The raw source
        // locator used to be printed here, which is not the same thing: it is long enough to
        // skim past and it never says "somebody else wrote this".
        const sample: Record<string, unknown> = {};
        // A lookup's input is chosen above, so it is the lookup column's field; a REST operation's is
        // whatever the source declared.
        const sampleFields = operation.sql ? operation.sql.lookupColumns.filter((c) => c.field.name === lookupColumn).map((c) => c.field) : operation.input;
        for (const field of sampleFields) {
          const suggested = isKnown(field.example) ? String(field.example.value) : undefined;
          const origin = suggested === undefined ? "" : " (from the API description)";
          const required = valueOrUndefined(field.required) === true || field.in === "path";
          const typed = (await ask.question(`        sample value for ${field.name}${required ? "" : " (optional)"}${origin} `, suggested)).trim();
          if (typed !== "") sample[field.name] = coerce(typed);
        }
        if (Object.keys(sample).length > 0) decision.sampleInput = sample;
      }
    }
    decisions.push(decision);
  }

  // The two principals a recorded contract is replayed as (ADR-0012 D-8), asked once per run and
  // only when some lookup consented to a probe. Blank is allowed: the probe is then refused with the
  // reason, and the manifest is still written.
  let identities: DecisionRecord["identities"];
  if (draft.sql && decisions.some((d) => d.keep && d.probe === true)) {
    const principal = (await ask.question("Principal that owns the sample row (a key in --identity-map) ", args.principals?.[0])).trim();
    const negativePrincipal = (await ask.question("A DIFFERENT principal, who must see none of it ", args.principals?.[1])).trim();
    if (principal !== "" || negativePrincipal !== "") {
      identities = { ...(principal !== "" ? { principal } : {}), ...(negativePrincipal !== "" ? { negativePrincipal } : {}) };
    }
  }

  return {
    version: "0",
    company: { id: companyId, ...(companyName !== "" ? { name: companyName } : {}) },
    ...(baseUrlEnvVar !== "" ? { baseUrlEnvVar } : {}),
    ...(authEnvVar !== "" ? { authEnvVar } : {}),
    ...(identities ? { identities } : {}),
    decisions,
  };
}

/** A typed sample value from a terminal. JSON first (so `50`, `true`, `["a"]` survive), then
 *  the raw string — a backend that wants the string `"50"` gets it by quoting. */
function coerce(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return text;
  }
}

// ---------------------------------------------------------------------------------------
// argv
// ---------------------------------------------------------------------------------------

export function parseInitArgs(argv: string[]): InitArgs | { error: string } {
  const flag = (name: string): string | undefined => {
    const idx = argv.indexOf(name);
    return idx === -1 ? undefined : argv[idx + 1];
  };
  const valued = ["--out", "--domain", "--company", "--decisions", "--report", "--source", "--dsn-env", "--identity-map"];
  const consumed = new Set<number>();
  for (const name of valued) {
    const idx = argv.indexOf(name);
    if (idx !== -1) {
      consumed.add(idx);
      consumed.add(idx + 1);
    }
  }
  const positional = argv.filter((a, i) => !consumed.has(i) && !a.startsWith("--"));
  const spec = positional[1]; // positional[0] is the verb itself
  const sourceFlag = flag("--source");
  if (sourceFlag !== undefined && sourceFlag !== "openapi" && sourceFlag !== "postgres") {
    return { error: `--source '${sourceFlag}' is not a source (openapi, postgres)` };
  }
  const source = sourceFlag ?? "openapi";
  const dsnEnv = flag("--dsn-env");
  const identityMap = flag("--identity-map");
  if (source === "postgres") {
    if (spec !== undefined) return { error: "--source postgres reads a database and takes no <spec-file>" };
    if (dsnEnv === undefined) return { error: "--source postgres requires --dsn-env <VAR>, the name of the environment variable holding the connection string" };
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(dsnEnv)) {
      // Never echoed: a value that is not a variable name may well be a connection string.
      return { error: "--dsn-env takes the NAME of an environment variable, never a connection string" };
    }
    if (identityMap !== undefined && !argv.includes("--probe")) return { error: "--identity-map is used only with --probe: it names the identities a recorded contract is replayed as" };
  } else {
    if (spec === undefined) return { error: "a spec file is required" };
    if (dsnEnv !== undefined) return { error: "--dsn-env is used only with --source postgres" };
    if (identityMap !== undefined) return { error: "--identity-map is used only with --source postgres" };
  }
  const out = flag("--out");
  if (out === undefined) return { error: "--out <dir> is required" };

  return {
    spec: spec ?? "",
    // Only when `--source` was given: an invocation that never mentions it parses to exactly what it
    // parsed to before the flag existed.
    ...(sourceFlag !== undefined ? { source } : {}),
    ...(dsnEnv !== undefined ? { dsnEnv } : {}),
    ...(identityMap !== undefined ? { identityMap } : {}),
    out,
    ...(flag("--domain") !== undefined ? { domain: flag("--domain")! } : {}),
    ...(flag("--company") !== undefined ? { company: flag("--company")! } : {}),
    probe: argv.includes("--probe"),
    ...(flag("--decisions") !== undefined ? { decisionsFile: flag("--decisions")! } : {}),
    interactive: !argv.includes("--non-interactive"),
    force: argv.includes("--force"),
    ...(flag("--report") !== undefined ? { reportFile: flag("--report")! } : {}),
  };
}

// ---------------------------------------------------------------------------------------
// The verb
// ---------------------------------------------------------------------------------------

/** What a test may substitute. Nothing here is reachable from the command line. */
export interface InitDeps {
  /** Pool factory and connection registry for the database source, so a test owns its pools. */
  sql?: SqlInvokeOptions;
  /** The environment the DSN variable is read from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export async function runInitCmd(argv: string[], deps: InitDeps = {}): Promise<number> {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(INIT_USAGE);
    return 0;
  }
  const parsed = parseInitArgs(argv);
  if ("error" in parsed) {
    console.error(`archstone init: ${parsed.error}\n\n${INIT_USAGE}`);
    return 2;
  }
  const args = parsed;
  const env = deps.env ?? process.env;

  let adapter: SourceAdapter;
  let input: SourceInput;
  let invoke: RecordContractOptions | undefined;
  if (args.source === "postgres") {
    adapter = postgresAdapter;
    // The identity map is read before the database is touched: a bad path should cost nothing.
    let identityAdapter: ((principal: string | undefined) => Record<string, string> | undefined) | undefined;
    if (args.identityMap !== undefined) {
      const loaded = readIdentityMap(resolve(process.cwd(), args.identityMap));
      if (!loaded.ok) {
        console.error(`archstone init: ${loaded.error}`);
        return 2;
      }
      args.principals = Object.keys(loaded.map);
      identityAdapter = (principal) => (principal !== undefined && Object.hasOwn(loaded.map, principal) ? loaded.map[principal] : undefined);
    }
    const source = await loadCatalogSource(args.dsnEnv!, env, deps.sql);
    if (!source.ok) {
      console.error(`archstone init: ${source.error}`);
      return source.code;
    }
    input = source.input;
    invoke = { ...deps.sql, env, ...(identityAdapter ? { identityAdapter } : {}) };
  } else {
    const specFile = resolve(process.cwd(), args.spec);
    if (!existsSync(specFile)) {
      console.error(`archstone init: no such file: ${specFile}`);
      return 2;
    }

    adapter = openApiAdapter;
    const loaded = loadSource(adapter, specFile);
    input = loaded.input;
    for (const key of loaded.unresolved) {
      console.error(`archstone init: referenced document '${key}' could not be read from the spec's own directory — operations that need it will be skipped.`);
    }
  }
  const draft = adapter.adapt(input);

  if (draft.operations.length === 0) {
    console.error(`archstone init: ${adapter.id} found no candidate operations in ${args.source === "postgres" ? input.origin : args.spec}.`);
    for (const n of draft.notes) console.error(`  - ${n.code}${n.detail ? `: ${n.detail}` : ""}`);
    return 1;
  }

  let record: DecisionRecord | undefined;
  if (args.decisionsFile !== undefined) {
    // C-3: a flag that answers a question the record already answers is a CONFLICT, not a
    // default. Silently ignoring it is the failure mode the `interactive` fix already closed
    // once — the user said something and the tool pretended they had not.
    const ignored = [args.company !== undefined ? "--company" : undefined, args.domain !== undefined ? "--domain" : undefined].filter(
      (f): f is string => f !== undefined,
    );
    if (ignored.length > 0) {
      console.error(
        `archstone init: ${ignored.join(" and ")} ${ignored.length === 1 ? "is" : "are"} answered by the Decision Record and cannot be combined with --decisions.\n` +
          `  ${ignored.includes("--company") ? "Set `company.id` in the record" : ""}${ignored.length === 2 ? "; " : ""}${ignored.includes("--domain") ? "the domain is the first half of each `capabilityId` in the record" : ""}.`,
      );
      return 2;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(resolve(process.cwd(), args.decisionsFile), "utf8"));
    } catch (err) {
      console.error(`archstone init: cannot read the Decision Record: ${(err as Error).message}`);
      return 2;
    }
    // C-2: the record used to be an unchecked cast, and it was the ONE input `init` trusted
    // completely while refusing to trust anything else. A missing `company` produced a raw
    // TypeError with a stack trace — on the `--non-interactive` path, which is CI, where a
    // stack trace is the least actionable output there is.
    const validation = validateDecisionRecord(parsed);
    if (!validation.ok) {
      console.error(`archstone init: the Decision Record at ${args.decisionsFile} is not valid:`);
      for (const problem of validation.problems) console.error(`  - ${problem}`);
      return 2;
    }
    record = validation.record;
  } else if (!args.interactive) {
    // DoD-5(d), and the one refusal in this file that is not about the network: `init` never
    // defaults an `effect`. With no human to ask and no record to read, there is nothing to do
    // that would not be a guess about a value the business pays for months later.
    console.error("archstone init: --non-interactive requires --decisions <file>. `init` never defaults an `effect`.");
    return 2;
  } else {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let outcome: DecisionRecord | "no-more-input" | "terminal-closed" | undefined;
    try {
      outcome = await runGateOverTerminal(draft, rl, args);
    } finally {
      rl.close();
    }
    // Ctrl+D is a user saying "I changed my mind"; a closed stdin is a terminal that went away.
    // Both deserve the clean terminal state the refusal paths already produce — nothing written,
    // one line, non-zero — rather than the unhandled error and Node stack trace they used to
    // produce. A retry bound cannot cover either: both arrive as a REJECTED PROMISE, and
    // `MAX_PROMPT_ATTEMPTS` counts answers, not failures to be able to ask.
    if (outcome === "no-more-input") {
      // Deliberately NOT "cancelled": the same `AbortError` covers Ctrl+D and a stdin that ran
      // out, and telling a CI runner it changed its mind is a small lie that costs someone an
      // hour. The hint names the supported way to answer without a human.
      console.error("\narchstone init: no more input (Ctrl+D, or stdin ended) — nothing was written.");
      console.error("  To answer without a human, use --decisions <file> --non-interactive.");
      return 2;
    }
    if (outcome === "terminal-closed") {
      console.error("\narchstone init: the terminal closed before the gate finished — nothing was written.");
      return 2;
    }
    record = outcome;
    if (!record) return 2;
  }

  const result = await runInit(draft, record, {
    targetDir: resolve(process.cwd(), args.out),
    force: args.force,
    probe: args.probe,
    // "Interactive" for R-8's purposes means A HUMAN WAS ACTUALLY ASKED, not "the
    // --non-interactive flag was absent". A Decision Record file supplies every answer up
    // front, so `--decisions` without `--non-interactive` has no prompt either — and treating
    // it as interactive would let a file-supplied `probeNonReadMethodConfirmed` authorize a
    // non-GET probe against a production backend with nobody at the terminal. The second
    // confirmation is a human act performed AT THE MOMENT OF THE CALL; that is the whole
    // reason it is separate from `effect`, which a file may legitimately carry.
    interactive: args.interactive && args.decisionsFile === undefined,
    ...(invoke ? { invoke } : {}),
  });

  const report = formatReport({
    origin: draft.source.origin,
    adapter: draft.source.adapter,
    targetDir: resolve(process.cwd(), args.out),
    emitted: result.emitted,
    written: result.written,
    failures: result.failures,
    probes: result.probes.map((p) => ({ capabilityId: p.capabilityId, outcome: p.outcome, detail: p.detail })),
    verifications: result.verifications,
    candidates: draft.operations.length,
  });
  console.log(`\n${report}`);

  if (result.ok) {
    // The report goes to a COMMITTABLE FILE as well as to stdout (product §11.2): the file is
    // the pull-request review surface, and a reviewer who was not at the terminal is the second
    // pair of eyes on the one risk automation cannot close (R-9).
    const reportFile = args.reportFile !== undefined ? resolve(process.cwd(), args.reportFile) : join(resolve(process.cwd(), args.out), "INIT-REPORT.md");
    try {
      writeFileSync(reportFile, report);
      console.log(`Report also written to ${reportFile}\n`);
    } catch (err) {
      console.error(`archstone init: could not write the report file: ${(err as Error).message}`);
    }
  }

  return result.ok ? 0 : 1;
}
