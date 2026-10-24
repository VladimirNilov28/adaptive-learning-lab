import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store.js";

function setup(store: Store) {
  const course = store.createCourse({ title: "Structured course" });
  const phase = store.upsertPhase({ courseId: course.id, title: "Phase" });
  const topic = store.upsertTopic({ phaseId: phase.id, title: "Topic" });
  const lesson = store.upsertLesson({ topicId: topic.id, title: "Guided lesson" });
  const choice = store.upsertQuestion({
    topicId: topic.id, type: "multiple_choice", prompt: "Pick the even numbers",
    options: [{ id: "a", text: "2" }, { id: "b", text: "3" }, { id: "c", text: "4" }],
    correctAnswer: ["a", "c"], explanation: "SECRET-EXPLANATION", hint: "Divisible by two",
  });
  const bug = store.upsertQuestion({
    topicId: topic.id, type: "find_bug", prompt: "Fix the loop", starterCode: "for i in range(10)\n  print(i)",
    language: "python", explanation: "Missing colon", hint: "Look at the end of line 1",
  });
  const intro = store.upsertSection({ lessonId: lesson.id, kind: "introduction", title: "Intro", content: "Welcome", position: 0 });
  const theory = store.upsertSection({ lessonId: lesson.id, kind: "theory", title: "Theory", content: "```bash\nls -la\n```", position: 1 });
  const ex = store.upsertSection({ lessonId: lesson.id, kind: "exercise", title: "Evens", questionId: choice.id, position: 2 });
  const fix = store.upsertSection({ lessonId: lesson.id, kind: "exercise", title: "Debug", questionId: bug.id, position: 3 });
  return { course, phase, topic, lesson, choice, bug, intro, theory, ex, fix };
}
const withStore = (fn: (store: Store, path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "learning-lesson-test-")), path = join(dir, "test.sqlite");
  const store = new Store(path);
  try { fn(store, path); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
};

test("structured lessons: ordered sections, validation, reordering, and archiving", () => withStore((store) => {
  const f = setup(store);
  assert.deepEqual(store.studentLesson(f.lesson.id).sections.map((s) => s.title), ["Intro", "Theory", "Evens", "Debug"]);
  assert.throws(() => store.upsertSection({ lessonId: f.lesson.id, kind: "exercise", title: "No question" }), /require questionId/);
  assert.throws(() => store.upsertSection({ lessonId: f.lesson.id, kind: "theory", questionId: f.choice.id }), /Only exercise/);
  const other = store.upsertLesson({ topicId: f.topic.id, title: "Other" });
  assert.throws(() => store.upsertSection({ id: f.intro.id, lessonId: other.id, kind: "introduction" }), /cannot move/);
  const foreign = store.createCourse({ title: "Foreign" });
  const fp = store.upsertPhase({ courseId: foreign.id, title: "P" });
  const ft = store.upsertTopic({ phaseId: fp.id, title: "T" });
  const fq = store.upsertQuestion({ topicId: ft.id, type: "short_text", prompt: "Q" });
  assert.throws(() => store.upsertSection({ lessonId: f.lesson.id, kind: "exercise", questionId: fq.id }), /same course|lesson's course/);
  assert.throws(() => store.reorder({ kind: "section", parentId: f.lesson.id, ids: [f.intro.id] }), /every sibling/);
  store.reorder({ kind: "section", parentId: f.lesson.id, ids: [f.theory.id, f.intro.id, f.ex.id, f.fix.id] });
  assert.deepEqual(store.studentLesson(f.lesson.id).sections.map((s) => s.title), ["Theory", "Intro", "Evens", "Debug"]);
  store.upsertSection({ ...f.intro, lessonId: f.lesson.id, archived: true, questionId: null });
  assert.equal(store.studentLesson(f.lesson.id).sections.length, 3);
  assert.equal(store.instructorLesson(f.lesson.id).sections.length, 4);
  const structure = store.structure(f.course.id).phases[0].topics[0].lessons[0];
  assert.equal(structure.sectionCount, 3);
}));

test("student lesson payload hides keys and explanations until an answer is submitted", () => withStore((store) => {
  const f = setup(store);
  const before = JSON.stringify(store.studentLesson(f.lesson.id));
  assert.ok(!before.includes("SECRET-EXPLANATION"));
  assert.ok(!before.includes("correctAnswer"));
  assert.ok(before.includes("Divisible by two"), "lesson hints are available on request");
  const exam = store.saveAssessment({ courseId: f.course.id, title: "Exam", mode: "exam", durationMinutes: 5, questionIds: [f.choice.id] });
  const attempt = JSON.stringify(store.startAttempt(exam.id));
  assert.ok(!attempt.includes("Divisible by two") && !attempt.includes("SECRET") && !attempt.includes("correctAnswer"),
    "assessments never expose hints, keys, or explanations before submission");
  const after = store.submitExercise(f.ex.id, ["a"]);
  assert.equal(after.question?.explanation, "SECRET-EXPLANATION");
}));

test("exercise grading reuses objective grading, allows retries, and completes sections", () => withStore((store) => {
  const f = setup(store);
  assert.throws(() => store.submitExercise(f.ex.id, []), /Provide an answer/);
  assert.throws(() => store.submitExercise(f.ex.id, ["z"]), /valid, unique option IDs/);
  assert.throws(() => store.submitExercise(f.fix.id, ["a"]), /text response/);
  assert.throws(() => store.submitExercise(f.theory.id, "x"), /no active exercise/);
  const wrong = store.submitExercise(f.ex.id, ["a"]);
  assert.equal(wrong.latest?.score, 0);
  assert.equal(wrong.completed, false);
  const right = store.submitExercise(f.ex.id, ["c", "a"]);
  assert.equal(right.latest?.score, 1);
  assert.equal(right.completed, true);
  assert.equal(right.submissions, 2);
  const progress = store.progress(f.course.id);
  assert.equal(progress.exercises.incorrectSubmissions, 1);
  assert.equal(progress.exercises.completed, 1);
  assert.deepEqual(progress.strugglingExercises, [], "a solved exercise with one miss is not flagged");
  store.submitExercise(f.ex.id, ["b"]); // regress after solving: twice wrong is flagged
  assert.equal(store.progress(f.course.id).strugglingExercises[0].sectionId, f.ex.id);
  assert.throws(() => store.completeSection(f.ex.id, true), /Submit an answer/);
}));

test("written exercises await instructor review with partial credit; snapshots survive question edits", () => withStore((store) => {
  const f = setup(store);
  const submitted = store.submitExercise(f.fix.id, "for i in range(10):\n  print(i)");
  assert.equal(submitted.latest?.score, null);
  assert.equal(submitted.completed, true, "a written submission completes the section");
  const pending = store.exerciseSubmissions({ courseId: f.course.id, status: "pending_review" });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].status, "pending_review");
  assert.equal(pending[0].lessonId, f.lesson.id);
  store.upsertQuestion({ ...f.bug, prompt: "EDITED prompt" });
  const graded = store.gradeExerciseSubmission({ submissionId: pending[0].id, score: 0.5, feedback: "Close; explain why." });
  assert.equal(graded.status, "partially_correct");
  assert.equal(graded.question.prompt, "Fix the loop", "review uses the frozen snapshot");
  assert.equal(store.studentLesson(f.lesson.id).sections.find((s) => s.id === f.fix.id)?.latest?.feedback, "Close; explain why.");
  assert.equal(store.exerciseSubmissions({ status: "pending_review" }).length, 0);
  assert.throws(() => store.gradeExerciseSubmission({ submissionId: pending[0].id, score: 2, feedback: "x" }));
  const choiceSub = store.submitExercise(f.ex.id, ["a"]);
  assert.throws(() => store.gradeExerciseSubmission({ submissionId: choiceSub.latest!.id, score: 1, feedback: "x" }), /automatically/);
}));

test("section completion, lesson auto-completion, and resume position persist across restarts", () => withStore((store, path) => {
  const f = setup(store);
  store.completeSection(f.intro.id, true);
  store.completeSection(f.theory.id, true);
  store.setPosition(f.lesson.id, f.theory.id);
  assert.throws(() => store.setPosition(f.lesson.id, "missing"), /Not found/);
  store.submitExercise(f.ex.id, ["a", "c"]);
  assert.equal(store.progress(f.course.id).completedLessons, 0);
  store.submitExercise(f.fix.id, "answer");
  store.close();
  const reopened = new Store(path);
  try {
    const p = reopened.progress(f.course.id);
    assert.equal(p.completedLessons, 1, "completing every section completes the lesson");
    assert.equal(p.lessonProgress[0].sectionsCompleted, 4);
    assert.equal(p.lastPosition?.sectionId, f.fix.id, "latest exercise becomes the resume point");
    assert.equal(reopened.studentLesson(f.lesson.id).lastSectionId, f.fix.id);
    reopened.completeSection(f.intro.id, false);
    assert.equal(reopened.studentLesson(f.lesson.id).sections.find((s) => s.id === f.intro.id)?.completed, false);
  } finally { reopened.close(); }
}));

test("legacy Markdown-only lessons keep working and new tables are added without data loss", () => withStore((store, path) => {
  const course = store.createCourse({ title: "Legacy" });
  const phase = store.upsertPhase({ courseId: course.id, title: "P" });
  const topic = store.upsertTopic({ phaseId: phase.id, title: "T" });
  const lesson = store.upsertLesson({ topicId: topic.id, title: "Old", content: "# Old content" });
  store.completeLesson(lesson.id, true);
  for (const table of ["exercise_submissions", "section_progress", "lesson_positions", "lesson_sections"])
    store.db.exec(`DROP TABLE ${table}`);
  store.close();
  const reopened = new Store(path);
  try {
    const view = reopened.studentLesson(lesson.id);
    assert.equal(view.content, "# Old content");
    assert.deepEqual(view.sections, []);
    assert.equal(reopened.progress(course.id).completedLessons, 1);
    assert.equal(reopened.progress(course.id).lastPosition, null);
  } finally { reopened.close(); }
}));
