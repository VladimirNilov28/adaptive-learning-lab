import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getStore } from "@/lib/store";

export default async function TopicPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, store = getStore();
  let topic;
  try { topic = store.getTopic(id); } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound(); throw error;
  }
  const course = store.listCourses().map((c) => store.structure(c.id))
    .find((c) => c.phases.some((p) => p.topics.some((t) => t.id === id)))!;
  const full = course.phases.flatMap((p) => p.topics).find((t) => t.id === id)!;
  const feedback = store.progress(course.id).feedback.filter((f) => f.topic_id === id);
  return <><Link className="back" href={`/courses/${course.id}`}>← {course.title}</Link>
    <div className="page-heading"><p className="eyebrow">Topic</p><h1>{topic.title}</h1><p className="muted">{topic.description}</p></div>
    <section className="panel"><h2>Lessons</h2>{!full.lessons.length && <p className="muted">No lessons yet. Your instructor is preparing this topic.</p>}
      {full.lessons.map((l) => <Link className="lesson-row" href={`/lessons/${l.id}`} key={l.id}>
        <span>{l.completed ? "✓ " : ""}{l.title}<small>{l.description}</small></span><span>→</span></Link>)}</section>
    {feedback.length > 0 && <section className="panel"><h2>Instructor feedback</h2>
      {feedback.map((f) => <p className="feedback" key={f.id}>{f.message}</p>)}</section>}
  </>;
}
