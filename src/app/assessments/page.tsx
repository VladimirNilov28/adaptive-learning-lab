import Link from "next/link";
import { notFound } from "next/navigation";
import { AppError, getStore } from "@/lib/store";
import { AssessmentList, CourseNav } from "@/components/assessments";

export default async function AssessmentsPage({ searchParams }: {
  searchParams: Promise<{ courseId?: string }>;
}) {
  const { courseId } = await searchParams, store = getStore();
  let courses;
  try { courses = courseId ? [store.getCourse(courseId)] : store.listCourses(); }
  catch (error) {
    if (error instanceof AppError && error.status === 404) notFound(); throw error;
  }
  return <><div className="page-heading"><p className="eyebrow">Practice & exams</p><h1>Assessments</h1>
    <p className="muted">Read the instructions, then start when you are ready. Active attempts keep their original deadline.</p></div>
    {courseId && <><CourseNav courseId={courseId} /><Link className="back" href="/assessments">All courses →</Link></>}
    {!courses.length && <div className="empty">No courses yet. Your instructor can create a course and assessments through MCP.</div>}
    {courses.map((course) => <AssessmentList key={course.id} title={course.title}
      assessments={store.listAssessments(course.id)} progress={store.progress(course.id)} />)}
  </>;
}
