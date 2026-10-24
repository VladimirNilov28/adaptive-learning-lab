import { notFound, redirect } from "next/navigation";
import { AppError, getStore } from "@/lib/store";
import { AssessmentRunner } from "@/components/assessment-runner";

export default async function AttemptPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  let attempt;
  try { attempt = getStore().studentAttempt(id); } catch (error) {
    if (error instanceof AppError && error.status === 404) notFound(); throw error;
  }
  if (attempt.submitted_at) redirect(`/attempts/${id}/results`);
  return <AssessmentRunner key={id} initial={attempt} />;
}
