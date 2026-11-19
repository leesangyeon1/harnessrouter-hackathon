import { quantEmulatorRequest } from "@/lib/server";
export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return quantEmulatorRequest(request, "detail", (await context.params).id);
}
