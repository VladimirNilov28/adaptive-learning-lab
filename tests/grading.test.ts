import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/lib/store.js";
import {
  assertSafeLogic, checkBashConstraints, gradeQuestion, gradingConfigInput, gradingVersion,
  normalizeText, RuleValidationError,
} from "../src/lib/grading/index.js";

const withStore = (fn: (store: Store, path: string) => void) => {
  const dir = mkdtempSync(join(tmpdir(), "learning-grading-test-")), path = join(dir, "test.sqlite");
  const store = new Store(path);
  try { fn(store, path); } finally { store.close(); rmSync(dir, { recursive: true, force: true }); }
};

function base(store: Store) {
  const course = store.createCourse({ title: "Shell course" });
  const phase = store.upsertPhase({ courseId: course.id, title: "Phase" });
  const topic = store.upsertTopic({ phaseId: phase.id, title: "Files" });
  const lesson = store.upsertLesson({ topicId: topic.id, title: "Listing files" });
  return { course, phase, topic, lesson };
}

/** Grades a throwaway question without touching the database. */
const grade = (type: string, grading: unknown, value: string | string[] | null, extra: Record<string, unknown> = {}) =>
  gradeQuestion(
    { id: "q", type, options: [], difficulty: "medium", grading: gradingConfigInput.parse(grading), ...extra },
    value,
  );

test("every automatic strategy grades deterministically without executing anything", () => {
  assert.equal(grade("short_text", { strategy: "exact_match", expected: ["ls -la"] }, "ls -la").status, "correct");
  assert.equal(grade("short_text", { strategy: "exact_match", expected: ["ls -la"] }, "LS -LA").status, "incorrect");
  assert.equal(grade("short_text", { strategy: "exact_match", expected: ["ls -la"], caseSensitive: false }, "LS -la").status, "correct");

  assert.equal(grade("short_text", { strategy: "normalized_match", expected: ["chmod"] }, "  chmod\r\n").status, "correct");
  assert.equal(grade("short_text", {
    strategy: "normalized_match", expected: ["Read Write"], normalization: { ignoreCase: true, collapseWhitespace: true, trim: true },
  }, "read    write").status, "correct");

  assert.equal(grade("short_text", { strategy: "accepted_answers", accepted: ["cat", "less", "more"] }, "less").status, "correct");
  assert.equal(grade("short_text", { strategy: "accepted_answers", accepted: ["cat"] }, "head").status, "incorrect");

  assert.equal(grade("numeric", { strategy: "numeric", expected: 420 }, "420").status, "correct");
  assert.equal(grade("numeric", { strategy: "numeric", expected: 1000 }, "1,000").status, "correct");
  assert.equal(grade("numeric", { strategy: "numeric", expected: 3.14159, absoluteTolerance: 0.01 }, "3.14").status, "correct");
  assert.equal(grade("numeric", { strategy: "numeric", expected: 100, relativeTolerance: 0.05 }, "97").status, "correct");
  assert.equal(grade("numeric", { strategy: "numeric", expected: 100, relativeTolerance: 0.05 }, "80").status, "incorrect");
  assert.equal(grade("numeric", { strategy: "numeric", expected: 42 }, "forty-two").errorType, "syntax_error");

  const output = { strategy: "output_match", accepted: ["one\ntwo"] };
  assert.equal(grade("predict_output", output, "one\r\ntwo\n").status, "correct");
  assert.equal(grade("predict_output", output, "one two").status, "incorrect");
  assert.equal(grade("predict_output", output, "one two").errorType, "incorrect_output");

  const regex = { strategy: "regex_match", pattern: "chmod\\s+\\d{3}\\s+\\S+" };
  assert.equal(grade("code_text", regex, "chmod 644 notes.txt").status, "correct");
  assert.equal(grade("code_text", regex, "chmod notes.txt").status, "incorrect");
  assert.equal(grade("code_text", { ...regex, fullMatch: false }, "run chmod 644 notes.txt now").status, "correct");

  const rule = { strategy: "rule", logic: { and: [{ ">": [{ var: "lineCount" }, 1] }, { in: ["for", { var: "normalized" }] }] } };
  assert.equal(grade("code_text", rule, "for i in 1 2 3\ndo echo $i\ndone").status, "correct");
  assert.equal(grade("code_text", rule, "echo hi").status, "incorrect");

  assert.equal(grade("short_text", { strategy: "manual" }, "anything").status, "needs_review");
  assert.equal(grade("short_text", { strategy: "manual" }, "anything").score, null);
});

test("choice grading keeps exact-set behaviour and supports explicit partial credit", () => {
  const options = [{ id: "a", text: "a" }, { id: "b", text: "b" }, { id: "c", text: "c" }];
  const question = { id: "q", type: "multiple_choice", options, correctAnswer: ["a", "b"], difficulty: "easy" };
  const strict = { ...question, grading: gradingConfigInput.parse({ strategy: "multiple_choice" }) };
  assert.equal(gradeQuestion(strict, ["a", "b"]).status, "correct");
  assert.equal(gradeQuestion(strict, ["a"]).status, "incorrect");
  assert.equal(gradeQuestion(strict, ["a", "b", "c"]).status, "incorrect");

  const partial = { ...question, grading: gradingConfigInput.parse({ strategy: "multiple_choice", partialCredit: true, points: 2 }) };
  const half = gradeQuestion(partial, ["a"]);
  assert.equal(half.status, "partially_correct");
  assert.equal(half.awardedPoints, 1);
  assert.equal(half.maxPoints, 2);
  // Selecting everything must not pay: incorrect picks cancel the correct ones out.
  assert.equal(gradeQuestion(partial, ["a", "b", "c"]).awardedPoints, 1);
  const generous = { ...question, grading: gradingConfigInput.parse({ strategy: "multiple_choice", partialCredit: true, penalizeIncorrect: false }) };
  assert.equal(gradeQuestion(generous, ["a", "c"]).score, 0.5);
  assert.equal(gradeQuestion(strict, []).errorType, "incomplete_answer");
});

test("bash answers are analysed structurally and never executed", () => {
  const config = {
    strategy: "bash_structure",
    constraints: { command: ["ls"], exactFlags: ["-l", "-a"], positionalArguments: [] },
  };
  assert.equal(grade("code_text", config, "ls -la").status, "correct");
  assert.equal(grade("code_text", config, "ls -l -a").status, "correct");
  assert.match(grade("code_text", config, "ls -la").feedback, /not executed/);
  assert.equal(grade("code_text", config, "ls -l").status, "incorrect");
  assert.equal(grade("code_text", config, "ls -l").errorType, "incorrect_flag");
  assert.equal(grade("code_text", config, "dir -la").errorType, "incorrect_command");

  const pipeline = {
    strategy: "bash_structure",
    constraints: {
      pipeline: ["grep", "wc"], positionalArguments: ["error", "app.log"],
      exactFlags: ["-l"], allowExtraArguments: false,
    },
  };
  assert.equal(grade("code_text", pipeline, "grep error app.log | wc -l").status, "correct");
  assert.equal(grade("code_text", pipeline, "grep error app.log").status, "incorrect");

  const redirect = {
    strategy: "bash_structure",
    // The redirection target is not an operand, so it is not listed in positionalArguments.
    constraints: { command: ["echo"], exactFlags: [], positionalArguments: ["hi"], requiredRedirections: [">"] },
  };
  assert.equal(grade("code_text", redirect, "echo hi > out.txt").status, "correct");
  assert.equal(grade("code_text", redirect, "echo hi").errorType, "redirection_error");

  // Unbalanced quoting is objectively invalid shell, so it is a syntax error rather than a crash.
  const syntax = grade("code_text", {
    strategy: "bash_structure", constraints: { command: ["echo"], exactFlags: [], allowExtraArguments: true },
  }, 'echo "unterminated');
  assert.equal(syntax.status, "incorrect");
  assert.equal(syntax.errorType, "syntax_error");

  // Unrecognised alternatives can be routed to a human instead of being marked wrong.
  const lenient = {
    strategy: "bash_structure", onMismatch: "needs_review",
    constraints: { command: ["ls"], exactFlags: [], allowExtraArguments: true }, acceptedAnswers: ["dir"],
  };
  assert.equal(grade("code_text", lenient, "dir").status, "correct");
  assert.equal(grade("code_text", lenient, "find . -maxdepth 1").status, "needs_review");

  const analysis = checkBashConstraints("cat file.txt | grep -i warn | wc -l", { minPipeSegments: 3 });
  assert.deepEqual(analysis.analysis.commands, ["cat", "grep", "wc"]);
  assert.deepEqual(analysis.failures, []);
});

/**
 * Regression suite for the false positives reported by the AI instructor: the checker used to only
 * look for the presence of required tokens, so any answer that *also* contained something else
 * (an extra option, swapped operands, a second statement) scored full marks.
 */
test("strict bash constraints reject the reported false positives", () => {
  const grepN = {
    strategy: "bash_structure",
    constraints: {
      command: ["grep"], exactFlags: ["-n"],
      positionalArguments: ["ERROR", "app.log"], quotedArguments: ["ERROR"],
    },
  };
  const status = (answer: string) => grade("code_text", grepN, answer).status;

  assert.equal(status('grep -n "ERROR" app.log'), "correct");

  // 1. An extra option changes what the command does and must never be accepted.
  assert.equal(status('grep -nv "ERROR" app.log'), "incorrect");
  assert.equal(grade("code_text", grepN, 'grep -nv "ERROR" app.log').errorType, "incorrect_flag");
  assert.match(grade("code_text", grepN, 'grep -nv "ERROR" app.log').feedback, /Unexpected option\(s\): `-v`/);

  // 2. `grep -n PATTERN FILE` is not `grep -n FILE PATTERN`.
  assert.equal(status('grep -n app.log "ERROR"'), "incorrect");
  assert.match(grade("code_text", grepN, 'grep -n app.log "ERROR"').feedback, /Order matters/);

  // 3. Extra options plus an extra operand.
  assert.equal(status('grep -n -r -i "ERROR" app.log other.log'), "incorrect");

  // 4. A second statement smuggled in after a correct one.
  assert.equal(status('grep -n "ERROR" app.log; rm -rf /'), "incorrect");
  assert.equal(status('grep -n "ERROR" app.log && rm -rf /'), "incorrect");

  // Combined short options are equivalent to separate ones.
  assert.equal(status('grep -n "ERROR" app.log'), "correct");
  assert.equal(grade("code_text", {
    strategy: "bash_structure",
    constraints: { command: ["ls"], exactFlags: ["-l", "-a", "-h"], positionalArguments: [] },
  }, "ls -lah").status, "correct");
  assert.equal(grade("code_text", {
    strategy: "bash_structure",
    constraints: { command: ["ls"], exactFlags: ["-l", "-a"], positionalArguments: [] },
  }, "ls -lah").status, "incorrect");

  // Missing arguments, wrong file, wrong pattern.
  assert.equal(status("grep -n"), "incorrect");
  assert.equal(status('grep -n "ERROR" application.log'), "incorrect");
  assert.equal(status('grep -n "WARN" app.log'), "incorrect");

  // Quoting is only enforced where the instructor asked for it.
  assert.equal(status("grep -n ERROR app.log"), "incorrect");
  assert.equal(grade("code_text", {
    strategy: "bash_structure",
    constraints: { command: ["grep"], exactFlags: ["-n"], positionalArguments: ["ERROR", "app.log"] },
  }, "grep -n ERROR app.log").status, "correct");

  // Long options count only when the instructor declares them equivalent.
  assert.equal(status('grep --line-number "ERROR" app.log'), "incorrect");
  assert.equal(grade("code_text", {
    strategy: "bash_structure",
    constraints: {
      command: ["grep"], exactFlags: ["-n"], flagAliases: { "-n": ["--line-number"] },
      positionalArguments: ["ERROR", "app.log"],
    },
  }, 'grep --line-number "ERROR" app.log').status, "correct");
});

test("bash grading fails closed when it cannot establish correctness", () => {
  // A legacy, presence-only configuration: valid answers still pass...
  const legacy = {
    strategy: "bash_structure",
    constraints: {
      completeness: "open", command: ["grep"], requiredFlags: ["-n"], requiredArguments: ["ERROR", "app.log"],
    },
  };
  assert.equal(grade("code_text", legacy, 'grep -n "ERROR" app.log').status, "correct");
  // ...but anything the rules do not describe goes to a human instead of scoring a point.
  for (const answer of [
    'grep -nv "ERROR" app.log',
    'grep -n app.log "ERROR"',
    'grep -n -r -i "ERROR" app.log other.log',
    'grep -n "ERROR" app.log; rm -rf /',
    'grep -n "ERROR" app.log > found.txt',
  ]) {
    const result = grade("code_text", legacy, answer);
    assert.equal(result.status, "needs_review", answer);
    assert.equal(result.score, null, answer);
    // The feedback must never imply the answer was run.
    assert.match(result.feedback, /Nothing was executed/, answer);
  }

  // Unsupported shell constructs are unreviewable by code, not proof that the student is wrong.
  const strict = {
    strategy: "bash_structure",
    constraints: { command: ["grep"], exactFlags: ["-n"], positionalArguments: ["ERROR", "app.log"] },
  };
  for (const answer of [
    'grep -n "ERROR" $LOGFILE',
    "grep -n ERROR $(ls *.log)",
    "grep -n ERROR `ls`",
    "for f in *.log; do grep -n ERROR $f; done",
    "grep -n ERROR <(cat app.log)",
  ]) {
    const result = grade("code_text", strict, answer);
    assert.equal(result.status, "needs_review", answer);
    assert.match(result.feedback, /could not be graded automatically/, answer);
  }

  // A parser limitation must never be reported as a wrong answer.
  const unparsable = checkBashConstraints("grep -n ERROR $(", { command: ["grep"] });
  assert.equal(unparsable.failures.length, 0);
  assert.ok(unparsable.ambiguities.length > 0);
});

test("bash questions accept several valid command forms without regular expressions", () => {
  const countErrors = {
    strategy: "bash_structure",
    constraints: {
      command: ["grep"], exactFlags: ["-c"], positionalArguments: ["ERROR", "app.log"],
    },
    alternatives: [
      { pipeline: ["grep", "wc"], exactFlags: ["-l"], positionalArguments: ["ERROR", "app.log"] },
    ],
    acceptedAnswers: ["awk '/ERROR/ {n++} END {print n}' app.log"],
  };
  assert.equal(grade("code_text", countErrors, "grep -c ERROR app.log").status, "correct");
  assert.equal(grade("code_text", countErrors, "grep ERROR app.log | wc -l").status, "correct");
  assert.equal(grade("code_text", countErrors, "awk '/ERROR/ {n++} END {print n}' app.log").status, "correct");
  // The wrong way round through the pipeline is still wrong.
  assert.equal(grade("code_text", countErrors, "wc -l app.log | grep ERROR").status, "incorrect");
  assert.equal(grade("code_text", countErrors, "grep -cv ERROR app.log").status, "incorrect");

  // Flags that take a value are declared, so the value is not mistaken for an operand.
  const head = {
    strategy: "bash_structure",
    constraints: {
      command: ["grep"], exactFlags: ["-m"], flagsWithValues: ["-m"], requiredFlagValues: { "-m": "5" },
      positionalArguments: ["ERROR", "app.log"],
    },
  };
  assert.equal(grade("code_text", head, "grep -m 5 ERROR app.log").status, "correct");
  assert.equal(grade("code_text", head, "grep -m5 ERROR app.log").status, "correct");
  assert.equal(grade("code_text", head, "grep -m 10 ERROR app.log").status, "incorrect");

  // Order can be relaxed deliberately, but only when the instructor says so.
  const anyOrder = {
    strategy: "bash_structure",
    constraints: { command: ["cp"], exactFlags: [], positionalArguments: ["a.txt", "b.txt"], argumentOrder: "any" },
  };
  assert.equal(grade("code_text", anyOrder, "cp b.txt a.txt").status, "correct");
  assert.equal(grade("code_text", anyOrder, "cp a.txt c.txt").status, "incorrect");

  // Redirections are closed too: an unrequested one is a real difference in behaviour.
  const redirect = {
    strategy: "bash_structure",
    constraints: {
      command: ["sort"], exactFlags: [], positionalArguments: ["names.txt"], requiredRedirections: [">"],
    },
  };
  assert.equal(grade("code_text", redirect, "sort names.txt > sorted.txt").status, "correct");
  assert.equal(grade("code_text", redirect, "sort names.txt >> sorted.txt").status, "incorrect");
  assert.equal(grade("code_text", redirect, "sort names.txt > sorted.txt 2> err.txt").status, "incorrect");
});

test("invalid grading configurations are rejected before they can reach a student", () => {
  // Catastrophic backtracking.
  assert.throws(() => gradingConfigInput.parse({ strategy: "regex_match", pattern: "(a+)+$" }), /catastrophic backtracking/);
  // Stateful flags carry lastIndex between answers.
  assert.throws(() => gradingConfigInput.parse({ strategy: "regex_match", pattern: "abc", flags: "g" }), /i, m, s and u/);
  assert.throws(() => gradingConfigInput.parse({ strategy: "exact_match", expected: [] }));
  assert.throws(() => gradingConfigInput.parse({ strategy: "bash_structure", constraints: {} }), /at least one structural constraint/);
  assert.throws(() => gradingConfigInput.parse({
    strategy: "bash_structure",
    constraints: { command: ["ls"], exactFlags: [], allowExtraArguments: true, minPipeSegments: 3, maxPipeSegments: 2 },
  }), /cannot exceed/);
  // Positive-only constraints cannot disprove an answer, so they are refused with actionable advice.
  assert.throws(() => gradingConfigInput.parse({
    strategy: "bash_structure", constraints: { command: ["grep"], requiredFlags: ["-n"] },
  }), /exactFlags/);
  assert.throws(() => gradingConfigInput.parse({
    strategy: "bash_structure", constraints: { command: ["grep"], exactFlags: ["-n"], allowedFlags: ["-i"] },
  }), /not both/);
  assert.throws(() => gradingConfigInput.parse({
    strategy: "bash_structure",
    constraints: { command: ["grep"], exactFlags: ["-n"], positionalArguments: ["a"], requiredArguments: ["a"] },
  }), /not both/);
  // Flags must look like flags.
  assert.throws(() => gradingConfigInput.parse({
    strategy: "bash_structure", constraints: { command: ["grep"], exactFlags: ["n"], positionalArguments: [] },
  }), /must start with/);
  assert.throws(() => gradingConfigInput.parse({ strategy: "nonsense" }));
  assert.throws(() => gradingConfigInput.parse({ strategy: "numeric", expected: "ten" }));

  // json-logic is restricted to an explicit allowlist and a fixed fact set.
  assert.throws(() => assertSafeLogic({ log: "leak" }), RuleValidationError);
  assert.throws(() => assertSafeLogic({ "==": [{ var: "process" }, 1] }), /Unknown rule variable/);
  assert.throws(() => assertSafeLogic({ method: ["constructor"] }), /Unsupported grading operation/);
  const deep = Array.from({ length: 40 }).reduce<unknown>((inner) => ({ "!": inner }), true);
  assert.throws(() => assertSafeLogic(deep), /nested too deeply/);
  assert.throws(() => gradingConfigInput.parse({ strategy: "rule", logic: { log: 1 } }), /Unsupported grading operation/);
});

test("question validation ties grading configuration to the question type", () => withStore((store) => {
  const f = base(store);
  assert.throws(() => store.upsertQuestion({
    topicId: f.topic.id, type: "short_text", prompt: "p", grading: { strategy: "single_choice" },
  }), /requires a choice question/);
  assert.throws(() => store.upsertQuestion({
    topicId: f.topic.id, type: "single_choice", prompt: "p",
    options: [{ id: "a", text: "a" }, { id: "b", text: "b" }], correctAnswer: ["a"],
    grading: { strategy: "exact_match", expected: ["a"] },
  }), /not exact_match/);
  assert.throws(() => store.upsertQuestion({
    topicId: f.topic.id, type: "short_text", prompt: "p", hintPolicy: { afterFailedAttempts: 2 },
  }), /requires a hint/);
  assert.throws(() => store.upsertQuestion({
    topicId: f.topic.id, type: "numeric", prompt: "p", grading: { strategy: "exact_match", expected: ["1"] },
  }), /numeric, rule or manual/);
}));

test("lesson exercises grade instantly, enforce retry limits, and gate hints", () => withStore((store) => {
  const f = base(store);
  const question = store.upsertQuestion({
    topicId: f.topic.id, type: "code_text", prompt: "List all files including hidden ones",
    grading: {
      strategy: "bash_structure", points: 2,
      constraints: { command: ["ls"], exactFlags: ["-a"], positionalArguments: [] },
    },
    retryPolicy: { mode: "limited", maxAttempts: 3 },
    hint: "Hidden files start with a dot", hintPolicy: { afterFailedAttempts: 1 },
    explanation: "SECRET-EXPLANATION",
  });
  const section = store.upsertSection({ lessonId: f.lesson.id, kind: "exercise", title: "List", questionId: question.id });

  const before = store.studentLesson(f.lesson.id).sections.at(-1)!;
  assert.equal(before.grading?.strategy, "bash_structure");
  assert.equal(before.grading?.automatic, true);
  assert.equal(before.grading?.maxPoints, 2);
  assert.equal(before.grading?.attemptsRemaining, 3);
  assert.equal(before.grading?.hintAvailable, false);
  assert.equal(before.question?.hint, undefined);
  // The answer key itself is never serialised to the student, even in the grading summary.
  assert.equal(JSON.stringify(before).includes("exactFlags"), false);
  assert.equal(JSON.stringify(before).includes("SECRET-EXPLANATION"), false);

  const wrong = store.submitExercise(section.id, "ls", { durationMs: 4200 });
  assert.equal(wrong.latest?.status, "incorrect");
  assert.equal(wrong.latest?.awardedPoints, 0);
  assert.equal(wrong.latest?.errorType, "incorrect_flag");
  assert.equal(wrong.completed, false);
  assert.equal(wrong.grading?.attemptsRemaining, 2);
  assert.equal(wrong.grading?.hintAvailable, true);

  const hint = store.useHint(section.id);
  assert.equal(hint.hint, "Hidden files start with a dot");
  assert.equal(hint.grading.hintUsed, true);

  const right = store.submitExercise(section.id, "ls -a");
  assert.equal(right.latest?.status, "correct");
  assert.equal(right.latest?.awardedPoints, 2);
  assert.equal(right.completed, true);
  assert.equal(right.grading?.attemptsRemaining, 1);
  assert.equal(right.question?.explanation, "SECRET-EXPLANATION");

  store.submitExercise(section.id, "ls -a -l");
  assert.throws(() => store.submitExercise(section.id, "ls -a"), /attempts/);

  const single = store.upsertQuestion({
    topicId: f.topic.id, type: "short_text", prompt: "One shot",
    grading: { strategy: "accepted_answers", accepted: ["yes"] }, retryPolicy: { mode: "none" },
  });
  const oneShot = store.upsertSection({ lessonId: f.lesson.id, kind: "exercise", title: "Once", questionId: single.id });
  store.submitExercise(oneShot.id, "no");
  assert.throws(() => store.submitExercise(oneShot.id, "yes"), /single attempt/);
}));

test("analytics separate first-attempt from eventual mastery and never overstate a small sample", () => withStore((store) => {
  const f = base(store);
  const make = (prompt: string, accepted: string) => {
    const q = store.upsertQuestion({
      topicId: f.topic.id, type: "short_text", prompt,
      grading: { strategy: "accepted_answers", accepted: [accepted] }, difficulty: "easy",
    });
    return store.upsertSection({ lessonId: f.lesson.id, kind: "exercise", title: prompt, questionId: q.id });
  };
  const first = make("first", "alpha"), second = make("second", "beta");
  store.submitExercise(first.id, "wrong", { durationMs: 9000 });
  store.submitExercise(first.id, "alpha", { durationMs: 3000 });
  store.submitExercise(second.id, "beta", { durationMs: 1000 });

  const analytics = store.learningAnalytics({ courseId: f.course.id });
  assert.equal(analytics.totals.attempts, 3);
  assert.equal(analytics.totals.questionsSeen, 2);
  assert.equal(analytics.firstAttemptAccuracy.value, 0.5);
  assert.equal(analytics.firstAttemptAccuracy.sample, 2);
  assert.equal(analytics.firstAttemptAccuracy.lowSample, true, "two questions is not a mastery signal");
  assert.equal(analytics.eventualAccuracy.value, 1);
  assert.equal(analytics.totals.mastery, 1);
  assert.equal(analytics.trend.direction, "insufficient_data");
  assert.ok(analytics.notes.some((n) => n.includes("provisional")));

  const topic = store.topicAnalytics({ courseId: f.course.id, topicId: f.topic.id });
  assert.equal(topic.title, "Files");
  assert.equal(topic.averageAttemptsToSuccess.value, 1.5);
  assert.equal(topic.averageResponseMs.value, 4333);
  assert.equal(topic.byDifficulty.easy.attempts, 3);
  assert.equal(topic.hintUsageRate.value, 0);

  const recent = store.recentAttempts({ courseId: f.course.id, limit: 2 });
  assert.equal(recent.length, 2);
  assert.equal(recent[0].answer, "beta");
  assert.equal(recent[0].status, "correct");

  const mistakes = store.commonMistakes({ courseId: f.course.id });
  assert.equal(mistakes.wrongAttempts, 1);
  assert.equal(mistakes.byErrorType[0].count, 1);
  assert.deepEqual(mistakes.repeatedlyMissedQuestions, []);

  const filtered = store.recentAttempts({ courseId: f.course.id, status: "incorrect" });
  assert.equal(filtered.length, 1);
  assert.equal(filtered[0].answer, "wrong");
  assert.equal(store.recentAttempts({ courseId: f.course.id, source: "assessment" }).length, 0);
}));

test("manual answers wait for a human and are excluded from accuracy instead of counted wrong", () => withStore((store) => {
  const f = base(store);
  const q = store.upsertQuestion({ topicId: f.topic.id, type: "code_text", prompt: "Explain your approach" });
  const section = store.upsertSection({ lessonId: f.lesson.id, kind: "exercise", title: "Explain", questionId: q.id });
  const submitted = store.submitExercise(section.id, "I would use a loop.");
  assert.equal(submitted.latest?.status, "needs_review");
  assert.equal(submitted.grading?.automatic, false);
  assert.equal(submitted.completed, true);

  const pending = store.pendingReviews({ courseId: f.course.id });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].answer, "I would use a loop.");

  const analytics = store.learningAnalytics({ courseId: f.course.id });
  assert.equal(analytics.firstAttemptAccuracy.value, null, "a pending answer is not evidence either way");
  assert.equal(analytics.totals.pendingReview, 1);

  store.gradeExerciseSubmission({ submissionId: submitted.latest!.id, score: 0.5, feedback: "Right idea, add the edge case." });
  const reviewed = store.studentLesson(f.lesson.id).sections.at(-1)!;
  assert.equal(reviewed.latest?.status, "partially_correct");
  assert.equal(reviewed.latest?.awardedPoints, 0.5);
  assert.equal(store.pendingReviews({ courseId: f.course.id }).length, 0);
  assert.equal(store.learningAnalytics({ courseId: f.course.id }).firstAttemptAccuracy.value, 0);
}));

test("assessment answers are graded by the same engine and feed the same ledger", () => withStore((store) => {
  const f = base(store);
  const auto = store.upsertQuestion({
    topicId: f.topic.id, type: "short_text", prompt: "Which flag shows hidden files?",
    grading: { strategy: "accepted_answers", accepted: ["-a", "--all"], points: 3 },
  });
  const manual = store.upsertQuestion({ topicId: f.topic.id, type: "code_text", prompt: "Describe permissions" });
  const assessment = store.saveAssessment({ courseId: f.course.id, title: "Check", questionIds: [auto.id, manual.id] });
  const attempt = store.startAttempt(assessment.id);
  store.saveAnswer(attempt.id, { questionId: auto.id, value: "--all" });
  store.saveAnswer(attempt.id, { questionId: manual.id, value: "Owner, group, others." });
  const results = store.submitAttempt(attempt.id);

  assert.equal(results.earned, 3);
  assert.equal(results.total, 4);
  assert.equal(results.percentage, null, "a pending review means there is no final percentage yet");
  assert.equal(results.provisional, true);
  assert.equal(results.answers.find((a) => a.question_id === auto.id)!.result.status, "correct");
  assert.equal(results.answers.find((a) => a.question_id === manual.id)!.result.status, "needs_review");

  const attempts = store.recentAttempts({ courseId: f.course.id, source: "assessment" });
  assert.equal(attempts.length, 2);
  assert.equal(attempts.find((a) => a.questionId === auto.id)!.maxPoints, 3);
  const graded = store.gradeOpenAnswer({ attemptId: attempt.id, questionId: manual.id, score: 1, feedback: "Complete." });
  assert.equal(graded.percentage, 100);
  assert.equal(graded.earned, 4);
  assert.equal(store.topicPerformance(f.course.id)[0].percentage, 100);
}));

test("legacy questions keep their original grading and survive an engine upgrade", () => withStore((store, path) => {
  const f = base(store);
  const legacy = store.upsertQuestion({
    topicId: f.topic.id, type: "single_choice", prompt: "Pick one",
    options: [{ id: "a", text: "a" }, { id: "b", text: "b" }], correctAnswer: ["a"],
  });
  assert.equal(gradeQuestion({ ...legacy, grading: undefined }, ["a"]).strategy, "single_choice");
  assert.equal(gradeQuestion({ ...legacy, grading: undefined }, ["a"]).maxPoints, 1);
  const written = store.upsertQuestion({ topicId: f.topic.id, type: "short_text", prompt: "Explain" });
  assert.equal(gradeQuestion({ ...written, grading: undefined }, "anything").status, "needs_review");

  // The fingerprint changes only when the grading rules change.
  const key = gradingVersion(legacy);
  assert.equal(gradingVersion({ ...legacy, prompt: "Different prompt" } as typeof legacy), key);
  assert.notEqual(gradingVersion({ ...legacy, correctAnswer: ["b"] }), key);

  store.close();
  const reopened = new Store(path);
  try {
    assert.equal(reopened.getQuestion(legacy.id).prompt, "Pick one");
    assert.equal(reopened.learningAnalytics({ courseId: f.course.id }).totals.attempts, 0);
  } finally { reopened.close(); }
}));

test("normalization is opt-in and never silently rewrites a meaningful answer", () => {
  assert.equal(normalizeText("  a  b  ", {
    trim: false, ignoreCase: false, collapseWhitespace: false, normalizeLineEndings: false,
    ignoreTrailingNewline: false, trimLineEnds: false, ignoreBlankLines: false,
  }), "  a  b  ");
  assert.equal(normalizeText("a\r\nb", {
    trim: false, ignoreCase: false, collapseWhitespace: false, normalizeLineEndings: true,
    ignoreTrailingNewline: false, trimLineEnds: false, ignoreBlankLines: false,
  }), "a\nb");
  // Whitespace stays significant for predicted output unless the instructor opts out.
  assert.equal(grade("predict_output", { strategy: "output_match", accepted: ["a  b"] }, "a b").status, "incorrect");
});
