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
  return db;
}
