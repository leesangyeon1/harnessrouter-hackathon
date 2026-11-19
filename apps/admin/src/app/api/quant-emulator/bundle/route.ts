import { quantEmulatorRequest } from "@/lib/server";
export const GET = (request: Request) =>
  quantEmulatorRequest(request, "bundle");
