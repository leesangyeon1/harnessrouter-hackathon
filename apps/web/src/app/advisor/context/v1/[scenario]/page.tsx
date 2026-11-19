import { notFound } from "next/navigation";
import Link from "next/link";
import { advisorSnapshot } from "@/lib/advisor-context-server";
import { advisorContextPath } from "@/lib/advisor-context";

export const metadata = {
  title: "Synthetic advisor scenario · Harness",
  robots: { index: false, follow: false },
};
export default async function ContextPage({
  params,
  searchParams,
}: {
  params: Promise<{ scenario: string }>;
  searchParams: Promise<{ sha?: string }>;
}) {
  const snapshot = advisorSnapshot((await params).scenario);
  if (!snapshot) notFound();
  const expected = (await searchParams).sha;
  if (expected && expected !== snapshot.sha256)
    return (
      <main style={{ padding: 32 }}>
        <h1>Snapshot changed</h1>
        <p>
          Reload the selected scenario before analyzing. Do not use this page as
          the requested snapshot.
        </p>
      </main>
    );
  const { payload, sha256 } = snapshot;
  return (
    <main
      style={{ maxWidth: 1000, margin: "auto", padding: 32, lineHeight: 1.7 }}
    >
      <Link href="/">Return to Harness</Link>
      <h1>{payload.comparison.label}</h1>
      <p>
        <strong>Synthetic demonstration data</strong> · educational comparison
        only · not user financial records or live offers.
      </p>
      <dl>
        <dt>Scenario</dt>
        <dd>{payload.scenario_id}</dd>
        <dt>Version</dt>
        <dd>{payload.scenario_version}</dd>
        <dt>Snapshot SHA-256 (canonical payload JSON)</dt>
        <dd style={{ overflowWrap: "anywhere" }}>{sha256}</dd>
      </dl>
      <h2>Comparison goal</h2>
      <p>{payload.comparison.goal}</p>
      <h2>Inputs, options and deterministic calculator evidence</h2>
      <p>
        All figures below belong to this selected scenario/version. The
        comparison does not require workspace files or prior memory. Calculator
        assumptions are part of the snapshot.
      </p>
      <a
        href={`${advisorContextPath(payload.scenario_id)}/snapshot.json?sha=${sha256}`}
      >
        Read the exact context JSON
      </a>
      <pre
        style={{
          whiteSpace: "pre-wrap",
          overflowWrap: "anywhere",
          background: "#f5f2ed",
          padding: 20,
        }}
      >
        {JSON.stringify(snapshot, null, 2)}
      </pre>
    </main>
  );
}
