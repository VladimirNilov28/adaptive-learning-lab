import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store.js";
import { databasePath } from "../src/lib/db.js";

function fixture(store: Store) {
  const course = store.createCourse({ title: "Fixture course" });
  const phase = store.upsertPhase({ courseId: course.id, title: "Fixture phase" });
  const topic = store.upsertTopic({ phaseId: phase.id, title: "Fixture topic" });
  const lesson = store.upsertLesson({ topicId: topic.id, title: "Fixture lesson", content: "# Fixture content" });
  const choice = store.upsertQuestion({
    topicId: topic.id, type: "single_choice", prompt: "Fixture prompt",
    options: [{ id: "a", text: "Option A" }, { id: "b", text: "Option B" }],
    correctAnswer: ["b"], explanation: "Original explanation",
  });
  return { course, phase, topic, lesson, choice };
}

test("database location follows working directory or an explicit absolute environment path", () => {
  const original = process.env.LEARNING_DB_PATH;
  try {
    delete process.env.LEARNING_DB_PATH;
    assert.equal(databasePath("/tmp/fixture-workspace"), "/tmp/fixture-workspace/data/learning.sqlite");
    process.env.LEARNING_DB_PATH = "/tmp/fixture-explicit.sqlite";
    assert.equal(databasePath("/tmp/other-workspace"), "/tmp/fixture-explicit.sqlite");
    process.env.LEARNING_DB_PATH = "relative.sqlite";
    assert.throws(() => databasePath(), /must be an absolute path/);
  } finally {
    if (original === undefined) delete process.env.LEARNING_DB_PATH;
    else process.env.LEARNING_DB_PATH = original;
  }
});

test("initialization is empty, persistent, idempotent, and enables foreign keys", () => {
  const dir = mkdtempSync(join(tmpdir(), "learning-db-test-"));
  try {
    const path = join(dir, "nested", "test.sqlite");
    const first = new Store(path);
    assert.deepEqual(first.listCourses(), []);
    assert.equal(first.db.pragma("foreign_keys", { simple: true }), 1);
    const course = first.createCourse({ title: "Persistent fixture" });
    first.close();
    const reopened = new Store(path);
    assert.equal(reopened.listCourses().length, 1);
    assert.equal(reopened.getCourse(course.id).title, "Persistent fixture");
    assert.equal(reopened.activeCourseId(), course.id);
    reopened.close();
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("course hierarchy creation, safe updates, ordering, and adaptive topic moves", () => {
  const store = new Store(":memory:");
  try {
    const f = fixture(store);
    assert.equal(store.structure(f.course.id).phases[0].topics[0].lessons[0].content, "# Fixture content");
    store.updateCourse({ id: f.course.id, description: "Changed" });
    assert.equal(store.getCourse(f.course.id).title, "Fixture course");
    assert.equal(store.getCourse(f.course.id).description, "Changed");
    const phase2 = store.upsertPhase({ courseId: f.course.id, title: "Another phase" });
    store.reorder({ kind: "phase", parentId: f.course.id, ids: [phase2.id, f.phase.id] });
    assert.equal(store.structure(f.course.id).phases[0].id, phase2.id);
    assert.throws(() => store.reorder({ kind: "phase", parentId: f.course.id, ids: [f.phase.id, f.phase.id] }));
    assert.throws(() => store.reorder({ kind: "phase", parentId: "missing", ids: [] }), /Not found/);
    store.setPriority({ topicId: f.topic.id, priority: 90 });
    store.upsertTopic({ id: f.topic.id, phaseId: phase2.id, title: "Moved topic" });
    assert.equal(store.getTopic(f.topic.id).priority, 90);
    assert.equal(store.structure(f.course.id).phases[0].topics[0].id, f.topic.id);
    const anotherCourse = store.createCourse({ title: "Other fixture" });
    const foreignPhase = store.upsertPhase({ courseId: anotherCourse.id, title: "Foreign phase" });
    assert.throws(() => store.upsertTopic({ id: f.topic.id, phaseId: foreignPhase.id, title: "Invalid move" }));
    assert.equal(store.getTopic(f.topic.id).phase_id, phase2.id);
  } finally { store.close(); }
});

test("question validation rejects ambiguous keys, invalid options, and open-answer keys", () => {
  const store = new Store(":memory:");
  try {
    const f = fixture(store);
    assert.deepEqual(store.getQuestion(f.choice.id).correctAnswer, ["b"]);
    assert.throws(() => store.upsertQuestion({ ...f.choice, correctAnswer: ["missing"] }));
    assert.throws(() => store.upsertQuestion({ ...f.choice, correctAnswer: ["a", "b"] }));
    assert.throws(() => store.upsertQuestion({
      ...f.choice, options: [{ id: "a", text: "A" }, { id: "a", text: "Duplicate" }],
    }));
    assert.throws(() => store.upsertQuestion({
      topicId: f.topic.id, type: "short_text", prompt: "Fixture", correctAnswer: [],
    }));
    assert.equal(store.getQuestion(f.choice.id).prompt, "Fixture prompt");
  } finally { store.close(); }
});

test("objective grading is exact-set, active answers are redacted, and submission is idempotent", () => {
  const store = new Store(":memory:");
  try {
    const f = fixture(store);
    const multi = store.upsertQuestion({
      topicId: f.topic.id, type: "multiple_choice", prompt: "Multiple fixture",
      options: [{ id: "a", text: "A" }, { id: "b", text: "B" }, { id: "c", text: "C" }],
      correctAnswer: ["a", "c"],
    });
    const assessment = store.saveAssessment({
      courseId: f.course.id, title: "Fixture assessment", questionIds: [f.choice.id, multi.id],
    });
    const attempt = store.startAttempt(assessment.id);
    assert.equal(store.startAttempt(assessment.id).id, attempt.id);
    assert.equal("correctAnswer" in attempt.questions[0], false);
    assert.equal("explanation" in attempt.questions[0], false);
    assert.throws(() => store.results(attempt.id), /only after submission/);
    assert.throws(() => store.saveAnswer(attempt.id, { questionId: f.choice.id, value: ["missing"] }));
    assert.throws(() => store.saveAnswer(attempt.id, { questionId: multi.id, value: ["a", "a"] }));
    store.saveAnswer(attempt.id, { questionId: f.choice.id, value: ["b"] });
    store.saveAnswer(attempt.id, { questionId: multi.id, value: ["c", "a"] });
    const result = store.submitAttempt(attempt.id);
    assert.equal(result.percentage, 100);
    assert.equal(result.pendingReview, 0);
    assert.deepEqual(store.submitAttempt(attempt.id), result);
    assert.throws(() => store.saveAnswer(attempt.id, { questionId: f.choice.id, value: ["a"] }), /already been submitted/);
    assert.throws(() => store.gradeOpenAnswer({ attemptId: attempt.id, questionId: f.choice.id, score: 0, feedback: "No" }));
    const second = store.startAttempt(assessment.id);
    store.saveAnswer(second.id, { questionId: multi.id, value: ["a"] });
    assert.equal(store.submitAttempt(second.id).earned, 0);
  } finally { store.close(); }
});

test("question and assessment edits never rewrite active or historical snapshots", () => {
  const store = new Store(":memory:");
  try {
    const f = fixture(store);
    const assessment = store.saveAssessment({
      courseId: f.course.id, title: "Original title", questionIds: [f.choice.id],
    });
    const attempt = store.startAttempt(assessment.id);
    store.upsertQuestion({ ...f.choice, prompt: "Edited prompt", correctAnswer: ["a"], explanation: "Edited explanation" });
    store.saveAssessment({ ...assessment, title: "Edited title" }, assessment.id);
    store.saveAnswer(attempt.id, { questionId: f.choice.id, value: ["b"] });
    const result = store.submitAttempt(attempt.id);
    assert.equal(result.percentage, 100);
    assert.equal(result.title, "Original title");
    assert.equal(result.questions[0].prompt, "Fixture prompt");
    assert.equal(result.questions[0].explanation, "Original explanation");
    store.upsertQuestion({ ...f.choice, prompt: "Another edit" });
    assert.deepEqual(store.results(attempt.id), result);
    assert.equal(store.startAttempt(assessment.id).questions[0].prompt, "Another edit");
  } finally { store.close(); }
});

test("persisted deadlines expire without a browser and reject late writes", () => {
  const dir = mkdtempSync(join(tmpdir(), "learning-deadline-test-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    const f = fixture(store);
    assert.throws(() => store.saveAssessment({
      courseId: f.course.id, title: "Invalid exam", mode: "exam", questionIds: [f.choice.id],
    }));
    const a = store.saveAssessment({
      courseId: f.course.id, title: "Exam fixture", mode: "exam", durationMinutes: 1, questionIds: [f.choice.id],
    });
    const attempt = store.startAttempt(a.id);
    assert.ok(attempt.deadline);
    store.saveAnswer(attempt.id, { questionId: f.choice.id, value: ["b"] });
    const deadline = new Date(Date.now() - 5000).toISOString();
    store.db.prepare("UPDATE attempts SET deadline=? WHERE id=?").run(deadline, attempt.id);
    store.close(); store = new Store(path);
    assert.throws(() => store.saveAnswer(attempt.id, { questionId: f.choice.id, value: ["a"] }), /already been submitted/);
    const result = store.results(attempt.id);
    assert.equal(result.submitted_at, deadline);
    assert.equal(result.percentage, 100);
    assert.notEqual(store.startAttempt(a.id).id, attempt.id);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("complete learning workflow persists written reviews, feedback, priorities, and recommendations", () => {
  const dir = mkdtempSync(join(tmpdir(), "learning-workflow-test-"));
  const path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    const f = fixture(store);
    const topic2 = store.upsertTopic({ phaseId: f.phase.id, title: "Second fixture topic" });
    const lesson2 = store.upsertLesson({ topicId: topic2.id, title: "Next fixture lesson" });
    const written = (["short_text", "code_text", "predict_output"] as const).map((type) =>
      store.upsertQuestion({ topicId: topic2.id, type, prompt: `${type} fixture` }));
    const a = store.saveAssessment({
      courseId: f.course.id, title: "Workflow fixture", questionIds: [f.choice.id, ...written.map((q) => q.id)],
    });
    store.completeLesson(f.lesson.id, true);
    const attempt = store.startAttempt(a.id);
    store.saveAnswer(attempt.id, { questionId: f.choice.id, value: ["a"] });
    for (const q of written)
      store.saveAnswer(attempt.id, { questionId: q.id, value: "Stored only; never executed" });
    assert.equal(store.submitAttempt(attempt.id).pendingReview, 3);
    assert.equal(store.results(attempt.id).percentage, null);
    assert.equal(store.results(attempt.id).gradedPercentage, 0);
    assert.equal(store.topicPerformance(f.course.id).find((t) => t.topicId === topic2.id)?.percentage, null);
    for (const q of written)
      store.gradeOpenAnswer({ attemptId: attempt.id, questionId: q.id, score: 0.5, feedback: "Partial credit fixture" });
    assert.equal(store.results(attempt.id).earned, 1.5);
    assert.equal(store.results(attempt.id).percentage, 38);
    store.setFeedback({ courseId: f.course.id, attemptId: attempt.id, message: "Review fixture" });
    store.setPriority({ topicId: topic2.id, priority: 95 });
    store.recommend({ courseId: f.course.id, topicId: topic2.id, lessonId: lesson2.id, reason: "Recommendation fixture" });
    store.close(); store = new Store(path);
    const progress = store.progress(f.course.id);
    assert.equal(progress.completedLessons, 1);
    assert.equal(progress.recommendation?.lessonId, lesson2.id);
    assert.equal(progress.recommendation?.reason, "Recommendation fixture");
    assert.equal(progress.feedback[0].message, "Review fixture");
    assert.equal(progress.weakTopics.length, 2);
    assert.equal(store.getTopic(topic2.id).priority, 95);
    assert.equal(store.results(attempt.id).pendingReview, 0);
    assert.equal(store.studentAnswers(attempt.id).answers.length, 4);
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("explicit lesson assessment links preserve omitted updates and reject foreign-course links atomically", () => {
  const store = new Store(":memory:");
  try {
    const f = fixture(store), other = fixture(store);
    const assessment = store.saveAssessment({ courseId: f.course.id, title: "Linked exam", questionIds: [f.choice.id] });
    const foreign = store.saveAssessment({ courseId: other.course.id, title: "Foreign exam", questionIds: [other.choice.id] });
    store.upsertLesson({ ...f.lesson, topicId: f.topic.id, assessmentIds: [assessment.id] });
    assert.deepEqual(store.getLesson(f.lesson.id).assessmentIds, [assessment.id]);
    assert.deepEqual(store.structure(f.course.id).phases[0].topics[0].lessons[0].assessmentIds, [assessment.id]);
    store.upsertLesson({ id: f.lesson.id, topicId: f.topic.id, title: "Updated without replacing links" });
    assert.deepEqual(store.getLesson(f.lesson.id).assessmentIds, [assessment.id]);
    assert.throws(() => store.upsertLesson({
      id: f.lesson.id, topicId: f.topic.id, title: "Must not persist", assessmentIds: [foreign.id],
    }), /must belong/);
    assert.equal(store.getLesson(f.lesson.id).title, "Updated without replacing links");
    assert.deepEqual(store.getLesson(f.lesson.id).assessmentIds, [assessment.id]);
    store.upsertLesson({ id: f.lesson.id, topicId: f.topic.id, title: "Cleared", assessmentIds: [] });
    assert.deepEqual(store.getLesson(f.lesson.id).assessmentIds, []);
  } finally { store.close(); }
});

test("additive initialization preserves legacy courses, assessment snapshots, and completion", () => {
  const dir = mkdtempSync(join(tmpdir(), "learning-migration-test-")), path = join(dir, "test.sqlite");
  let store = new Store(path);
  try {
    const f = fixture(store);
    const a = store.saveAssessment({ courseId: f.course.id, title: "Existing exam", questionIds: [f.choice.id] });
    const attempt = store.startAttempt(a.id);
    store.saveAnswer(attempt.id, { questionId: f.choice.id, value: ["b"] });
    store.completeLesson(f.lesson.id, true);
    const result = store.submitAttempt(attempt.id);
    store.db.exec("DROP TABLE lesson_assessments");
    store.close(); store = new Store(path);
    assert.deepEqual(store.results(attempt.id), result);
    assert.equal(store.progress(f.course.id).completedLessons, 1);
    assert.deepEqual(store.getLesson(f.lesson.id).assessmentIds, []);
    assert.equal(store.getAssessment(a.id).title, "Existing exam");
  } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("written diagnostic resumes across connections and reviews never count pending answers as wrong", () => {
  const dir = mkdtempSync(join(tmpdir(), "learning-diagnostic-test-")), path = join(dir, "test.sqlite");
  const first = new Store(path), second = new Store(path);
  try {
    const f = fixture(first);
    const questions = Array.from({ length: 12 }, (_, i) => first.upsertQuestion({
      topicId: f.topic.id, prompt: `Written fixture ${i}`,
      type: (["short_text", "code_text", "predict_output"] as const)[i % 3],
    }));
    const a = first.saveAssessment({
      courseId: f.course.id, title: "Written diagnostic fixture", mode: "exam",
      durationMinutes: 35, questionIds: questions.map((q) => q.id),
    });
    const started = first.startAttempt(a.id);
    const duplicate = second.startAttempt(a.id);
    assert.equal(duplicate.id, started.id);
    assert.equal(duplicate.deadline, started.deadline);
    assert.equal(Date.parse(started.deadline!) - Date.parse(started.started_at), 35 * 60_000);
    const response = "  first line\n\tindented line\n\nlast line  ";
    first.saveAnswer(started.id, { questionId: questions[1].id, value: response });
    assert.equal(second.studentAttempt(started.id).answers[questions[1].id], response);
    const result = second.submitAttempt(started.id);
    assert.equal(result.percentage, null);
    assert.equal(result.gradedPercentage, null);
    assert.equal(result.pendingReview, 12);
    assert.equal(result.gradedCount, 0);
    assert.deepEqual(first.submitAttempt(started.id), result);
    assert.equal(first.progress(f.course.id).attempts[0].result?.percentage, null);
    assert.equal(first.topicPerformance(f.course.id)[0].needsPractice, false);
    assert.throws(() => first.saveAnswer(started.id, { questionId: questions[1].id, value: "changed" }), /already been submitted/);
    first.upsertQuestion({ ...questions[1], prompt: "Changed later" });
    const partial = first.gradeOpenAnswer({
      attemptId: started.id, questionId: questions[1].id, score: 0.5, feedback: "Partial credit",
    });
    assert.equal(partial.percentage, null);
    assert.equal(partial.gradedPercentage, 50);
    assert.equal(partial.gradedCount, 1);
    assert.equal(partial.pendingReview, 11);
    assert.equal(partial.questions[1].prompt, "Written fixture 1");
    assert.equal(partial.answers.find((answer) => answer.question_id === questions[1].id)?.value, response);
    assert.equal(second.topicPerformance(f.course.id)[0].percentage, 50);
    assert.equal(second.topicPerformance(f.course.id)[0].graded, 1);
    for (const q of questions.filter((q) => q.id !== questions[1].id))
      first.gradeOpenAnswer({ attemptId: started.id, questionId: q.id, score: 1, feedback: "Reviewed" });
    assert.equal(second.results(started.id).percentage, 96);
    assert.equal(second.results(started.id).pendingReview, 0);
  } finally { first.close(); second.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("local single-student access rejects nonexistent records and foreign attempt questions", () => {
  const store = new Store(":memory:");
  try {
    const f = fixture(store), other = fixture(store);
    store.setActiveCourse(other.course.id);
    const assessment = store.saveAssessment({ courseId: f.course.id, title: "Exam", questionIds: [f.choice.id] });
    const attempt = store.startAttempt(assessment.id);
    assert.equal(attempt.course_id, f.course.id);
    assert.throws(() => store.getCourse("missing"), /Not found/);
    assert.throws(() => store.studentAttempt("missing"), /Not found/);
    assert.throws(() => store.saveAnswer(attempt.id, { questionId: other.choice.id, value: ["b"] }), /not part of this attempt/);
    assert.throws(() => store.saveAnswer(attempt.id, { questionId: f.choice.id, value: "b" }), /valid, unique option IDs/);
    assert.deepEqual(store.studentAttempt(attempt.id).answers, {});
    assert.throws(() => store.setFeedback({ courseId: other.course.id, attemptId: attempt.id, message: "Wrong scope" }));
    assert.throws(() => store.gradeOpenAnswer({ attemptId: attempt.id, questionId: f.choice.id, score: 0.5, feedback: "Premature" }));
  } finally { store.close(); }
});

test("assessment changes are transactional and cross-course questions are rejected", () => {
  const store = new Store(":memory:");
  try {
    const f = fixture(store), other = fixture(store);
    const a = store.saveAssessment({ courseId: f.course.id, title: "Valid", questionIds: [f.choice.id] });
    assert.throws(() => store.saveAssessment({ ...a, title: "Invalid", questionIds: [f.choice.id, other.choice.id] }, a.id));
    assert.equal(store.getAssessment(a.id).title, "Valid");
    assert.deepEqual(store.getAssessment(a.id).questionIds, [f.choice.id]);
    assert.throws(() => store.saveAssessment({ ...a, questionIds: [f.choice.id, f.choice.id] }, a.id));
    assert.throws(() => store.recommend({ courseId: f.course.id, topicId: other.topic.id, reason: "Invalid" }));
    assert.throws(() => store.setFeedback({ courseId: f.course.id, topicId: other.topic.id, message: "Invalid" }));
  } finally { store.close(); }
});

test("moving a recommended lesson updates its recommendation atomically", () => {
  const store = new Store(":memory:");
  try {
    const f = fixture(store);
    const destination = store.upsertTopic({ phaseId: f.phase.id, title: "Destination" });
    store.recommend({ courseId: f.course.id, topicId: f.topic.id, lessonId: f.lesson.id, reason: "Fixture" });
    store.upsertLesson({ id: f.lesson.id, topicId: destination.id, title: f.lesson.title });
    assert.equal(store.progress(f.course.id).recommendation?.topicId, destination.id);
    assert.equal(store.progress(f.course.id).recommendation?.lessonId, f.lesson.id);
  } finally { store.close(); }
});
