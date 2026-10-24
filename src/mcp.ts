import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { databasePath } from "./lib/db.ts";
import { AppError, Store } from "./lib/store.ts";
import {
  id, courseInput, phaseInput, topicInput, lessonInput, questionInput, assessmentInput, reorderInput,
  sectionInput,
} from "./lib/schemas.ts";

const store = new Store(databasePath());
const server = new McpServer({ name: "adaptive-learning-lab", version: "1.0.0" });

function tool<T extends z.ZodRawShape>(
  name: string, description: string, shape: T, run: (args: z.infer<z.ZodObject<T>>) => unknown,
) {
  const inputSchema: z.ZodRawShape = shape;
  server.registerTool(name, { description, inputSchema }, async (args) => {
    try {
      const result = run(z.object(shape).parse(args));
      const structuredContent = { result };
      return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent };
    } catch (error) {
      const message = error instanceof z.ZodError ? error.message :
        error instanceof AppError ? error.message : "Database operation failed; inspect MCP stderr.";
      console.error(`[${name}]`, error);
      return { isError: true, content: [{ type: "text" as const, text: message }] };
    }
  });
}

tool("list_courses", "List all courses and the active course ID. An empty list means the instructor must create content.",
  {}, () => ({ courses: store.listCourses(), activeCourseId: store.activeCourseId() }));
tool("get_course_structure", "Get a complete ordered course, including phases, topics, lessons, IDs, and completion status.",
  { courseId: id }, ({ courseId }) => store.structure(courseId));
tool("create_course", "Create a subject-agnostic course. The first course becomes active. No content is generated automatically.",
  courseInput.shape, (args) => store.createCourse(args));
tool("update_course", "Update course metadata. Omitted fields are preserved.",
  { id, ...courseInput.partial().shape }, (args) => store.updateCourse(args));
tool("upsert_phase", "Create a phase (omit id) or replace its fields (supply existing id). Position is zero-based. Cannot change course.",
  phaseInput.shape, (args) => store.upsertPhase(args));
tool("upsert_topic", "Create or replace a topic. It may move between phases within its course; priority is preserved.",
  topicInput.shape, (args) => store.upsertTopic(args));
tool("upsert_lesson", "Create or replace a lesson. `content` is optional introductory Markdown shown before any structured sections (use upsert_lesson_section to build guided lessons). Optional assessmentIds explicitly link same-course assessments in order; omit to preserve existing links, or [] to clear them. Can move between topics in the same course. Completion is preserved.",
  lessonInput.shape, (args) => store.upsertLesson(args));
tool("reorder_content", "Reorder phases (parent=course), topics (parent=phase), lessons (parent=topic), or lesson sections (parent=lesson, include archived sections). Provide ALL sibling IDs exactly once in desired order.",
  reorderInput.shape, (args) => store.reorder(args));
tool("get_lesson",
  "Instructor view of one lesson: Markdown content, linked assessments, every section in order (including archived), each exercise's full question with answer key, student completion, submission counts, latest submission, and the student's last reading position.",
  { lessonId: id }, ({ lessonId }) => store.instructorLesson(lessonId));
tool("upsert_lesson_section",
  "Create (omit id) or replace a section within a lesson. Kinds: introduction, objectives, theory, example, explanation, summary, note (Markdown content; GFM, fenced code with language tags, and > [!NOTE]/[!TIP]/[!WARNING] callouts) and exercise, knowledge_check (require questionId of a question in the same course; content is optional instructions shown above it). Position is zero-based. Set archived=true to hide a section while preserving student submissions. Sections cannot move between lessons.",
  sectionInput.innerType().shape, (args) => store.upsertSection(args));
tool("upsert_question",
  "Create or replace a question for assessments or lesson exercises. Choice questions require options with stable IDs and correctAnswer (option IDs). Written types (short_text, code_text, predict_output, find_bug) require instructor review; omit options and correctAnswer. Optional hint (shown on request in lessons, never during assessments), starterCode (prefilled editable text, e.g. buggy code for find_bug), and language (e.g. bash, python). Existing attempts and exercise submissions retain frozen question snapshots. Topic cannot change.",
  questionInput.innerType().shape, (args) => store.upsertQuestion(args));
tool("create_assessment", "Create an assessment using existing question IDs from any topics in the same course. Exams require durationMinutes. Every question is worth one point.",
  assessmentInput.innerType().shape, (args) => store.saveAssessment(args));
tool("update_assessment", "Replace an assessment definition and question ordering. All definition fields are required or take defaults. Existing attempts are unchanged.",
  { id, ...assessmentInput.innerType().shape }, ({ id: assessmentId, ...args }) => store.saveAssessment(args, assessmentId));
tool("list_assessments", "List assessments, optionally restricted to one course.",
  { courseId: id.optional() }, ({ courseId }) => store.listAssessments(courseId));
tool("get_assessment", "Get an instructor assessment definition, including current question text, answer keys, and explanations. Not a student endpoint.",
  { assessmentId: id }, ({ assessmentId }) => {
    const assessment = store.getAssessment(assessmentId);
    return { ...assessment, questions: assessment.questionIds.map((qid) => store.getQuestion(qid)) };
  });
tool("get_student_progress", "Get lesson and section completion (lessonProgress), last reading position, exercise summary, struggling exercises (repeated or unresolved incorrect answers), attempt IDs/results, weak topics (below 70% of graded assessment answers), feedback, and next lesson recommendation.",
  { courseId: id }, ({ courseId }) => store.progress(courseId));
tool("get_assessment_results", "Get a submitted attempt's frozen questions, answers, grading, pending reviews, and feedback. percentage is null until all answers are graded; gradedPercentage uses only graded responses. Unsubmitted results are unavailable.",
  { attemptId: id }, ({ attemptId }) => store.results(attemptId));
tool("get_student_answers", "Inspect an attempt's saved answers. Active attempts do not include keys or grading; submitted attempts include full results.",
  { attemptId: id }, ({ attemptId }) => store.studentAnswers(attemptId));
tool("get_topic_performance", "Get cumulative graded performance by topic, pending written reviews, priority, and weak areas.",
  { courseId: id }, ({ courseId }) => store.topicPerformance(courseId));
tool("get_exercise_submissions",
  "List lesson exercise submissions (newest first) with frozen question snapshots, student answers, scores, feedback, and section/lesson IDs. Filter by courseId, lessonId, sectionId, and status: all, pending_review (written answers awaiting review), incorrect (score below 1), reviewed.",
  {
    courseId: id.optional(), lessonId: id.optional(), sectionId: id.optional(),
    status: z.enum(["all", "pending_review", "incorrect", "reviewed"]).default("all"),
    limit: z.number().int().min(1).max(500).default(100),
  }, (args) => store.exerciseSubmissions(args));
tool("grade_exercise_submission",
  "Review a written lesson exercise submission (short_text, code_text, predict_output, find_bug). Score is 0..1 (partial credit allowed); feedback is shown to the student under the exercise. Re-grading replaces the previous review. The student's answer is immutable.",
  { submissionId: id, score: z.number().min(0).max(1), feedback: z.string().trim().min(1).max(200_000) },
  (args) => store.gradeExerciseSubmission(args));
tool("set_instructor_feedback", "Append feedback to a course, optionally linked to a topic or submitted attempt. Existing feedback is preserved.",
  { courseId: id, attemptId: id.optional(), topicId: id.optional(), message: z.string().trim().min(1).max(200_000) },
  (args) => store.setFeedback(args));
tool("grade_open_answer", "Review a submitted short-text, code/text, or predict-output response. Score is 0..1 (partial credit allowed). Feedback is required. Student responses remain immutable.",
  { attemptId: id, questionId: id, score: z.number().min(0).max(1), feedback: z.string().trim().min(1).max(200_000) },
  (args) => store.gradeOpenAnswer(args));
tool("set_learning_priority", "Set a topic's priority from 0 to 100; higher priorities come first in automatic recommendations.",
  { topicId: id, priority: z.number().int().min(0).max(100) }, (args) => store.setPriority(args));
tool("recommend_next_topic", "Set an explicit next topic and optionally a specific lesson. This overrides automatic recommendations until replaced. Reason is shown to the student.",
  { courseId: id, topicId: id, lessonId: id.optional(), reason: z.string().trim().min(1).max(10_000) },
  (args) => store.recommend(args));

await server.connect(new StdioServerTransport());
console.error(`Adaptive Learning Lab MCP ready. SQLite: ${databasePath()}`);
const shutdown = async () => { await server.close(); store.close(); process.exit(0); };
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
process.stdin.once("end", shutdown);
