import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getStore } from "@/lib/store";
import type { SectionKind } from "@/lib/schemas";
import { Markdown } from "@/components/markdown";
import { MutationButton } from "@/components/actions";
import { AssessmentList } from "@/components/assessments";
import { CourseSidebar } from "@/components/course-sidebar";
import { AskInstructor, ExerciseCard, LessonTracker, SectionDone, type AskContext } from "@/components/lesson";

const kindLabel: Record<SectionKind, string> = {
  introduction: "Introduction", objectives: "Learning objectives", theory: "Concept", example: "Example",
  exercise: "Exercise", explanation: "Explanation", knowledge_check: "Knowledge check", summary: "Summary", note: "Note",
};

export default async function LessonPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, store = getStore();
  let lesson;
  try { lesson = store.studentLesson(id); } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound(); throw error;
  }
  const topic = store.getTopic(lesson.topic_id);
  const course = store.listCourses().map((c) => store.structure(c.id))
    .find((c) => c.phases.some((p) => p.topics.some((t) => t.id === topic.id)))!;
  const phase = course.phases.find((p) => p.topics.some((t) => t.id === topic.id))!;
  const lessons = course.phases.flatMap((p) => p.topics).flatMap((t) => t.lessons);
  const current = lessons.findIndex((l) => l.id === id), completed = lessons[current].completed;
  const previous = lessons[current - 1], next = lessons[current + 1];
  const progress = store.progress(course.id);
  const assessments = lesson.assessmentIds.length ? lesson.assessmentIds.map((assessmentId) => store.getAssessment(assessmentId)) :
    store.listAssessments(course.id);
  const sections = lesson.sections, done = sections.filter((s) => s.completed).length;
  const resume = lesson.lastSectionId && sections.findIndex((s) => s.id === lesson.lastSectionId) > 0 ?
    sections.find((s) => s.id === lesson.lastSectionId) : undefined;
  const ask: AskContext = { courseTitle: course.title, courseId: course.id, topicTitle: topic.title, topicId: topic.id,
    lessonTitle: lesson.title, lessonId: lesson.id };
  const label = (s: (typeof sections)[number]) => s.title || kindLabel[s.kind];
  return <div className="lesson-layout">
    <CourseSidebar course={course} lessonId={id} />
    <article className="lesson-main">
      <nav className="breadcrumb" aria-label="Breadcrumb"><Link href={`/courses/${course.id}`}>{course.title}</Link><span aria-hidden>/</span>
        <span>{phase.title}</span><span aria-hidden>/</span><Link href={`/topics/${topic.id}`}>{topic.title}</Link></nav>
      <header className="lesson-header"><p className="eyebrow">Lesson {current + 1} of {lessons.length}{completed ? " · Completed" : ""}</p>
        <h1>{lesson.title}</h1>{lesson.description && <p className="lead">{lesson.description}</p>}
        <div className="lesson-meta">{sections.length > 0 && <div className="section-progress">
          <progress value={done} max={sections.length} aria-label="Sections completed" />
          <span className="muted small-text">{done} of {sections.length} sections</span></div>}
          <AskInstructor context={ask} compact /></div>
        {resume && !completed && <Link className="resume-link" href={`#section-${resume.id}`}>Continue where you left off: {label(resume)} ↓</Link>}
      </header>
      {lesson.content && <section className="lesson-section" id="lesson-intro"><Markdown>{lesson.content}</Markdown></section>}
      {!lesson.content && !sections.length && <p className="empty">Lesson content is being prepared.</p>}
      {sections.map((s) => {
        const context = { ...ask, sectionId: s.id, sectionTitle: label(s) };
        return <section key={s.id} id={`section-${s.id}`} data-section-id={s.id}
          className={`lesson-section kind-${s.kind} ${s.question ? "interactive" : ""}`}>
          <header className="section-head"><span className="section-kind">{kindLabel[s.kind]}{s.completed ? " ✓" : ""}</span>
            {!s.question && <AskInstructor context={context} compact />}</header>
          {s.title && <h2>{s.title}</h2>}
          {s.content && <Markdown>{s.content}</Markdown>}
          {s.question && <ExerciseCard section={s} askContext={context} />}
          {!s.question && <SectionDone sectionId={s.id} completed={s.completed} />}
          <span data-section-end={s.id} aria-hidden />
        </section>;
      })}
      <footer className="lesson-footer">
        <div className="row"><MutationButton secondary={completed}
          data={{ action: "complete_lesson", lessonId: id, completed: !completed }}>
          {completed ? "Mark as incomplete" : "Mark lesson complete"}</MutationButton>
          {sections.length > 0 && done < sections.length && !completed &&
            <span className="muted small-text">Completing every section also completes the lesson.</span>}</div>
        <nav className="pager" aria-label="Lesson navigation">
          {previous ? <Link href={`/lessons/${previous.id}`} className="pager-link"><small>← Previous</small>{previous.title}</Link> : <span />}
          {next ? <Link href={`/lessons/${next.id}`} className="pager-link next"><small>Next →</small>{next.title}</Link> : <span />}
        </nav>
        <AssessmentList title={lesson.assessmentIds.length ? "Related assessments" : "Course assessments"}
          assessments={assessments} progress={progress} />
      </footer>
      <LessonTracker lessonId={id} autoComplete={sections.filter((s) => !s.question && !s.completed).map((s) => s.id)} />
    </article>
    {sections.length > 1 && <aside className="lesson-toc" aria-label="On this page"><p className="eyebrow">On this page</p>
      <ol>{lesson.content && <li><a href="#lesson-intro">Overview</a></li>}
        {sections.map((s) => <li key={s.id} className={s.completed ? "done" : ""}><a href={`#section-${s.id}`}>
          <span className="check" aria-label={s.completed ? "Completed" : undefined}>{s.completed ? "✓" : ""}</span>
          <span>{s.question ? `${kindLabel[s.kind]}: ` : ""}{label(s)}</span></a></li>)}</ol></aside>}
  </div>;
}
