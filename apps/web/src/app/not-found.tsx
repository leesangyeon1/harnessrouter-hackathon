import Link from "next/link";
export default function NotFound() {
  return (
    <main className="fatal-state">
      <h1>A little off track.</h1>
      <p>This page isn’t in your workspace.</p>
      <Link className="button primary" href="/">
        Back to overview
      </Link>
    </main>
  );
}
