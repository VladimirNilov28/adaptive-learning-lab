"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import type { AnswerValue, StudentSection } from "@/lib/schemas";
import { Markdown } from "./markdown";
import { studentApi } from "./actions";
import { copyText, InlineText } from "./code-block";

const choice = (type: string) => type === "single_choice" || type === "multiple_choice";
const draftKey = (sectionId: string) => `exercise-draft:${sectionId}`;
export const typeLabel: Record<string, string> = {
  single_choice: "Single choice", multiple_choice: "Multiple choice", short_text: "Short answer",
  code_text: "Code / command", predict_output: "Predict the output", find_bug: "Find the bug",
};

function display(value: AnswerValue, q: NonNullable<StudentSection["question"]>) {
  if (value === null) return "";
  return Array.isArray(value) ? value.map((key) => q.options.find((o) => o.id === key)?.text ?? key).join("\n") : value;
}

export function ExerciseCard({ section, askContext }: { section: StudentSection; askContext: AskContext }) {
  const router = useRouter();
  const [local, setLocal] = useState<StudentSection | null>(null);
  // Prefer the freshest view: our own submission until the server catches up, then server data (e.g. instructor review).
  const view = local && local.submissions > section.submissions ? local : section;
  const q = view.question!, initial = (view.latest?.value ?? (choice(q.type) ? [] : q.starterCode ?? "")) as AnswerValue;
  const [value, setValue] = useState<AnswerValue>(initial);
  const [hint, setHint] = useState(false), [reveal, setReveal] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(""), [restored, setRestored] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(draftKey(section.id));
      if (saved !== null) { setValue(JSON.parse(saved) as AnswerValue); setRestored(true); }
    } catch { /* drafts are a convenience only */ }
  }, [section.id]);

  function change(next: AnswerValue) {
    setValue(next); setError("");
    try { localStorage.setItem(draftKey(section.id), JSON.stringify(next)); } catch { /* ignore */ }
  }
  function reset() {
    setValue(choice(q.type) ? [] : q.starterCode ?? ""); setRestored(false); setError("");
    try { localStorage.removeItem(draftKey(section.id)); } catch { /* ignore */ }
  }
  async function submit() {
    setBusy(true); setError(""); setReveal(false);
    try {
      const updated = await studentApi<StudentSection>({ action: "submit_exercise", sectionId: section.id, value });
      setLocal(updated); setRestored(false);
      try { localStorage.removeItem(draftKey(section.id)); } catch { /* ignore */ }
      router.refresh();
    } catch (e) { setError(e instanceof Error ? e.message : "Could not submit your answer"); }
    finally { setBusy(false); }
  }

  const selected = Array.isArray(value) ? value : [];
  const latest = view.latest, written = !choice(q.type);
  const status = !latest ? null : latest.score === null ? "pending" : latest.score === 1 ? "correct" :
    latest.score > 0 ? "partial" : "incorrect";
  const code = q.type !== "short_text";
  const inputId = `exercise-input-${section.id}`;
  return <div className={`exercise ${status ? `exercise-${status}` : ""}`}>
    <div className="exercise-head"><span className="exercise-label">{view.kind === "knowledge_check" ? "Knowledge check" : "Exercise"}</span>
      <span className="badge">{typeLabel[q.type]}</span><span className="badge">{q.difficulty}</span>
      {view.completed && <span className="badge correct">✓ Completed</span>}
      <AskInstructor context={{ ...askContext, exercisePrompt: q.prompt }} compact /></div>
    <Markdown>{q.prompt}</Markdown>
    {choice(q.type) ? <fieldset disabled={busy}><legend className="muted small-text">
      {q.type === "multiple_choice" ? "Select all that apply." : "Select one answer."}</legend>
      {q.options.map((o) => <label className={`answer-option ${selected.includes(o.id) ? "selected" : ""}`} key={o.id}>
        <input type={q.type === "single_choice" ? "radio" : "checkbox"} name={`ex-${section.id}`} checked={selected.includes(o.id)}
          onChange={() => change(q.type === "single_choice" ? [o.id] :
            selected.includes(o.id) ? selected.filter((key) => key !== o.id) : [...selected, o.id])} />
        <span><InlineText text={o.text} /></span></label>)}
    </fieldset> : <div className="code-input">
      <label htmlFor={inputId} className="code-input-label"><span>{q.type === "predict_output" ? "Expected output" :
        q.type === "find_bug" ? "Corrected version and explanation" : code ? "Your answer" : "Your response"}</span>
        {q.language && <span className="muted">{q.language}</span>}</label>
      <textarea id={inputId} className={code ? "mono" : ""} rows={code ? Math.min(18, Math.max(6, String(value ?? "").split("\n").length + 2)) : 4}
        spellCheck={!code} autoCapitalize="off" autoCorrect="off" value={typeof value === "string" ? value : ""} maxLength={200_000}
        disabled={busy} onChange={(e) => change(e.target.value)}
        placeholder={code ? "Type your answer. It is saved as text and never executed." : "Type your answer."} />
    </div>}
    {restored && <p className="muted small-text">Unsubmitted draft restored from this browser.</p>}
    <div className="exercise-actions">
      <button className="button" disabled={busy} onClick={() => void submit()}>{busy ? "Submitting..." : latest ? "Submit again" : "Submit answer"}</button>
      {q.hint && <button className="button secondary" aria-expanded={hint} onClick={() => setHint(!hint)}>{hint ? "Hide hint" : "Show hint"}</button>}
      <button className="button ghost" disabled={busy} onClick={reset}>Reset answer</button>
      {view.submissions > 0 && <span className="muted small-text">{view.submissions} attempt{view.submissions === 1 ? "" : "s"}</span>}
    </div>
    {hint && q.hint && <div className="callout callout-tip" data-callout="hint"><Markdown>{q.hint}</Markdown></div>}
    {error && <p className="error" role="alert">{error}</p>}
    <div aria-live="polite">{latest && <div className={`exercise-feedback feedback-${status}`}>
      <p className="feedback-title">{status === "correct" ? (written ? `Reviewed · ${latest.score} / 1` : "Correct") :
        status === "pending" ? "Submitted · awaiting instructor review" :
        status === "partial" ? `Reviewed · partially correct (${latest.score} / 1)` :
        written ? `Reviewed · ${latest.score} / 1` : "Not quite — review and try again"}</p>
      {status === "pending" && <p className="muted small-text">Your answer is saved. Your instructor reviews written answers through MCP;
        feedback will appear here. You can keep going.</p>}
      {written && <><p className="muted small-text">Last submitted answer</p><pre className="answer-text">{display(latest.value, q)}</pre></>}
      {latest.feedback && <><p className="muted small-text">Instructor feedback</p><div className="feedback"><Markdown>{latest.feedback}</Markdown></div></>}
      {status === "correct" ? q.explanation && <Markdown>{q.explanation}</Markdown> :
        (q.explanation || q.correctAnswer) && (reveal ? <div className="reveal">
          {q.correctAnswer && <><p className="muted small-text">Correct answer</p><pre className="answer-text">{display(q.correctAnswer, q)}</pre></>}
          {q.explanation && <Markdown>{q.explanation}</Markdown>}
        </div> : <button className="button ghost" onClick={() => setReveal(true)}>
          {q.correctAnswer ? "Reveal answer and explanation" : "Show explanation"}</button>)}
    </div>}</div>
  </div>;
}

export function SectionDone({ sectionId, completed }: { sectionId: string; completed: boolean }) {
  const router = useRouter(), [busy, setBusy] = useState(false), [error, setError] = useState("");
  return <div className="section-done"><button className={`button ghost ${completed ? "done" : ""}`} disabled={busy}
    aria-pressed={completed} onClick={async () => {
      setBusy(true); setError("");
      try { await studentApi({ action: "complete_section", sectionId, completed: !completed }); router.refresh(); }
      catch (e) { setError(e instanceof Error ? e.message : "Could not update"); }
      finally { setBusy(false); }
    }}>{completed ? "✓ Read" : "Mark as read"}</button>{error && <span className="error">{error}</span>}</div>;
}

/** Marks reading sections complete once their end has been visible for a moment, and remembers the reading position. */
export function LessonTracker({ lessonId, autoComplete }: { lessonId: string; autoComplete: string[] }) {
  const router = useRouter();
  const pending = useRef(new Set(autoComplete));
  useEffect(() => { pending.current = new Set(autoComplete); }, [autoComplete]);
  useEffect(() => {
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    let positionTimer: ReturnType<typeof setTimeout> | undefined, lastSaved = "";
    const ends = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const sectionId = (entry.target as HTMLElement).dataset.sectionEnd!;
        if (!entry.isIntersecting) { clearTimeout(timers.get(sectionId)); timers.delete(sectionId); continue; }
        if (!pending.current.has(sectionId) || timers.has(sectionId)) continue;
        timers.set(sectionId, setTimeout(() => {
          pending.current.delete(sectionId);
          studentApi({ action: "complete_section", sectionId, completed: true }).then(() => router.refresh(), () => {
            pending.current.add(sectionId);
          });
        }, 1500));
      }
    }, { threshold: 1 });
    const starts = new IntersectionObserver((entries) => {
      const visible = entries.filter((e) => e.isIntersecting).map((e) => (e.target as HTMLElement).dataset.sectionId!);
      if (!visible.length) return;
      clearTimeout(positionTimer);
      positionTimer = setTimeout(() => {
        if (visible[0] === lastSaved) return;
        lastSaved = visible[0];
        void studentApi({ action: "set_position", lessonId, sectionId: visible[0] }).catch(() => { lastSaved = ""; });
      }, 2000);
    }, { rootMargin: "0px 0px -60% 0px" });
    document.querySelectorAll<HTMLElement>("[data-section-end]").forEach((el) => ends.observe(el));
    document.querySelectorAll<HTMLElement>("[data-section-id]").forEach((el) => starts.observe(el));
    return () => { ends.disconnect(); starts.disconnect(); timers.forEach(clearTimeout); clearTimeout(positionTimer); };
  }, [lessonId, router]);
  return null;
}

export type AskContext = {
  courseTitle: string; courseId: string; topicTitle: string; topicId: string; lessonTitle: string; lessonId: string;
  sectionTitle?: string; sectionId?: string; exercisePrompt?: string;
};

function compose(c: AskContext, selection: string) {
  const lines = [
    "I have a question about my Adaptive Learning Lab lesson.", "",
    `Course: ${c.courseTitle} (courseId: ${c.courseId})`,
    `Topic: ${c.topicTitle} (topicId: ${c.topicId})`,
    `Lesson: ${c.lessonTitle} (lessonId: ${c.lessonId})`,
  ];
  if (c.sectionId) lines.push(`Section: ${c.sectionTitle || "Untitled section"} (sectionId: ${c.sectionId})`);
  if (selection) lines.push("", "The part I am asking about:", ...selection.split("\n").map((l) => `> ${l}`));
  if (c.exercisePrompt) lines.push("", "Exercise:", ...c.exercisePrompt.slice(0, 1500).split("\n").map((l) => `> ${l}`));
  lines.push("", "My question: ");
  return lines.join("\n");
}

/** Builds an editable, copyable question for the external instructor. Never includes keys or hidden explanations. */
export function AskInstructor({ context, compact = false }: { context: AskContext; compact?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null), selection = useRef("");
  const [text, setText] = useState(""), [copied, setCopied] = useState("");
  return <>
    <button type="button" className={compact ? "ask-link" : "button secondary"}
      onMouseDown={() => { selection.current = window.getSelection()?.toString().trim().slice(0, 800) ?? ""; }}
      onClick={() => {
        if (!selection.current) selection.current = window.getSelection()?.toString().trim().slice(0, 800) ?? "";
        setText(compose(context, selection.current)); setCopied(""); selection.current = "";
        dialog.current?.showModal();
      }}>Ask instructor</button>
    <dialog ref={dialog} className="ask-dialog" aria-labelledby={`ask-title-${context.sectionId ?? context.lessonId}`}>
      <h2 id={`ask-title-${context.sectionId ?? context.lessonId}`}>Ask your instructor</h2>
      <p className="muted small-text">Edit the question, copy it, and paste it into your instructor chat (for example ChatGPT Desktop with this MCP server connected).
        The IDs let the instructor find this exact place through MCP. Nothing is sent automatically.</p>
      <label className="sr-only" htmlFor={`ask-text-${context.sectionId ?? context.lessonId}`}>Question</label>
      <textarea id={`ask-text-${context.sectionId ?? context.lessonId}`} rows={12} value={text} onChange={(e) => setText(e.target.value)} />
      <div className="exercise-actions">
        <button className="button" onClick={async () => setCopied(await copyText(text) ? "Copied — paste it into your instructor chat." :
          "Copy failed — select the text and copy it manually.")}>Copy question</button>
        <a className="button secondary" href="https://chatgpt.com/" target="_blank" rel="noopener noreferrer">Open ChatGPT ↗</a>
        <button className="button ghost" onClick={() => dialog.current?.close()}>Close</button>
      </div>
      <p className="small-text muted" aria-live="polite">{copied}</p>
    </dialog>
  </>;
}
