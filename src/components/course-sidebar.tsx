import Link from "next/link";
import type { CourseStructure } from "@/lib/schemas";

function Tree({ course, lessonId }: { course: CourseStructure; lessonId: string }) {
  return <>{course.phases.map((phase, i) => {
    const lessons = phase.topics.flatMap((t) => t.lessons);
    const done = lessons.filter((l) => l.completed).length;
    return <details key={phase.id} className="nav-phase" open={phase.topics.some((t) => t.lessons.some((l) => l.id === lessonId))}>
      <summary><span>{i + 1}. {phase.title}</span><span className="muted">{done}/{lessons.length}</span></summary>
      {phase.topics.map((topic) => <div key={topic.id} className="nav-topic">
        <Link className="nav-topic-title" href={`/topics/${topic.id}`}>{topic.title}</Link>
        <ul>{topic.lessons.map((l) => <li key={l.id}><Link href={`/lessons/${l.id}`} aria-current={l.id === lessonId ? "page" : undefined}
          className={l.id === lessonId ? "active" : ""}>
          <span className={l.completed ? "check done" : "check"} aria-label={l.completed ? "Completed" : "Not completed"}>{l.completed ? "✓" : ""}</span>
          <span>{l.title}</span></Link></li>)}</ul>
      </div>)}
    </details>;
  })}</>;
}

/** Desktop: sticky sidebar. Mobile: collapsible menu above the lesson. */
export function CourseSidebar({ course, lessonId }: { course: CourseStructure; lessonId: string }) {
  const lessons = course.phases.flatMap((p) => p.topics).flatMap((t) => t.lessons);
  const head = <div className="sidebar-head"><Link href={`/courses/${course.id}`} className="sidebar-course">{course.title}</Link>
    <p className="muted small-text">{lessons.filter((l) => l.completed).length} of {lessons.length} lessons complete</p>
    <Link className="small-text accent" href={`/assessments?courseId=${course.id}`}>Assessments →</Link></div>;
  return <>
    <aside className="course-sidebar" aria-label="Course navigation">{head}<Tree course={course} lessonId={lessonId} /></aside>
    <details className="course-menu"><summary>Course menu · {lessons.findIndex((l) => l.id === lessonId) + 1} of {lessons.length}</summary>
      <nav aria-label="Course navigation (mobile)">{head}<Tree course={course} lessonId={lessonId} /></nav></details>
  </>;
}
