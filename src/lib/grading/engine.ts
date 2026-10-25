import { createHash } from "node:crypto";
import { checkBashConstraints } from "./bash.ts";
import {
  type GradingConfig, type GradingStrategy, maxAttemptsFor, type RetryPolicy,
} from "./config.ts";
import { describeNormalization, normalizeText, textAnswerNormalization, type Normalization } from "./normalize.ts";
import { buildRuleData, runRule } from "./rules.ts";

export const GRADING_STATUSES = ["correct", "incorrect", "partially_correct", "needs_review"] as const;
export type GradingStatus = (typeof GRADING_STATUSES)[number];

/** Small, extensible taxonomy. `unclassified` is used whenever the evidence is insufficient. */
export const ERROR_TYPES = [
  "syntax_error", "incorrect_command", "incorrect_flag", "incorrect_arguments", "permissions_error",
  "redirection_error", "incorrect_output", "logic_error", "incomplete_answer", "unclassified", "none",
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export type GradableQuestion = {
  id: string;
  type: string;
  options: { id: string; text: string }[];
  correctAnswer?: string[];
  difficulty: string;
  grading?: GradingConfig;
  retryPolicy?: RetryPolicy;
};
export type AnswerInput = string | string[] | null;

export type GradingOutcome = {
  status: GradingStatus;
  /** Fraction of the maximum points, or null when the answer still needs instructor review. */
  score: number | null;
  awardedPoints: number;
  maxPoints: number;
  strategy: GradingStrategy;
  /** Stable fingerprint of the grading configuration that produced this result. */
  gradingVersion: string;
  errorType: ErrorType;
  feedback: string;
  details: Record<string, unknown>;
};

const CHOICE_TYPES = new Set(["single_choice", "multiple_choice"]);
export const isChoiceQuestion = (q: { type: string }) => CHOICE_TYPES.has(q.type);
const round = (value: number) => Math.round(value * 1000) / 1000;
const isEmptyAnswer = (value: AnswerInput) =>
  value === null || (Array.isArray(value) ? value.length === 0 : value.trim() === "");

/**
 * Resolves the configuration actually used for a question. Legacy questions carry no explicit
 * configuration: choice questions keep exact-set grading and written questions keep instructor
 * review, so historical behaviour is unchanged.
 */
export function resolveGradingConfig(q: GradableQuestion): GradingConfig {
  if (q.grading) return q.grading;
  if (q.type === "single_choice") return { strategy: "single_choice", points: 1 };
  if (q.type === "multiple_choice")
    return { strategy: "multiple_choice", points: 1, partialCredit: false, penalizeIncorrect: true };
  return { strategy: "manual", points: 1 };
}

/** Fingerprints the grading rules so historical scores stay explainable after a question is edited. */
export function gradingVersion(q: GradableQuestion): string {
  const config = resolveGradingConfig(q);
  const material = JSON.stringify({ config, correctAnswer: q.correctAnswer ?? null, type: q.type });
  return createHash("sha256").update(material).digest("hex").slice(0, 12);
}

function outcome(
  q: GradableQuestion, config: GradingConfig, partial: Omit<GradingOutcome, "strategy" | "gradingVersion" | "maxPoints" | "awardedPoints" | "score"> & { score: number | null },
): GradingOutcome {
  const maxPoints = config.points;
  const score = partial.score;
  return {
    ...partial,
    maxPoints,
    awardedPoints: score === null ? 0 : round(score * maxPoints),
    score: score === null ? null : round(score),
    strategy: config.strategy,
    gradingVersion: gradingVersion(q),
    feedback: config.feedback && partial.status !== "correct" ? config.feedback : partial.feedback,
  };
}

const matchNormalized = (answer: string, accepted: string[], options: Normalization) => {
  const normalized = normalizeText(answer, options);
  return accepted.some((candidate) => normalizeText(candidate, options) === normalized);
};

function gradeChoice(q: GradableQuestion, config: GradingConfig, value: AnswerInput) {
  const selected = Array.isArray(value) ? value : [];
  const correct = q.correctAnswer ?? [];
  const correctSelected = selected.filter((key) => correct.includes(key)).length;
  const incorrectSelected = selected.length - correctSelected;
  const exact = correctSelected === correct.length && incorrectSelected === 0 && correct.length > 0;
  if (config.strategy === "multiple_choice" && config.partialCredit && !exact && correct.length > 0) {
    const raw = (config.penalizeIncorrect ? correctSelected - incorrectSelected : correctSelected) / correct.length;
    const score = Math.min(1, Math.max(0, raw));
    return {
      score,
      status: (score > 0 ? "partially_correct" : "incorrect") as GradingStatus,
      errorType: (selected.length ? "unclassified" : "incomplete_answer") as ErrorType,
      feedback: score > 0
        ? `${correctSelected} of ${correct.length} correct option(s) selected${incorrectSelected ? `, ${incorrectSelected} incorrect` : ""}.`
        : "None of the required options were selected.",
      details: { correctSelected, incorrectSelected, requiredOptions: correct.length },
    };
  }
  return {
    score: exact ? 1 : 0,
    status: (exact ? "correct" : "incorrect") as GradingStatus,
    errorType: (exact ? "none" : selected.length ? "unclassified" : "incomplete_answer") as ErrorType,
    feedback: exact ? "Correct." : selected.length ? "That selection is not correct." : "No option was selected.",
    details: { correctSelected, incorrectSelected, requiredOptions: correct.length },
  };
}

function gradeText(q: GradableQuestion, config: GradingConfig, answer: string) {
  switch (config.strategy) {
    case "exact_match": {
      const options: Normalization = { ...textAnswerNormalization, trim: false, normalizeLineEndings: false, ignoreCase: !config.caseSensitive };
      const matched = config.expected.some((candidate) => normalizeText(candidate, options) === normalizeText(answer, options));
      return {
        score: matched ? 1 : 0, status: (matched ? "correct" : "incorrect") as GradingStatus,
        errorType: (matched ? "none" : "unclassified") as ErrorType,
        feedback: matched ? "Correct." : `Compared exactly${config.caseSensitive ? "" : ", ignoring case"}; the answer did not match.`,
        details: { caseSensitive: config.caseSensitive },
      };
    }
    case "normalized_match":
    case "accepted_answers": {
      const accepted = config.strategy === "normalized_match" ? config.expected : config.accepted;
      const matched = matchNormalized(answer, accepted, config.normalization);
      const applied = describeNormalization(config.normalization);
      return {
        score: matched ? 1 : 0, status: (matched ? "correct" : "incorrect") as GradingStatus,
        errorType: (matched ? "none" : "unclassified") as ErrorType,
        feedback: matched
          ? `Correct — matched an accepted answer${applied.length ? ` (${applied.join(", ")})` : ""}.`
          : `No accepted answer matched${applied.length ? ` (${applied.join(", ")})` : ""}.`,
        details: { acceptedCount: accepted.length, normalization: applied },
      };
    }
    case "numeric": {
      const cleaned = answer.trim().replace(/,/g, "");
      const parsed = Number(cleaned);
      if (cleaned === "" || !Number.isFinite(parsed))
        return {
          score: 0, status: "incorrect" as GradingStatus, errorType: "syntax_error" as ErrorType,
          feedback: "A numeric answer was expected.", details: { parsed: null },
        };
      const absolute = Math.abs(parsed - config.expected);
      const withinAbsolute = config.absoluteTolerance !== undefined && absolute <= config.absoluteTolerance;
      const withinRelative = config.relativeTolerance !== undefined && config.expected !== 0 &&
        absolute / Math.abs(config.expected) <= config.relativeTolerance;
      const exact = parsed === config.expected;
      const matched = exact || withinAbsolute || withinRelative;
      return {
        score: matched ? 1 : 0, status: (matched ? "correct" : "incorrect") as GradingStatus,
        errorType: (matched ? "none" : "logic_error") as ErrorType,
        feedback: matched ? "Correct." : "The numeric value does not match the expected result.",
        details: { parsed, expected: config.expected, difference: round(absolute) },
      };
    }
    case "output_match": {
      const matched = matchNormalized(answer, config.accepted, config.normalization);
      const applied = describeNormalization(config.normalization);
      return {
        score: matched ? 1 : 0, status: (matched ? "correct" : "incorrect") as GradingStatus,
        errorType: (matched ? "none" : "incorrect_output") as ErrorType,
        feedback: matched
          ? "Correct — the predicted output matches."
          : `The predicted output does not match the expected output${applied.length ? ` (${applied.join(", ")})` : "; whitespace is significant"}.`,
        details: { acceptedCount: config.accepted.length, normalization: applied },
      };
    }
    case "regex_match": {
      const normalized = normalizeText(answer, config.normalization);
      const source = config.fullMatch ? `^(?:${config.pattern})$` : config.pattern;
      let matched = false, failure: string | null = null;
      try { matched = new RegExp(source, config.flags).test(normalized); }
      catch (error) { failure = error instanceof Error ? error.message : "Invalid pattern"; }
      if (failure)
        return {
          score: null, status: "needs_review" as GradingStatus, errorType: "unclassified" as ErrorType,
          feedback: "This question's pattern could not be applied; your answer was sent for instructor review.",
          details: { patternError: failure },
        };
      return {
        score: matched ? 1 : 0, status: (matched ? "correct" : "incorrect") as GradingStatus,
        errorType: (matched ? "none" : "unclassified") as ErrorType,
        feedback: matched ? "Correct — the answer matches the expected form." : "The answer does not match the expected form.",
        details: { fullMatch: config.fullMatch },
      };
    }
    case "rule": {
      const data = buildRuleData(answer, config.normalization);
      const result = runRule(config.logic, data);
      if (result.error)
        return {
          score: null, status: "needs_review" as GradingStatus, errorType: "unclassified" as ErrorType,
          feedback: "This question's grading rule could not be applied; your answer was sent for instructor review.",
          details: { ruleError: result.error },
        };
      const status: GradingStatus = result.score === 1 ? "correct" : result.score > 0 ? "partially_correct" : "incorrect";
      return {
        score: result.score, status, errorType: (status === "correct" ? "none" : "unclassified") as ErrorType,
        feedback: status === "correct" ? "Correct." : status === "partially_correct"
          ? "Partially correct — some requirements were met." : "The answer does not satisfy this question's requirements.",
        details: { ruleScore: result.score },
      };
    }
    case "bash_structure": {
      if (config.acceptedAnswers.length && matchNormalized(answer, config.acceptedAnswers, config.normalization))
        return {
          score: 1, status: "correct" as GradingStatus, errorType: "none" as ErrorType,
          feedback: "Correct — this matches an accepted answer.", details: { matchedAcceptedAnswer: true },
        };
      // Each alternative is a complete, independently sufficient way to answer the question.
      // `alternatives` post-dates stored configurations, so it may be absent on legacy rows.
      const candidates = [config.constraints, ...(config.alternatives ?? [])];
      const results = candidates.map((constraints) => ({ constraints, ...checkBashConstraints(answer, constraints) }));
      const accepted = results.find((r) => !r.failures.length && !r.ambiguities.length);
      if (accepted)
        return {
          score: 1, status: "correct" as GradingStatus, errorType: "none" as ErrorType,
          // Deliberately scoped language: the command was inspected, never run.
          feedback: "Correct — the command has the required structure. It was checked statically, not executed.",
          details: {
            commands: accepted.analysis.commands, flags: accepted.analysis.flags,
            checkedConstraints: Object.keys(accepted.constraints),
            matchedAlternative: results.indexOf(accepted) || undefined,
          },
        };
      // Fail closed: if any reading of the answer is merely unjudgeable, a human decides.
      const unresolved = results.find((r) => r.ambiguities.length);
      if (unresolved)
        return {
          score: null, status: "needs_review" as GradingStatus, errorType: "unclassified" as ErrorType,
          feedback: `This answer could not be graded automatically: ${unresolved.ambiguities.map((a) => a.message).join(" ")} It was sent for instructor review. Nothing was executed.`,
          details: {
            ambiguities: unresolved.ambiguities, failures: unresolved.failures,
            commands: unresolved.analysis.commands, parses: unresolved.analysis.ok,
          },
        };
      const best = results[0];
      const primary = best.failures[0];
      const needsReview = config.onMismatch === "needs_review" && primary.errorType !== "syntax_error";
      return {
        score: needsReview ? null : 0,
        status: (needsReview ? "needs_review" : "incorrect") as GradingStatus,
        errorType: primary.errorType as ErrorType,
        feedback: needsReview
          ? `This answer does not match the expected structure (${primary.message}), so it was sent for instructor review in case it is a valid alternative.`
          : best.failures.map((f) => f.message).join(" "),
        details: {
          failures: best.failures, commands: best.analysis.commands,
          flags: best.analysis.flags, parses: best.analysis.ok,
        },
      };
    }
    default:
      return {
        score: null, status: "needs_review" as GradingStatus, errorType: "unclassified" as ErrorType,
        feedback: "Saved for instructor review.", details: {},
      };
  }
}

/** Deterministic, side-effect-free grading. No student input is ever executed. */
export function gradeQuestion(q: GradableQuestion, value: AnswerInput): GradingOutcome {
  const config = resolveGradingConfig(q);
  if (config.strategy === "manual")
    return outcome(q, config, {
      score: null, status: "needs_review", errorType: "unclassified",
      feedback: "Saved. Your instructor reviews this answer.", details: {},
    });
  if (isEmptyAnswer(value) && !isChoiceQuestion(q))
    return outcome(q, config, {
      score: 0, status: "incorrect", errorType: "incomplete_answer",
      feedback: "No answer was provided.", details: {},
    });
  if (config.strategy === "single_choice" || config.strategy === "multiple_choice")
    return outcome(q, config, gradeChoice(q, config, value));
  const answer = typeof value === "string" ? value : "";
  return outcome(q, config, gradeText(q, config, answer));
}

/** True when a question is graded immediately without any instructor involvement. */
export function isAutomaticallyGraded(q: GradableQuestion) {
  return resolveGradingConfig(q).strategy !== "manual";
}
export function maxPointsFor(q: GradableQuestion) {
  return resolveGradingConfig(q).points;
}
export function retryLimitFor(q: GradableQuestion): number | null {
  return maxAttemptsFor(q.retryPolicy ?? { mode: "unlimited" });
}
