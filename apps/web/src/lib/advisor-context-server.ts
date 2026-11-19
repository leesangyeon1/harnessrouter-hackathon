import { createHash } from "node:crypto";
import {
  advisorContextPayload,
  canonicalJson,
  type AdvisorSnapshot,
} from "./advisor-context";

export function advisorSnapshot(id: string): AdvisorSnapshot | null {
  const payload = advisorContextPayload(id);
  return payload
    ? {
        payload,
        sha256: createHash("sha256")
          .update(canonicalJson(payload))
          .digest("hex"),
      }
    : null;
}
