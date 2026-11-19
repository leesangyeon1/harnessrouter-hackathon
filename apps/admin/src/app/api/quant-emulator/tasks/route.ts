import { quantEmulatorRequest } from "@/lib/server";
export const GET = (request: Request) => quantEmulatorRequest(request, "tasks");
export const POST = (request: Request) =>
  quantEmulatorRequest(request, "tasks");
