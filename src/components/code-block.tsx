"use client";

import { useRef, useState } from "react";

export async function copyText(text: string) {
  try { await navigator.clipboard.writeText(text); return true; } catch {
    const area = document.createElement("textarea");
    area.value = text; area.setAttribute("readonly", ""); area.style.position = "fixed"; area.style.opacity = "0";
    document.body.appendChild(area); area.select();
    const ok = document.execCommand("copy"); area.remove();
    return ok;
  }
}

export function CodeBlock({ children, ...props }: React.ComponentProps<"pre">) {
  const ref = useRef<HTMLPreElement>(null), [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const child = Array.isArray(children) ? children[0] : children;
  const className = (child as { props?: { className?: string } } | undefined)?.props?.className ?? "";
  const language = /language-([\w+#.-]+)/.exec(className)?.[1];
  return <div className="code-block">
    <div className="code-toolbar"><span>{language ?? "text"}</span>
      <button type="button" onClick={async () => {
        setState(await copyText(ref.current?.querySelector("code")?.textContent ?? ref.current?.textContent ?? "") ? "copied" : "failed");
        setTimeout(() => setState("idle"), 1800);
      }} aria-label="Copy code to clipboard">{state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : "Copy"}</button>
    </div>
    <pre ref={ref} {...props}>{children}</pre>
  </div>;
}

export function InlineText({ text }: { text: string }) {
  return <>{text.split(/(`[^`\n]+`)/).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={i}>{part.slice(1, -1)}</code> : part)}</>;
}
