import { NextResponse } from "next/server";
import {
  STALE_PROCESS_CODE,
  STALE_PROCESS_HEADER,
  isStaleProcessError,
} from "@/lib/api/stale-process";

/** Convert the typed stale-process error into a retryable API response. */
export function staleProcessResponse(error: unknown): NextResponse | null {
  if (!isStaleProcessError(error)) return null;

  return NextResponse.json(
    {
      error: error.message,
      code: STALE_PROCESS_CODE,
      requiresRestart: true,
    },
    {
      status: 503,
      headers: {
        [STALE_PROCESS_HEADER]: "1",
        "Retry-After": "2",
      },
    }
  );
}
