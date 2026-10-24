import Link from "next/link";
import { getStore } from "@/lib/store";
import { RecentAttempts } from "@/components/course";
import { MutationButton } from "@/components/actions";
import { AssessmentList } from "@/components/assessments";

export default function Dashboard() {
  const store = getStore(), courses = store.listCourses(), activeId = store.activeCourseId();
  if (!courses.length) return <section className="empty hero-empty"><span className="empty-icon">↗</span>
    <h1>A clean slate for your next goal</h1><p>There are no courses yet. Connect a compatible local MCP client and ask your instructor to create a course, phases, topics, and lessons.</p>
    <p className="muted">Start the instructor server with <code>npm run mcp</code>. See the README for client setup. This app does not contain an embedded AI or sample curriculum.</p>
  </section>;
  const active = courses.find((c) => c.id === activeId) ?? courses[0];
  const progress = store.progress(active.id), r = progress.recommendation, last = progress.lastPosition;
  const resume = last && !last.lessonCompleted ? last : null;
  const lessonPct = progress.totalLessons ? Math.round(progress.completedLessons / progress.totalLessons * 100) : 0;
  const activeAttempt = progress.attempts.find((a) => !a.submitted_at);
  const pendingAttempts = progress.attempts.filter((a) => a.result?.pendingReview).length;
  const attention = [
    ...(activeAttempt ? [{ key: activeAttempt.id, href: `/attempts/${activeAttempt.id}`, label: `${activeAttempt.title} is in progress`, note: "Resume" }] : []),
    ...progress.weakTopics.map((t) => ({ key: t.topicId, href: `/topics/${t.topicId}`, label: t.title, note: `${t.percentage}% on graded answers` })),
    ...progress.strugglingExercises.slice(0, 5).map((e) => ({ key: e.sectionId, href: `/lessons/${e.lessonId}#section-${e.sectionId}`,
      label: `${e.sectionTitle || "Exercise"} · ${e.lessonTitle}`, note: `${e.incorrectSubmissions} incorrect ${e.incorrectSubmissions === 1 ? "try" : "tries"}` })),
  ];
  const waiting = pendingAttempts + progress.exercises.pendingReview;
  return <>
    <div className="page-heading row"><div><p className="eyebrow">{courses.length > 1 ? "Active course" : "Your course"}</p>
      <h1 style={{ fontSize: "clamp(1.5rem, 3vw, 2rem)" }}>{active.title}</h1></div>
      <Link className="button ghost" href={`/courses/${active.id}`}>Course outline</Link></div>

    <section className="panel continue-card" aria-labelledby="continue-title">
      {resume ? <><p className="eyebrow">Continue learning</p><h2 id="continue-title">{resume.lessonTitle}</h2>
        <p className="muted">{resume.sectionTitle ? `You stopped at “${resume.sectionTitle}”.` : "Pick up where you left off."}</p>
        <Link className="button" href={`/lessons/${resume.lessonId}${resume.sectionId ? `#section-${resume.sectionId}` : ""}`}>Continue →</Link>
        {r?.lessonId && r.lessonId !== resume.lessonId && <p className="small-text muted" style={{ marginTop: 14 }}>
          Recommended next: <Link className="accent" href={`/lessons/${r.lessonId}`}>{r.lessonTitle}</Link> — {r.reason}</p>}</> :
      r ? <><p className="eyebrow">Up next</p><h2 id="continue-title">{r.lessonTitle ?? r.topicTitle}</h2><p className="muted">{r.reason}</p>
        <Link className="button" href={r.lessonId ? `/lessons/${r.lessonId}` : `/topics/${r.topicId}`}>{r.lessonId ? "Start lesson" : "Explore topic"} →</Link></> :
      <><p className="eyebrow">Up next</p><h2 id="continue-title">{progress.totalLessons ? "All lessons complete" : "Your learning path starts here"}</h2>
        <p className="muted">{progress.totalLessons ? "Your instructor can review your progress and recommend more practice." :
          "Your instructor has not added lessons yet. They will appear here as soon as they are created through MCP."}</p></>}
    </section>

    <div className="dash-grid">
      <section className="panel" aria-labelledby="progress-title"><div className="row"><h2 id="progress-title">Progress</h2>
        <Link className="small-text accent" href="/progress">Details →</Link></div>
        <div className="meter"><div className="meter-row"><span>Lessons</span><span className="muted">{progress.completedLessons} / {progress.totalLessons}</span></div>
          <progress value={lessonPct} max={100} aria-label="Lessons completed" /></div>
        {progress.exercises.total > 0 && <div className="meter"><div className="meter-row"><span>Exercises</span>
          <span className="muted">{progress.exercises.completed} / {progress.exercises.total}</span></div>
          <progress value={progress.exercises.completed} max={progress.exercises.total} aria-label="Exercises completed" /></div>}
        <div className="meter-row"><span>Assessments submitted</span><span className="muted">{progress.attempts.filter((a) => a.submitted_at).length}</span></div>
        {waiting > 0 && <div className="meter-row"><span>Awaiting instructor review</span><span className="muted">{waiting}</span></div>}
      </section>
      <section className="panel" aria-labelledby="attention-title"><h2 id="attention-title">Needs attention</h2>
        {!attention.length ? <p className="muted">Nothing flagged. Topics and exercises that need more practice will appear here.</p> :
          <ul className="attention">{attention.map((a) => <li key={a.key}><Link href={a.href}>{a.label}</Link><span className="muted small-text">{a.note}</span></li>)}</ul>}
      </section>
    </div>
    <div className="section-heading"><h2>Assessments</h2><Link href={`/assessments?courseId=${active.id}`}>All assessments →</Link></div>
    <AssessmentList title="Available assessments" assessments={store.listAssessments(active.id)} progress={progress} />
    {progress.attempts.length > 0 && <RecentAttempts progress={progress} limit={3} />}
    {courses.length > 1 && <section className="panel"><h2>Other courses</h2>
      {courses.filter((c) => c.id !== active.id).map((c) => <div className="assessment-row" key={c.id}>
        <Link href={`/courses/${c.id}`}>{c.title}</Link>
        <MutationButton secondary data={{ action: "set_active_course", courseId: c.id }}>Make active</MutationButton></div>)}</section>}
  </>;
}
