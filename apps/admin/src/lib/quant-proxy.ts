import {
  AdminGateError,
  checkOrigin,
  safeOrigin,
  validTokenId,
} from "./security";

type Dependencies = {
  base: string;
  origin: string;
  session: () => Promise<{ token: string }>;
  transport?: typeof fetch;
};

// A closed set of destinations: no events, files, follow-ups, cancellation or jobs.
export async function proxyQuant(
  request: Request,
  target: "bundle" | "tasks" | "detail",
  dependencies: Dependencies,
  id?: string,
) {
  const { base, origin, session, transport = fetch } = dependencies;
  const post = request.method === "POST";
  if ((post && target !== "tasks") || (!post && request.method !== "GET"))
    throw new AdminGateError(405, "Method is not available.");
  if (post) checkOrigin(request.headers.get("origin"), origin);
  const { token } = await session(); // Current backend role on every request.
  let path = "/v1/agent-tasks";
  let body: string | undefined;
  if (target === "detail") {
    if (!id || !validTokenId(id))
      throw new AdminGateError(400, "Invalid evaluation task id.");
    path += `/${id}`;
  } else if (target === "bundle") {
    const query = new URL(request.url).searchParams;
    const symbol = (query.get("symbol") || "AAPL").trim().toUpperCase();
    const mode = query.get("mode") || "sample";
    if (
      !/^[A-Z0-9./-]{1,32}$/.test(symbol) ||
      !["auto", "stored", "sample"].includes(mode)
    )
      throw new AdminGateError(400, "Invalid bundle symbol or mode.");
    path += `/quant-bundle?${new URLSearchParams({ symbol, mode })}`;
  } else if (post) {
    const text = await request.text();
    if (text.length > 524288)
      throw new AdminGateError(413, "Evaluation input is too large.");
    let payload;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AdminGateError(400, "Evaluation input must be JSON.");
    }
    if (
      !payload ||
      typeof payload !== "object" ||
      Array.isArray(payload) ||
      Object.keys(payload).some(
        (key) => !["input", "feature_key"].includes(key),
      ) ||
      payload.feature_key !== "quant_eval" ||
      typeof payload.input !== "string" ||
      !payload.input.trim()
    )
      throw new AdminGateError(400, "A quant evaluation input is required.");
    body = JSON.stringify({ input: payload.input, feature_key: "quant_eval" });
  } else path += "?feature_key=quant_eval";
  const response = await transport(`${safeOrigin(base)}${path}`, {
    method: post ? "POST" : "GET",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(post ? { "Content-Type": "application/json" } : {}),
    },
    body,
    cache: "no-store",
    redirect: "error",
    credentials: "omit",
    signal: AbortSignal.timeout(30000),
  });
  const answer = await response.json();
  if (!response.ok) {
    throw new AdminGateError(
      response.status,
      typeof answer?.detail === "string"
        ? answer.detail.slice(0, 1500)
        : "The evaluation service refused the request.",
    );
  }
  if (target === "detail" && answer?.feature_key !== "quant_eval")
    throw new AdminGateError(404, "Quant evaluation not found.");
  return { answer, status: response.status };
}
