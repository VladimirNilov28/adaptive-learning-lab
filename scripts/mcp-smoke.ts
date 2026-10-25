import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { createServer } from "node:net";
import { request as httpRequest } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { z } from "zod";
import type { AttemptView, AttemptResults } from "../src/lib/schemas.js";
import { Store } from "../src/lib/store.js";

const root = fileURLToPath(new URL("../", import.meta.url));
await access(join(root, ".next", "BUILD_ID")).catch(() => {
  throw new Error("Run npm run build before the MCP/web smoke test.");
});
const temporary = await mkdtemp(join(tmpdir(), "learning-mcp-web-smoke-"));
const env = { ...process.env, LEARNING_DB_PATH: join(temporary, "shared.sqlite"), NEXT_TELEMETRY_DISABLED: "1" };
const socket = createServer();
socket.listen(0, "127.0.0.1");
await once(socket, "listening");
const address = socket.address();
assert.ok(address && typeof address !== "string");
const port = address.port;
await new Promise<void>((resolve, reject) => socket.close((error) => error ? reject(error) : resolve()));
const base = `http://127.0.0.1:${port}`;
let web: ChildProcess | undefined, webLogs = "";
let client: Client | undefined;

async function connect() {
  const transport = new StdioClientTransport({
    command: process.execPath, args: [join(root, "dist", "mcp.js")],
    cwd: temporary, env, stderr: "pipe",
  });
  transport.stderr?.on("data", (chunk: Buffer) => process.stderr.write(chunk));
  const connected = new Client({ name: "mcp-web-smoke", version: "1.0.0" });
  await connected.connect(transport);
  return connected;
}
async function tool<T extends z.ZodTypeAny>(name: string, args: Record<string, unknown>, schema: T): Promise<z.infer<T>> {
  assert.ok(client);
  const response = await client.callTool({ name, arguments: args });
  assert.ok(!response.isError, JSON.stringify(response.content));
  return z.object({ result: schema }).parse(response.structuredContent).result;
}
const entity = z.object({ id: z.string() }).passthrough();
async function startWeb() {
  webLogs = "";
  web = spawn(process.execPath, [join(root, "node_modules/next/dist/bin/next"), "start", "--hostname", "127.0.0.1", "--port", String(port)],
    { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] });
  web.on("error", (error) => { webLogs += error.message; });
  for (const output of [web.stdout, web.stderr])
    output?.on("data", (chunk: Buffer) => { webLogs = (webLogs + chunk.toString()).slice(-20_000); });
  for (let n = 0; n < 100; n++) {
    if (web.exitCode !== null) throw new Error(`Web server exited: ${webLogs}`);
    try {
      const response = await fetch(base);
      if (response.ok) return;
      throw new Error(`Web readiness returned ${response.status}: ${webLogs}`);
    } catch (error) {
      if (!(error instanceof TypeError && error.cause instanceof Error &&
        "code" in error.cause && error.cause.code === "ECONNREFUSED")) throw error;
    }
    await delay(200);
  }
  throw new Error(`Web server was not ready: ${webLogs}`);
}
async function stopWeb() {
  if (web && web.exitCode === null) {
    const exited = once(web, "exit");
    web.kill("SIGTERM");
    await exited;
  }
  web = undefined;
}
async function post<T>(data: object): Promise<T> {
  const response = await fetch(`${base}/api/student`, {
    method: "POST", headers: { "Content-Type": "application/json", Origin: base }, body: JSON.stringify(data),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  return body as T;
}

async function browserFlow(ids: { courseId: string; topicId: string; lessonId: string; choiceId: string; writtenId: string }) {
  const { chromium } = await import("playwright");
  const multiple = await tool("upsert_question", {
    topicId: ids.topicId, type: "multiple_choice", prompt: "Browser multiple fixture",
    options: [{ id: "x", text: "First option" }, { id: "y", text: "Second option" }, { id: "z", text: "Third option" }],
    correctAnswer: ["x", "z"],
  }, entity);
  const short = await tool("upsert_question", {
    topicId: ids.topicId, type: "short_text", prompt: "Browser short fixture",
  }, entity);
  const predict = await tool("upsert_question", {
    topicId: ids.topicId, type: "predict_output", prompt: "Browser output fixture\n\n```text\n  whitespace\n```",
  }, entity);
  const exam = await tool("create_assessment", {
    courseId: ids.courseId, title: "Browser diagnostic fixture", mode: "exam", durationMinutes: 35,
    questionIds: [ids.choiceId, multiple.id, short.id, ids.writtenId, predict.id],
  }, entity);
  await tool("upsert_lesson", {
    id: ids.lessonId, topicId: ids.topicId, title: "Fixture lesson", content: "Open the related assessment.",
    assessmentIds: [exam.id],
  }, entity);
  const browser = await chromium.launch();
  const page = await browser.newPage();
  const browserErrors: string[] = [];
  page.on("pageerror", (error) => browserErrors.push(error.message));
  try {
    await page.goto(`${base}/lessons/${ids.lessonId}`);
    await page.getByRole("heading", { name: "Related assessments" }).waitFor();
    await page.getByRole("link", { name: "View instructions", exact: true }).click();
    await page.getByRole("button", { name: "Start assessment", exact: true }).waitFor();
    assert.match(await page.locator("main").innerText(), /35 min/);
    assert.match(await page.locator("main").innerText(), /5\s+questions/);
    await page.getByRole("button", { name: "Start assessment", exact: true }).click();
    await page.waitForURL(/\/attempts\/[^/]+$/);
    await page.getByRole("radio", { name: "Option B" }).waitFor();
    const attemptId = new URL(page.url()).pathname.split("/").at(-1)!;
    const started = await post<AttemptView>({ action: "start_attempt", assessmentId: exam.id });
    assert.equal(started.id, attemptId);
    assert.match(await page.getByRole("timer").innerText(), /^(35:00|34:\d\d)$/);
    assert.equal(await page.getByText("SECRET_EXPLANATION_ONLY_AFTER_SUBMISSION").count(), 0);
    await tool("upsert_question", {
      id: ids.choiceId, topicId: ids.topicId, type: "single_choice", prompt: "Edited after browser start",
      options: [{ id: "a", text: "Changed A" }, { id: "b", text: "Changed B" }], correctAnswer: ["a"],
    }, entity);
    await page.getByRole("radio", { name: "Option B" }).check();
    await page.getByRole("button", { name: "Next →", exact: true }).click();
    await page.getByText("Browser multiple fixture", { exact: true }).waitFor();
    await page.getByRole("checkbox", { name: "First option" }).check();
    await page.getByRole("checkbox", { name: "Third option" }).check();
    await page.getByRole("button", { name: "Next →", exact: true }).click();
    await page.getByText("Browser short fixture", { exact: true }).waitFor();
    let injectSaveFailure = true;
    await page.route("**/api/student", async (route) => {
      const request = route.request();
      const body = request.method() === "POST" ? request.postDataJSON() : null;
      if (injectSaveFailure && body?.action === "save_answer" && body.questionId === short.id) {
        injectSaveFailure = false;
        await route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"Injected save failure"}' });
      } else await route.continue();
    });
    await page.getByLabel("Your response", { exact: true }).fill("A saved written response");
    await page.getByRole("alert").filter({ hasText: "Injected save failure" }).waitFor();
    await page.getByRole("button", { name: "Retry save" }).click();
    await page.getByText("All changes saved", { exact: true }).waitFor();
    await page.unroute("**/api/student");
    await page.reload();
    await page.getByRole("navigation", { name: "Question navigation" }).getByRole("button", { name: new RegExp("^Question 3,") }).click();
    assert.equal(await page.getByLabel("Your response", { exact: true }).inputValue(), "A saved written response");
    const resumed = await (await fetch(`${base}/api/student?attemptId=${attemptId}`)).json() as AttemptView;
    assert.equal(resumed.deadline, started.deadline);
    assert.ok(!/correctAnswer|explanation|score|reviewed_at|feedback/.test(JSON.stringify(resumed)));
    await page.getByRole("button", { name: "Next →", exact: true }).click();
    await page.getByText("Fixture written response", { exact: true }).waitFor();
    const code = "  first line\n\tindented line\n\nlast line  ";
    await page.getByLabel("Your response", { exact: true }).fill(code);
    await page.getByRole("button", { name: "Next →", exact: true }).click();
    await page.getByText("Browser output fixture", { exact: false }).waitFor();
    assert.equal(await page.getByLabel("Your response", { exact: true }).getAttribute("spellcheck"), "false");
    await page.getByLabel("Your response", { exact: true }).fill("  output\n");
    await page.getByLabel("Your response", { exact: true }).fill("");
    await page.getByText("All changes saved", { exact: true }).waitFor();
    await page.reload();
    await page.getByRole("navigation", { name: "Question navigation" }).getByRole("button", { name: new RegExp("^Question 4,") }).click();
    assert.equal(await page.getByLabel("Your response", { exact: true }).inputValue(), code);
    await page.getByRole("button", { name: "Submit assessment", exact: true }).click();
    await page.getByRole("alertdialog").waitFor();
    assert.match(await page.getByRole("alertdialog").innerText(), /1 unanswered: question 5/);
    await page.getByRole("button", { name: "Keep working" }).click();
    assert.equal(await page.getByRole("alertdialog").count(), 0);
    await page.getByRole("button", { name: "Submit assessment", exact: true }).click();
    await page.getByRole("button", { name: "Confirm submission" }).click();
    await page.waitForURL(`**/attempts/${attemptId}/results`);
    await page.getByRole("heading", { name: "Awaiting instructor review" }).waitFor();
    assert.equal(await page.locator(".score").count(), 0);
    assert.equal(await page.getByText("Pending review", { exact: true }).count(), 2);
    assert.equal(await page.getByText("Not answered · awaiting review", { exact: true }).count(), 1);
    const pending = await tool("get_assessment_results", { attemptId }, z.object({ percentage: z.null(), pendingReview: z.literal(3) }));
    assert.equal(pending.percentage, null);
    await tool("grade_open_answer", {
      attemptId, questionId: short.id, score: 0.5, feedback: "Browser partial feedback",
    }, z.object({ percentage: z.null(), gradedPercentage: z.number() }));
    await page.reload();
    await page.getByText("Browser partial feedback", { exact: true }).waitFor();
    assert.equal(await page.locator(".score").count(), 0);
    await tool("grade_open_answer", {
      attemptId, questionId: ids.writtenId, score: 1, feedback: "Formatting preserved",
    }, z.object({ percentage: z.null() }));
    await tool("grade_open_answer", {
      attemptId, questionId: predict.id, score: 0, feedback: "No response provided",
    }, z.object({ percentage: z.literal(70), pendingReview: z.literal(0) }));
    await page.reload();
    await page.getByText("Final score", { exact: true }).waitFor();
    assert.equal(await page.locator(".score").innerText(), "70%");
    assert.ok(!(await page.locator("main").innerText()).includes("Edited after browser start"));
    assert.ok((await page.locator("pre.answer-text").allTextContents()).includes(code));
    await page.getByRole("link", { name: "Open lesson →", exact: true }).waitFor();
    const progress = await tool("get_student_progress", { courseId: ids.courseId }, z.object({
      attempts: z.array(z.object({ id: z.string(), result: z.object({ percentage: z.number().nullable() }).nullable() })),
    }));
    assert.equal(progress.attempts.find((a) => a.id === attemptId)?.result?.percentage, 70);

    const expiring = await tool("create_assessment", {
      courseId: ids.courseId, title: "Browser expiry fixture", mode: "exam", durationMinutes: 1, questionIds: [ids.writtenId],
    }, entity);
    await page.goto(`${base}/assessments/${expiring.id}`);
    await page.getByRole("button", { name: "Start assessment", exact: true }).click();
    await page.waitForURL(/\/attempts\/[^/]+$/);
    const expiredId = new URL(page.url()).pathname.split("/").at(-1)!;
    await page.getByLabel("Your response", { exact: true }).fill("Saved before expiry");
    await page.getByText("All changes saved", { exact: true }).waitFor();
    const store = new Store(env.LEARNING_DB_PATH);
    try {
      store.db.prepare("UPDATE attempts SET deadline=? WHERE id=?").run(new Date(Date.now() + 3000).toISOString(), expiredId);
    } finally { store.close(); }
    await page.reload();
    await page.getByRole("timer").waitFor();
    await page.waitForURL(`**/attempts/${expiredId}/results`);
    await page.getByRole("heading", { name: "Awaiting instructor review" }).waitFor();
    assert.match(await page.locator("main").innerText(), /Saved before expiry/);
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("navigation", { name: "Main navigation" }).getByRole("link", { name: "Assessments", exact: true }).click();
    await page.getByRole("heading", { name: "Assessments", exact: true }).waitFor();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(browserErrors, []);
    await lessonBrowserFlow(ids.courseId, ids.topicId);
    console.log("PASS: browser discovery/start, all 5 input types, save failure/retry, whitespace, reload/resume, submission warning, frozen snapshots, partial review, deadline expiry, and mobile navigation.");
  } finally { await browser.close(); }
}

async function lessonBrowserFlow(courseId: string, topicId: string) {
  const { chromium } = await import("playwright");
  const lesson = await tool("upsert_lesson", { topicId, title: "Browser guided lesson", position: 5 }, entity);
  const q = await tool("upsert_question", {
    topicId, type: "multiple_choice", prompt: "Browser exercise prompt",
    options: [{ id: "x", text: "Choice X" }, { id: "y", text: "Choice Y" }, { id: "z", text: "Choice Z" }],
    correctAnswer: ["x", "z"], explanation: "BROWSER_LESSON_EXPLANATION", hint: "Browser hint text",
  }, entity);
  const code = await tool("upsert_question", { topicId, type: "code_text", prompt: "Browser command prompt", starterCode: "grep -r" }, entity);
  await tool("upsert_lesson_section", { lessonId: lesson.id, kind: "theory", title: "Browser theory",
    content: "Read this.\n\n```bash\necho copy-me\n```" }, entity);
  const ex = await tool("upsert_lesson_section", { lessonId: lesson.id, kind: "exercise", title: "Browser exercise", questionId: q.id, position: 1 }, entity);
  await tool("upsert_lesson_section", { lessonId: lesson.id, kind: "exercise", title: "Browser command", questionId: code.id, position: 2 }, entity);
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: base });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  try {
    await page.goto(`${base}/lessons/${lesson.id}`);
    await page.getByRole("complementary", { name: "Course navigation" }).getByRole("link", { name: /Browser guided lesson/ }).waitFor();
    await page.getByRole("button", { name: "Copy code to clipboard" }).first().click();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).trim(), "echo copy-me");
    const card = page.locator(`#section-${ex.id}`);
    assert.equal(await card.getByText("Browser hint text").count(), 0);
    await card.getByRole("button", { name: "Show hint" }).click();
    await card.getByText("Browser hint text").waitFor();
    await card.getByLabel("Choice X").check();
    await card.getByRole("button", { name: "Submit answer" }).click();
    await card.getByText(/Not quite · 0 \/ 1 point/).waitFor();
    assert.equal(await page.getByText("BROWSER_LESSON_EXPLANATION").count(), 0, "answer hidden until revealed");
    await card.getByRole("button", { name: "Reveal answer and explanation" }).click();
    await card.getByText("BROWSER_LESSON_EXPLANATION").waitFor();
    await card.getByLabel("Choice Z").check();
    await card.getByRole("button", { name: "Try again" }).click();
    await card.getByText(/^Correct · 1 \/ 1 point$/).waitFor();
    const command = page.getByLabel("Your answer");
    assert.equal(await command.inputValue(), "grep -r");
    await command.fill("grep -rn TODO .");
    await page.reload();
    assert.equal(await page.getByLabel("Your answer").inputValue(), "grep -rn TODO .", "draft restored after reload");
    await page.getByRole("button", { name: "Reset answer" }).last().click();
    assert.equal(await page.getByLabel("Your answer").inputValue(), "grep -r");
    await page.getByLabel("Your answer").fill("grep -rn TODO .");
    await page.getByRole("button", { name: "Submit answer" }).last().click();
    await page.getByText("Submitted · awaiting instructor review").waitFor();
    await page.getByRole("button", { name: "Ask instructor" }).first().click();
    const dialog = page.getByRole("dialog", { name: "Ask your instructor" });
    const question = await dialog.getByRole("textbox").inputValue();
    assert.ok(question.includes(`lessonId: ${lesson.id}`) && question.includes(`courseId: ${courseId}`));
    assert.ok(!question.includes("BROWSER_LESSON_EXPLANATION"));
    await dialog.getByRole("button", { name: "Close" }).click();
    await page.goto(base);
    await page.getByRole("heading", { name: "Needs attention" }).waitFor();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/lessons/${lesson.id}`);
    await page.getByText(/Course menu/).click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
  } finally { await browser.close(); }
}

try {
  client = await connect();
  assert.equal((await client.listTools()).tools.length, 31);
  await startWeb();
  assert.match(await (await fetch(base)).text(), /There are no courses yet/);
  const course = await tool("create_course", { title: "MCP web smoke fixture", description: "Temporary integration fixture" }, entity);
  const read = await tool("get_course_structure", { courseId: course.id }, z.object({ title: z.string() }));
  assert.equal(read.title, "MCP web smoke fixture");
  assert.match(await (await fetch(base)).text(), /MCP web smoke fixture/);
  const phase = await tool("upsert_phase", { courseId: course.id, title: "Fixture phase" }, entity);
  const topic = await tool("upsert_topic", { phaseId: phase.id, title: "Fixture topic" }, entity);
  const lesson = await tool("upsert_lesson", {
    topicId: topic.id, title: "Fixture lesson", content: "# MCP lesson visible\n\n```ts\nconst fixture = true;\n```",
  }, entity);
  const lessonHtml = await (await fetch(`${base}/lessons/${lesson.id}`)).text();
  assert.match(lessonHtml, /MCP lesson visible/);
  assert.match(lessonHtml, /hljs-keyword/);
  const choice = await tool("upsert_question", {
    topicId: topic.id, type: "single_choice", prompt: "Fixture choice",
    options: [{ id: "a", text: "Option A" }, { id: "b", text: "Option B" }],
    correctAnswer: ["b"], explanation: "SECRET_EXPLANATION_ONLY_AFTER_SUBMISSION",
  }, entity);
  const written = await tool("upsert_question", { topicId: topic.id, type: "code_text", prompt: "Fixture written response" }, entity);
  const assessment = await tool("create_assessment", {
    courseId: course.id, title: "Fixture exam", mode: "exam", durationMinutes: 5, questionIds: [choice.id, written.id],
  }, entity);
  for (const path of ["/", `/courses/${course.id}`, "/assessments", `/assessments?courseId=${course.id}`, `/lessons/${lesson.id}`]) {
    const html = await (await fetch(`${base}${path}`)).text();
    assert.match(html, /Fixture exam/);
    assert.ok(html.includes(`/assessments/${assessment.id}`));
  }
  await tool("upsert_lesson", {
    id: lesson.id, topicId: topic.id, title: "Fixture lesson", assessmentIds: [assessment.id],
    content: "# MCP lesson visible\n\n```ts\nconst fixture = true;\n```",
  }, entity);
  assert.match(await (await fetch(`${base}/lessons/${lesson.id}`)).text(), /Related assessments/);

  // Structured lesson: sections + embedded exercises created through MCP, used through the web API, reviewed through MCP.
  const guided = await tool("upsert_lesson", { topicId: topic.id, title: "Guided fixture lesson", position: 1 }, entity);
  const exChoice = await tool("upsert_question", {
    topicId: topic.id, type: "single_choice", prompt: "Which command lists hidden files?",
    options: [{ id: "a", text: "ls" }, { id: "b", text: "ls -a" }], correctAnswer: ["b"],
    explanation: "LESSON_SECRET_EXPLANATION", hint: "Hidden files start with a dot",
  }, entity);
  const exWritten = await tool("upsert_question", {
    topicId: topic.id, type: "find_bug", prompt: "Fix this script", starterCode: "echo $HOME\nexit 1", language: "bash",
  }, entity);
  const sectionSchema = z.object({ id: z.string() });
  const intro = await tool("upsert_lesson_section", { lessonId: guided.id, kind: "introduction", title: "Fixture introduction",
    content: "> [!TIP]\n> Fixture callout\n\n```bash\nls -la /tmp\n```", position: 0 }, sectionSchema);
  const choiceSection = await tool("upsert_lesson_section", { lessonId: guided.id, kind: "exercise", title: "Hidden files",
    questionId: exChoice.id, position: 1 }, sectionSchema);
  const bugSection = await tool("upsert_lesson_section", { lessonId: guided.id, kind: "exercise", title: "Debug fixture",
    questionId: exWritten.id, position: 2 }, sectionSchema);
  const guidedHtml = await (await fetch(`${base}/lessons/${guided.id}`)).text();
  for (const expected of ["Fixture introduction", "Fixture callout", "callout-tip", "Copy", "Which command lists hidden files?", "On this page", "Ask instructor"])
    assert.ok(guidedHtml.includes(expected), `lesson HTML should include ${expected}`);
  assert.ok(!guidedHtml.includes("LESSON_SECRET_EXPLANATION") && !guidedHtml.includes("correctAnswer"), "no key before submission");
  await post({ action: "complete_section", sectionId: intro.id, completed: true });
  await post({ action: "set_position", lessonId: guided.id, sectionId: choiceSection.id });
  const wrong = await post<{ latest: { score: number }; question: { explanation?: string } }>(
    { action: "submit_exercise", sectionId: choiceSection.id, value: ["a"] });
  assert.equal(wrong.latest.score, 0);
  assert.equal(wrong.question.explanation, "LESSON_SECRET_EXPLANATION");
  await post({ action: "submit_exercise", sectionId: choiceSection.id, value: ["b"] });
  await post({ action: "submit_exercise", sectionId: bugSection.id, value: "echo \"$HOME\"\nexit 0" });
  const submissions = await tool("get_exercise_submissions", { lessonId: guided.id, status: "pending_review" },
    z.array(z.object({ id: z.string(), value: z.string(), sectionId: z.string() })));
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0].sectionId, bugSection.id);
  await tool("grade_exercise_submission", { submissionId: submissions[0].id, score: 1, feedback: "Smoke exercise review visible" },
    z.object({ status: z.literal("correct") }));
  assert.match(await (await fetch(`${base}/lessons/${guided.id}`)).text(), /Smoke exercise review visible/);
  const guidedProgress = await tool("get_student_progress", { courseId: course.id }, z.object({
    exercises: z.object({ completed: z.number(), incorrectSubmissions: z.number() }),
    lastPosition: z.object({ lessonId: z.string() }).nullable(),
  }));
  assert.deepEqual([guidedProgress.exercises.completed, guidedProgress.exercises.incorrectSubmissions], [2, 1]);
  assert.equal(guidedProgress.lastPosition?.lessonId, guided.id);
  const otherCourse = await tool("create_course", { title: "Other course fixture" }, entity);
  for (const path of [`/courses/${otherCourse.id}`, `/assessments?courseId=${otherCourse.id}`])
    assert.ok(!(await (await fetch(`${base}${path}`)).text()).includes(`/assessments/${assessment.id}`));
  assert.equal((await fetch(`${base}/assessments?courseId=missing`)).status, 404);
  assert.equal((await fetch(`${base}/attempts/missing`)).status, 404);
  assert.equal((await fetch(`${base}/api/student?attemptId=missing`)).status, 404);
  const nonlocalHostStatus = await new Promise<number | undefined>((resolve, reject) => {
    const request = httpRequest(base, { headers: { Host: "not-local.invalid" } }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on("error", reject);
    request.end();
  });
  assert.equal(nonlocalHostStatus, 403);
  const attempt = await post<AttemptView>({ action: "start_attempt", assessmentId: assessment.id });
  const duplicateStart = await post<AttemptView>({ action: "start_attempt", assessmentId: assessment.id });
  assert.equal(duplicateStart.id, attempt.id);
  assert.equal(duplicateStart.deadline, attempt.deadline);
  assert.ok(attempt.deadline);
  assert.ok(!JSON.stringify(attempt).includes("correctAnswer"));
  assert.ok(!JSON.stringify(attempt).includes("SECRET_EXPLANATION"));
  const attemptHtml = await (await fetch(`${base}/attempts/${attempt.id}`)).text();
  assert.ok(!attemptHtml.includes("SECRET_EXPLANATION"));
  assert.ok(!attemptHtml.includes("correctAnswer"));
  const earlyResults = await fetch(`${base}/attempts/${attempt.id}/results`, { redirect: "manual" });
  assert.equal(earlyResults.status, 307);
  assert.equal(earlyResults.headers.get("location"), `/attempts/${attempt.id}`);
  const blocked = await fetch(`${base}/api/student`, {
    method: "POST", headers: { Origin: "https://example.invalid", "Content-Type": "application/json" },
    body: JSON.stringify({ action: "submit_attempt", attemptId: attempt.id }),
  });
  assert.equal(blocked.status, 403);
  const noOrigin = await fetch(`${base}/api/student`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action: "submit_attempt", attemptId: attempt.id }),
  });
  assert.equal(noOrigin.status, 403);
  for (const [data, expected] of [
    [{ action: "save_answer", attemptId: attempt.id, questionId: "not-in-attempt", value: "Invalid" }, 400],
    [{ action: "save_answer", attemptId: "missing", questionId: written.id, value: "Invalid" }, 404],
    [{ action: "grade_open_answer", attemptId: attempt.id, questionId: written.id, score: 1 }, 400],
  ] as const) {
    const rejected = await fetch(`${base}/api/student`, {
      method: "POST", headers: { Origin: base, "Content-Type": "application/json" }, body: JSON.stringify(data),
    });
    assert.equal(rejected.status, expected);
  }
  await post({ action: "save_answer", attemptId: attempt.id, questionId: choice.id, value: ["b"] });
  await post({ action: "save_answer", attemptId: attempt.id, questionId: written.id, value: "Never executed; stored as text" });
  const resumed = await (await fetch(`${base}/api/student?attemptId=${attempt.id}`)).json() as AttemptView;
  assert.equal(resumed.answers[written.id], "Never executed; stored as text");
  assert.equal(resumed.deadline, attempt.deadline);
  assert.ok(!/correctAnswer|explanation|score|reviewed_at|feedback/.test(JSON.stringify(resumed)));
  await post({ action: "complete_lesson", lessonId: lesson.id, completed: true });
  const result = await post<AttemptResults>({ action: "submit_attempt", attemptId: attempt.id });
  assert.equal(result.percentage, null);
  assert.equal(result.gradedPercentage, 100);
  assert.equal(result.pendingReview, 1);
  assert.equal((await post<AttemptResults>({ action: "submit_attempt", attemptId: attempt.id })).submitted_at, result.submitted_at);
  const late = await fetch(`${base}/api/student`, {
    method: "POST", headers: { Origin: base, "Content-Type": "application/json" },
    body: JSON.stringify({ action: "save_answer", attemptId: attempt.id, questionId: choice.id, value: ["a"] }),
  });
  assert.equal(late.status, 409);
  assert.match(await (await fetch(`${base}/attempts/${attempt.id}/results`)).text(), /Awaiting instructor review/);
  await tool("grade_open_answer", {
    attemptId: attempt.id, questionId: written.id, score: 0.5, feedback: "Smoke review persisted",
  }, z.object({ percentage: z.literal(75) }));
  await tool("set_instructor_feedback", {
    courseId: course.id, attemptId: attempt.id, message: "Smoke instructor feedback",
  }, entity);
  await tool("set_learning_priority", { topicId: topic.id, priority: 90 }, entity);
  await tool("recommend_next_topic", {
    courseId: course.id, topicId: topic.id, lessonId: lesson.id, reason: "Smoke recommendation visible",
  }, z.object({ reason: z.string() }));
  assert.match(await (await fetch(base)).text(), /Smoke recommendation visible/);
  assert.match(await (await fetch(`${base}/attempts/${attempt.id}/results`)).text(), /Smoke review persisted/);
  if (process.argv.includes("--browser")) await browserFlow({
    courseId: course.id, topicId: topic.id, lessonId: lesson.id, choiceId: choice.id, writtenId: written.id,
  });
  await stopWeb(); await client.close();
  client = await connect();
  await startWeb();
  await tool("get_assessment_results", { attemptId: attempt.id }, z.object({ percentage: z.literal(75), pendingReview: z.literal(0) }));
  assert.match(await (await fetch(base)).text(), /Smoke recommendation visible/);
  assert.match(await (await fetch(`${base}/progress`)).text(), /Smoke instructor feedback/);
  console.log("PASS: compiled STDIO discovery → course/lesson creation → web display → assessment → instructor review → recommendation → web + MCP restart persistence.");
} finally {
  await stopWeb();
  await client?.close();
  await rm(temporary, { recursive: true, force: true });
}
