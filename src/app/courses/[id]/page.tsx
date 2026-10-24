import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getStore } from "@/lib/store";
import { CourseOutline, ProgressStats, Recommendation } from "@/components/course";
import { MutationButton } from "@/components/actions";
import { AssessmentList, CourseNav } from "@/components/assessments";

export default async function CoursePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params, store = getStore();
  let course;
  try { course = store.structure(id); } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound(); throw error;
  }
  const progress = store.progress(id), assessments = store.listAssessments(id);
  return <><Link className="back" href="/">← Dashboard</Link><div className="page-heading"><p className="eyebrow">Course overview</p>
    <h1>{course.title}</h1><p className="muted">{course.description}</p>
    {store.activeCourseId() !== id && <MutationButton data={{ action: "set_active_course", courseId: id }}>Make active course</MutationButton>}
  </div><CourseNav courseId={id} /><ProgressStats progress={progress} /><Recommendation progress={progress} />
    <AssessmentList assessments={assessments} progress={progress} /><CourseOutline course={course} /></>;
}
