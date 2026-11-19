export class AdminGateError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export function safeOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new AdminGateError(
      503,
      "Operations service configuration is incomplete.",
    );
  }
  const local =
    url.protocol === "http:" &&
    ["127.0.0.1", "localhost"].includes(url.hostname);
  if (
    (url.protocol !== "https:" && !local) ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash
  )
    throw new AdminGateError(
      503,
      "Operations service configuration is invalid.",
    );
  return url.origin;
}
export async function checkAdmin(
  token: string | undefined,
  apiBase: string,
  transport: typeof fetch = fetch,
): Promise<{ user_id: string; role: "admin" }> {
  if (!token)
    throw new AdminGateError(401, "Administrator sign-in is required.");
  const origin = safeOrigin(apiBase);
  let response: Response;
  try {
    response = await transport(`${origin}/v1/me`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
    });
  } catch {
    throw new AdminGateError(503, "The account service could not be reached.");
  }
  if (response.status === 401)
    throw new AdminGateError(401, "Your administrator session has expired.");
  if (!response.ok)
    throw new AdminGateError(
      response.status === 403 ? 403 : 503,
      "Administrator access could not be verified.",
    );
  let profile: { user_id?: unknown; role?: unknown };
  try {
    profile = await response.json();
  } catch {
    throw new AdminGateError(
      503,
      "The account service returned an unreadable response.",
    );
  }
  if (profile?.role !== "admin")
    throw new AdminGateError(
      403,
      "Administrator access is required for this workspace.",
    );
  if (typeof profile.user_id !== "string" || !profile.user_id)
    throw new AdminGateError(
      503,
      "The account service returned an invalid profile.",
    );
  return { user_id: profile.user_id, role: "admin" };
}
export function checkOrigin(origin: string | null, configured: string): void {
  if (!origin || origin !== safeOrigin(configured))
    throw new AdminGateError(
      403,
      "This request must come from the operations workspace.",
    );
}
export const validTokenId = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
