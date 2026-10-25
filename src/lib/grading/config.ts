import safeRegex from "safe-regex2";
import { z } from "zod";
import { bashConstraints } from "./bash.ts";
import { normalizationInput, outputNormalization, textAnswerNormalization } from "./normalize.ts";
import { ruleLogic } from "./rules.ts";

export const GRADING_STRATEGIES = [
  "single_choice", "multiple_choice", "exact_match", "normalized_match", "accepted_answers",
  "numeric", "output_match", "regex_match", "rule", "bash_structure", "manual",
] as const;
export type GradingStrategy = (typeof GRADING_STRATEGIES)[number];

/**
 * Patterns are read by humans during review and are checked for catastrophic backtracking, both of
 * which get unreliable as a pattern grows. The previous 300-character ceiling was arbitrary and
 * rejected legitimate alternation lists, so it is raised here; the limit still exists to keep an
 * instructor from encoding a whole grammar in one unreviewable line. Questions needing more than
 * this should use `bash_structure` constraints or `accepted_answers` instead.
 */
const MAX_PATTERN_LENGTH = 1000;
const answerText = z.string().min(1).max(20_000);
const answerList = z.array(answerText).min(1).max(50);
const points = z.number().min(0.5).max(100).default(1);

/** Rejects patterns that are oversized, stateful, or vulnerable to catastrophic backtracking. */
export const safePattern = z.string().min(1, "Pattern must not be empty")
  .max(MAX_PATTERN_LENGTH, `Pattern must be at most ${MAX_PATTERN_LENGTH} characters. A pattern this long is hard to review and hard to check for catastrophic backtracking — prefer strategy "accepted_answers" for a list of valid answers, or "bash_structure" to describe a command's structure directly.`)
  .superRefine((pattern, ctx) => {
  if (!safeRegex(pattern)) {
    const culprit = /\([^()]*[+*][^()]*\)\s*[+*]/.exec(pattern)?.[0]
      ?? /\[[^\]]*\][+*][^$]*[+*]/.exec(pattern)?.[0] ?? null;
    ctx.addIssue({
      code: "custom",
      message: `Pattern rejected: it risks catastrophic backtracking${culprit ? ` around \`${culprit}\`` : ""}. A repetition inside another repetition (such as \`(a+)+\` or \`(\\d+\\.)+\`) can take exponential time on a near-miss answer. Rewrite it with a bounded repetition like \`{1,3}\`, or avoid regex entirely: use strategy "accepted_answers" to list valid answers, or "bash_structure" to assert command names, options and arguments.`,
    });
  }
  try { new RegExp(pattern); }
  catch (error) { ctx.addIssue({ code: "custom", message: `Invalid regular expression: ${error instanceof Error ? error.message : "unknown"}` }); }
});
/** `g` and `y` are excluded because they carry mutable `lastIndex` state between calls. */
export const regexFlags = z.string().max(4).regex(/^[imsu]*$/, "Only the i, m, s and u regex flags are supported").default("");

const base = { points, feedback: z.string().max(2000).optional() };

export const gradingConfigInput = z.discriminatedUnion("strategy", [
  z.object({ ...base, strategy: z.literal("single_choice") }),
  z.object({
    ...base, strategy: z.literal("multiple_choice"),
    /** Awards a share of the points per correct selection instead of all-or-nothing. */
    partialCredit: z.boolean().default(false),
    /** Subtracts incorrect selections from the partial score so guessing everything scores zero. */
    penalizeIncorrect: z.boolean().default(true),
  }),
  z.object({
    ...base, strategy: z.literal("exact_match"),
    expected: answerList,
    caseSensitive: z.boolean().default(true),
  }),
  z.object({
    ...base, strategy: z.literal("normalized_match"),
    expected: answerList,
    normalization: normalizationInput.default(textAnswerNormalization),
  }),
  z.object({
    ...base, strategy: z.literal("accepted_answers"),
    accepted: answerList,
    normalization: normalizationInput.default(textAnswerNormalization),
  }),
  z.object({
    ...base, strategy: z.literal("numeric"),
    expected: z.number().finite(),
    absoluteTolerance: z.number().min(0).max(1e9).optional(),
    relativeTolerance: z.number().min(0).max(1).optional(),
  }),
  z.object({
    ...base, strategy: z.literal("output_match"),
    accepted: answerList,
    normalization: normalizationInput.default(outputNormalization),
  }),
  z.object({
    ...base, strategy: z.literal("regex_match"),
    pattern: safePattern,
    flags: regexFlags,
    /** Requires the pattern to match the whole answer rather than appear inside it. */
    fullMatch: z.boolean().default(true),
    normalization: normalizationInput.default(textAnswerNormalization),
  }),
  z.object({
    ...base, strategy: z.literal("rule"),
    logic: ruleLogic,
    normalization: normalizationInput.default(textAnswerNormalization),
  }),
  z.object({
    ...base, strategy: z.literal("bash_structure"),
    constraints: bashConstraints,
    /**
     * Additional, independently sufficient constraint sets. An answer matching any one of them is
     * correct. This lets an instructor accept `grep -c` and `grep | wc -l` for the same question
     * without resorting to a regular expression.
     */
    alternatives: z.array(bashConstraints).max(10).default([]),
    /** Answers accepted verbatim (after normalization) without consulting the constraints. */
    acceptedAnswers: z.array(answerText).max(50).default([]),
    /**
     * What to report when the structural assertions fail. Structural analysis cannot prove that an
     * unrecognized alternative is wrong, so instructors may route those answers to review instead.
     */
    onMismatch: z.enum(["incorrect", "needs_review"]).default("incorrect"),
    normalization: normalizationInput.default(textAnswerNormalization),
  }),
  z.object({
    ...base, strategy: z.literal("manual"),
    rubric: z.string().max(10_000).optional(),
  }),
]).superRefine((config, ctx) => {
  if (config.strategy === "numeric" && config.absoluteTolerance === undefined && config.relativeTolerance === undefined
    && !Number.isFinite(config.expected))
    ctx.addIssue({ code: "custom", message: "numeric grading requires a finite expected value" });
});

export type GradingConfig = z.infer<typeof gradingConfigInput>;

export const CHOICE_STRATEGIES: GradingStrategy[] = ["single_choice", "multiple_choice"];
export const TEXT_STRATEGIES: GradingStrategy[] = [
  "exact_match", "normalized_match", "accepted_answers", "numeric", "output_match",
  "regex_match", "rule", "bash_structure",
];
export const isAutomatic = (strategy: GradingStrategy) => strategy !== "manual";

export const retryPolicyInput = z.object({
  mode: z.enum(["unlimited", "limited", "none"]).default("unlimited"),
  maxAttempts: z.number().int().min(1).max(50).optional(),
}).default({ mode: "unlimited" }).superRefine((policy, ctx) => {
  if (policy.mode === "limited" && policy.maxAttempts === undefined)
    ctx.addIssue({ code: "custom", message: "A limited retry policy requires maxAttempts" });
});
export type RetryPolicy = z.infer<typeof retryPolicyInput>;

export const hintPolicyInput = z.object({
  /** Number of failed attempts required before the hint becomes available. */
  afterFailedAttempts: z.number().int().min(0).max(20).default(0),
}).default({ afterFailedAttempts: 0 });
export type HintPolicy = z.infer<typeof hintPolicyInput>;

export const maxAttemptsFor = (policy: RetryPolicy): number | null =>
  policy.mode === "none" ? 1 : policy.mode === "limited" ? policy.maxAttempts ?? null : null;
