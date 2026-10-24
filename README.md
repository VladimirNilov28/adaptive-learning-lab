# Adaptive Learning Lab

A single-student, local-first learning workspace. An **external MCP instructor** manages the curriculum; the Next.js app is for reading lessons, taking assessments, and viewing progress. No embedded AI, API keys, authentication, or preloaded educational content.

## Install and run

Use Node.js **22.13+ or 24 LTS** and npm. `better-sqlite3` is a native dependency; if a prebuilt binary is unavailable, install macOS Command Line Tools (`xcode-select --install`).

```sh
npm install
npm run dev
```

Open **http://127.0.0.1:3000**. Development and production servers bind to localhost only. Do not forward the port or expose the application publicly.

```sh
npm run build       # Compile dist/mcp.js and build the Next.js app
npm start           # Production web server, localhost:3000
npm run build:mcp   # Compile only the independent MCP server
npm run mcp         # Development STDIO server via tsx
npm run typecheck
npm test
```

`npm run mcp` waits for a client on stdin; it is not a web server. For a client connection, prefer launching the **compiled entry directly with Node**, as below. Do not launch `npm`, a shell wrapper, or `next` in the client's command field.

## Architecture and storage

- `src/app/`: Next.js App Router pages and a student-only API.
- `src/lib/`: Zod validation, idempotent SQLite schema, shared data-access layer.
- `src/mcp.ts` → `dist/mcp.js`: official MCP TypeScript SDK, **STDIO only**. Runs without Next.js.
- SQLite defaults to **`data/learning.sqlite` under the process working directory**, outside `.next` and `dist`. Both processes must use the same working directory or the same absolute `LEARNING_DB_PATH`.

An explicit **absolute** `LEARNING_DB_PATH` overrides the working-directory default. For example, run the web app with:

```sh
LEARNING_DB_PATH="/Users/mirlov/adaptive-learning-lab/data/learning.sqlite" npm run dev
```

Database initialization creates empty tables, never sample courses. Mutations commit immediately; visible web pages refresh every 10 seconds and on window focus. Reload to see changes immediately. SQLite WAL and a busy timeout support the two local processes. To back up, stop both processes and copy the database (including any remaining `-wal`/`-shm` files).

### Student assessment navigation

Use **Assessments** in the main navigation to browse all courses, or the course's **Assessments** link for its filtered list. Assessments also appear above the course outline on the dashboard and course overview. Open **View instructions** to see the question count and duration before explicitly starting; **Resume attempt** returns to the persisted active attempt without changing its deadline.

Lessons show actionable assessment links. Instructors can pass `assessmentIds: ["assessment-id"]` to `upsert_lesson` to associate existing assessments from the same course. Omitting `assessmentIds` preserves previous links; `[]` clears explicit associations. Unlinked lessons show **Course assessments**, so existing prose-only diagnostic instructions remain usable without editing old content or guessing associations from titles. Initialization adds only a join table; existing lessons, questions, answers, and attempts are preserved.

After submission, written answers show **Awaiting instructor review**, not an incorrect answer or final zero score. Reviewed points are labelled **Graded so far**; a final percentage appears only when every response has a grade. Results link to the recommended next lesson and update as the instructor supplies grades and feedback.

### Interactive lessons

Lessons keep their Markdown `content` (shown as the overview) and may add ordered **sections**: `introduction`, `objectives`, `theory`, `example`, `exercise`, `explanation`, `knowledge_check`, `summary`, `note`. Exercise and knowledge-check sections embed a question that students answer in place, with an optional hint, starter code, retry, and feedback. Choice questions are graded automatically. Written answers (`short_text`, `code_text`, `predict_output`, `find_bug`) are stored for instructor review and are **never executed**. Answer keys and explanations are only sent after the student's first submission.

The lesson page has a course sidebar (a collapsible menu on mobile), a section outline, previous/next links, and section progress. Sections count as read when the student scrolls past them or clicks **Mark as read**. A lesson completes automatically once every section is done. The last viewed section is saved, so the dashboard's **Continue learning** card and the lesson's **Continue where you left off** link resume there.

**Ask instructor** builds an editable question that includes the course, topic, lesson, and section titles and IDs, any selected text, and the exercise prompt. It never includes hints, keys, or explanations. **Copy question** places the text on the clipboard. **Open ChatGPT** only opens chatgpt.com: nothing is sent automatically, so paste the question yourself. The instructor can locate the section with `get_lesson`.

Markdown supports GFM tables, task lists, highlighted code with **Copy** buttons, and callouts (`> [!NOTE]`, `TIP`, `IMPORTANT`, `WARNING`, `CAUTION`). External links open in a new tab, and raw HTML is not rendered.

## ChatGPT Desktop on macOS: custom STDIO MCP

These instructions target the **Settings → Plugins → MCPs → Add custom MCP** dialog specified for your Desktop client. Availability and labels depend on the installed client version; if it does not offer custom **STDIO** MCPs, use a compatible local MCP client instead. A browser ChatGPT session does **not** automatically gain access to this server. No HTTP MCP endpoint, tunnel, reverse proxy, or authentication is provided.

First run `npm run build:mcp` in this project. Find the absolute Node executable:

```sh
node -p 'process.execPath'
```

Fill the fields as follows. Replace the Node path with the exact output above, and replace the project path if your checkout is elsewhere.

| Field | Value |
|---|---|
| **Name** | `Adaptive Learning Lab` |
| **Type** | `STDIO` |
| **Command to launch** | `/Users/mirlov/.nvm/versions/node/v24.22.1/bin/node` (the absolute executable on this machine; replace with your `process.execPath` output) |
| **Arguments** | One argument: `/Users/mirlov/adaptive-learning-lab/dist/mcp.js` |
| **Environment variables** | `LEARNING_DB_PATH` = `/Users/mirlov/adaptive-learning-lab/data/learning.sqlite` |
| **Working directory** | `/Users/mirlov/adaptive-learning-lab` |

If Arguments uses an array editor, enter `["/Users/mirlov/adaptive-learning-lab/dist/mcp.js"]`. If it uses one row per argument, add one row with that path. If Environment variables uses JSON, enter `{"LEARNING_DB_PATH":"/Users/mirlov/adaptive-learning-lab/data/learning.sqlite"}`. Enter paths as field values, not shell commands; do not add literal quotation marks around a single path.

Save/enable the MCP and connect/reconnect it. The client launches its own server process; you do not also need `npm run mcp` in a terminal. The web app can start before or after the MCP server. Rebuild and reconnect the MCP after changing its source.

Equivalent configuration for a client that accepts a `mcpServers` JSON object (some clients call `cwd` “Working directory”):

```json
{
  "mcpServers": {
    "adaptive-learning-lab": {
      "command": "/Users/mirlov/.nvm/versions/node/v24.22.1/bin/node",
      "args": ["/Users/mirlov/adaptive-learning-lab/dist/mcp.js"],
      "cwd": "/Users/mirlov/adaptive-learning-lab",
      "env": {
        "LEARNING_DB_PATH": "/Users/mirlov/adaptive-learning-lab/data/learning.sqlite"
      }
    }
  }
}
```

The compiled entry uses normal Node.js, not a global `tsx` installation or the shell's PATH. All protocol messages go to stdout through the SDK; startup/errors go to stderr. If tools are not discovered, check the client's stderr logs, absolute paths, Node version, and database permissions. Use an explicit database path to avoid accidentally opening separate databases.

## Instructor tools

All tools validate Zod inputs and return JSON text plus `structuredContent: { result: ... }`. Validation/storage failures are MCP tool errors. IDs are returned by creation tools. No source-code edits are needed to manage content.

| Tools | Purpose |
|---|---|
| `list_courses`, `get_course_structure` | Discover courses and full ordered curriculum |
| `create_course`, `update_course` | Create and edit course metadata |
| `upsert_phase`, `upsert_topic`, `upsert_lesson` | Create or replace curriculum content |
| `reorder_content` | Reorder all siblings under a parent |
| `upsert_question` | Create/update questions and answer keys (optional `hint`, `starterCode`, `language`) |
| `get_lesson` | Lesson with all sections, full questions, completion, submission counts, and the student's last position |
| `upsert_lesson_section` | Create/update/archive a lesson section; exercises reference a `questionId` from the same course |
| `get_exercise_submissions` | Exercise submissions filtered by course/lesson/section and status (`pending_review`, `incorrect`, `reviewed`) |
| `grade_exercise_submission` | Score (0–1) and feedback for a written exercise submission |
| `create_assessment`, `update_assessment`, `list_assessments`, `get_assessment` | Manage assessments and instructor question details |
| `get_student_progress`, `get_assessment_results`, `get_student_answers`, `get_topic_performance` | Inspect progress, attempt IDs, answers, and topic performance |
| `set_instructor_feedback`, `grade_open_answer` | Append feedback and grade submitted written answers |
| `set_learning_priority`, `recommend_next_topic` | Adapt topic priority and recommend a topic/lesson |

Curriculum creation order: course → phase (`courseId`) → topic (`phaseId`) → lesson/question (`topicId`) → assessment (`courseId`, ordered `questionIds`). Use returned IDs for later calls. Positions are zero-based. Upserts omit `id` for creation; supply an existing `id` to replace fields. Omitted optional fields take their schema defaults, so send all fields you want to preserve. `update_course` is a partial update; `update_assessment` replaces the definition.

Topics may move between phases and lessons between topics in the same course. Cross-course moves and changing a question's topic are rejected to keep historical associations sound. `reorder_content` takes `kind` (`phase`, `topic`, `lesson`, or `section`), `parentId`, and `ids` containing every sibling exactly once.

Question types:

- `single_choice`: at least two `options: [{id, text}]`; `correctAnswer: ["option-id"]`.
- `multiple_choice`: same options shape; `correctAnswer` contains all correct IDs. Exact-set grading, no partial automatic credit.
- `short_text`, `code_text`, `predict_output`, `find_bug`: omit options and correctAnswer. Responses are stored for instructor review, never executed.

Questions have `prompt`, `explanation`, and `difficulty` (`easy`, `medium`, `hard`). Prompts and lessons support Markdown with highlighted fenced code. Raw HTML is not rendered.

Assessments use `mode: "practice" | "exam"`; exams require `durationMinutes` (1–1440). Practice may be untimed or timed. Each question is worth one point. `grade_open_answer` accepts `attemptId`, `questionId`, `score` (0–1, including partial credit), and required `feedback`. Results and MCP progress return `percentage: null` until every written answer is reviewed; `gradedCount`, `gradedPercentage`, and `earned` describe only completed grading. Topic performance uses graded answers across all submitted attempts; below 70% is a weak area. Unreviewed responses are not treated as topic failures.

`set_learning_priority` accepts `topicId` and `priority` (0–100, higher first). `recommend_next_topic` takes `courseId`, `topicId`, optional `lessonId`, and a student-visible `reason`; it overrides automatic recommendations until replaced. Otherwise recommendations prioritize unfinished topics by instructor priority, weak areas, then curriculum order.

Lesson sections: `upsert_lesson_section` takes `lessonId`, `kind`, `title`, Markdown `content`, `position`, `questionId` (required for `exercise`/`knowledge_check`, forbidden otherwise), and `archived`. Archive a section instead of deleting it so that past submissions remain. Each exercise submission stores a snapshot of the question, so later edits don't change historical grading. `get_student_progress` also returns `lastPosition`, per-lesson section progress, an `exercises` summary, and `strugglingExercises` (repeated or unresolved incorrect answers). Topic performance still counts assessment answers only.

## Verify the full integration

```sh
npm run typecheck
npm test
npm run build
npm run smoke:mcp
npx playwright install chromium  # One-time setup for browser verification
npm run smoke:browser
```

The smoke test launches the **absolute Node executable + compiled MCP entry** through the official SDK client. It discovers all 25 tools, creates a temporary fixture course through STDIO, reads it back, launches a local production web server, and verifies that the course and highlighted lesson appear. It then saves/submits student answers through the student API, checks redaction and local-origin protection, retrieves/reviews results through MCP, updates recommendations, and restarts both processes to check persistence.

Both smoke commands use an isolated temporary SQLite file, an available localhost port, and stop their processes and remove fixture data afterward. **Your existing database is not modified.** `smoke:browser` adds a headless Chromium check of real student navigation, all five question inputs, save failure/retry, whitespace preservation, refresh/resume, unanswered-question confirmation, pending and partial reviews, immutable snapshots, deadline expiry, mobile navigation, and a guided lesson (sections, exercise retry, hint, reset, Ask instructor, and resume). It accelerates expiry by changing only the temporary fixture deadline. No live ChatGPT session is required.

For a manual check in your configured Desktop client, ask the instructor to call `list_courses`, create a course and hierarchy with the tools, and read `get_course_structure`. Open/reload the web dashboard and the lesson. Take an assessment, then ask the instructor to retrieve `get_student_progress` (for the attempt ID), `get_assessment_results`, grade written responses, and set a recommendation. Reload the dashboard/progress page to see the feedback loop.

## Restarting after an update

Database changes only add tables (`lesson_sections`, `section_progress`, `exercise_submissions`, `lesson_positions`), which are created automatically on first start. Existing data is untouched.

1. Stop the web app, then run `npm run build` (this also compiles `dist/mcp.js`) and `npm run start` (or `npm run dev`).
2. In ChatGPT Desktop, disable and re-enable, or remove and re-add, the MCP server in ChatGPT Desktop so that it relaunches `dist/mcp.js` and discovers the 25 tools.

## Reliability and MVP limits

- Questions, keys, topic IDs, assessment title, and deadline are snapshotted at **attempt start**. Subsequent edits never rewrite existing answers or grading. Student writes to completed attempts are blocked; instructor reviews explicitly update only grading/feedback.
- One active attempt per assessment; starting again resumes it. Submission is transactional and idempotent, so retries cannot duplicate results.
- A persisted UTC deadline is enforced server-side. The active page counts down, saves answers after a short debounce, polls the server, and submits at expiry. If every process/browser is closed, expired attempts are finalized on the next attempt/progress/results access; no always-running scheduler is required. The deadline does not reset on restart.
- Answers are acknowledged when saved. Question navigation and explicit submission wait for pending writes; blur, page hiding, and leaving the attempt flush pending edits. Wait for “All changes saved” before closing the tab; failed writes show errors and can be retried. A crash, offline browser, or deadline can still prevent the last unsaved keystrokes from reaching the server.
- Student payloads omit keys, explanations, and grading before submission. Result pages reveal them only afterward. Local Host and same-Origin checks protect mutations, but this is **not** a hardened network service or a locked-down/proctored exam browser. A user with local filesystem/MCP access can inspect instructor data.
- There are no accounts, enrollment gates, or active-course access restrictions: the single local student can access every course. APIs reject missing records, questions outside the target attempt, and student attempts to invoke instructor-only operations. Instructor content associations are restricted to the same course.
- No deletion UI, content editor, student accounts, AI grading, code execution, calendar locks, or external infrastructure. Feedback is plain text. Lessons/questions are Markdown. Large courses use straightforward synchronous local queries rather than an analytics system.