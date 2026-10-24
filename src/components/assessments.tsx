import Link from "next/link";
import type { Assessment } from "@/lib/schemas";
import type { Store } from "@/lib/store";

export function CourseNav({ courseId }: { courseId: string }) {
  return <nav className="row course-nav" aria-label="Course navigation">
    <Link href={`/courses/${courseId}`}>Course overview & lessons</Link>
    <Link href={`/assessments?courseId=${courseId}`}>Assessments</Link>
  </nav>;
}

export function AssessmentList({ assessments, progress, title = "Assessments" }: {
  assessments: Assessment[]; progress: ReturnType<Store["progress"]>; title?: string;
}) {
  return <section className="panel"><h2>{title}</h2>
    {!assessments.length && <p className="muted">No assessments yet. Your instructor can add practice or timed exams.</p>}
    {assessments.map((a) => {
      const active = progress.attempts.find((attempt) => attempt.assessment_id === a.id && !attempt.submitted_at);
      const latest = progress.attempts.find((attempt) => attempt.assessment_id === a.id && attempt.submitted_at);
      return <div className="assessment-row" key={a.id}><div>
        <h3><Link href={`/assessments/${a.id}`}>{a.title}</Link></h3>
        <p className="muted">{a.questionIds.length} questions · {a.mode} · {a.durationMinutes ? `${a.durationMinutes} minutes` : "untimed"}</p>
        {latest?.result && <Link href={`/attempts/${latest.id}/results`}>
          {latest.result.pendingReview ? "Awaiting instructor review · View submitted answers" : `View results & feedback · ${latest.result.percentage}%`}</Link>}
      </div><Link className="button secondary" href={active ? `/attempts/${active.id}` : `/assessments/${a.id}`}>
        {active ? "Resume attempt" : "View instructions"}</Link></div>;
    })}
  </section>;
}
