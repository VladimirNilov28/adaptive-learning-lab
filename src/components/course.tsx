import Link from "next/link";
import type { CourseStructure } from "@/lib/schemas";
import type { Store } from "@/lib/store";

export function CourseOutline({ course }: { course: CourseStructure }) {
  if (!course.phases.length) return <div className="empty">No phases yet. Your instructor can add phases, topics, and lessons through MCP.</div>;
  return <div className="stack">{course.phases.map((phase, i) => <section className="panel" key={phase.id}>
    <p className="eyebrow">Phase {i + 1}</p><h2>{phase.title}</h2><p className="muted">{phase.description}</p>
    {!phase.topics.length && <p className="muted">No topics in this phase yet.</p>}
    {phase.topics.map((topic) => <div className="topic" key={topic.id}>
      <div className="row"><h3><Link href={`/topics/${topic.id}`}>{topic.title}</Link></h3>
        {topic.priority > 0 && <span className="badge">Priority {topic.priority}</span>}</div>
      <p className="muted">{topic.description}</p>
      {!topic.lessons.length && <p className="muted">Lessons are being prepared.</p>}
      {topic.lessons.map((lesson) => <Link className="lesson-row" href={`/lessons/${lesson.id}`} key={lesson.id}>
        <span className={lesson.completed ? "accent" : "muted"} aria-label={lesson.completed ? "Completed" : "Not completed"}>
          {lesson.completed ? "✓" : "○"}</span>
        <span>{lesson.title}<small>{lesson.description}</small></span>
        <span className="muted small-text">{lesson.sectionCount > 0 ? `${lesson.sectionsCompleted}/${lesson.sectionCount} sections ` : ""}→</span>
      </Link>)}
    </div>)}
  </section>)}</div>;
}

export function Recommendation({ progress }: { progress: ReturnType<Store["progress"]> }) {
  const r = progress.recommendation;
  return <section className="panel recommended"><p className="eyebrow">Your next step</p>
    {r ? <><h2>{r.lessonTitle ?? r.topicTitle}</h2><p className="muted">{r.reason}</p>
      <Link className="button" href={r.lessonId ? `/lessons/${r.lessonId}` : `/topics/${r.topicId}`}>
        {r.lessonId ? "Open lesson" : "Explore topic"} →</Link></> :
      <><h2>{progress.totalLessons ? "All lessons complete" : "Your learning path starts here"}</h2>
        <p className="muted">{progress.totalLessons ? "Your instructor can review progress and recommend more practice." :
          "Connect an external MCP instructor to create your curriculum."}</p></>}
  </section>;
}

export function ProgressStats({ progress }: { progress: ReturnType<Store["progress"]> }) {
  const percentage = progress.totalLessons ? Math.round(progress.completedLessons / progress.totalLessons * 100) : 0;
  return <div className="stats">
    <div className="panel"><p className="muted">Lessons complete</p><strong>{progress.completedLessons} / {progress.totalLessons}</strong>
      <progress value={percentage} max={100} aria-label="Lesson completion" /></div>
    <div className="panel"><p className="muted">Submitted assessments</p><strong>{progress.attempts.filter((a) => a.submitted_at).length}</strong></div>
    <div className="panel"><p className="muted">Topics to practice</p><strong>{progress.weakTopics.length}</strong></div>
  </div>;
}

export function RecentAttempts({ progress, limit = 20 }: { progress: ReturnType<Store["progress"]>; limit?: number }) {
  return <section className="panel"><h2>{limit < 20 ? "Recent results" : "Assessment attempts"}</h2>
    {!progress.attempts.length && <p className="muted">No attempts yet. Assessments will appear when your instructor creates them.</p>}
    {progress.attempts.slice(0, limit).map((a) => <Link className="lesson-row"
      href={a.submitted_at ? `/attempts/${a.id}/results` : `/attempts/${a.id}`} key={a.id}>
      <span>{a.title}<small>{new Date(a.started_at).toLocaleString("en-GB", { timeZone: "UTC" })} UTC</small></span>
      <span className="badge">{a.result ? a.result.pendingReview ?
        `Awaiting review · ${a.result.gradedCount}/${a.result.total} graded` : `${a.result.percentage}%` : "Resume"}</span>
    </Link>)}
    {progress.attempts.length > limit && <p className="muted small-text">{limit < 20 ? <Link className="accent" href="/progress">All attempts →</Link> :
      "Showing the latest 20 attempts. All results remain available through MCP."}</p>}
  </section>;
}
