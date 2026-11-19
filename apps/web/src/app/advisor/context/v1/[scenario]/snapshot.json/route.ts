import { advisorSnapshot } from "@/lib/advisor-context-server";

export async function GET(
  request: Request,
  context: { params: Promise<{ scenario: string }> },
) {
  const snapshot = advisorSnapshot((await context.params).scenario);
  const expected = new URL(request.url).searchParams.get("sha");
  const status = !snapshot
    ? 404
    : expected && expected !== snapshot.sha256
      ? 409
      : 200;
  return Response.json(
    status === 200
      ? snapshot
      : {
          detail:
            status === 404
              ? "Unknown synthetic scenario."
              : "Snapshot changed; reload the selected scenario before analyzing.",
        },
    {
      status,
      headers: {
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex",
        "X-Content-Type-Options": "nosniff",
      },
    },
  );
}
