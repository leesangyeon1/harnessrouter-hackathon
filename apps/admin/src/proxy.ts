import { NextResponse, type NextRequest } from "next/server";
import { AdminGateError, checkAdmin } from "./lib/security";
export async function proxy(request: NextRequest) {
  try {
    await checkAdmin(
      request.cookies.get("harness_admin_session")?.value,
      process.env.INTERNAL_API_BASE_URL ?? "",
    );
    return NextResponse.next();
  } catch (error) {
    if (error instanceof AdminGateError && error.status === 401)
      return NextResponse.redirect(new URL("/", request.url));
    const status = error instanceof AdminGateError ? error.status : 503;
    return new NextResponse(
      "<!doctype html><html lang='en'><head><meta name='viewport' content='width=device-width,initial-scale=1'><title>Access unavailable — Harness Operations</title></head><body style='font-family:system-ui;background:#f7f8fa;color:#34433c;padding:10vh 8vw'><h1>Operations access unavailable</h1><p>Administrator permission could not be verified for this request.</p><a href='/'>Return to sign-in</a></body></html>",
      {
        status,
        headers: {
          "Content-Type": "text/html; charset=utf-8",
          "Cache-Control": "no-store",
        },
      },
    );
  }
}
export const config = { matcher: ["/workspace/:path*"] };
