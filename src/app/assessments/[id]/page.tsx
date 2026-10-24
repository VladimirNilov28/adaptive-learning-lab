import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getStore } from "@/lib/store";
import { MutationButton } from "@/components/actions";
import { CourseNav } from "@/components/assessments";

export default async function AssessmentPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, store = getStore();
  let assessment;
  try { assessment = store.getAssessment(id); } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound(); throw error;
  }
  const progress = store.progress(assessment.courseId);
  const active = progress.attempts.find((a) => a.assessment_id === id && !a.submitted_at);
  const submitted = progress.attempts.filter((a) => a.assessment_id === id && a.submitted_at);
  return <div className="reading"><Link className="back" href={`/courses/${assessment.courseId}`}>← Course overview</Link>
    <CourseNav courseId={assessment.courseId} />
    <div className="page-heading"><p className="eyebrow">{assessment.mode === "exam" ? "Timed exam" : "Practice assessment"}</p>
      <h1>{assessment.title}</h1><p className="muted">{assessment.description}</p></div>
    <section className="panel"><div className="stats"><div><strong>{assessment.questionIds.length}</strong><p className="muted">questions</p></div>
      <div><strong>{assessment.durationMinutes ? `${assessment.durationMinutes} min` : "Untimed"}</strong><p className="muted">duration</p></div></div>
      <p>Answers are saved locally. Choice questions are graded automatically; written answers are reviewed by your instructor.</p>
      <p className="muted">No hints, answer keys, or grading feedback are shown until submission.
        {assessment.durationMinutes && " The deadline is fixed when you start. Leaving or refreshing does not pause it; expired attempts are submitted automatically."}</p>
      {active ? <Link className="button" href={`/attempts/${active.id}`}>Resume attempt</Link> :
        <MutationButton href="attempt" data={{ action: "start_attempt", assessmentId: id }}>
          {submitted.length ? "Start new attempt" : "Start assessment"}</MutationButton>}
    </section>
    {submitted.length > 0 && <section className="panel"><h2>Previous attempts</h2>
      {submitted.map((a) => <Link className="lesson-row" key={a.id} href={`/attempts/${a.id}/results`}>
        <span>{a.title}<small>{a.submitted_at}</small></span><span className="badge">
          {a.result?.pendingReview ? "Awaiting instructor review" : `${a.result?.percentage}% · View feedback`}</span></Link>)}</section>}
    </div>;
}
