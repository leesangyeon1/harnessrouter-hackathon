import { redirect } from "next/navigation";
import { apiBase, verifiedSession } from "@/lib/server";
import { Operations } from "./operations";
export const dynamic = "force-dynamic";
export default async function Workspace() {
  let token: string;
  try {
    token = (await verifiedSession()).token;
  } catch {
    redirect("/");
  }
  let initialTokens = [];
  let initialError = "";
  try {
    const response = await fetch(`${apiBase()}/v1/admin/worker-tokens`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
      redirect: "error",
      signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw new Error("Unavailable");
    const body = await response.json();
    if (!Array.isArray(body.tokens)) throw new Error("Invalid token list");
    initialTokens = body.tokens;
  } catch {
    initialError = "Worker credentials could not be loaded. Try refreshing.";
  }
  return (
    <Operations initialTokens={initialTokens} initialError={initialError} />
  );
}
