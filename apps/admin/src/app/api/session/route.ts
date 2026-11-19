import { cookies } from "next/headers";
import { AdminGateError, checkAdmin, checkOrigin } from "@/lib/security";
import { adminOrigin, apiBase, cookieName, failure, json } from "@/lib/server";

export async function POST(request: Request) {
  try {
    checkOrigin(request.headers.get("origin"), adminOrigin(request));
    const body = (await request.json()) as {
      token?: unknown;
      username?: unknown;
      password?: unknown;
    };

    let sessionToken: string;
    if (
      typeof body?.username === "string" &&
      typeof body?.password === "string" &&
      body.username.trim().length > 0 &&
      body.password.length > 0
    ) {
      let loginResponse: Response;
      try {
        loginResponse = await fetch(`${apiBase()}/v1/auth/admin-login`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            username: body.username.trim(),
            password: body.password,
          }),
          cache: "no-store",
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(15000),
        });
      } catch {
        throw new AdminGateError(
          503,
          "The account service could not be reached.",
        );
      }
      if (loginResponse.status === 401) {
        throw new AdminGateError(401, "Invalid administrator ID or password.");
      }
      if (!loginResponse.ok) {
        throw new AdminGateError(
          503,
          "Administrator access could not be verified.",
        );
      }
      const loginData = (await loginResponse.json()) as { token?: unknown };
      if (typeof loginData?.token !== "string" || !loginData.token) {
        throw new AdminGateError(
          503,
          "The account service returned an invalid session.",
        );
      }
      sessionToken = loginData.token;
    } else if (
      typeof body?.token === "string" &&
      body.token.length > 0 &&
      body.token.length <= 10000
    ) {
      sessionToken = body.token;
    } else {
      throw new AdminGateError(
        401,
        "Enter a valid administrator ID and password.",
      );
    }

    const profile = await checkAdmin(sessionToken, apiBase());
    (await cookies()).set(cookieName, sessionToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: 28800,
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
