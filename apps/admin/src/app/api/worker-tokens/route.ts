import { workerRequest } from "@/lib/server";
export const dynamic = "force-dynamic";
export async function GET(request: Request) {
  return workerRequest(request);
}
export async function POST(request: Request) {
  return workerRequest(request);
}
