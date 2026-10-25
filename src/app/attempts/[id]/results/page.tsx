import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { AppError, getStore } from "@/lib/store";
import { Markdown } from "@/components/markdown";
import type { AnswerValue, Question } from "@/lib/schemas";
import { Recommendation } from "@/components/course";
import { CourseNav } from "@/components/assessments";

function display(value: AnswerValue, q: Question) {
  if (value === null || value === "" || (Array.isArray(value) && !value.length)) return "No answer provided";
  return Array.isArray(value) ? value.map((id) => q.options.find((o) => o.id === id)?.text ?? id).join("\n") : value;
}
const empty = (value: AnswerValue) => value === null || (Array.isArray(value) ? !value.length : !value.trim());
type Outcome = { status: string; awardedPoints: number; maxPoints: number };
function status(result: Outcome, value: AnswerValue) {
  const points = `${result.awardedPoints} / ${result.maxPoints}`;
  if (empty(value))
    return result.status === "needs_review"
      ? { label: "Not answered · awaiting review", tone: "unanswered" }
      : { label: "Not answered", tone: "unanswered" };
  if (result.status === "needs_review") return { label: "Pending review", tone: "pending" };
  if (result.status === "correct") return { label: `Correct · ${points}`, tone: "correct" };
  if (result.status === "partially_correct") return { label: `Partially correct · ${points}`, tone: "partial" };
  return { label: `Incorrect · ${points}`, tone: "incorrect" };
}
export default async function ResultsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, store = getStore();
  let result;
  try {
    if (!store.studentAttempt(id).submitted_at) redirect(`/attempts/${id}`);
    result = store.results(id);
  } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound(); throw error;
  }
  return <div className="reading"><Link className="back" href={`/courses/${result.course_id}`}>← Course overview</Link>
    <CourseNav courseId={result.course_id} />
    <div className="page-heading"><p className="eyebrow">Assessment results</p><h1>{result.title}</h1></div>
    <section className="panel">{result.pendingReview ? <>
      <h2>Awaiting instructor review</h2><p>{result.pendingReview} written response(s) pending. Your submission is saved; no final score is available yet.</p>
      {result.gradedCount > 0 && <p className="muted">Graded so far: {result.earned} points ({result.gradedPercentage}%).
        Ungraded responses are not counted as incorrect.</p>}
      <p className="muted">Your instructor can review these answers through MCP. Return here to view feedback; this page updates automatically.</p>
    </> : <><p className="eyebrow">Final score</p><div className="score">{result.percentage}<span>%</span></div>
      <p>{result.earned} / {result.total} points · All answers have been graded.</p>
      <a href="#answer-review">View feedback & answer review →</a></>}
      <div className="status-summary">{Object.entries(result.questions.reduce<Record<string, number>>((counts, q) => {
        const answer = result.answers.find((a) => a.question_id === q.id);
        const s = status(answer?.result ?? { status: "needs_review", awardedPoints: 0, maxPoints: 1 }, answer?.value ?? null);
        counts[s.tone] = (counts[s.tone] ?? 0) + 1; return counts;
      }, {})).map(([tone, n]) => <span key={tone} className={`badge ${tone}`}>{n} {{ correct: "correct", incorrect: "incorrect",
        partial: "partially correct", pending: "pending review", unanswered: "not answered" }[tone]}</span>)}</div>
      <p style={{ marginTop: 14 }}><Link href={`/assessments/${result.assessment_id}`}>Assessment instructions & attempts →</Link></p></section>
    <Recommendation progress={store.progress(result.course_id)} />
    {result.feedback.length > 0 && <section className="panel"><h2>Instructor feedback</h2>
      {result.feedback.map((f) => <p className="feedback" key={f.id}>{f.message}</p>)}</section>}
    <div id="answer-review">{result.questions.map((q, i) => {
      const answer = result.answers.find((a) => a.question_id === q.id)!, s = status(answer.result, answer.value);
      return <section className="panel" key={q.id}><div className="row"><p className="eyebrow">Question {i + 1}</p>
        <span className={`badge ${s.tone}`}>{s.label}</span></div>
        <Markdown>{q.prompt}</Markdown>
        {answer.result.explanation && <p className="muted small-text">{answer.result.explanation}</p>}
        <h3>Your answer</h3><pre className="answer-text">{display(answer.value, q)}</pre>
        {q.correctAnswer && <><h3>Correct answer</h3><pre className="answer-text">{display(q.correctAnswer, q)}</pre></>}
        {q.explanation && <><h3>Explanation</h3><Markdown>{q.explanation}</Markdown></>}
        {answer.feedback && <><h3>Instructor review</h3><p className="feedback">{answer.feedback}</p></>}
      </section>;
    })}</div></div>;
}
