import { parse as parseShell } from "shell-quote";
import { z } from "zod";

/**
 * Structural (not semantic) analysis of a shell command line.
 *
 * Parsing proves only that a command has a recognizable shape. It never proves that a command
 * produces a particular result, so callers must not report "correct" on the strength of parsing
 * alone — only on the strength of the explicit constraints an instructor configured.
 */

const SHELL_KEYWORDS = new Set([
  "if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac",
  "in", "function", "select", "time", "{", "}", "!", "[[", "]]",
]);
const REDIRECTION_OPS = new Set([">", ">>", "<", "<<", "<<<", ">&", "<&", "&>", ">|"]);
const CONTROL_OPS = new Set([";", "&&", "||", "&", "\n"]);

export type CommandSegment = {
  /** First non-assignment token of the segment, or null for an empty segment. */
  command: string | null;
  isKeyword: boolean;
  /** Every token after the command, with globs rendered back to their pattern. */
  args: string[];
  /** Long flags (`--color=auto` becomes `--color`) and short flags, cluster-expanded. */
  flags: string[];
  /** Flags exactly as written, e.g. `-la` or `--color=auto`. */
  rawFlags: string[];
  /** Non-flag arguments. */
  operands: string[];
  redirections: { op: string; target: string | null; fd: string | null }[];
};
export type ShellStatement = { segments: CommandSegment[] };
/** Constructs the supported subset cannot reason about. Their presence forces instructor review. */
export type UnsupportedConstruct = { construct: string; explanation: string };
export type ShellAnalysis = {
  ok: boolean;
  error: string | null;
  statements: ShellStatement[];
  /** Flattened pipeline command names across all statements, keywords excluded. */
  commands: string[];
  flags: string[];
  rawFlags: string[];
  operands: string[];
  redirections: { op: string; target: string | null; fd: string | null }[];
  pipeSegments: number;
  controlOperators: string[];
  /** Verbatim contents of every quoted span in the source, in order. */
  quoted: string[];
  /** Non-empty when the answer uses shell features outside the supported subset. */
  unsupported: UnsupportedConstruct[];
};

/**
 * Splits the source into unquoted and quoted regions. Structural feature detection must ignore
 * quoted text: `echo "$(date)"` is a literal string to grep-style constraints, not a substitution.
 */
function scanRegions(source: string) {
  const unquoted: string[] = [], quoted: string[] = [];
  let quote: '"' | "'" | null = null, escaped = false, buffer = "";
  for (const character of source) {
    if (escaped) { escaped = false; buffer += character; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; buffer += character; continue; }
    if (quote) {
      if (character === quote) { quoted.push(buffer); buffer = ""; quote = null; }
      else buffer += character;
      continue;
    }
    if (character === '"' || character === "'") { unquoted.push(buffer); buffer = ""; quote = character; continue; }
    buffer += character;
  }
  (quote ? quoted : unquoted).push(buffer);
  return { unquoted, quoted };
}

/**
 * Detects shell features the structural checker cannot evaluate. These never make an answer
 * incorrect — they make it unreviewable by code, so it is handed to a human instead.
 */
const UNSUPPORTED_PATTERNS: [RegExp, string, string][] = [
  [/\$\(\(/, "arithmetic expansion", "`$((...))` is evaluated at run time, so its value cannot be checked statically"],
  [/<\(|>\(/, "process substitution", "`<(...)` and `>(...)` create run-time file descriptors"],
  [/\$\(/, "command substitution", "`$(...)` runs another command, whose output cannot be known without executing it"],
  [/`/, "backtick command substitution", "backticks run another command, whose output cannot be known without executing it"],
  [/<<-?\s*['\"]?\w/, "here-document", "here-documents carry multi-line input the checker does not model"],
  [/\$\{?[A-Za-z_][A-Za-z0-9_]*\}?/, "variable reference", "a variable's value is only known at run time"],
  [/(^|[\s;&|])\(/, "subshell", "`( ... )` groups commands in a subshell"],
  [/\{[^}]*,[^}]*\}/, "brace expansion", "`{a,b}` expands to several words before the command runs"],
];
const UNSUPPORTED_KEYWORDS = new Set(["if", "for", "while", "until", "case", "function", "select", "[[", "{"]);

function unsupportedConstructs(unquoted: string[], commands: string[]): UnsupportedConstruct[] {
  const found = new Map<string, UnsupportedConstruct>();
  const text = unquoted.join(" ");
  for (const [pattern, construct, explanation] of UNSUPPORTED_PATTERNS)
    if (pattern.test(text) && !found.has(construct)) found.set(construct, { construct, explanation });
  for (const command of commands)
    if (UNSUPPORTED_KEYWORDS.has(command) && !found.has("compound statement"))
      found.set("compound statement", {
        construct: "compound statement",
        explanation: `\`${command}\` starts a compound statement (loop, conditional or function) that the checker does not model`,
      });
  return [...found.values()];
}

const emptySegment = (): CommandSegment =>
  ({ command: null, isKeyword: false, args: [], flags: [], rawFlags: [], operands: [], redirections: [] });

/** Shell-quote accepts unbalanced quotes silently, so quoting is validated separately. */
function quotingError(source: string): string | null {
  let quote: '"' | "'" | null = null, escaped = false;
  for (const character of source) {
    if (escaped) { escaped = false; continue; }
    if (character === "\\" && quote !== "'") { escaped = true; continue; }
    if (quote) { if (character === quote) quote = null; continue; }
    if (character === '"' || character === "'") quote = character;
  }
  if (quote) return `Unbalanced ${quote === '"' ? "double" : "single"} quote`;
  if (escaped) return "Trailing backslash escape";
  return null;
}

function classifyFlag(token: string, segment: CommandSegment) {
  if (token === "-" || token === "--" || !token.startsWith("-")) { segment.operands.push(token); return; }
  segment.rawFlags.push(token);
  if (token.startsWith("--")) { segment.flags.push(token.split("=")[0]); return; }
  // `-la` is shorthand for `-l -a`; record the cluster and each individual flag.
  const letters = token.slice(1);
  if (/^[A-Za-z0-9]+$/.test(letters)) for (const letter of letters) segment.flags.push(`-${letter}`);
  else segment.flags.push(token);
}

export function analyzeShell(source: string): ShellAnalysis {
  const base: ShellAnalysis = {
    ok: false, error: null, statements: [], commands: [], flags: [], rawFlags: [],
    operands: [], redirections: [], pipeSegments: 0, controlOperators: [], quoted: [], unsupported: [],
  };
  const regions = scanRegions(source);
  const quoting = quotingError(source);
  if (quoting) return { ...base, error: quoting, quoted: regions.quoted };
  let tokens: ReturnType<typeof parseShell>;
  try {
    // Keep variable references literal instead of expanding them against the host environment.
    tokens = parseShell(source, (key: string) => `$${key}`);
  } catch (error) {
    return {
      ...base, quoted: regions.quoted,
      error: error instanceof Error ? error.message : "Could not parse the command",
      // A tokenizer limitation is not evidence about the student; callers must route it to review.
      unsupported: [{ construct: "unparsable command", explanation: "the tokenizer could not read this command line" }],
    };
  }
  const statements: ShellStatement[] = [];
  let statement: ShellStatement = { segments: [] };
  let segment = emptySegment();
  const controlOperators: string[] = [];
  let pendingRedirect: { op: string; fd: string | null } | null = null;

  const closeSegment = () => { statement.segments.push(segment); segment = emptySegment(); };
  const closeStatement = () => { closeSegment(); statements.push(statement); statement = { segments: [] }; };

  for (const token of tokens) {
    if (typeof token === "string") {
      if (pendingRedirect) {
        segment.redirections.push({ ...pendingRedirect, target: token });
        pendingRedirect = null;
        continue;
      }
      if (segment.command === null) {
        // `NAME=value command ...` keeps the assignment as an operand and uses the next token.
        if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(token)) { segment.operands.push(token); continue; }
        segment.command = token;
        segment.isKeyword = SHELL_KEYWORDS.has(token);
        continue;
      }
      segment.args.push(token);
      classifyFlag(token, segment);
      continue;
    }
    if ("comment" in token) continue;
    if (!("op" in token)) continue;
    if (token.op === "glob") {
      const pattern = (token as { pattern: string }).pattern;
      if (pendingRedirect) { segment.redirections.push({ ...pendingRedirect, target: pattern }); pendingRedirect = null; continue; }
      if (segment.command === null) { segment.command = pattern; continue; }
      segment.args.push(pattern);
      classifyFlag(pattern, segment);
      continue;
    }
    const op = token.op;
    if (REDIRECTION_OPS.has(op)) {
      if (pendingRedirect) segment.redirections.push({ ...pendingRedirect, target: null });
      // A bare numeric operand immediately before a redirection is its file descriptor (`2>&1`).
      const previous = segment.operands[segment.operands.length - 1];
      let fd: string | null = null;
      if (previous !== undefined && /^[0-9]$/.test(previous) && segment.args[segment.args.length - 1] === previous) {
        fd = previous; segment.operands.pop(); segment.args.pop();
      } else if (segment.command !== null && segment.args.length === 0 && /^[0-9]$/.test(segment.command)) {
        fd = segment.command; segment.command = null;
      }
      pendingRedirect = { op, fd };
      continue;
    }
    if (pendingRedirect) { segment.redirections.push({ ...pendingRedirect, target: null }); pendingRedirect = null; }
    if (op === "|" || op === "|&") { closeSegment(); continue; }
    if (CONTROL_OPS.has(op)) { controlOperators.push(op); closeStatement(); continue; }
    // Any other operator (subshells, process substitution) is recorded as an operand.
    if (segment.command === null) segment.command = op; else { segment.args.push(op); segment.operands.push(op); }
  }
  if (pendingRedirect) segment.redirections.push({ ...pendingRedirect, target: null });
  closeStatement();

  const nonEmpty = statements
    .map((s) => ({ segments: s.segments.filter((seg) => seg.command !== null || seg.operands.length || seg.redirections.length) }))
    .filter((s) => s.segments.length);
  const allSegments = nonEmpty.flatMap((s) => s.segments);
  const allCommands = allSegments.filter((s) => s.command !== null).map((s) => s.command!);
  return {
    ok: true, error: null, statements: nonEmpty,
    quoted: regions.quoted,
    unsupported: unsupportedConstructs(regions.unquoted, allCommands),
    commands: allSegments.filter((s) => s.command && !s.isKeyword).map((s) => s.command!),
    flags: allSegments.flatMap((s) => s.flags),
    rawFlags: allSegments.flatMap((s) => s.rawFlags),
    operands: allSegments.flatMap((s) => s.operands),
    redirections: allSegments.flatMap((s) => s.redirections),
    pipeSegments: Math.max(...nonEmpty.map((s) => s.segments.length), 0),
    controlOperators,
  };
}


const commandName = z.string().trim().min(1).max(100);
const flagName = z.string().trim().min(1).max(60).regex(/^-/, "Flags must start with `-`, e.g. -n or --line-number");
const argumentText = z.string().trim().min(1).max(200);
const redirectionOp = z.string().trim().min(1).max(10);

/**
 * Instructor-authored structural assertions.
 *
 * Two independent ideas live here:
 *
 * 1. **Positive assertions** (`command`, `requiredFlags`, `requiredArguments`, ...) say what an
 *    answer must contain.
 * 2. **Closure** (`exactFlags`/`allowedFlags`, `positionalArguments`/`allowExtraArguments`,
 *    `maxStatements`) says what an answer may *not* contain beyond that.
 *
 * Positive assertions alone can never establish correctness: `grep -n "ERROR" app.log` and
 * `grep -nv "ERROR" app.log` satisfy exactly the same positive assertions while doing opposite
 * things. `completeness: "strict"` therefore requires closure, and `completeness: "open"` keeps
 * under-specified legacy configurations working while downgrading anything unaccounted-for to
 * instructor review instead of silently awarding a point.
 */
export const bashConstraints = z.object({
  /** Accepted names for the first command in the answer. */
  command: z.array(commandName).max(30).optional(),
  /** Commands that must appear somewhere in the answer. */
  requiredCommands: z.array(commandName).max(30).optional(),
  forbiddenCommands: z.array(commandName).max(30).optional(),
  /** Exact ordered pipeline, e.g. ["grep", "wc"]. */
  pipeline: z.array(commandName).max(20).optional(),

  requiredFlags: z.array(flagName).max(30).optional(),
  forbiddenFlags: z.array(flagName).max(30).optional(),
  /** Closed whitelist: any other flag makes the answer incorrect. Required flags are implicit. */
  allowedFlags: z.array(flagName).max(60).optional(),
  /** The flag set must be exactly this, no more and no less. Implies `allowedFlags`. */
  exactFlags: z.array(flagName).max(60).optional(),
  /** Declares equivalent spellings, e.g. {"-n": ["--line-number"]}, so either form is accepted. */
  flagAliases: z.record(flagName, z.array(flagName).max(10)).optional(),
  /** Flags that consume the following word (e.g. `-m 5`), so it is not mistaken for an operand. */
  flagsWithValues: z.array(flagName).max(30).optional(),
  /** Required `--name=value` / `-n value` pairs. */
  requiredFlagValues: z.record(flagName, argumentText).optional(),

  /** Operands (paths, patterns, arguments) that must be present, order not considered. */
  requiredArguments: z.array(argumentText).max(30).optional(),
  forbiddenArguments: z.array(argumentText).max(30).optional(),
  /** The complete ordered operand list. This is what makes `grep PATTERN FILE` ≠ `grep FILE PATTERN`. */
  positionalArguments: z.array(argumentText).max(30).optional(),
  /** `strict` compares `positionalArguments` in order; `any` compares them as a set. */
  argumentOrder: z.enum(["strict", "any"]).default("strict"),
  /** Permits operands beyond those listed. Off by default so stray arguments are caught. */
  allowExtraArguments: z.boolean().default(false),
  /** Operands that must be quoted in the source, e.g. a pattern containing spaces or globs. */
  quotedArguments: z.array(argumentText).max(30).optional(),

  requiredRedirections: z.array(redirectionOp).max(10).optional(),
  forbiddenRedirections: z.array(redirectionOp).max(10).optional(),
  /** Rejects redirections that were not explicitly required. */
  allowExtraRedirections: z.boolean().default(false),

  minPipeSegments: z.number().int().min(1).max(20).optional(),
  maxPipeSegments: z.number().int().min(1).max(20).optional(),
  /** Separate statements (`;`, `&&`, `||`). One by default, so `cmd; rm -rf /` is not "correct". */
  maxStatements: z.number().int().min(1).max(10).default(1),

  /**
   * `strict` requires the constraints to be closed and grades definitively.
   * `open` allows partial constraints but returns `needs_review` for anything unaccounted-for.
   */
  completeness: z.enum(["strict", "open"]).default("strict"),
}).superRefine((c, ctx) => {
  const configured = Object.entries(c).filter(([key, value]) =>
    value !== undefined && !["argumentOrder", "allowExtraArguments", "allowExtraRedirections", "maxStatements", "completeness"].includes(key));
  if (!configured.length)
    ctx.addIssue({ code: "custom", message: "bash_structure requires at least one structural constraint" });
  if (c.minPipeSegments && c.maxPipeSegments && c.minPipeSegments > c.maxPipeSegments)
    ctx.addIssue({ code: "custom", message: "minPipeSegments cannot exceed maxPipeSegments" });
  if (c.exactFlags && c.allowedFlags)
    ctx.addIssue({ code: "custom", message: "Use either exactFlags (the complete set) or allowedFlags (a whitelist), not both" });
  if (c.positionalArguments && c.requiredArguments)
    ctx.addIssue({ code: "custom", message: "Use either positionalArguments (the complete ordered list) or requiredArguments (presence only), not both" });
  if (c.completeness === "open") return;
  // Strict mode has to be able to *disprove* an answer, which requires closed flag and operand sets.
  if (!c.command && !c.pipeline)
    ctx.addIssue({ code: "custom", message: "strict bash_structure requires `command` (or `pipeline`) so the expected command is unambiguous. Add it, or set completeness:'open' to send unrecognised answers to instructor review." });
  if (!c.exactFlags && !c.allowedFlags)
    ctx.addIssue({ code: "custom", message: "strict bash_structure requires `exactFlags` (the complete option set, use [] for none) or `allowedFlags` (a whitelist). Without one, an extra option such as `-v` would silently pass. Alternatively set completeness:'open' to route such answers to instructor review." });
  if (!c.positionalArguments && !c.allowExtraArguments)
    ctx.addIssue({ code: "custom", message: "strict bash_structure requires `positionalArguments` (the complete ordered operand list, use [] for none) or allowExtraArguments:true. Without one, reordered or extra arguments would silently pass." });
});
export type BashConstraints = z.infer<typeof bashConstraints>;
/** Stored legacy configurations predate the closure fields, so every field is optional at runtime. */
export type BashConstraintsLike = Partial<BashConstraints>;

export type BashErrorType =
  "syntax_error" | "incorrect_command" | "incorrect_flag" | "incorrect_arguments" | "redirection_error";
export type ConstraintFailure = { check: string; message: string; errorType: BashErrorType };
/** Something the checker observed but was not told how to judge. Never counted against a student. */
export type ConstraintAmbiguity = { check: string; message: string };

const has = (values: string[], wanted: string) => values.includes(wanted);
const list = (values: string[]) => values.map((v) => `\`${v}\``).join(", ");

/** Resolves alias spellings so `-n` and `--line-number` compare equal when declared equivalent. */
function canonicalizer(aliases: Record<string, string[]> | undefined) {
  const map = new Map<string, string>();
  for (const [canonical, spellings] of Object.entries(aliases ?? {}))
    for (const spelling of spellings) map.set(spelling, canonical);
  return (flag: string) => map.get(flag) ?? flag;
}

/**
 * Re-reads each segment so that declared value-taking flags consume their value instead of leaving
 * it in the operand list, which would otherwise look like a stray positional argument.
 */
function resolveSegments(analysis: ShellAnalysis, flagsWithValues: string[], canonical: (flag: string) => string) {
  const valueFlags = new Set(flagsWithValues.map(canonical));
  const flags: string[] = [], operands: string[] = [];
  const flagValues = new Map<string, string[]>();
  const record = (flag: string, value: string | null) => {
    flags.push(flag);
    if (value === null) return;
    const existing = flagValues.get(flag);
    if (existing) existing.push(value); else flagValues.set(flag, [value]);
  };
  for (const segment of analysis.statements.flatMap((s) => s.segments)) {
    for (let i = 0; i < segment.args.length; i++) {
      const token = segment.args[i];
      if (!token.startsWith("-") || token === "-" || token === "--") { operands.push(token); continue; }
      if (token.startsWith("--")) {
        const [name, ...rest] = token.split("=");
        const flag = canonical(name);
        if (rest.length) { record(flag, rest.join("=")); continue; }
        if (valueFlags.has(flag) && segment.args[i + 1] !== undefined) { record(flag, segment.args[++i]); continue; }
        record(flag, null);
        continue;
      }
      const letters = token.slice(1);
      if (!/^[A-Za-z0-9]+$/.test(letters)) { record(canonical(token), null); continue; }
      // `-la` is `-l -a`; only the final letter of a cluster may take a value (`-m5` or `-m 5`).
      for (let letter = 0; letter < letters.length; letter++) {
        const flag = canonical(`-${letters[letter]}`);
        const remainder = letters.slice(letter + 1);
        if (valueFlags.has(flag)) {
          if (remainder) { record(flag, remainder); letter = letters.length; }
          else if (segment.args[i + 1] !== undefined) record(flag, segment.args[++i]);
          else record(flag, null);
          continue;
        }
        record(flag, null);
      }
    }
  }
  return { flags, operands, flagValues };
}

/**
 * Checks an answer against the configured assertions.
 *
 * Returns `failures` (verified wrong) separately from `ambiguities` (the checker was not told how
 * to judge something it observed). Callers must never report "correct" while an ambiguity stands.
 */
export function checkBashConstraints(source: string, constraints: BashConstraintsLike) {
  const analysis = analyzeShell(source);
  const failures: ConstraintFailure[] = [];
  const ambiguities: ConstraintAmbiguity[] = [];
  const strict = constraints.completeness === "strict";

  if (!analysis.ok) {
    // Unbalanced quoting is objectively invalid shell; anything else is a limit of *our* reader.
    if (analysis.unsupported.length)
      return {
        analysis, failures, ambiguities: [{ check: "parse", message: analysis.error ?? "The command could not be read" }],
      };
    return {
      analysis, ambiguities,
      failures: [{ check: "parse", message: analysis.error ?? "Could not parse the command", errorType: "syntax_error" as const }],
    };
  }
  for (const { construct, explanation } of analysis.unsupported)
    ambiguities.push({ check: "unsupported", message: `This answer uses ${construct}: ${explanation}` });
  if (!analysis.commands.length) {
    if (ambiguities.length) return { analysis, failures, ambiguities };
    return {
      analysis, ambiguities,
      failures: [{ check: "parse", message: "No command was found", errorType: "syntax_error" as const }],
    };
  }

  const canonical = canonicalizer(constraints.flagAliases);
  const resolved = resolveSegments(analysis, constraints.flagsWithValues ?? [], canonical);
  const observedFlags = resolved.flags;
  const operands = resolved.operands;

  const first = analysis.statements[0]?.segments[0]?.command ?? null;
  if (constraints.command && (first === null || !constraints.command.includes(first)))
    failures.push({ check: "command", message: `Expected the command to be one of: ${list(constraints.command)}`, errorType: "incorrect_command" });
  for (const required of constraints.requiredCommands ?? [])
    if (!has(analysis.commands, required))
      failures.push({ check: "requiredCommands", message: `Expected \`${required}\` to be used`, errorType: "incorrect_command" });
  for (const forbidden of constraints.forbiddenCommands ?? [])
    if (has(analysis.commands, forbidden))
      failures.push({ check: "forbiddenCommands", message: `\`${forbidden}\` is not allowed for this task`, errorType: "incorrect_command" });
  if (constraints.pipeline) {
    const actual = analysis.statements[0]?.segments.map((s) => s.command ?? "").filter(Boolean) ?? [];
    if (actual.length !== constraints.pipeline.length || constraints.pipeline.some((c, i) => actual[i] !== c))
      failures.push({
        check: "pipeline",
        message: `Expected the pipeline ${constraints.pipeline.join(" | ")}, but found ${actual.join(" | ") || "nothing"}`,
        errorType: "incorrect_command",
      });
  }

  // --- flags -------------------------------------------------------------------------------
  const required = (constraints.requiredFlags ?? []).map(canonical);
  const exact = constraints.exactFlags?.map(canonical);
  const allowed = constraints.allowedFlags?.map(canonical);
  for (const flag of required)
    if (!has(observedFlags, flag))
      failures.push({ check: "requiredFlags", message: `Expected the \`${flag}\` option`, errorType: "incorrect_flag" });
  for (const flag of (constraints.forbiddenFlags ?? []).map(canonical))
    if (has(observedFlags, flag))
      failures.push({ check: "forbiddenFlags", message: `The \`${flag}\` option is not allowed here`, errorType: "incorrect_flag" });
  if (exact) {
    const missing = exact.filter((flag) => !has(observedFlags, flag));
    const extra = observedFlags.filter((flag) => !has(exact, flag));
    if (missing.length)
      failures.push({ check: "exactFlags", message: `Missing option(s): ${list(missing)}`, errorType: "incorrect_flag" });
    if (extra.length)
      failures.push({ check: "exactFlags", message: `Unexpected option(s): ${list([...new Set(extra)])}. This question expects exactly ${exact.length ? list(exact) : "no options"}`, errorType: "incorrect_flag" });
  } else if (allowed) {
    const permitted = [...allowed, ...required];
    const extra = observedFlags.filter((flag) => !has(permitted, flag));
    if (extra.length)
      failures.push({ check: "allowedFlags", message: `Unexpected option(s): ${list([...new Set(extra)])}`, errorType: "incorrect_flag" });
  } else {
    // No closure configured: an unexpected option changes behaviour, so this cannot be graded.
    const unaccounted = observedFlags.filter((flag) => !has(required, flag));
    if (unaccounted.length)
      ambiguities.push({
        check: "flags",
        message: `The option(s) ${list([...new Set(unaccounted)])} are not described by this question's grading rules, so the answer cannot be judged automatically`,
      });
  }
  for (const [flag, value] of Object.entries(constraints.requiredFlagValues ?? {}))
    if (!(resolved.flagValues.get(canonical(flag)) ?? []).includes(value))
      failures.push({ check: "requiredFlagValues", message: `Expected \`${flag}\` to be given the value \`${value}\``, errorType: "incorrect_flag" });

  // --- operands ----------------------------------------------------------------------------
  for (const argument of constraints.forbiddenArguments ?? [])
    if (has(operands, argument))
      failures.push({ check: "forbiddenArguments", message: `\`${argument}\` is not allowed as an argument`, errorType: "incorrect_arguments" });
  if (constraints.positionalArguments) {
    const expected = constraints.positionalArguments;
    if (constraints.argumentOrder === "any") {
      const missing = expected.filter((argument) => !has(operands, argument));
      if (missing.length)
        failures.push({ check: "positionalArguments", message: `Missing argument(s): ${list(missing)}`, errorType: "incorrect_arguments" });
      const extra = operands.filter((argument) => !has(expected, argument));
      if (extra.length && !constraints.allowExtraArguments)
        failures.push({ check: "positionalArguments", message: `Unexpected argument(s): ${list(extra)}`, errorType: "incorrect_arguments" });
    } else {
      const compared = constraints.allowExtraArguments ? operands.slice(0, expected.length) : operands;
      const mismatched = compared.length !== expected.length || expected.some((argument, i) => compared[i] !== argument);
      if (mismatched)
        failures.push({
          check: "positionalArguments",
          errorType: "incorrect_arguments",
          message: `Expected the arguments ${expected.length ? expected.map((a) => `\`${a}\``).join(" then ") : "(none)"}, but found ${operands.length ? operands.map((a) => `\`${a}\``).join(" then ") : "none"}. Order matters here.`,
        });
    }
  } else if (constraints.requiredArguments) {
    const expected = constraints.requiredArguments;
    for (const argument of expected)
      if (!has(operands, argument))
        failures.push({ check: "requiredArguments", message: `Expected \`${argument}\` as an argument`, errorType: "incorrect_arguments" });
    const extra = operands.filter((argument) => !has(expected, argument));
    if (extra.length && !constraints.allowExtraArguments) {
      if (strict) failures.push({ check: "requiredArguments", message: `Unexpected argument(s): ${list(extra)}`, errorType: "incorrect_arguments" });
      else ambiguities.push({ check: "requiredArguments", message: `The argument(s) ${list(extra)} are not described by this question's grading rules` });
    }
    // Presence alone cannot distinguish `grep PATTERN FILE` from `grep FILE PATTERN`.
    const present = expected.filter((argument) => has(operands, argument));
    const order = present.map((argument) => operands.indexOf(argument));
    if (present.length > 1 && order.some((position, i) => i > 0 && position < order[i - 1]))
      ambiguities.push({
        check: "argumentOrder",
        message: `The arguments appear in a different order than the question lists them (${list(operands)}), and this question does not declare whether order matters`,
      });
  } else if (operands.length && strict && !constraints.allowExtraArguments) {
    failures.push({ check: "positionalArguments", message: `Unexpected argument(s): ${list(operands)}`, errorType: "incorrect_arguments" });
  } else if (operands.length && !strict) {
    ambiguities.push({ check: "arguments", message: `The argument(s) ${list(operands)} are not described by this question's grading rules` });
  }

  // --- quoting -----------------------------------------------------------------------------
  for (const argument of constraints.quotedArguments ?? [])
    if (!analysis.quoted.includes(argument))
      failures.push({
        check: "quotedArguments", errorType: "incorrect_arguments",
        message: `\`${argument}\` must be quoted, otherwise the shell would split or expand it`,
      });

  // --- redirections ------------------------------------------------------------------------
  const redirectionOf = (r: { op: string; fd: string | null }) => `${r.fd ?? ""}${r.op}`;
  for (const op of constraints.requiredRedirections ?? [])
    if (!analysis.redirections.some((r) => r.op === op || redirectionOf(r) === op))
      failures.push({ check: "requiredRedirections", message: `Expected the \`${op}\` redirection`, errorType: "redirection_error" });
  for (const op of constraints.forbiddenRedirections ?? [])
    if (analysis.redirections.some((r) => r.op === op || redirectionOf(r) === op))
      failures.push({ check: "forbiddenRedirections", message: `The \`${op}\` redirection is not allowed here`, errorType: "redirection_error" });
  if (!constraints.allowExtraRedirections) {
    const expected = constraints.requiredRedirections ?? [];
    // A file-descriptor redirection such as `2>` only counts as expected if it was named exactly.
    const extra = analysis.redirections.filter((r) =>
      r.fd === null ? !expected.includes(r.op) : !expected.includes(redirectionOf(r)));
    if (extra.length) {
      const names = list([...new Set(extra.map(redirectionOf))]);
      if (strict || expected.length)
        failures.push({ check: "redirections", message: `Unexpected redirection(s): ${names}`, errorType: "redirection_error" });
      else ambiguities.push({ check: "redirections", message: `The redirection(s) ${names} are not described by this question's grading rules` });
    }
  }

  // --- shape -------------------------------------------------------------------------------
  if (constraints.minPipeSegments && analysis.pipeSegments < constraints.minPipeSegments)
    failures.push({ check: "minPipeSegments", message: `Expected at least ${constraints.minPipeSegments} piped commands`, errorType: "incorrect_command" });
  if (constraints.maxPipeSegments && analysis.pipeSegments > constraints.maxPipeSegments)
    failures.push({ check: "maxPipeSegments", message: `Expected at most ${constraints.maxPipeSegments} piped commands`, errorType: "incorrect_command" });
  const maxStatements = constraints.maxStatements ?? 1;
  if (analysis.statements.length > maxStatements) {
    const message = `Expected ${maxStatements === 1 ? "a single command" : `at most ${maxStatements} commands`}, but found ${analysis.statements.length} separated by ${list([...new Set(analysis.controlOperators)])}`;
    if (strict) failures.push({ check: "maxStatements", message, errorType: "incorrect_command" });
    else ambiguities.push({ check: "maxStatements", message });
  }
  return { analysis, failures, ambiguities };
}

/** True when the constraints can establish correctness on their own. */
export const isClosedConstraintSet = (c: BashConstraintsLike) =>
  c.completeness === "strict" ||
  (Boolean(c.command || c.pipeline) && Boolean(c.exactFlags || c.allowedFlags) &&
    Boolean(c.positionalArguments || c.allowExtraArguments));
