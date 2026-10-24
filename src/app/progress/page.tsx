import Link from "next/link";
import { getStore } from "@/lib/store";
import { ProgressStats, RecentAttempts, Recommendation } from "@/components/course";

export default function ProgressPage() {
  const store = getStore(), courseId = store.activeCourseId();
  if (!courseId) return <div className="empty"><h1>No progress yet</h1><p>Create a course through MCP to start learning.</p><Link href="/">Dashboard →</Link></div>;
  const course = store.getCourse(courseId), progress = store.progress(courseId);
  return <><div className="page-heading"><p className="eyebrow">{course.title}</p><h1>Your progress</h1>
    <p className="muted">Written responses are provisional until reviewed. Topic scores use graded answers across all attempts.</p></div>
    <ProgressStats progress={progress} /><Recommendation progress={progress} />
    <section className="panel"><h2>Topic performance</h2>
      {!progress.performance.length && <p className="muted">Your instructor has not added topics yet.</p>}
      {progress.performance.map((t) => <div className="performance-row" key={t.topicId}>
        <Link href={`/topics/${t.topicId}`}>{t.title}</Link><span className={t.needsPractice ? "warning" : "muted"}>
          {t.percentage === null ? "Not assessed" : `${t.percentage}%`} · {t.graded} graded{t.pending ? ` · ${t.pending} pending` : ""}
          {t.needsPractice ? " · Practice recommended" : ""}</span></div>)}</section>
    <section className="panel"><h2>Lessons</h2>
      {!progress.lessonProgress.length && <p className="muted">No lessons yet.</p>}
      {progress.lessonProgress.map((l) => <div className="performance-row" key={l.lessonId}>
        <Link href={`/lessons/${l.lessonId}`}>{l.completed ? "✓ " : ""}{l.title}</Link><span className="muted">
          {l.completed ? "Completed" : l.sectionCount ? `${l.sectionsCompleted} / ${l.sectionCount} sections` : "Not started"}</span></div>)}</section>
    {progress.exercises.total > 0 && <section className="panel"><h2>Lesson exercises</h2>
      <p className="muted">{progress.exercises.completed} of {progress.exercises.total} completed · {progress.exercises.incorrectSubmissions} incorrect
        {progress.exercises.incorrectSubmissions === 1 ? " try" : " tries"} · {progress.exercises.pendingReview} awaiting review</p>
      {progress.strugglingExercises.map((e) => <div className="performance-row" key={e.sectionId}>
        <Link href={`/lessons/${e.lessonId}#section-${e.sectionId}`}>{e.sectionTitle || "Exercise"} · {e.lessonTitle}</Link>
        <span className="warning">{e.incorrectSubmissions} incorrect · {e.completed ? "solved" : "not solved yet"}</span></div>)}</section>}
    <RecentAttempts progress={progress} />
    <section className="panel"><h2>Instructor feedback</h2>
      {!progress.feedback.length && <p className="muted">No feedback yet. Your instructor can review assessments through MCP.</p>}
      {progress.feedback.map((f) => <div className="feedback" key={f.id}><p>{f.message}</p>
        {f.attempt_id && <Link href={`/attempts/${f.attempt_id}/results`}>View assessment →</Link>}
        {f.topic_id && <Link href={`/topics/${f.topic_id}`}>View topic →</Link>}</div>)}</section></>;
}
