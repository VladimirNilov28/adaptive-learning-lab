import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import { Store } from "../src/lib/store.js";

test("compiled STDIO server discovers read/write tools and works without Next.js from another cwd", async () => {
  const dir = mkdtempSync(join(tmpdir(), "learning-mcp-test-"));
  const entry = fileURLToPath(new URL("../dist/mcp.js", import.meta.url));
  const transport = new StdioClientTransport({
    command: process.execPath, args: [entry], cwd: dir, stderr: "pipe",
    env: { ...process.env, LEARNING_DB_PATH: join(dir, "shared.sqlite") },
  });
  let diagnostics = "";
  transport.stderr?.on("data", (chunk: Buffer) => { diagnostics += chunk.toString(); });
  const client = new Client({ name: "learning-test", version: "1.0.0" });
  try {
    await client.connect(transport);
    const { tools } = await client.listTools();
    const expected = [
      "list_courses", "get_course_structure", "create_course", "update_course", "upsert_phase",
      "upsert_topic", "upsert_lesson", "reorder_content", "upsert_question", "create_assessment",
      "update_assessment", "list_assessments", "get_assessment", "get_student_progress",
      "get_assessment_results", "get_student_answers", "get_topic_performance",
      "set_instructor_feedback", "grade_open_answer", "set_learning_priority", "recommend_next_topic",
      "get_lesson", "upsert_lesson_section", "get_exercise_submissions", "grade_exercise_submission",
      "validate_grading_config", "get_learning_analytics", "get_topic_analytics", "get_recent_attempts",
      "get_common_mistakes", "get_pending_reviews",
    ];
    assert.deepEqual(tools.map((t) => t.name).sort(), expected.sort());
    const created = await client.callTool({ name: "create_course", arguments: { title: "STDIO fixture" } });
    assert.ok(!created.isError);
    const { result: course } = z.object({ result: z.object({ id: z.string(), title: z.string() }) }).parse(created.structuredContent);
    assert.equal(course.title, "STDIO fixture");
    const structure = await client.callTool({ name: "get_course_structure", arguments: { courseId: course.id } });
    assert.equal(z.object({ result: z.object({ title: z.string() }) }).parse(structure.structuredContent).result.title, "STDIO fixture");
    const invalid = await client.callTool({ name: "create_course", arguments: { title: "" } });
    assert.equal(invalid.isError, true);
    assert.match(diagnostics, /MCP ready/);

    const call = async (name: string, args: Record<string, unknown>) => {
      const response = await client.callTool({ name, arguments: args });
      assert.ok(!response.isError, `${name}: ${JSON.stringify(response.content)}`);
      return z.object({ result: z.any() }).parse(response.structuredContent).result;
    };
    const phase = await call("upsert_phase", { courseId: course.id, title: "Phase" });
    const topic = await call("upsert_topic", { phaseId: phase.id, title: "Topic" });
    const lesson = await call("upsert_lesson", { topicId: topic.id, title: "Structured lesson" });
    const question = await call("upsert_question", { topicId: topic.id, type: "code_text", prompt: "List all files",
      hint: "Hidden files too", starterCode: "ls", language: "bash" });
    const theory = await call("upsert_lesson_section", { lessonId: lesson.id, kind: "theory", title: "Listing",
      content: "Use `ls`.\n\n```bash\nls -la\n```", position: 0 });
    const exercise = await call("upsert_lesson_section", { lessonId: lesson.id, kind: "exercise", title: "Try it",
      questionId: question.id, position: 1 });
    await call("reorder_content", { kind: "section", parentId: lesson.id, ids: [exercise.id, theory.id] });
    const badSection = await client.callTool({ name: "upsert_lesson_section", arguments: { lessonId: lesson.id, kind: "exercise" } });
    assert.equal(badSection.isError, true);

    // Student activity through the shared database (as the web app does), then instructor review via MCP.
    const student = new Store(join(dir, "shared.sqlite"));
    try {
      assert.deepEqual(student.studentLesson(lesson.id).sections.map((s) => s.title), ["Try it", "Listing"]);
      student.submitExercise(exercise.id, "ls -a");
    } finally { student.close(); }
    const pending = await call("get_exercise_submissions", { courseId: course.id, status: "pending_review" });
    assert.equal(pending.length, 1);
    assert.equal(pending[0].value, "ls -a");
    const graded = await call("grade_exercise_submission", { submissionId: pending[0].id, score: 0.5, feedback: "Add -l for details." });
    assert.equal(graded.status, "partially_correct");
    const detail = await call("get_lesson", { lessonId: lesson.id });
    assert.equal(detail.sections[0].latestSubmission.feedback, "Add -l for details.");
    assert.equal(detail.sections[0].question.hint, "Hidden files too");
    const progress = await call("get_student_progress", { courseId: course.id });
    assert.equal(progress.exercises.completed, 1);
    assert.equal(progress.lastPosition.sectionId, exercise.id);
  } finally {
    await client.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
