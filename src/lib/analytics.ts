import type Database from "better-sqlite3";
import { z } from "zod";
import { linearRegression } from "simple-statistics";
import { ERROR_TYPES, GRADING_STATUSES, type ErrorType, type GradingStatus } from "./grading/index.ts";

/**
 * Analytics are computed from the `question_attempts` ledger only. Nothing here grades anything and
 * nothing here invents numbers: every metric reports the sample it was computed from so a reader
 * (human or AI) can tell a real signal from a single lucky answer.
 */

const id = z.string().trim().min(1).max(200);
const difficulties = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof difficulties)[number];

/** Fewer distinct questions than this and every rate is reported as "not enough evidence yet". */
export const LOW_SAMPLE_THRESHOLD = 5;

export const analyticsFilter = z.object({
  courseId: id.optional(),
  phaseId: id.optional(),
  topicId: id.optional(),
  lessonId: id.optional(),
  sectionId: id.optional(),
  assessmentId: id.optional(),
  questionId: id.optional(),
  source: z.enum(["all", "exercise", "assessment"]).default("all"),
  difficulty: z.enum(["all", ...difficulties]).default("all"),
  questionType: z.string().trim().min(1).max(40).optional(),
  strategy: z.string().trim().min(1).max(60).optional(),
  status: z.enum(["all", ...GRADING_STATUSES]).default("all"),
  errorType: z.enum(["all", ...ERROR_TYPES]).default("all"),
  since: z.string().trim().min(4).max(40).optional(),
  until: z.string().trim().min(4).max(40).optional(),
  limit: z.number().int().min(1).max(500).default(50),
});
export type AnalyticsFilter = z.input<typeof analyticsFilter>;

export type AttemptRecord = {
  source: "exercise" | "assessment";
  sequence: number;
  attempt_key: string;
  submission_id: string | null;
  question_id: string;
  topic_id: string | null;
  phase_id: string | null;
  course_id: string | null;
  lesson_id: string | null;
  section_id: string | null;
  assessment_id: string | null;
  assessment_attempt_id: string | null;
  answer_json: string;
  submitted_at: string;
  attempt_number: number;
  strategy: string;
  grading_version: string;
  status: GradingStatus;
  awarded_points: number;
  max_points: number;
  score: number | null;
  difficulty: Difficulty | null;
  question_type: string | null;
  duration_ms: number | null;
  hint_used: number;
  hint_count: number;
  error_type: ErrorType;
  feedback: string | null;
  explanation: string;
  review_status: "pending" | "reviewed" | "not_required";
  reviewed_at: string | null;
};

type Clause = { sql: string; params: unknown[] };

function whereClause(f: z.output<typeof analyticsFilter>): Clause {
  const parts: string[] = [];
  const params: unknown[] = [];
  const eq = (column: string, value: unknown) => {
    if (value === undefined) return;
    parts.push(`${column} = ?`);
    params.push(value);
  };
  eq("course_id", f.courseId);
  eq("phase_id", f.phaseId);
  eq("topic_id", f.topicId);
  eq("lesson_id", f.lessonId);
  eq("section_id", f.sectionId);
  eq("assessment_id", f.assessmentId);
  eq("question_id", f.questionId);
  eq("question_type", f.questionType);
  eq("strategy", f.strategy);
  if (f.source !== "all") eq("source", f.source);
  if (f.difficulty !== "all") eq("difficulty", f.difficulty);
  if (f.status !== "all") eq("status", f.status);
  if (f.errorType !== "all") eq("error_type", f.errorType);
  if (f.since) { parts.push("submitted_at >= ?"); params.push(f.since); }
  if (f.until) { parts.push("submitted_at <= ?"); params.push(f.until); }
  return { sql: parts.length ? `WHERE ${parts.join(" AND ")}` : "", params };
}

export function queryAttempts(db: Database.Database, input: unknown): AttemptRecord[] {
  const f = analyticsFilter.parse(input ?? {});
  const where = whereClause(f);
  return db.prepare(
    `SELECT * FROM question_attempts ${where.sql} ORDER BY submitted_at ASC, sequence ASC`,
  ).all(...where.params) as AttemptRecord[];
}

const round = (value: number, digits = 3) => {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
};

/** A rate that always travels with the sample it came from, so nobody reads 100% off one answer. */
export type Rate = { value: number | null; sample: number; lowSample: boolean };

function rate(hits: number, sample: number, threshold = LOW_SAMPLE_THRESHOLD): Rate {
  return {
    value: sample ? round(hits / sample) : null,
    sample,
    lowSample: sample < threshold,
  };
}

const isResolved = (a: AttemptRecord) => a.status !== "needs_review";
const isCorrect = (a: AttemptRecord) => a.status === "correct";

/** Attempts grouped per question, ordered oldest first. */
function byQuestion(attempts: AttemptRecord[]) {
  const groups = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const list = groups.get(a.question_id);
    if (list) list.push(a);
    else groups.set(a.question_id, [a]);
  }
  for (const list of groups.values())
    list.sort((x, y) => x.submitted_at.localeCompare(y.submitted_at) || x.sequence - y.sequence);
  return groups;
}

export type MistakeCount = {
  errorType: ErrorType;
  count: number;
  share: number;
  examples: { questionId: string; submittedAt: string; explanation: string }[];
};

export function errorHistogram(attempts: AttemptRecord[], examplesPerType = 3): MistakeCount[] {
  const wrong = attempts.filter((a) => a.status === "incorrect" || a.status === "partially_correct");
  const counts = new Map<ErrorType, AttemptRecord[]>();
  for (const a of wrong) {
    const list = counts.get(a.error_type);
    if (list) list.push(a);
    else counts.set(a.error_type, [a]);
  }
  return [...counts.entries()]
    .map(([errorType, list]) => ({
      errorType,
      count: list.length,
      share: round(list.length / wrong.length),
      examples: list.slice(-examplesPerType).map((a) => ({
        questionId: a.question_id,
        submittedAt: a.submitted_at,
        explanation: a.explanation,
      })),
    }))
    .sort((a, b) => b.count - a.count || a.errorType.localeCompare(b.errorType));
}

export type DifficultyBreakdown = Record<Difficulty | "unknown", {
  attempts: number;
  firstAttemptAccuracy: Rate;
  eventualAccuracy: Rate;
}>;

function difficultyBreakdown(attempts: AttemptRecord[]): DifficultyBreakdown {
  const buckets = { easy: [], medium: [], hard: [], unknown: [] } as Record<Difficulty | "unknown", AttemptRecord[]>;
  for (const a of attempts) buckets[a.difficulty ?? "unknown"].push(a);
  const out = {} as DifficultyBreakdown;
  for (const [key, list] of Object.entries(buckets) as [Difficulty | "unknown", AttemptRecord[]][]) {
    const groups = byQuestion(list);
    const firsts = [...groups.values()].map((g) => g[0]).filter(isResolved);
    const eventual = [...groups.values()].filter((g) => g.some(isResolved));
    out[key] = {
      attempts: list.length,
      firstAttemptAccuracy: rate(firsts.filter(isCorrect).length, firsts.length),
      eventualAccuracy: rate(eventual.filter((g) => g.some(isCorrect)).length, eventual.length),
    };
  }
  return out;
}

export type TopicMetrics = {
  topicId: string;
  attempts: number;
  questionsSeen: number;
  pointsEarned: number;
  pointsPossible: number;
  mastery: number | null;
  firstAttemptAccuracy: Rate;
  eventualAccuracy: Rate;
  averageAttemptsToSuccess: { value: number | null; sample: number };
  hintUsageRate: Rate;
  averageResponseMs: { value: number | null; sample: number };
  pendingReview: number;
  byDifficulty: DifficultyBreakdown;
  topErrors: MistakeCount[];
  lowSample: boolean;
  lastAttemptAt: string | null;
};

/** Mastery uses the latest resolved attempt per question: what the student can do *now*. */
export function topicMetrics(topicId: string, attempts: AttemptRecord[]): TopicMetrics {
  const groups = byQuestion(attempts);
  const firsts = [...groups.values()].map((g) => g[0]).filter(isResolved);
  const resolvedGroups = [...groups.values()].filter((g) => g.some(isResolved));
  const latest = [...groups.values()]
    .map((g) => [...g].reverse().find(isResolved))
    .filter((a): a is AttemptRecord => Boolean(a));
  const pointsEarned = latest.reduce((sum, a) => sum + a.awarded_points, 0);
  const pointsPossible = latest.reduce((sum, a) => sum + a.max_points, 0);
  const solved = [...groups.values()].filter((g) => g.some(isCorrect));
  const attemptsToSuccess = solved.map((g) => g.findIndex(isCorrect) + 1);
  const timed = attempts.filter((a) => typeof a.duration_ms === "number" && a.duration_ms > 0);
  return {
    topicId,
    attempts: attempts.length,
    questionsSeen: groups.size,
    pointsEarned: round(pointsEarned),
    pointsPossible: round(pointsPossible),
    mastery: pointsPossible ? round(pointsEarned / pointsPossible) : null,
    firstAttemptAccuracy: rate(firsts.filter(isCorrect).length, firsts.length),
    eventualAccuracy: rate(solved.length, resolvedGroups.length),
    averageAttemptsToSuccess: {
      value: attemptsToSuccess.length
        ? round(attemptsToSuccess.reduce((a, b) => a + b, 0) / attemptsToSuccess.length, 2)
        : null,
      sample: attemptsToSuccess.length,
    },
    hintUsageRate: rate(attempts.filter((a) => a.hint_used > 0).length, attempts.length),
    averageResponseMs: {
      value: timed.length ? Math.round(timed.reduce((sum, a) => sum + (a.duration_ms ?? 0), 0) / timed.length) : null,
      sample: timed.length,
    },
    pendingReview: attempts.filter((a) => a.review_status === "pending").length,
    byDifficulty: difficultyBreakdown(attempts),
    topErrors: errorHistogram(attempts).slice(0, 5),
    lowSample: groups.size < LOW_SAMPLE_THRESHOLD,
    lastAttemptAt: attempts.length ? attempts[attempts.length - 1].submitted_at : null,
  };
}

export type Trend = {
  direction: "improving" | "declining" | "steady" | "insufficient_data";
  slopePerDay: number | null;
  points: { date: string; accuracy: number; attempts: number }[];
};

/**
 * Daily first-attempt accuracy fitted with an ordinary least-squares line. Three or more days with
 * resolved attempts are required; below that the honest answer is "we do not know yet".
 */
export function accuracyTrend(attempts: AttemptRecord[]): Trend {
  const days = new Map<string, { correct: number; total: number }>();
  for (const [, group] of byQuestion(attempts)) {
    const first = group[0];
    if (!isResolved(first)) continue;
    const date = first.submitted_at.slice(0, 10);
    const day = days.get(date) ?? { correct: 0, total: 0 };
    day.total++;
    if (isCorrect(first)) day.correct++;
    days.set(date, day);
  }
  const points = [...days.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, day]) => ({ date, accuracy: round(day.correct / day.total), attempts: day.total }));
  if (points.length < 3) return { direction: "insufficient_data", slopePerDay: null, points };
  const origin = Date.parse(`${points[0].date}T00:00:00.000Z`);
  const series: [number, number][] = points.map((p) => [
    (Date.parse(`${p.date}T00:00:00.000Z`) - origin) / 86_400_000,
    p.accuracy,
  ]);
  const { m } = linearRegression(series);
  const slope = Number.isFinite(m) ? round(m, 4) : null;
  const direction = slope === null || Math.abs(slope) < 0.01 ? "steady" : slope > 0 ? "improving" : "declining";
  return { direction, slopePerDay: slope, points };
}

export type LearningAnalytics = {
  filter: z.output<typeof analyticsFilter>;
  generatedAt: string;
  totals: {
    attempts: number;
    questionsSeen: number;
    pointsEarned: number;
    pointsPossible: number;
    mastery: number | null;
    pendingReview: number;
    autoGraded: number;
    legacyAttempts: number;
  };
  firstAttemptAccuracy: Rate;
  eventualAccuracy: Rate;
  hintUsageRate: Rate;
  byTopic: TopicMetrics[];
  byDifficulty: DifficultyBreakdown;
  commonMistakes: MistakeCount[];
  trend: Trend;
  notes: string[];
};

export function learningAnalytics(
  db: Database.Database,
  input: unknown,
  topicTitles: Map<string, string> = new Map(),
): LearningAnalytics & { byTopic: (TopicMetrics & { title: string | null })[] } {
  const filter = analyticsFilter.parse(input ?? {});
  const attempts = queryAttempts(db, filter);
  const overall = topicMetrics("__all__", attempts);
  const topics = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    const key = a.topic_id ?? "__unknown__";
    const list = topics.get(key);
    if (list) list.push(a);
    else topics.set(key, [a]);
  }
  const notes: string[] = [];
  if (!attempts.length) notes.push("No attempts match this filter yet.");
  if (overall.lowSample && attempts.length)
    notes.push(`Fewer than ${LOW_SAMPLE_THRESHOLD} distinct questions: treat every rate as provisional.`);
  const legacyAttempts = attempts.filter((a) => a.strategy === "legacy").length;
  if (legacyAttempts)
    notes.push(`${legacyAttempts} attempt(s) predate the grading engine and are interpreted from stored scores.`);
  if (overall.pendingReview)
    notes.push(`${overall.pendingReview} attempt(s) await instructor review and are excluded from accuracy rates.`);
  return {
    filter,
    generatedAt: new Date().toISOString(),
    totals: {
      attempts: attempts.length,
      questionsSeen: overall.questionsSeen,
      pointsEarned: overall.pointsEarned,
      pointsPossible: overall.pointsPossible,
      mastery: overall.mastery,
      pendingReview: overall.pendingReview,
      autoGraded: attempts.filter((a) => a.strategy !== "legacy" && a.review_status === "not_required").length,
      legacyAttempts,
    },
    firstAttemptAccuracy: overall.firstAttemptAccuracy,
    eventualAccuracy: overall.eventualAccuracy,
    hintUsageRate: overall.hintUsageRate,
    byTopic: [...topics.entries()]
      .map(([topicId, list]) => ({
        ...topicMetrics(topicId, list),
        title: topicTitles.get(topicId) ?? null,
      }))
      .sort((a, b) => (a.mastery ?? 2) - (b.mastery ?? 2) || b.attempts - a.attempts),
    byDifficulty: overall.byDifficulty,
    commonMistakes: errorHistogram(attempts),
    trend: accuracyTrend(attempts),
    notes,
  };
}

export type RecentAttempt = {
  source: "exercise" | "assessment";
  questionId: string;
  topicId: string | null;
  lessonId: string | null;
  assessmentId: string | null;
  questionType: string | null;
  difficulty: Difficulty | null;
  attemptNumber: number;
  status: GradingStatus;
  errorType: ErrorType;
  strategy: string;
  awardedPoints: number;
  maxPoints: number;
  hintUsed: boolean;
  durationMs: number | null;
  submittedAt: string;
  answer: unknown;
  explanation: string;
  reviewStatus: "pending" | "reviewed" | "not_required";
};

function toRecent(a: AttemptRecord): RecentAttempt {
  let answer: unknown = null;
  try { answer = JSON.parse(a.answer_json); } catch { answer = a.answer_json; }
  return {
    source: a.source,
    questionId: a.question_id,
    topicId: a.topic_id,
    lessonId: a.lesson_id,
    assessmentId: a.assessment_id,
    questionType: a.question_type,
    difficulty: a.difficulty,
    attemptNumber: a.attempt_number,
    status: a.status,
    errorType: a.error_type,
    strategy: a.strategy,
    awardedPoints: a.awarded_points,
    maxPoints: a.max_points,
    hintUsed: a.hint_used > 0,
    durationMs: a.duration_ms,
    submittedAt: a.submitted_at,
    answer,
    explanation: a.explanation,
    reviewStatus: a.review_status,
  };
}

export function recentAttempts(db: Database.Database, input: unknown): RecentAttempt[] {
  const filter = analyticsFilter.parse(input ?? {});
  return queryAttempts(db, filter).slice(-filter.limit).reverse().map(toRecent);
}

export function commonMistakes(db: Database.Database, input: unknown) {
  const filter = analyticsFilter.parse(input ?? {});
  const attempts = queryAttempts(db, filter);
  const histogram = errorHistogram(attempts);
  const repeated = new Map<string, AttemptRecord[]>();
  for (const a of attempts) {
    if (a.status === "correct" || a.status === "needs_review") continue;
    const list = repeated.get(a.question_id);
    if (list) list.push(a);
    else repeated.set(a.question_id, [a]);
  }
  return {
    filter,
    wrongAttempts: attempts.filter((a) => a.status === "incorrect" || a.status === "partially_correct").length,
    byErrorType: histogram,
    repeatedlyMissedQuestions: [...repeated.entries()]
      .filter(([, list]) => list.length > 1)
      .map(([questionId, list]) => ({
        questionId,
        misses: list.length,
        topicId: list[0].topic_id,
        lastMissAt: list[list.length - 1].submitted_at,
        errorTypes: [...new Set(list.map((a) => a.error_type))],
        eventuallyCorrect: attempts.some((a) => a.question_id === questionId && a.status === "correct"),
      }))
      .sort((a, b) => b.misses - a.misses)
      .slice(0, filter.limit),
  };
}

export function pendingReviews(db: Database.Database, input: unknown) {
  const filter = analyticsFilter.parse(input ?? {});
  const where = whereClause(filter);
  const clause = where.sql ? `${where.sql} AND review_status = 'pending'` : "WHERE review_status = 'pending'";
  const rows = db.prepare(
    `SELECT * FROM question_attempts ${clause} ORDER BY submitted_at ASC, sequence ASC LIMIT ?`,
  ).all(...where.params, filter.limit) as AttemptRecord[];
  return rows.map((a) => ({
    ...toRecent(a),
    submissionId: a.submission_id,
    assessmentAttemptId: a.assessment_attempt_id,
    sectionId: a.section_id,
    waitingSince: a.submitted_at,
  }));
}
