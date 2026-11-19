import "server-only";
import { cookies } from "next/headers";
import {
  AdminGateError,
  checkAdmin,
  checkOrigin,
  safeOrigin,
  validTokenId,
} from "./security";

export const cookieName = "harness_admin_session";
export const apiBase = () =>
  safeOrigin(process.env.INTERNAL_API_BASE_URL ?? "");
export const adminOrigin = (request: Request) =>
  process.env.ADMIN_APP_ORIGIN ??
  (process.env.NODE_ENV !== "production" ? new URL(request.url).origin : "");
export async function verifiedSession() {
  const token = (await cookies()).get(cookieName)?.value;
  const profile = await checkAdmin(token, apiBase());
  return { token: token!, profile };
}
export const json = (value: unknown, status = 200) =>
  Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store, private", Vary: "Cookie" },
  });
export function failure(error: unknown) {
  return error instanceof AdminGateError
    ? json({ detail: error.message }, error.status)
    : json(
        { detail: "The operations service could not complete this request." },
        503,
      );
}
export async function workerRequest(request: Request, id?: string) {
  try {
    if (request.method !== "GET")
      checkOrigin(request.headers.get("origin"), adminOrigin(request));
    const { token } = await verifiedSession();
    if (id !== undefined && !validTokenId(id))
      return json({ detail: "Invalid worker token id." }, 400);
    const path = `/v1/admin/worker-tokens${id ? `/${id}` : ""}`;
    const response = await fetch(`${apiBase()}${path}`, {
      method: request.method,
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      credentials: "omit",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok)
      return json(
        {
          detail:
            response.status === 403
              ? "Administrator access is no longer available."
              : response.status === 404
                ? "This token is no longer active."
                : "The token request could not be completed.",
        },
        response.status,
      );
    if (response.status === 204)
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": "no-store" },
      });
    return json(await response.json(), response.status);
  } catch (error) {
    return failure(error);
  }
}
