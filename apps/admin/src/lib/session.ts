// Request-time renewal: expiry alone does not emit onIdTokenChanged.
// A failed renewal returns before the operation; mutations are never replayed.
export async function sessionRequest(
  path: string,
  init: RequestInit,
  currentToken: () => Promise<string | null>,
  transport: typeof fetch = fetch,
): Promise<Response> {
  const token = await currentToken();
  if (token) {
    const renewal = await transport("/api/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token }),
      cache: "no-store",
      credentials: "same-origin",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!renewal.ok) return renewal;
  }
  return transport(path, {
    ...init,
    cache: "no-store",
    credentials: "same-origin",
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
}
