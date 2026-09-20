"use client";

import { useState, useSyncExternalStore } from "react";
import { Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/use-locale";
import { getHost, type CabinetHost } from "@/lib/host";

// The host is an external value injected by the shell (Electron preload or
// the fork's cabinetHost binding): read it with useSyncExternalStore so the
// server (and the hydration render) sees null and the client corrects after
// mount — no setState-in-effect, no hydration mismatch. The snapshot is
// reference-stable: getHost() returns a cached singleton.
const emptySubscribe = () => () => {};

function readHost(): CabinetHost | null {
  const host = getHost();
  return host.kind === "electron" && host.platform === "darwin" ? host : null;
}

/**
 * Settings → About → Uninstall Cabinet (macOS Electron only).
 *
 * Removes the .app bundle, caches, prefs, saved state, web storage, and
 * logs. Does NOT touch user data at `~/Library/Application Support/Cabinet/
 * cabinet-data` — your cabinet content is preserved and the path is shown
 * in the confirmation so you know where to find it.
 */
export function UninstallSection() {
  const { t } = useLocale();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const host = useSyncExternalStore(emptySubscribe, readHost, () => null);

  if (!host) return null;

  const dataPath = "~/Library/Application Support/Cabinet/cabinet-data";

  const handleUninstall = async () => {
    const ok = window.confirm(
      `Uninstall Cabinet?\n\n` +
        `This removes the app from /Applications and clears caches, ` +
        `preferences, saved state, web storage, and logs.\n\n` +
        `Your cabinet content at\n  ${dataPath}\nwill be preserved. ` +
        `Open that folder in Finder if you want to back it up before reinstalling later.\n\n` +
        `Cabinet will quit immediately after you confirm.`
    );
    if (!ok) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await host.system.uninstall();
      if (!result.ok) {
        setError(result.error || "Uninstall failed.");
        setSubmitting(false);
      }
      // On success, the app quits and a detached shell removes the .app a
      // moment later. Nothing more to do here.
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSubmitting(false);
    }
  };

  return (
    <div className="border-t border-border pt-6">
      <h3 className="text-[14px] font-semibold mb-1">{t("uninstall:title")}</h3>
      <p className="text-[12px] text-muted-foreground mb-3">
        Remove Cabinet.app and Library caches/preferences/state/logs from your
        Mac. Your cabinet content at{" "}
        <span className="font-mono text-[11px] rounded bg-muted px-1 py-0.5">
          {dataPath}
        </span>{" "}
        is <strong>not</strong> deleted. Open that folder in Finder if you
        want to back it up before reinstalling.
      </p>
      <Button
        variant="destructive"
        size="sm"
        className="h-8 gap-1.5 text-[12px]"
        disabled={submitting}
        onClick={handleUninstall}
      >
        <Trash2 className="h-3.5 w-3.5" />
        {submitting ? "Uninstalling…" : "Uninstall Cabinet"}
      </Button>
      {error && (
        <p className="mt-2 text-[11px] text-destructive">{error}</p>
      )}
    </div>
  );
}
