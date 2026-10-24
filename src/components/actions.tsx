"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

export async function studentApi<T>(data: object, keepalive = false): Promise<T> {
  const response = await fetch("/api/student", {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data), keepalive,
  });
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? "Request failed");
  return body as T;
}

export function LiveRefresh() {
  const router = useRouter();
  useEffect(() => {
    const interval = setInterval(() => { if (document.visibilityState === "visible") router.refresh(); }, 10_000);
    const focus = () => router.refresh();
    window.addEventListener("focus", focus);
    return () => { clearInterval(interval); window.removeEventListener("focus", focus); };
  }, [router]);
  return null;
}

export function MutationButton({ data, children, href, secondary = false }: {
  data: object; children: React.ReactNode; href?: string; secondary?: boolean;
}) {
  const [busy, setBusy] = useState(false), [error, setError] = useState("");
  const router = useRouter();
  return <div><button className={secondary ? "button secondary" : "button"} disabled={busy}
    onClick={async () => {
      setBusy(true); setError("");
      try {
        const result = await studentApi<{ id?: string; submitted_at?: string | null }>(data);
        if (href) router.push(href === "attempt" ?
          `/attempts/${result.id}${result.submitted_at ? "/results" : ""}` : href);
        router.refresh();
      } catch (e) { setError(e instanceof Error ? e.message : "Operation failed"); }
      finally { setBusy(false); }
    }}>{busy ? "Saving..." : children}</button>
    {error && <p className="error" role="alert">{error}</p>}
  </div>;
}
