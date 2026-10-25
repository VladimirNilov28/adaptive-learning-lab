import { z } from "zod";
import {
  CHOICE_STRATEGIES, gradingConfigInput, hintPolicyInput, retryPolicyInput,
  type GradingConfig, type GradingStatus, type ErrorType, type GradingStrategy,
} from "./grading/index.ts";

export const id = z.string().trim().min(1).max(100);
const title = z.string().trim().min(1).max(300);
const text = z.string().max(200_000);
const order = z.number().int().min(0).max(100_000);
export const courseInput = z.object({
  title,
  description: text.default(""),
});
export const phaseInput = z.object({
  id: id.optional(),
  courseId: id,
  title,
  description: text.default(""),
  position: order.default(0),
});
export const topicInput = z.object({
  id: id.optional(),
  phaseId: id,
  title,
  description: text.default(""),
  position: order.default(0),
});
export const lessonInput = z.object({
  id: id.optional(),
  topicId: id,
  title,
  description: text.default(""),
  content: text.default(""),
  position: order.default(0),
  assessmentIds: z.array(id).max(300).refine((ids) => new Set(ids).size === ids.length,
    "Assessment IDs must be unique").optional(),
});
export const questionType = z.enum([
  "single_choice", "multiple_choice", "short_text", "code_text", "predict_output", "find_bug", "numeric",
]);
export const choiceTypes = new Set(["single_choice", "multiple_choice"]);
export const questionInput = z.object({
  id: id.optional(),
  topicId: id,
  type: questionType,
  prompt: text.min(1),
  options: z.array(z.object({ id, text: text.min(1) })).max(30).default([]),
  correctAnswer: z.array(id).max(30).optional(),
  explanation: text.default(""),
  difficulty: z.enum(["easy", "medium", "hard"]).default("medium"),
  hint: text.optional(),
  starterCode: text.optional(),
  language: z.string().trim().max(40).regex(/^[\w+#.-]*$/, "Use a plain language name such as bash or python").optional(),
  /** Deterministic grading rules. Omit to keep legacy behaviour (choice: exact set, written: review). */
  grading: gradingConfigInput.optional(),
  retryPolicy: retryPolicyInput,
  hintPolicy: hintPolicyInput,
  /** Free-form topic tags the AI instructor can use to group questions inside a topic. */
  tags: z.array(z.string().trim().min(1).max(60)).max(20).default([]),
}).superRefine((q, ctx) => {
  const choice = q.type === "single_choice" || q.type === "multiple_choice";
  const optionIds = new Set(q.options.map((o) => o.id));
  if (optionIds.size !== q.options.length)
    ctx.addIssue({ code: "custom", message: "Option IDs must be unique" });
  if (choice && (q.options.length < 2 || !q.correctAnswer?.length))
    ctx.addIssue({ code: "custom", message: "Choice questions require options and a correct answer" });
  if (q.type === "single_choice" && q.correctAnswer?.length !== 1)
    ctx.addIssue({ code: "custom", message: "Single-choice questions require one correct option" });
  if (q.correctAnswer && (new Set(q.correctAnswer).size !== q.correctAnswer.length ||
    q.correctAnswer.some((answer) => !optionIds.has(answer))))
    ctx.addIssue({ code: "custom", message: "Correct answers must be unique option IDs" });
  if (!choice && (q.options.length || q.correctAnswer !== undefined))
    ctx.addIssue({ code: "custom", message: "Written responses use grading configuration instead of options and correctAnswer" });
  if (q.grading) {
    const isChoiceStrategy = CHOICE_STRATEGIES.includes(q.grading.strategy);
    if (choice && !isChoiceStrategy && q.grading.strategy !== "manual")
      ctx.addIssue({ code: "custom", message: `Choice questions support single_choice, multiple_choice or manual grading, not ${q.grading.strategy}` });
    if (choice && isChoiceStrategy && q.grading.strategy !== q.type)
      ctx.addIssue({ code: "custom", message: `A ${q.type} question requires ${q.type} grading` });
    if (!choice && isChoiceStrategy)
      ctx.addIssue({ code: "custom", message: `${q.grading.strategy} grading requires a choice question` });
    if (q.type === "numeric" && !["numeric", "manual", "rule"].includes(q.grading.strategy))
      ctx.addIssue({ code: "custom", message: "Numeric questions require numeric, rule or manual grading" });
  }
  if (q.hintPolicy.afterFailedAttempts > 0 && !q.hint)
    ctx.addIssue({ code: "custom", message: "hintPolicy.afterFailedAttempts requires a hint" });
  if (q.retryPolicy.mode === "none" && q.grading?.strategy === "manual")
    ctx.addIssue({ code: "custom", message: "Manually reviewed questions cannot disable retries" });
});
export const assessmentInput = z.object({
  courseId: id,
  title,
  description: text.default(""),
  mode: z.enum(["practice", "exam"]).default("practice"),
  durationMinutes: z.number().int().min(1).max(1440).nullable().default(null),
  questionIds: z.array(id).min(1).max(300),
}).superRefine((a, ctx) => {
  if (a.mode === "exam" && a.durationMinutes === null)
    ctx.addIssue({ code: "custom", message: "Exams require durationMinutes" });
  if (new Set(a.questionIds).size !== a.questionIds.length)
    ctx.addIssue({ code: "custom", message: "Question IDs must be unique" });
});
export const sectionKind = z.enum([
  "introduction", "objectives", "theory", "example", "exercise", "explanation", "knowledge_check", "summary", "note",
]);
export const sectionInput = z.object({
  id: id.optional(),
  lessonId: id,
  kind: sectionKind,
  title: z.string().trim().max(300).default(""),
  content: text.default(""),
  questionId: id.nullable().default(null),
  position: order.default(0),
  archived: z.boolean().default(false),
}).superRefine((s, ctx) => {
  const interactive = s.kind === "exercise" || s.kind === "knowledge_check";
  if (interactive && !s.questionId)
    ctx.addIssue({ code: "custom", message: "Exercise and knowledge_check sections require questionId" });
  if (!interactive && s.questionId)
    ctx.addIssue({ code: "custom", message: "Only exercise and knowledge_check sections may reference a question" });
});
export const reorderInput = z.object({
  kind: z.enum(["phase", "topic", "lesson", "section"]),
  parentId: id,
  ids: z.array(id).max(1000),
});
export const answerValue = z.union([text, z.array(id).max(30), z.null()]);
export const saveAnswerInput = z.object({ questionId: id, value: answerValue });
export type Question = z.infer<typeof questionInput> & { id: string };
export type AnswerValue = z.infer<typeof answerValue>;
/** Never includes `grading`: accepted answers and rules are answer keys. */
export type StudentQuestion = Omit<Question, "correctAnswer" | "explanation" | "grading" | "hint"> & { hint?: string };
export type SectionKind = z.infer<typeof sectionKind>;
export type SectionRow = {
  id: string; lesson_id: string; kind: SectionKind; title: string; content: string;
  question_id: string | null; position: number; archived: number; created_at: string; updated_at: string;
};
/** Student-safe description of how a question is graded, without revealing the rules themselves. */
export type GradingSummary = {
  strategy: GradingStrategy; automatic: boolean; maxPoints: number;
  maxAttempts: number | null; attemptsUsed: number; attemptsRemaining: number | null;
  hintAvailable: boolean; hintAfterFailedAttempts: number; hintUsed: boolean; hintCount: number;
};
export type ExerciseSubmission = {
  id: string; value: AnswerValue; score: number | null; feedback: string;
  reviewed_at: string | null; created_at: string;
  status: GradingStatus; awardedPoints: number; maxPoints: number; errorType: ErrorType;
  /** Deterministic engine feedback. Instructor review text stays in `feedback`. */
  explanation: string; strategy: GradingStrategy; gradingVersion: string;
};
/** Student-safe section. `question` keys/explanations appear only after the student has submitted. */
export type StudentSection = Omit<SectionRow, "archived" | "question_id"> & {
  completed: boolean;
  question: (StudentQuestion & { correctAnswer?: string[]; explanation?: string }) | null;
  submissions: number; latest: ExerciseSubmission | null;
  grading: GradingSummary | null;
};
export type StudentLesson = Lesson & {
  sections: StudentSection[]; lastSectionId: string | null;
};
export type AssessmentInput = z.infer<typeof assessmentInput>;
export type Course = { id: string; title: string; description: string; created_at: string; updated_at: string };
export type Phase = Course & { course_id: string; position: number };
export type Topic = Course & { phase_id: string; position: number; priority: number };
export type Lesson = Course & { topic_id: string; position: number; content: string; assessmentIds: string[] };
export type CourseStructure = Course & {
  phases: (Phase & { topics: (Topic & { lessons: (Lesson & { completed: boolean; sectionCount: number; sectionsCompleted: number })[] })[] })[];
};
export type Assessment = AssessmentInput & { id: string; created_at: string; updated_at: string };
export type AttemptRow = {
  id: string; assessment_id: string; course_id: string; title: string;
  mode: "practice" | "exam"; started_at: string; deadline: string | null;
  submitted_at: string | null; questions_json: string;
};
export type AnswerRow = {
  attempt_id: string; question_id: string; value_json: string;
  score: number | null; feedback: string; reviewed_at: string | null; updated_at: string;
  status: GradingStatus | null; awarded_points: number | null; max_points: number | null;
  error_type: ErrorType | null; strategy: GradingStrategy | null; grading_version: string | null;
  explanation: string | null; topic_id: string | null; difficulty: string | null;
};
export type AttemptView = Omit<AttemptRow, "questions_json"> & {
  questions: StudentQuestion[]; answers: Record<string, AnswerValue>; serverNow: string;
};
export type GradedAnswer = Omit<AnswerRow, "value_json"> & {
  value: AnswerValue;
  /** Normalized view of the stored grading result, including legacy rows written before grading configs existed. */
  result: { status: GradingStatus; awardedPoints: number; maxPoints: number; errorType: ErrorType; explanation: string };
};
export type AttemptResults = Omit<AttemptRow, "questions_json"> & {
  questions: Question[];
  answers: GradedAnswer[];
  earned: number; total: number; percentage: number | null; pendingReview: number;
  gradedCount: number; gradedPercentage: number | null;
  /** True while any answer still awaits instructor review, so the score is provisional. */
  provisional: boolean;
  feedback: { id: string; message: string; created_at: string }[];
};
export type { GradingConfig, GradingStatus, ErrorType, GradingStrategy };
