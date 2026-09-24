"use client";

import { useEffect } from "react";
import { getHost } from "@/lib/host";
import { handleDeepLink } from "@/lib/navigation/deep-links";

/** Subscribe the renderer to OS-delivered `cabinet://` deep links. */
export function useDeepLinks(): void {
  useEffect(
    () => getHost().system.onOpenUrl((url) => void handleDeepLink(url)),
    [],
  );
}
