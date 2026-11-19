import { workerRequest } from "@/lib/server";
export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const { id } = await context.params;
  return workerRequest(request, id);
}
