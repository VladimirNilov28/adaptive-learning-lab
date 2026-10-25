import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { AppError, getStore } from "@/lib/store";
import { answerValue, id, saveAnswerInput } from "@/lib/schemas";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function failure(error: unknown) {
  if (error instanceof z.ZodError)
    return NextResponse.json({ error: error.issues.map((i) => i.message).join("; ") }, { status: 400 });
  if (error instanceof AppError)
    return NextResponse.json({ error: error.message }, { status: error.status });
  console.error("Student API:", error);
  return NextResponse.json({ error: "Storage operation failed. Check the application terminal." }, { status: 500 });
}
const mutation = z.discriminatedUnion("action", [
  z.object({ action: z.literal("set_active_course"), courseId: id }),
  z.object({ action: z.literal("complete_lesson"), lessonId: id, completed: z.boolean() }),
  z.object({ action: z.literal("start_attempt"), assessmentId: id }),
  z.object({ action: z.literal("save_answer"), attemptId: id, ...saveAnswerInput.shape }),
  z.object({ action: z.literal("submit_attempt"), attemptId: id }),
  z.object({ action: z.literal("complete_section"), sectionId: id, completed: z.boolean() }),
  z.object({
    action: z.literal("submit_exercise"), sectionId: id, value: answerValue,
    durationMs: z.number().int().min(0).max(86_400_000).nullable().default(null),
  }),
  z.object({ action: z.literal("use_hint"), sectionId: id }),
  z.object({ action: z.literal("set_position"), lessonId: id, sectionId: id.nullable() }),
]);

export async function POST(request: NextRequest) {
  try {
    const raw = await request.text();
    if (raw.length > 1_300_000) throw new AppError("Request is too large", 413);
    let json: unknown;
    try { json = JSON.parse(raw); } catch { throw new AppError("Invalid JSON"); }
    const data = mutation.parse(json), store = getStore();
    switch (data.action) {
      case "set_active_course": return NextResponse.json(store.setActiveCourse(data.courseId));
      case "complete_lesson": return NextResponse.json(store.completeLesson(data.lessonId, data.completed));
      case "start_attempt": return NextResponse.json(store.startAttempt(data.assessmentId));
      case "save_answer": return NextResponse.json(store.saveAnswer(data.attemptId, data));
      case "submit_attempt": return NextResponse.json(store.submitAttempt(data.attemptId));
      case "complete_section": return NextResponse.json(store.completeSection(data.sectionId, data.completed));
      case "submit_exercise":
        return NextResponse.json(store.submitExercise(data.sectionId, data.value, { durationMs: data.durationMs }));
      case "use_hint": return NextResponse.json(store.useHint(data.sectionId));
      case "set_position": return NextResponse.json(store.setPosition(data.lessonId, data.sectionId));
    }
  } catch (error) { return failure(error); }
}

export async function GET(request: NextRequest) {
  try {
    return NextResponse.json(getStore().studentAttempt(id.parse(request.nextUrl.searchParams.get("attemptId"))),
      { headers: { "Cache-Control": "no-store" } });
  } catch (error) { return failure(error); }
}
