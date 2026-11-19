import { cookies } from "next/headers";
import { AdminGateError, checkAdmin, checkOrigin } from "@/lib/security";
import { adminOrigin, apiBase, cookieName, failure, json } from "@/lib/server";

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), adminOrigin(request));
    const body = await request.json();
    if (
      typeof body?.token !== "string" ||
      body.token.length > 10000 ||
      !body.token
    )
      throw new AdminGateError(401, "A valid sign-in token is required.");
    const profile = await checkAdmin(body.token, apiBase());
    (await cookies()).set(cookieName, body.token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 3000,
    });
    return json({ role: profile.role });
  } catch (error) {
    return failure(error);
  }
}
export async function DELETE(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), adminOrigin(request));
    (await cookies()).delete(cookieName);
    return json({ status: "signed_out" });
  } catch (error) {
    return failure(error);
  }
}
