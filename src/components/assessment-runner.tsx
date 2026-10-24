"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnswerValue, AttemptView } from "@/lib/schemas";
import { Markdown } from "./markdown";
import { studentApi } from "./actions";
import { typeLabel } from "./lesson";
import { InlineText } from "./code-block";

export function AssessmentRunner({ initial }: { initial: AttemptView }) {
  const router = useRouter(), [index, setIndex] = useState(0);
  const [answers, setAnswers] = useState(initial.answers);
  const values = useRef(initial.answers);
  const [error, setError] = useState(""), [status, setStatus] = useState("All changes saved");
  const [confirm, setConfirm] = useState(false), [submitting, setSubmitting] = useState(false);
  const [navigating, setNavigating] = useState(false);
  const [remaining, setRemaining] = useState<number | null>(null);
  const offset = useRef(new Date(initial.serverNow).getTime() - Date.now());
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const queue = useRef<Promise<boolean>>(Promise.resolve(true));
  const revision = useRef(0);
  const dirty = useRef(new Map<string, { value: AnswerValue; revision: number }>());
  const busy = useRef(false), mounted = useRef(true);
  const question = initial.questions[index];
  const resultUrl = `/attempts/${initial.id}/results`;

  const flush = useCallback((keepalive = false): Promise<boolean> => {
    if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
    const batch = [...dirty.current.entries()];
    if (!batch.length) return queue.current;
    if (mounted.current) setStatus("Saving...");
    queue.current = queue.current.then(async () => {
      let success = true;
      for (const [questionId, edit] of batch) {
        if (dirty.current.get(questionId)?.revision !== edit.revision) continue;
        try {
          await studentApi({ action: "save_answer", attemptId: initial.id, questionId, value: edit.value }, keepalive);
          if (dirty.current.get(questionId)?.revision === edit.revision) dirty.current.delete(questionId);
        } catch (e) {
          success = false;
          if (mounted.current) setError(e instanceof Error ? e.message : "Could not save your answer");
        }
      }
      if (mounted.current) {
        setStatus(dirty.current.size ? success ? "Unsaved changes" : "Not saved — retry before leaving" : "All changes saved");
        if (!dirty.current.size) setError("");
      }
      return success && dirty.current.size === 0;
    });
    return queue.current;
  }, [initial.id]);

  const submit = useCallback(async (automatic = false) => {
    if (busy.current) return;
    busy.current = true; setSubmitting(true);
    try {
      if (!automatic && !await flush()) return;
      if (saveTimer.current) { clearTimeout(saveTimer.current); saveTimer.current = null; }
      await studentApi({ action: "submit_attempt", attemptId: initial.id });
      router.replace(resultUrl); router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Submission failed. Please retry."); }
    finally { busy.current = false; if (mounted.current) setSubmitting(false); }
  }, [flush, initial.id, resultUrl, router]);

  useEffect(() => {
    mounted.current = true;
    const hidden = () => { if (document.visibilityState === "hidden") void flush(true); };
    const leaving = () => { void flush(true); };
    document.addEventListener("visibilitychange", hidden);
    window.addEventListener("pagehide", leaving);
    return () => {
      mounted.current = false;
      void flush(true);
      document.removeEventListener("visibilitychange", hidden);
      window.removeEventListener("pagehide", leaving);
    };
  }, [flush]);
  useEffect(() => {
    if (!initial.deadline) return;
    const tick = () => {
      const seconds = Math.max(0, Math.ceil((Date.parse(initial.deadline!) - Date.now() - offset.current) / 1000));
      setRemaining(seconds);
      if (!seconds) void submit(true);
    };
    tick();
    const interval = setInterval(tick, 1000);
    return () => clearInterval(interval);
  }, [initial.deadline, submit]);
  useEffect(() => {
    const poll = async () => {
      try {
        const response = await fetch(`/api/student?attemptId=${encodeURIComponent(initial.id)}`, { cache: "no-store" });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? "Could not check attempt");
        const attempt = body as AttemptView;
        offset.current = Date.parse(attempt.serverNow) - Date.now();
        if (attempt.submitted_at) { router.replace(resultUrl); router.refresh(); }
      } catch (e) { if (mounted.current) setError(e instanceof Error ? e.message : "Connection failed"); }
    };
    const interval = setInterval(poll, 5000);
    window.addEventListener("focus", poll);
    return () => { clearInterval(interval); window.removeEventListener("focus", poll); };
  }, [initial.id, resultUrl, router]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty.current.size) { event.preventDefault(); void flush(true); }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [flush]);

  function change(value: AnswerValue) {
    revision.current++;
    dirty.current.set(question.id, { value, revision: revision.current });
    const updated = { ...values.current, [question.id]: value };
    values.current = updated; setAnswers(updated); setStatus("Unsaved changes");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => { saveTimer.current = null; void flush(); }, 400);
  }
  async function navigate(next: number) {
    setNavigating(true);
    try { if (await flush()) { setIndex(next); setConfirm(false); } }
    finally { setNavigating(false); }
  }
  const value = answers[question.id];
  const selected = Array.isArray(value) ? value : [];
  const hasAnswer = (questionId: string) => {
    const v = answers[questionId];
    return Array.isArray(v) ? v.length > 0 : typeof v === "string" && v.trim().length > 0;
  };
  const unanswered = initial.questions.map((q, i) => hasAnswer(q.id) ? 0 : i + 1).filter(Boolean);
  const answered = initial.questions.length - unanswered.length;
  const locked = submitting || navigating || remaining === 0;
  return <div className="reading"><div className="exam-heading"><p className="eyebrow">{initial.mode === "exam" ? "Exam · no hints or feedback until you submit" : "Practice assessment"}</p><h1>{initial.title}</h1></div>
    <div className="exam-bar"><div><strong>{answered} of {initial.questions.length} answered</strong>
      <span className="muted small-text" aria-live="polite" style={{ marginLeft: 12 }}>{status}</span></div>
      {initial.deadline && <div className={`timer ${remaining !== null && remaining < 300 ? "warning" : ""}`} role="timer" aria-label="Time remaining">
        {remaining === null ? "--:--" : `${Math.floor(remaining / 60).toString().padStart(2, "0")}:${(remaining % 60).toString().padStart(2, "0")}`}</div>}
    </div>
    {error && <div className="error panel" role="alert">{error}<button className="button secondary" disabled={locked} onClick={() => void flush()}>Retry save</button></div>}
    <nav className="question-nav" aria-label="Question navigation">{initial.questions.map((q, i) =>
      <button key={q.id} disabled={locked} onClick={() => void navigate(i)} aria-current={i === index ? "step" : undefined}
        aria-label={`Question ${i + 1}${hasAnswer(q.id) ? ", answered" : ", not answered"}`}
        className={`${i === index ? "current" : ""} ${hasAnswer(q.id) ? "answered" : ""}`}>
        {i + 1}</button>)}</nav>
    <div className="legend" aria-hidden><span className="l-answered">Answered</span><span>Not answered</span><span className="l-current">Current</span></div>
    <section className="panel question-panel"><p className="eyebrow">Question {index + 1} of {initial.questions.length} · {typeLabel[question.type]} · {question.difficulty}</p>
      <Markdown>{question.prompt}</Markdown>
      <fieldset disabled={locked} onBlur={() => void flush()}><legend className="sr-only">Your answer</legend>
        {question.type === "single_choice" || question.type === "multiple_choice" ?
          <><p className="muted">{question.type === "multiple_choice" ? "Select all that apply." : "Select one answer."}</p>
            {question.options.map((o) => <label className={`answer-option ${selected.includes(o.id) ? "selected" : ""}`} key={o.id}>
              <input type={question.type === "single_choice" ? "radio" : "checkbox"} name={question.id} checked={selected.includes(o.id)}
                onChange={() => change(question.type === "single_choice" ? [o.id] :
                  selected.includes(o.id) ? selected.filter((key) => key !== o.id) : [...selected, o.id])} />
              <span><InlineText text={o.text} /></span></label>)}</> :
          <><label htmlFor="written-answer">Your response</label><textarea id="written-answer" rows={question.type === "short_text" ? 5 : 12}
            className={question.type === "short_text" ? "" : "mono"} autoCapitalize="off" autoCorrect="off"
            spellCheck={question.type === "short_text"} maxLength={200_000}
            value={typeof value === "string" ? value : question.starterCode ?? ""} onChange={(e) => change(e.target.value)}
            placeholder="Write your answer here. Code is stored as text and is never executed." /></>}
      </fieldset>
    </section><div className="row"><button className="button secondary" disabled={locked || index === 0}
      onClick={() => void navigate(index - 1)}>← Previous</button>
      {index < initial.questions.length - 1 && <button className="button secondary" disabled={locked}
        onClick={() => void navigate(index + 1)}>Next →</button>}
      <button className="button" disabled={locked} onClick={() => setConfirm(true)}>Submit assessment</button></div>
    {confirm && <section className="panel confirm" role="alertdialog" aria-labelledby="submit-title" aria-describedby="submit-description">
      <h2 id="submit-title">Submit this attempt?</h2><p id="submit-description">
        {unanswered.length ? <span className="warning">{unanswered.length} unanswered: question{unanswered.length === 1 ? "" : "s"} {unanswered.join(", ")}. </span> :
          "All questions answered. "}You cannot change your responses after submission.</p><div className="row">
        <button className="button secondary" disabled={locked} onClick={() => setConfirm(false)}>Keep working</button>
        <button className="button" disabled={locked} onClick={() => void submit()}>{submitting ? "Submitting..." : "Confirm submission"}</button>
      </div></section>}
  </div>;
}
