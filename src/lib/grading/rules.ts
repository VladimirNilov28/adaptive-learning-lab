import jsonLogic from "json-logic-js";
import { z } from "zod";
import { analyzeShell } from "./bash.ts";
import { normalizeText, type Normalization } from "./normalize.ts";

/**
 * Declarative rule grading on top of json-logic-js.
 *
 * json-logic has no `eval`, no function calls and no property assignment, but it is still
 * validated against an explicit operation allowlist and size limits before it is stored or run,
 * so an instructor cannot smuggle in a custom or unbounded operation.
 */
export const ALLOWED_OPERATIONS = new Set([
  "==", "===", "!=", "!==", ">", ">=", "<", "<=", "!", "!!", "%",
  "and", "or", "if", "?:", "var", "in", "cat", "substr",
  "+", "-", "*", "/", "min", "max", "merge",
  "missing", "missing_some", "map", "filter", "all", "none", "some", "reduce",
]);
/** `log` is excluded on purpose: grading must not write to the server console. */
export const DENIED_OPERATIONS = new Set(["log"]);

export const RULE_DATA_KEYS = [
  "answer", "normalized", "lower", "length", "lineCount", "lines", "words", "number", "isNumber",
  "selected", "selectedCount", "command", "commands", "flags", "rawFlags", "operands",
  "redirections", "pipeSegments", "parses", "current", "accumulator",
] as const;

const MAX_NODES = 500, MAX_DEPTH = 20, MAX_STRING = 2000;

export class RuleValidationError extends Error {}

function isOperation(node: unknown): node is Record<string, unknown> {
  return typeof node === "object" && node !== null && !Array.isArray(node) && Object.keys(node).length === 1;
}

/** Throws RuleValidationError when a rule uses an unsupported operation or exceeds size limits. */
export function assertSafeLogic(logic: unknown) {
  let nodes = 0;
  const walk = (node: unknown, depth: number) => {
    if (++nodes > MAX_NODES) throw new RuleValidationError(`Rule is too large (limit ${MAX_NODES} nodes)`);
    if (depth > MAX_DEPTH) throw new RuleValidationError(`Rule is nested too deeply (limit ${MAX_DEPTH})`);
    if (node === null || typeof node === "number" || typeof node === "boolean") return;
    if (typeof node === "string") {
      if (node.length > MAX_STRING) throw new RuleValidationError(`Rule contains a string longer than ${MAX_STRING} characters`);
      return;
    }
    if (Array.isArray(node)) { for (const item of node) walk(item, depth + 1); return; }
    if (typeof node !== "object") throw new RuleValidationError("Rule contains an unsupported value");
    const keys = Object.keys(node as object);
    if (keys.length !== 1)
      throw new RuleValidationError(`Rule objects must hold exactly one operation, found: ${keys.join(", ") || "none"}`);
    const [operation] = keys;
    if (DENIED_OPERATIONS.has(operation) || !ALLOWED_OPERATIONS.has(operation))
      throw new RuleValidationError(`Unsupported grading operation \`${operation}\`. Allowed: ${[...ALLOWED_OPERATIONS].join(", ")}`);
    const argument = (node as Record<string, unknown>)[operation];
    if (operation === "var") {
      const names = (Array.isArray(argument) ? argument.slice(0, 1) : [argument])
        .filter((value): value is string => typeof value === "string");
      for (const name of names) {
        const root = name.split(".")[0];
        if (root !== "" && !(RULE_DATA_KEYS as readonly string[]).includes(root))
          throw new RuleValidationError(`Unknown rule variable \`${name}\`. Available: ${RULE_DATA_KEYS.join(", ")}`);
      }
    }
    walk(argument, depth + 1);
  };
  walk(logic, 0);
  return true;
}

export type RuleData = Record<string, unknown>;

/** Builds the fixed, read-only fact set a rule may inspect. */
export function buildRuleData(value: string | string[] | null, normalization: Normalization): RuleData {
  const selected = Array.isArray(value) ? value : [];
  const answer = typeof value === "string" ? value : "";
  const normalized = normalizeText(answer, normalization);
  const parsedNumber = Number(normalized.trim().replace(/,/g, ""));
  const isNumber = normalized.trim() !== "" && Number.isFinite(parsedNumber);
  const shell = analyzeShell(answer);
  return {
    answer, normalized, lower: normalized.toLowerCase(), length: answer.length,
    lines: normalized.split("\n"), lineCount: normalized.split("\n").length,
    words: normalized.split(/\s+/).filter(Boolean),
    number: isNumber ? parsedNumber : null, isNumber,
    selected, selectedCount: selected.length,
    command: shell.statements[0]?.segments[0]?.command ?? null,
    commands: shell.commands, flags: shell.flags, rawFlags: shell.rawFlags, operands: shell.operands,
    redirections: shell.redirections.map((r) => `${r.fd ?? ""}${r.op}`),
    pipeSegments: shell.pipeSegments, parses: shell.ok,
  };
}

export const ruleLogic = z.unknown().superRefine((logic, ctx) => {
  try { assertSafeLogic(logic); }
  catch (error) {
    ctx.addIssue({ code: "custom", message: error instanceof RuleValidationError ? error.message : "Invalid grading rule" });
  }
});

export type RuleOutcome = { score: number; error: string | null };

/** Runs a validated rule. A boolean result is all-or-nothing; a number is a 0..1 score fraction. */
export function runRule(logic: unknown, data: RuleData): RuleOutcome {
  try {
    assertSafeLogic(logic);
    const result = jsonLogic.apply(logic as Parameters<typeof jsonLogic.apply>[0], data);
    if (typeof result === "boolean") return { score: result ? 1 : 0, error: null };
    if (typeof result === "number" && Number.isFinite(result))
      return { score: Math.min(1, Math.max(0, result)), error: null };
    return { score: 0, error: "Grading rule did not return a boolean or a 0..1 number" };
  } catch (error) {
    return { score: 0, error: error instanceof Error ? error.message : "Grading rule failed" };
  }
}
