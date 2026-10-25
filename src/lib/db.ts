import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export function databasePath(root = process.cwd()) {
  const configured = process.env.LEARNING_DB_PATH;
  if (configured && !isAbsolute(configured))
    throw new Error("LEARNING_DB_PATH must be an absolute path");
  return configured ?? resolve(root, "data", "learning.sqlite");
}

export function openDatabase(path: string) {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.exec(`
    CREATE TABLE IF NOT EXISTS courses (
      id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS phases (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
      title TEXT NOT NULL, description TEXT NOT NULL, position INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS topics (
      id TEXT PRIMARY KEY, phase_id TEXT NOT NULL REFERENCES phases(id),
      title TEXT NOT NULL, description TEXT NOT NULL, position INTEGER NOT NULL,
      priority INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lessons (
      id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id),
      title TEXT NOT NULL, description TEXT NOT NULL, content TEXT NOT NULL, position INTEGER NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS questions (
      id TEXT PRIMARY KEY, topic_id TEXT NOT NULL REFERENCES topics(id),
      data_json TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessments (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
      title TEXT NOT NULL, description TEXT NOT NULL, mode TEXT NOT NULL,
      duration_minutes INTEGER, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS assessment_questions (
      assessment_id TEXT NOT NULL REFERENCES assessments(id),
      question_id TEXT NOT NULL REFERENCES questions(id), position INTEGER NOT NULL,
      PRIMARY KEY (assessment_id, question_id)
    );
    CREATE TABLE IF NOT EXISTS lesson_assessments (
      lesson_id TEXT NOT NULL REFERENCES lessons(id),
      assessment_id TEXT NOT NULL REFERENCES assessments(id), position INTEGER NOT NULL,
      PRIMARY KEY (lesson_id, assessment_id)
    );
    CREATE TABLE IF NOT EXISTS attempts (
      id TEXT PRIMARY KEY, assessment_id TEXT NOT NULL REFERENCES assessments(id),
      course_id TEXT NOT NULL REFERENCES courses(id), title TEXT NOT NULL, mode TEXT NOT NULL,
      started_at TEXT NOT NULL, deadline TEXT, submitted_at TEXT, questions_json TEXT NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS one_active_attempt
      ON attempts(assessment_id) WHERE submitted_at IS NULL;
    CREATE TABLE IF NOT EXISTS student_answers (
      attempt_id TEXT NOT NULL REFERENCES attempts(id), question_id TEXT NOT NULL,
      value_json TEXT NOT NULL, score REAL CHECK(score >= 0 AND score <= 1),
      feedback TEXT NOT NULL DEFAULT '', reviewed_at TEXT, updated_at TEXT NOT NULL,
      PRIMARY KEY(attempt_id, question_id)
    );
    CREATE TABLE IF NOT EXISTS lesson_completion (
      lesson_id TEXT PRIMARY KEY REFERENCES lessons(id), completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS instructor_feedback (
      id TEXT PRIMARY KEY, course_id TEXT NOT NULL REFERENCES courses(id),
      attempt_id TEXT REFERENCES attempts(id), topic_id TEXT REFERENCES topics(id),
      message TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS learning_recommendations (
      course_id TEXT PRIMARY KEY REFERENCES courses(id), topic_id TEXT NOT NULL REFERENCES topics(id),
      lesson_id TEXT REFERENCES lessons(id), reason TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lesson_sections (
      id TEXT PRIMARY KEY, lesson_id TEXT NOT NULL REFERENCES lessons(id), kind TEXT NOT NULL,
      title TEXT NOT NULL, content TEXT NOT NULL, question_id TEXT REFERENCES questions(id),
      position INTEGER NOT NULL, archived INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS section_progress (
      section_id TEXT PRIMARY KEY REFERENCES lesson_sections(id), completed_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exercise_submissions (
      id TEXT PRIMARY KEY, section_id TEXT NOT NULL REFERENCES lesson_sections(id),
      question_id TEXT NOT NULL, question_json TEXT NOT NULL, value_json TEXT NOT NULL,
      score REAL CHECK(score >= 0 AND score <= 1), feedback TEXT NOT NULL DEFAULT '',
      reviewed_at TEXT, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS exercise_hint_usage (
      section_id TEXT PRIMARY KEY REFERENCES lesson_sections(id),
      count INTEGER NOT NULL DEFAULT 0, first_used_at TEXT NOT NULL, updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS lesson_positions (
      lesson_id TEXT PRIMARY KEY REFERENCES lessons(id), section_id TEXT, updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS sections_parent ON lesson_sections(lesson_id, position);
    CREATE INDEX IF NOT EXISTS submissions_section ON exercise_submissions(section_id, created_at);
    CREATE INDEX IF NOT EXISTS phases_parent ON phases(course_id, position);
    CREATE INDEX IF NOT EXISTS topics_parent ON topics(phase_id, position);
    CREATE INDEX IF NOT EXISTS lessons_parent ON lessons(topic_id, position);
    CREATE INDEX IF NOT EXISTS attempts_course ON attempts(course_id, started_at);
  `);
  addAnalyticsColumns(db);
  createAnalyticsView(db);
  db.exec(`
    CREATE INDEX IF NOT EXISTS submissions_question ON exercise_submissions(question_id, created_at);
    CREATE INDEX IF NOT EXISTS submissions_topic ON exercise_submissions(topic_id, created_at);
    CREATE INDEX IF NOT EXISTS answers_question ON student_answers(question_id);
  `);
  return db;
}

/**
 * Grading and analytics columns are added in place so existing courses, questions, submissions,
 * attempts, reviews, and completion history survive every upgrade. Legacy rows keep NULLs and are
 * interpreted by `question_attempts` rather than being backfilled with invented data.
 */
const ANALYTICS_COLUMNS: Record<string, [string, string][]> = {
  exercise_submissions: [
    ["status", "TEXT"], ["awarded_points", "REAL"], ["max_points", "REAL"], ["error_type", "TEXT"],
    ["strategy", "TEXT"], ["grading_version", "TEXT"], ["explanation", "TEXT"], ["difficulty", "TEXT"],
    ["topic_id", "TEXT"], ["question_type", "TEXT"], ["attempt_number", "INTEGER"], ["duration_ms", "INTEGER"],
    ["hint_used", "INTEGER"], ["hint_count", "INTEGER"],
  ],
  student_answers: [
    ["status", "TEXT"], ["awarded_points", "REAL"], ["max_points", "REAL"], ["error_type", "TEXT"],
    ["strategy", "TEXT"], ["grading_version", "TEXT"], ["explanation", "TEXT"], ["difficulty", "TEXT"],
    ["topic_id", "TEXT"], ["question_type", "TEXT"],
  ],
};

function addAnalyticsColumns(db: Database.Database) {
  for (const [table, columns] of Object.entries(ANALYTICS_COLUMNS)) {
    const existing = new Set((db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).map((c) => c.name));
    if (!existing.size) continue;
    for (const [name, type] of columns)
      if (!existing.has(name)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${type}`);
  }
}

/**
 * One read-only ledger over both answer sources. Lesson exercises keep every retry as its own row;
 * assessment answers contribute one row per submitted attempt, so repeated attempts stay distinct.
 */
function createAnalyticsView(db: Database.Database) {
  const legacyStatus = (score: string) =>
    `CASE WHEN ${score} IS NULL THEN 'needs_review' WHEN ${score} >= 1 THEN 'correct'
       WHEN ${score} > 0 THEN 'partially_correct' ELSE 'incorrect' END`;
  db.exec(`
    DROP VIEW IF EXISTS question_attempts;
    CREATE VIEW question_attempts AS
    SELECT 'exercise' AS source, e.rowid AS sequence, e.id AS attempt_key, e.id AS submission_id, e.question_id,
      COALESCE(e.topic_id, l.topic_id) AS topic_id, t.phase_id AS phase_id, p.course_id AS course_id,
      s.lesson_id AS lesson_id, e.section_id AS section_id,
      NULL AS assessment_id, NULL AS assessment_attempt_id,
      e.value_json AS answer_json, e.created_at AS submitted_at,
      COALESCE(e.attempt_number, 1) AS attempt_number,
      COALESCE(e.strategy, 'legacy') AS strategy, COALESCE(e.grading_version, '') AS grading_version,
      COALESCE(e.status, ${legacyStatus("e.score")}) AS status,
      COALESCE(e.awarded_points, e.score, 0) AS awarded_points,
      COALESCE(e.max_points, 1) AS max_points, e.score AS score,
      COALESCE(e.difficulty, json_extract(e.question_json, '$.difficulty')) AS difficulty,
      COALESCE(e.question_type, json_extract(e.question_json, '$.type')) AS question_type,
      e.duration_ms AS duration_ms, COALESCE(e.hint_used, 0) AS hint_used, COALESCE(e.hint_count, 0) AS hint_count,
      COALESCE(e.error_type, 'unclassified') AS error_type,
      e.feedback AS feedback, COALESCE(e.explanation, '') AS explanation,
      CASE WHEN e.reviewed_at IS NOT NULL THEN 'reviewed' WHEN e.score IS NULL THEN 'pending' ELSE 'not_required' END AS review_status,
      e.reviewed_at AS reviewed_at
    FROM exercise_submissions e
      JOIN lesson_sections s ON s.id = e.section_id
      JOIN lessons l ON l.id = s.lesson_id
      JOIN topics t ON t.id = l.topic_id
      JOIN phases p ON p.id = t.phase_id
    UNION ALL
    SELECT 'assessment' AS source, sa.rowid AS sequence, a.id || ':' || sa.question_id AS attempt_key, NULL AS submission_id, sa.question_id,
      COALESCE(sa.topic_id, (SELECT json_extract(j.value, '$.topicId') FROM json_each(a.questions_json) j WHERE json_extract(j.value, '$.id') = sa.question_id)) AS topic_id, t.phase_id AS phase_id, a.course_id AS course_id,
      NULL AS lesson_id, NULL AS section_id,
      a.assessment_id AS assessment_id, a.id AS assessment_attempt_id,
      sa.value_json AS answer_json, COALESCE(a.submitted_at, sa.updated_at) AS submitted_at,
      (SELECT COUNT(*) FROM attempts prior WHERE prior.assessment_id = a.assessment_id
         AND prior.submitted_at IS NOT NULL AND prior.started_at <= a.started_at) AS attempt_number,
      COALESCE(sa.strategy, 'legacy') AS strategy, COALESCE(sa.grading_version, '') AS grading_version,
      COALESCE(sa.status, ${legacyStatus("sa.score")}) AS status,
      COALESCE(sa.awarded_points, sa.score, 0) AS awarded_points,
      COALESCE(sa.max_points, 1) AS max_points, sa.score AS score,
      COALESCE(sa.difficulty, (SELECT json_extract(j.value, '$.difficulty') FROM json_each(a.questions_json) j WHERE json_extract(j.value, '$.id') = sa.question_id)) AS difficulty,
      COALESCE(sa.question_type, (SELECT json_extract(j.value, '$.type') FROM json_each(a.questions_json) j WHERE json_extract(j.value, '$.id') = sa.question_id)) AS question_type,
      NULL AS duration_ms, 0 AS hint_used, 0 AS hint_count,
      COALESCE(sa.error_type, 'unclassified') AS error_type,
      sa.feedback AS feedback, COALESCE(sa.explanation, '') AS explanation,
      CASE WHEN sa.reviewed_at IS NOT NULL THEN 'reviewed' WHEN sa.score IS NULL THEN 'pending' ELSE 'not_required' END AS review_status,
      sa.reviewed_at AS reviewed_at
    FROM student_answers sa
      JOIN attempts a ON a.id = sa.attempt_id
      LEFT JOIN topics t ON t.id = COALESCE(sa.topic_id, (SELECT json_extract(j.value, '$.topicId') FROM json_each(a.questions_json) j WHERE json_extract(j.value, '$.id') = sa.question_id))
    WHERE a.submitted_at IS NOT NULL;
  `);
}
