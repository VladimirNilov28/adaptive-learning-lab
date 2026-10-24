import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { openDatabase, databasePath } from "./db.ts";
import {
  id, courseInput, phaseInput, topicInput, lessonInput, questionInput, assessmentInput,
  reorderInput, saveAnswerInput, sectionInput, answerValue,
  type Course, type Phase, type Topic, type Lesson, type CourseStructure, type Question,
  type Assessment, type AttemptRow, type AnswerRow, type AttemptView, type AttemptResults,
  type AnswerValue, type SectionRow, type StudentQuestion, type StudentSection, type StudentLesson,
  type ExerciseSubmission,
} from "./schemas.ts";

export class AppError extends Error {
  constructor(message: string, public status = 400) { super(message); }
}
const now = () => new Date().toISOString();
const parseQuestions = (value: string): Question[] => z.array(questionInput).parse(JSON.parse(value))
  .map((q) => ({ ...q, id: id.parse(q.id) }));

const isChoice = (q: Question) => q.type === "single_choice" || q.type === "multiple_choice";
/** Shared by assessments and lesson exercises. */
function validateAnswer(q: Question, value: AnswerValue) {
  if (value === null) return;
  if (isChoice(q)) {
    if (!Array.isArray(value) || (q.type === "single_choice" && value.length > 1) ||
      new Set(value).size !== value.length || value.some((v) => !q.options.some((o) => o.id === v)))
      throw new AppError("Answer must contain valid, unique option IDs");
  } else if (typeof value !== "string") throw new AppError("A text response is required");
}
/** Objective grading for choice questions; written types return null (instructor review). */
function gradeAnswer(q: Question, value: AnswerValue): number | null {
  if (!isChoice(q)) return null;
  const selected = Array.isArray(value) ? value : [], correct = q.correctAnswer ?? [];
  return selected.length === correct.length && correct.every((key) => selected.includes(key)) ? 1 : 0;
}
const studentQuestion = ({ correctAnswer: _key, explanation: _explanation, ...q }: Question): StudentQuestion => q;
const isEmpty = (v: AnswerValue) => v === null || (Array.isArray(v) ? !v.length : !v.trim());
type SubmissionRow = {
  id: string; section_id: string; question_id: string; question_json: string; value_json: string;
  score: number | null; feedback: string; reviewed_at: string | null; created_at: string;
};
const submissionView = (r: SubmissionRow): ExerciseSubmission => ({
  id: r.id, value: JSON.parse(r.value_json) as AnswerValue, score: r.score, feedback: r.feedback,
  reviewed_at: r.reviewed_at, created_at: r.created_at,
});
const submissionStatus = (score: number | null) =>
  score === null ? "pending_review" : score === 1 ? "correct" : score > 0 ? "partially_correct" : "incorrect";

export class Store {
  readonly db: Database.Database;
  constructor(path = databasePath()) { this.db = openDatabase(path); }
  close() { this.db.close(); }
  private all<T>(sql: string, ...args: (string | number | null)[]): T[] {
    return this.db.prepare(sql).all(...args) as T[];
  }
  private one<T>(sql: string, ...args: (string | number | null)[]): T {
    const row = this.db.prepare(sql).get(...args) as T | undefined;
    if (!row) throw new AppError("Not found", 404);
    return row;
  }
  private courseForTopic(topicId: string) {
    return this.one<{ course_id: string }>(
      "SELECT p.course_id FROM topics t JOIN phases p ON p.id=t.phase_id WHERE t.id=?", topicId,
    ).course_id;
  }
  listCourses() { return this.all<Course>("SELECT * FROM courses ORDER BY created_at, id"); }
  createCourse(input: unknown) {
    const c = courseInput.parse(input), courseId = randomUUID(), timestamp = now();
    this.db.transaction(() => {
      this.db.prepare("INSERT INTO courses VALUES (?, ?, ?, ?, ?)")
        .run(courseId, c.title, c.description, timestamp, timestamp);
      this.db.prepare("INSERT OR IGNORE INTO settings VALUES ('active_course', ?)").run(courseId);
    }).immediate();
    return this.getCourse(courseId);
  }
  updateCourse(input: unknown) {
    const c = courseInput.partial().extend({ id }).parse(input);
    const old = this.getCourse(c.id);
    this.db.prepare("UPDATE courses SET title=?, description=?, updated_at=? WHERE id=?")
      .run(c.title ?? old.title, c.description ?? old.description, now(), c.id);
    return this.getCourse(c.id);
  }
  getCourse(courseId: string) {
    return this.one<Course>("SELECT * FROM courses WHERE id=?", id.parse(courseId));
  }
  setActiveCourse(courseId: string) {
    this.getCourse(courseId);
    this.db.prepare("INSERT INTO settings VALUES ('active_course', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
      .run(courseId);
    return { courseId };
  }
  activeCourseId() {
    return (this.db.prepare("SELECT value FROM settings WHERE key='active_course'").get() as
      { value: string } | undefined)?.value ?? null;
  }
  upsertPhase(input: unknown) {
    const p = phaseInput.parse(input), phaseId = p.id ?? randomUUID(), timestamp = now();
    this.getCourse(p.courseId);
    if (p.id) {
      const old = this.one<Phase>("SELECT * FROM phases WHERE id=?", p.id);
      if (old.course_id !== p.courseId) throw new AppError("Phases cannot move between courses");
    }
    this.db.prepare(`INSERT INTO phases VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description,
      position=excluded.position, updated_at=excluded.updated_at`)
      .run(phaseId, p.courseId, p.title, p.description, p.position, timestamp, timestamp);
    return this.one<Phase>("SELECT * FROM phases WHERE id=?", phaseId);
  }
  upsertTopic(input: unknown) {
    const t = topicInput.parse(input), topicId = t.id ?? randomUUID(), timestamp = now();
    const parent = this.one<Phase>("SELECT * FROM phases WHERE id=?", t.phaseId);
    if (t.id && this.courseForTopic(t.id) !== parent.course_id)
      throw new AppError("Topics cannot move between courses");
    this.db.prepare(`INSERT INTO topics VALUES (?, ?, ?, ?, ?, 0, ?, ?)
      ON CONFLICT(id) DO UPDATE SET phase_id=excluded.phase_id, title=excluded.title,
      description=excluded.description, position=excluded.position, updated_at=excluded.updated_at`)
      .run(topicId, t.phaseId, t.title, t.description, t.position, timestamp, timestamp);
    return this.one<Topic>("SELECT * FROM topics WHERE id=?", topicId);
  }
  upsertLesson(input: unknown) {
    const l = lessonInput.parse(input), lessonId = l.id ?? randomUUID(), timestamp = now();
    this.db.transaction(() => {
      const courseId = this.courseForTopic(l.topicId);
      if (l.assessmentIds) {
        for (const assessmentId of l.assessmentIds) {
          if (this.getAssessment(assessmentId).courseId !== courseId)
            throw new AppError("Linked assessments must belong to the lesson's course");
        }
      }
      if (l.id) {
        const old = this.getLesson(l.id);
        if (old.topic_id !== l.topicId) {
          if (this.courseForTopic(old.topic_id) !== courseId)
            throw new AppError("Lessons cannot move between courses");
          this.db.prepare("UPDATE learning_recommendations SET topic_id=?, updated_at=? WHERE lesson_id=?")
            .run(l.topicId, timestamp, l.id);
        }
      }
      this.db.prepare(`INSERT INTO lessons VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET topic_id=excluded.topic_id, title=excluded.title,
        description=excluded.description, content=excluded.content, position=excluded.position,
        updated_at=excluded.updated_at`)
        .run(lessonId, l.topicId, l.title, l.description, l.content, l.position, timestamp, timestamp);
      if (l.assessmentIds !== undefined) {
        this.db.prepare("DELETE FROM lesson_assessments WHERE lesson_id=?").run(lessonId);
        const insert = this.db.prepare("INSERT INTO lesson_assessments VALUES (?, ?, ?)");
        l.assessmentIds.forEach((assessmentId, position) => insert.run(lessonId, assessmentId, position));
      }
    }).immediate();
    return this.getLesson(lessonId);
  }
  getLesson(lessonId: string) {
    const lesson = this.one<Omit<Lesson, "assessmentIds">>("SELECT * FROM lessons WHERE id=?", id.parse(lessonId));
    return { ...lesson, assessmentIds: this.lessonAssessmentIds(lesson.id) };
  }
  private lessonAssessmentIds(lessonId: string) {
    return this.all<{ assessment_id: string }>(
      "SELECT assessment_id FROM lesson_assessments WHERE lesson_id=? ORDER BY position", lessonId,
    ).map((a) => a.assessment_id);
  }
  getTopic(topicId: string) {
    return this.one<Topic>("SELECT * FROM topics WHERE id=?", id.parse(topicId));
  }
  structure(courseId: string): CourseStructure {
    const course = this.getCourse(courseId);
    return { ...course, phases: this.all<Phase>(
      "SELECT * FROM phases WHERE course_id=? ORDER BY position, created_at, id", courseId,
    ).map((p) => ({ ...p, topics: this.all<Topic>(
      "SELECT * FROM topics WHERE phase_id=? ORDER BY position, created_at, id", p.id,
    ).map((t) => ({ ...t, lessons: this.all<Lesson & { completed: number; sectionCount: number; sectionsCompleted: number }>(
      `SELECT l.*, EXISTS(SELECT 1 FROM lesson_completion c WHERE c.lesson_id=l.id) AS completed,
       (SELECT COUNT(*) FROM lesson_sections s WHERE s.lesson_id=l.id AND s.archived=0) AS sectionCount,
       (SELECT COUNT(*) FROM lesson_sections s JOIN section_progress sp ON sp.section_id=s.id
        WHERE s.lesson_id=l.id AND s.archived=0) AS sectionsCompleted
       FROM lessons l WHERE topic_id=? ORDER BY position, created_at, id`, t.id,
    ).map((l) => ({ ...l, assessmentIds: this.lessonAssessmentIds(l.id), completed: Boolean(l.completed) })) })) })) };
  }
  reorder(input: unknown) {
    const r = reorderInput.parse(input);
    const { table, parent } = {
      phase: { table: "phases", parent: "course_id" },
      topic: { table: "topics", parent: "phase_id" },
      lesson: { table: "lessons", parent: "topic_id" },
      section: { table: "lesson_sections", parent: "lesson_id" },
    }[r.kind];
    this.db.transaction(() => {
      if (r.kind === "phase") this.getCourse(r.parentId);
      else if (r.kind === "topic") this.one<Phase>("SELECT * FROM phases WHERE id=?", r.parentId);
      else if (r.kind === "lesson") this.getTopic(r.parentId);
      else this.getLesson(r.parentId);
      const siblings = this.all<{ id: string }>(`SELECT id FROM ${table} WHERE ${parent}=?`, r.parentId);
      if (r.ids.length !== siblings.length || new Set(r.ids).size !== r.ids.length ||
        siblings.some((s) => !r.ids.includes(s.id)))
        throw new AppError("Provide every sibling ID exactly once");
      const update = this.db.prepare(`UPDATE ${table} SET position=?, updated_at=? WHERE id=?`);
      r.ids.forEach((itemId, position) => update.run(position, now(), itemId));
    }).immediate();
    return { reordered: r.ids };
  }
  completeLesson(lessonId: string, completed: boolean) {
    this.getLesson(lessonId);
    z.boolean().parse(completed);
    if (completed) this.db.prepare("INSERT OR IGNORE INTO lesson_completion VALUES (?, ?)").run(lessonId, now());
    else this.db.prepare("DELETE FROM lesson_completion WHERE lesson_id=?").run(lessonId);
    return { lessonId, completed };
  }
  private section(sectionId: string) {
    return this.one<SectionRow>("SELECT * FROM lesson_sections WHERE id=?", id.parse(sectionId));
  }
  private sectionRows(lessonId: string, includeArchived = false) {
    return this.all<SectionRow & { completed: number }>(
      `SELECT s.*, EXISTS(SELECT 1 FROM section_progress p WHERE p.section_id=s.id) AS completed
       FROM lesson_sections s WHERE lesson_id=? ${includeArchived ? "" : "AND archived=0"}
       ORDER BY position, created_at, id`, lessonId,
    );
  }
  private submissionRows(sectionId: string) {
    return this.all<SubmissionRow>(
      "SELECT * FROM exercise_submissions WHERE section_id=? ORDER BY created_at DESC, rowid DESC", sectionId,
    );
  }
  upsertSection(input: unknown) {
    const s = sectionInput.parse(input), key = s.id ?? randomUUID(), timestamp = now();
    this.db.transaction(() => {
      const courseId = this.courseForTopic(this.getLesson(s.lessonId).topic_id);
      if (s.id) {
        const old = this.db.prepare("SELECT lesson_id FROM lesson_sections WHERE id=?").get(s.id) as
          { lesson_id: string } | undefined;
        if (old && old.lesson_id !== s.lessonId) throw new AppError("Sections cannot move between lessons");
      }
      if (s.questionId && this.courseForTopic(this.getQuestion(s.questionId).topicId) !== courseId)
        throw new AppError("Exercise questions must belong to the lesson's course");
      this.db.prepare(`INSERT INTO lesson_sections VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET kind=excluded.kind, title=excluded.title, content=excluded.content,
        question_id=excluded.question_id, position=excluded.position, archived=excluded.archived,
        updated_at=excluded.updated_at`)
        .run(key, s.lessonId, s.kind, s.title, s.content, s.questionId, s.position, Number(s.archived), timestamp, timestamp);
    }).immediate();
    return this.instructorLesson(s.lessonId).sections.find((section) => section.id === key)!;
  }
  /** Instructor view: all sections (including archived), full questions with keys, and student progress. */
  instructorLesson(lessonId: string) {
    const lesson = this.getLesson(lessonId);
    const position = this.db.prepare("SELECT section_id, updated_at FROM lesson_positions WHERE lesson_id=?")
      .get(lesson.id) as { section_id: string | null; updated_at: string } | undefined;
    return {
      ...lesson,
      completed: Boolean(this.db.prepare("SELECT 1 FROM lesson_completion WHERE lesson_id=?").get(lesson.id)),
      lastPosition: position ? { sectionId: position.section_id, updatedAt: position.updated_at } : null,
      sections: this.sectionRows(lesson.id, true).map(({ completed, archived, ...section }) => {
        const submissions = this.submissionRows(section.id);
        return {
          ...section, archived: Boolean(archived), completed: Boolean(completed),
          question: section.question_id ? this.getQuestion(section.question_id) : null,
          submissionCount: submissions.length,
          incorrectSubmissions: submissions.filter((r) => r.score !== null && r.score < 1).length,
          latestSubmission: submissions[0] ? { ...submissionView(submissions[0]), status: submissionStatus(submissions[0].score) } : null,
        };
      }),
    };
  }
  /** Student view: hides archived sections; keys and explanations only after the student submitted an answer. */
  studentLesson(lessonId: string): StudentLesson {
    const lesson = this.getLesson(lessonId);
    const position = this.db.prepare("SELECT section_id FROM lesson_positions WHERE lesson_id=?")
      .get(lesson.id) as { section_id: string | null } | undefined;
    return { ...lesson, lastSectionId: position?.section_id ?? null,
      sections: this.sectionRows(lesson.id).map((row) => this.studentSection(row)) };
  }
  private studentSection({ completed, archived: _archived, question_id, ...row }: SectionRow & { completed: number }): StudentSection {
    const submissions = question_id ? this.submissionRows(row.id) : [];
    const q = question_id ? this.getQuestion(question_id) : null;
    return {
      ...row, completed: Boolean(completed), submissions: submissions.length,
      latest: submissions[0] ? submissionView(submissions[0]) : null,
      question: q ? submissions.length ? q : studentQuestion(q) : null,
    };
  }
  private markSectionComplete(section: SectionRow) {
    const timestamp = now();
    this.db.prepare("INSERT OR IGNORE INTO section_progress VALUES (?, ?)").run(section.id, timestamp);
    const remaining = this.db.prepare(`SELECT COUNT(*) AS n FROM lesson_sections s WHERE s.lesson_id=? AND s.archived=0
      AND NOT EXISTS(SELECT 1 FROM section_progress p WHERE p.section_id=s.id)`).get(section.lesson_id) as { n: number };
    if (!remaining.n) this.db.prepare("INSERT OR IGNORE INTO lesson_completion VALUES (?, ?)").run(section.lesson_id, timestamp);
  }
  completeSection(sectionId: string, completed: boolean) {
    z.boolean().parse(completed);
    this.db.transaction(() => {
      const section = this.section(sectionId);
      if (section.archived) throw new AppError("This section is no longer part of the lesson");
      if (!completed) this.db.prepare("DELETE FROM section_progress WHERE section_id=?").run(section.id);
      else if (section.question_id) throw new AppError("Submit an answer to complete this exercise");
      else this.markSectionComplete(section);
    }).immediate();
    return { sectionId, completed };
  }
  setPosition(lessonId: string, sectionId: string | null) {
    this.getLesson(lessonId);
    if (sectionId !== null && this.section(sectionId).lesson_id !== lessonId)
      throw new AppError("Section does not belong to this lesson");
    this.db.prepare(`INSERT INTO lesson_positions VALUES (?, ?, ?)
      ON CONFLICT(lesson_id) DO UPDATE SET section_id=excluded.section_id, updated_at=excluded.updated_at`)
      .run(lessonId, sectionId, now());
    return { lessonId, sectionId };
  }
  /** Saves a new exercise submission (retries allowed). Choice questions are auto-graded; written ones await review. */
  submitExercise(sectionId: string, rawValue: unknown) {
    const value = answerValue.parse(rawValue);
    const sectionKey = this.db.transaction(() => {
      const section = this.section(sectionId);
      if (section.archived || !section.question_id) throw new AppError("This section has no active exercise");
      if (isEmpty(value)) throw new AppError("Provide an answer before submitting");
      const q = this.getQuestion(section.question_id);
      validateAnswer(q, value);
      const score = gradeAnswer(q, value), timestamp = now();
      this.db.prepare(`INSERT INTO exercise_submissions (id, section_id, question_id, question_json, value_json, score, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .run(randomUUID(), section.id, q.id, JSON.stringify(q), JSON.stringify(value), score, timestamp);
      if (score === null || score === 1) this.markSectionComplete(section);
      this.db.prepare(`INSERT INTO lesson_positions VALUES (?, ?, ?)
        ON CONFLICT(lesson_id) DO UPDATE SET section_id=excluded.section_id, updated_at=excluded.updated_at`)
        .run(section.lesson_id, section.id, timestamp);
      return section.id;
    }).immediate();
    const row = this.sectionRows(this.section(sectionKey).lesson_id).find((r) => r.id === sectionKey)!;
    return this.studentSection(row);
  }
  exerciseSubmissions(input: unknown) {
    const f = z.object({
      courseId: id.optional(), lessonId: id.optional(), sectionId: id.optional(),
      status: z.enum(["all", "pending_review", "incorrect", "reviewed"]).default("all"),
      limit: z.number().int().min(1).max(500).default(100),
    }).parse(input ?? {});
    const where = {
      all: "", pending_review: "AND e.score IS NULL", incorrect: "AND e.score IS NOT NULL AND e.score < 1",
      reviewed: "AND e.reviewed_at IS NOT NULL",
    }[f.status];
    return this.all<SubmissionRow & { lesson_id: string; lesson_title: string; section_title: string; section_kind: string;
      topic_id: string; course_id: string }>(
      `SELECT e.*, s.lesson_id, l.title AS lesson_title, s.title AS section_title, s.kind AS section_kind,
        l.topic_id, p.course_id
       FROM exercise_submissions e JOIN lesson_sections s ON s.id=e.section_id JOIN lessons l ON l.id=s.lesson_id
       JOIN topics t ON t.id=l.topic_id JOIN phases p ON p.id=t.phase_id
       WHERE (? IS NULL OR p.course_id=?) AND (? IS NULL OR s.lesson_id=?) AND (? IS NULL OR e.section_id=?) ${where}
       ORDER BY e.created_at DESC, e.rowid DESC LIMIT ?`,
      f.courseId ?? null, f.courseId ?? null, f.lessonId ?? null, f.lessonId ?? null,
      f.sectionId ?? null, f.sectionId ?? null, f.limit,
    ).map((r) => ({
      ...submissionView(r), status: submissionStatus(r.score), sectionId: r.section_id, sectionTitle: r.section_title,
      sectionKind: r.section_kind, lessonId: r.lesson_id, lessonTitle: r.lesson_title, topicId: r.topic_id,
      courseId: r.course_id, question: parseQuestions(`[${r.question_json}]`)[0],
    }));
  }
  gradeExerciseSubmission(input: unknown) {
    const g = z.object({
      submissionId: id, score: z.number().min(0).max(1), feedback: z.string().trim().min(1).max(200_000),
    }).parse(input);
    const row = this.one<SubmissionRow>("SELECT * FROM exercise_submissions WHERE id=?", g.submissionId);
    if (isChoice(parseQuestions(`[${row.question_json}]`)[0]))
      throw new AppError("Choice exercises are graded automatically; only written submissions can be reviewed");
    const timestamp = now();
    this.db.prepare("UPDATE exercise_submissions SET score=?, feedback=?, reviewed_at=? WHERE id=?")
      .run(g.score, g.feedback, timestamp, g.submissionId);
    return this.exerciseSubmissions({ sectionId: row.section_id, limit: 500 }).find((s) => s.id === g.submissionId)!;
  }
  upsertQuestion(input: unknown) {
    const q = questionInput.parse(input), questionId = q.id ?? randomUUID(), timestamp = now();
    this.courseForTopic(q.topicId);
    if (q.id) {
      const old = this.getQuestion(q.id);
      if (old.topicId !== q.topicId)
        throw new AppError("Question topic is stable; create a new question to change topic");
    }
    const question: Question = { ...q, id: questionId };
    this.db.prepare(`INSERT INTO questions VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET data_json=excluded.data_json, updated_at=excluded.updated_at`)
      .run(questionId, q.topicId, JSON.stringify(question), timestamp, timestamp);
    return question;
  }
  getQuestion(questionId: string): Question {
    const row = this.one<{ data_json: string }>("SELECT data_json FROM questions WHERE id=?", questionId);
    const q = questionInput.parse(JSON.parse(row.data_json));
    return { ...q, id: id.parse(q.id) };
  }
  saveAssessment(input: unknown, assessmentId?: string) {
    const a = assessmentInput.parse(input), key = assessmentId ?? randomUUID(), timestamp = now();
    this.db.transaction(() => {
      this.getCourse(a.courseId);
      if (assessmentId && this.getAssessment(assessmentId).courseId !== a.courseId)
        throw new AppError("Assessments cannot move between courses");
      for (const qid of a.questionIds) {
        if (this.courseForTopic(this.getQuestion(qid).topicId) !== a.courseId)
          throw new AppError("All assessment questions must belong to its course");
      }
      this.db.prepare(`INSERT INTO assessments VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET title=excluded.title, description=excluded.description,
        mode=excluded.mode, duration_minutes=excluded.duration_minutes, updated_at=excluded.updated_at`)
        .run(key, a.courseId, a.title, a.description, a.mode, a.durationMinutes, timestamp, timestamp);
      this.db.prepare("DELETE FROM assessment_questions WHERE assessment_id=?").run(key);
      const insert = this.db.prepare("INSERT INTO assessment_questions VALUES (?, ?, ?)");
      a.questionIds.forEach((qid, position) => insert.run(key, qid, position));
    }).immediate();
    return this.getAssessment(key);
  }
  getAssessment(assessmentId: string): Assessment {
    const a = this.one<{
      id: string; course_id: string; title: string; description: string; mode: "exam" | "practice";
      duration_minutes: number | null; created_at: string; updated_at: string;
    }>("SELECT * FROM assessments WHERE id=?", id.parse(assessmentId));
    return {
      id: a.id, courseId: a.course_id, title: a.title, description: a.description,
      mode: a.mode, durationMinutes: a.duration_minutes, created_at: a.created_at, updated_at: a.updated_at,
      questionIds: this.all<{ question_id: string }>(
        "SELECT question_id FROM assessment_questions WHERE assessment_id=? ORDER BY position", a.id,
      ).map((q) => q.question_id),
    };
  }
  listAssessments(courseId?: string) {
    if (courseId) this.getCourse(courseId);
    return this.all<{ id: string }>(
      `SELECT id FROM assessments ${courseId ? "WHERE course_id=?" : ""} ORDER BY created_at, id`,
      ...(courseId ? [courseId] : []),
    ).map((a) => this.getAssessment(a.id));
  }
  private attempt(attemptId: string) {
    return this.one<AttemptRow>("SELECT * FROM attempts WHERE id=?", id.parse(attemptId));
  }
  expireAttempts() {
    this.db.transaction(() => {
      this.all<{ id: string }>(
        "SELECT id FROM attempts WHERE submitted_at IS NULL AND deadline IS NOT NULL AND deadline<=?", now(),
      ).forEach((a) => this.submitInternal(a.id));
    }).immediate();
  }
  startAttempt(assessmentId: string): AttemptView {
    const attemptId = this.db.transaction(() => {
      this.expireAttempts();
      const existing = this.db.prepare(
        "SELECT id FROM attempts WHERE assessment_id=? AND submitted_at IS NULL",
      ).get(assessmentId) as { id: string } | undefined;
      if (existing) return existing.id;
      const a = this.getAssessment(assessmentId), key = randomUUID(), timestamp = now();
      const deadline = a.durationMinutes === null ? null :
        new Date(Date.now() + a.durationMinutes * 60_000).toISOString();
      this.db.prepare("INSERT INTO attempts VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?)")
        .run(key, a.id, a.courseId, a.title, a.mode, timestamp, deadline,
          JSON.stringify(a.questionIds.map((qid) => this.getQuestion(qid))));
      return key;
    }).immediate();
    return this.studentAttempt(attemptId);
  }
  studentAttempt(attemptId: string): AttemptView {
    this.expireAttempts();
    const { questions_json, ...a } = this.attempt(attemptId);
    return {
      ...a, serverNow: now(),
      // Exams and practice assessments never include keys, explanations, or lesson hints before submission.
      questions: parseQuestions(questions_json).map((q) => { const { hint: _hint, ...safe } = studentQuestion(q); return safe; }),
      answers: Object.fromEntries(this.all<AnswerRow>(
        "SELECT * FROM student_answers WHERE attempt_id=?", attemptId,
      ).map((answer) => [answer.question_id, JSON.parse(answer.value_json) as AnswerValue])),
    };
  }
  saveAnswer(attemptId: string, input: unknown) {
    const answer = saveAnswerInput.parse(input);
    const saved = this.db.transaction(() => {
      const a = this.attempt(attemptId);
      if (a.submitted_at) return false;
      if (a.deadline && a.deadline <= now()) {
        this.submitInternal(attemptId);
        return false;
      }
      const q = parseQuestions(a.questions_json).find((q) => q.id === answer.questionId);
      if (!q) throw new AppError("Question is not part of this attempt");
      validateAnswer(q, answer.value);
      this.db.prepare(`INSERT INTO student_answers
        (attempt_id, question_id, value_json, updated_at) VALUES (?, ?, ?, ?)
        ON CONFLICT(attempt_id, question_id) DO UPDATE SET value_json=excluded.value_json, updated_at=excluded.updated_at`)
        .run(attemptId, answer.questionId, JSON.stringify(answer.value), now());
      return true;
    }).immediate();
    if (!saved) throw new AppError("This attempt has already been submitted (or its deadline has passed)", 409);
    return { saved: true };
  }
  private submitInternal(attemptId: string) {
    const a = this.attempt(attemptId);
    if (a.submitted_at) return;
    const timestamp = a.deadline && a.deadline < now() ? a.deadline : now();
    for (const q of parseQuestions(a.questions_json)) {
      const existing = this.db.prepare(
        "SELECT value_json FROM student_answers WHERE attempt_id=? AND question_id=?",
      ).get(attemptId, q.id) as { value_json: string } | undefined;
      const value: AnswerValue = existing ? JSON.parse(existing.value_json) : null;
      const score = gradeAnswer(q, value);
      this.db.prepare(`INSERT INTO student_answers
        (attempt_id, question_id, value_json, score, updated_at) VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(attempt_id, question_id) DO UPDATE SET score=excluded.score, updated_at=excluded.updated_at`)
        .run(attemptId, q.id, JSON.stringify(value), score, timestamp);
    }
    this.db.prepare("UPDATE attempts SET submitted_at=? WHERE id=? AND submitted_at IS NULL")
      .run(timestamp, attemptId);
  }
  submitAttempt(attemptId: string) {
    this.db.transaction(() => this.submitInternal(attemptId)).immediate();
    return this.results(attemptId);
  }
  results(attemptId: string): AttemptResults {
    this.expireAttempts();
    const { questions_json, ...a } = this.attempt(attemptId);
    if (!a.submitted_at) throw new AppError("Results are available only after submission", 409);
    const questions = parseQuestions(questions_json);
    const answers = this.all<AnswerRow>("SELECT * FROM student_answers WHERE attempt_id=?", attemptId)
      .map(({ value_json, ...answer }) => ({ ...answer, value: JSON.parse(value_json) as AnswerValue }));
    const earned = answers.reduce((sum, a) => sum + (a.score ?? 0), 0);
    const pendingReview = answers.filter((a) => a.score === null).length;
    const gradedCount = answers.length - pendingReview;
    return {
      ...a, questions, answers, earned, total: questions.length,
      percentage: pendingReview ? null : Math.round(earned / questions.length * 100),
      pendingReview, gradedCount,
      gradedPercentage: gradedCount ? Math.round(earned / gradedCount * 100) : null,
      feedback: this.all<{ id: string; message: string; created_at: string }>(
        "SELECT id, message, created_at FROM instructor_feedback WHERE attempt_id=? ORDER BY created_at", attemptId,
      ),
    };
  }
  studentAnswers(attemptId: string) {
    const a = this.studentAttempt(attemptId);
    return a.submitted_at ? this.results(attemptId) : a;
  }
  gradeOpenAnswer(input: unknown) {
    const g = z.object({
      attemptId: id, questionId: id, score: z.number().min(0).max(1),
      feedback: z.string().trim().min(1).max(200_000),
    }).parse(input);
    this.db.transaction(() => {
      const result = this.results(g.attemptId);
      const q = result.questions.find((q) => q.id === g.questionId);
      if (!q || isChoice(q))
        throw new AppError("Only submitted written responses can be instructor-graded");
      this.db.prepare(`UPDATE student_answers SET score=?, feedback=?, reviewed_at=?, updated_at=?
        WHERE attempt_id=? AND question_id=?`)
        .run(g.score, g.feedback, now(), now(), g.attemptId, g.questionId);
    }).immediate();
    return this.results(g.attemptId);
  }
  setFeedback(input: unknown) {
    const f = z.object({
      courseId: id, attemptId: id.optional(), topicId: id.optional(),
      message: z.string().trim().min(1).max(200_000),
    }).parse(input);
    this.getCourse(f.courseId);
    if (f.topicId && this.courseForTopic(f.topicId) !== f.courseId)
      throw new AppError("Topic does not belong to course");
    if (f.attemptId && this.results(f.attemptId).course_id !== f.courseId)
      throw new AppError("Attempt does not belong to course");
    const key = randomUUID(), timestamp = now();
    this.db.prepare("INSERT INTO instructor_feedback VALUES (?, ?, ?, ?, ?, ?)")
      .run(key, f.courseId, f.attemptId ?? null, f.topicId ?? null, f.message, timestamp);
    return { id: key, ...f, created_at: timestamp };
  }
  setPriority(input: unknown) {
    const p = z.object({ topicId: id, priority: z.number().int().min(0).max(100) }).parse(input);
    this.getTopic(p.topicId);
    this.db.prepare("UPDATE topics SET priority=?, updated_at=? WHERE id=?").run(p.priority, now(), p.topicId);
    return this.getTopic(p.topicId);
  }
  recommend(input: unknown) {
    const r = z.object({
      courseId: id, topicId: id, lessonId: id.optional(),
      reason: z.string().trim().min(1).max(10_000),
    }).parse(input);
    this.getCourse(r.courseId);
    if (this.courseForTopic(r.topicId) !== r.courseId) throw new AppError("Topic does not belong to course");
    if (r.lessonId && this.getLesson(r.lessonId).topic_id !== r.topicId)
      throw new AppError("Lesson does not belong to topic");
    this.db.prepare(`INSERT INTO learning_recommendations VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(course_id) DO UPDATE SET topic_id=excluded.topic_id, lesson_id=excluded.lesson_id,
      reason=excluded.reason, updated_at=excluded.updated_at`)
      .run(r.courseId, r.topicId, r.lessonId ?? null, r.reason, now());
    return r;
  }
  topicPerformance(courseId: string) {
    this.expireAttempts();
    const topics = this.structure(courseId).phases.flatMap((p) => p.topics);
    const scores = new Map<string, { earned: number; graded: number; pending: number }>();
    for (const a of this.all<AttemptRow>(
      "SELECT * FROM attempts WHERE course_id=? AND submitted_at IS NOT NULL", courseId,
    )) {
      const result = this.results(a.id);
      for (const q of result.questions) {
        const answer = result.answers.find((answer) => answer.question_id === q.id);
        const s = scores.get(q.topicId) ?? { earned: 0, graded: 0, pending: 0 };
        if (answer?.score === null || answer?.score === undefined) s.pending++;
        else { s.graded++; s.earned += answer.score; }
        scores.set(q.topicId, s);
      }
    }
    return topics.map((t) => {
      const s = scores.get(t.id) ?? { earned: 0, graded: 0, pending: 0 };
      const percentage = s.graded ? Math.round(s.earned / s.graded * 100) : null;
      return { topicId: t.id, title: t.title, priority: t.priority, ...s, percentage,
        needsPractice: percentage !== null && percentage < 70 };
    });
  }
  progress(courseId: string) {
    this.expireAttempts();
    const structure = this.structure(courseId), performance = this.topicPerformance(courseId);
    const topics = structure.phases.flatMap((p) => p.topics);
    const lessons = topics.flatMap((t) => t.lessons);
    const explicit = this.db.prepare(
      "SELECT * FROM learning_recommendations WHERE course_id=?",
    ).get(courseId) as { topic_id: string; lesson_id: string | null; reason: string } | undefined;
    const ranked = [...topics].sort((a, b) => b.priority - a.priority ||
      Number(performance.find((t) => t.topicId === b.id)?.needsPractice) -
      Number(performance.find((t) => t.topicId === a.id)?.needsPractice));
    const nextTopic = explicit ? topics.find((t) => t.id === explicit.topic_id) :
      ranked.find((t) => t.lessons.some((l) => !l.completed)) ??
      ranked.find((t) => performance.find((p) => p.topicId === t.id)?.needsPractice);
    const nextLesson = explicit?.lesson_id ? lessons.find((l) => l.id === explicit.lesson_id) :
      nextTopic?.lessons.find((l) => !l.completed);
    const attempts = this.all<AttemptRow>(
      "SELECT * FROM attempts WHERE course_id=? ORDER BY started_at DESC, id", courseId,
    ).map(({ questions_json: _snapshot, ...a }) => ({
      ...a, result: a.submitted_at ? (() => {
        const r = this.results(a.id);
        return { percentage: r.percentage, pendingReview: r.pendingReview, earned: r.earned,
          total: r.total, gradedCount: r.gradedCount, gradedPercentage: r.gradedPercentage };
      })() : null,
    }));
    const exerciseRows = this.all<{ section_id: string; section_title: string; lesson_id: string; lesson_title: string;
      completed: number; submissions: number; incorrect: number; pending: number }>(
      `SELECT s.id AS section_id, s.title AS section_title, l.id AS lesson_id, l.title AS lesson_title,
        EXISTS(SELECT 1 FROM section_progress sp WHERE sp.section_id=s.id) AS completed,
        (SELECT COUNT(*) FROM exercise_submissions e WHERE e.section_id=s.id) AS submissions,
        (SELECT COUNT(*) FROM exercise_submissions e WHERE e.section_id=s.id AND e.score IS NOT NULL AND e.score < 1) AS incorrect,
        (SELECT COUNT(*) FROM exercise_submissions e WHERE e.section_id=s.id AND e.score IS NULL) AS pending
       FROM lesson_sections s JOIN lessons l ON l.id=s.lesson_id JOIN topics t ON t.id=l.topic_id
       JOIN phases p ON p.id=t.phase_id
       WHERE p.course_id=? AND s.archived=0 AND s.question_id IS NOT NULL`, courseId,
    );
    const position = this.db.prepare(`SELECT lp.lesson_id, lp.section_id, lp.updated_at, l.title AS lesson_title,
        s.title AS section_title, EXISTS(SELECT 1 FROM lesson_completion c WHERE c.lesson_id=l.id) AS lesson_completed
       FROM lesson_positions lp JOIN lessons l ON l.id=lp.lesson_id JOIN topics t ON t.id=l.topic_id
       JOIN phases p ON p.id=t.phase_id LEFT JOIN lesson_sections s ON s.id=lp.section_id AND s.archived=0
       WHERE p.course_id=? ORDER BY lp.updated_at DESC LIMIT 1`).get(courseId) as {
        lesson_id: string; section_id: string | null; updated_at: string; lesson_title: string;
        section_title: string | null; lesson_completed: number } | undefined;
    return {
      lastPosition: position ? {
        lessonId: position.lesson_id, lessonTitle: position.lesson_title,
        sectionId: position.section_title === null ? null : position.section_id, sectionTitle: position.section_title,
        lessonCompleted: Boolean(position.lesson_completed), updatedAt: position.updated_at,
      } : null,
      lessonProgress: lessons.map((l) => ({ lessonId: l.id, title: l.title, completed: l.completed,
        sectionCount: l.sectionCount, sectionsCompleted: l.sectionsCompleted })),
      exercises: {
        total: exerciseRows.length, completed: exerciseRows.filter((r) => r.completed).length,
        attempted: exerciseRows.filter((r) => r.submissions).length,
        incorrectSubmissions: exerciseRows.reduce((n, r) => n + r.incorrect, 0),
        pendingReview: exerciseRows.reduce((n, r) => n + r.pending, 0),
      },
      strugglingExercises: exerciseRows.filter((r) => r.incorrect >= 2 || (r.incorrect && !r.completed))
        .map((r) => ({ sectionId: r.section_id, sectionTitle: r.section_title, lessonId: r.lesson_id,
          lessonTitle: r.lesson_title, incorrectSubmissions: r.incorrect, completed: Boolean(r.completed) })),
      courseId, completedLessons: lessons.filter((l) => l.completed).length, totalLessons: lessons.length,
      completedLessonIds: lessons.filter((l) => l.completed).map((l) => l.id),
      performance, weakTopics: performance.filter((t) => t.needsPractice),
      recommendation: nextTopic ? {
        topicId: nextTopic.id, topicTitle: nextTopic.title, lessonId: nextLesson?.id ?? null,
        lessonTitle: nextLesson?.title ?? null,
        reason: explicit?.reason ?? "Based on learning priority, topic performance, and unfinished lessons.",
      } : null,
      attempts,
      feedback: this.all<{ id: string; message: string; topic_id: string | null; attempt_id: string | null; created_at: string }>(
        "SELECT * FROM instructor_feedback WHERE course_id=? ORDER BY created_at DESC", courseId,
      ),
    };
  }
}

let singleton: Store | undefined;
export function getStore() { return singleton ??= new Store(); }
