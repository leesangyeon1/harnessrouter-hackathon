"use client";
export default function ErrorPage({
  reset,
}: {
  error: Error;
  reset: () => void;
}) {
  return (
    <main className="fatal-state">
      <div className="brand-mark">h</div>
      <h1>Let’s try that again.</h1>
      <p>The workspace couldn’t load. Your accounts haven’t changed.</p>
      <button className="button primary" onClick={reset}>
        Reload workspace
      </button>
    </main>
  );
}
