"use client";
export default function ErrorPage({ reset }: { reset: () => void }) {
  return <div className="empty"><h1>Could not load your workspace</h1><p>Check the application terminal for storage errors. Your saved data has not been reset.</p>
    <button className="button" onClick={reset}>Try again</button></div>;
}
