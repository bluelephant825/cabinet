"use client";

import { ChevronLeft, ChevronRight } from "lucide-react";
import { useAppStore } from "@/stores/app-store";
import { useLocale } from "@/i18n/use-locale";

/**
 * Small "Back to task" / "Back to agent" chip rendered inside the viewer toolbar
 * when the user navigated here from a task/agent/cabinet context. Pops the
 * previous section from the app-store returnTo stack. Renders nothing when
 * there's no return context.
 */
export function ReturnToChip({ fullLabel = false }: { fullLabel?: boolean }) {
  const { t } = useLocale();
  const returnTo = useAppStore((s) => s.returnTo);
  const popReturnTo = useAppStore((s) => s.popReturnTo);
  if (!returnTo) return null;

  const parentLabel = (() => {
    switch (returnTo.type) {
      case "task":
        return t("chrome:returnTo.task");
      case "tasks":
        return t("chrome:returnTo.tasks");
      case "agent":
        return t("chrome:returnTo.agent");
      case "agents":
        return t("chrome:returnTo.agents");
      case "cabinet":
        return t("chrome:returnTo.cabinet");
      case "home":
        return t("chrome:returnTo.home");
      case "settings":
        return returnTo.slug === "rss" ? t("chrome:returnTo.rssSettings") : t("chrome:returnTo.settings");
      case "registry":
        return t("chrome:returnTo.registry");
      default:
        return t("chrome:returnTo.back");
    }
  })();

  return (
    <button
      type="button"
      onClick={popReturnTo}
      className="inline-flex shrink-0 items-center gap-0.5 text-[11.5px] text-muted-foreground hover:text-foreground transition-colors"
      title={t("chrome:returnTo.backTo", { label: parentLabel })}
      aria-label={t("chrome:returnTo.backTo", { label: parentLabel })}
    >
      {fullLabel && <ChevronLeft className="size-3.5 opacity-40 rtl:rotate-180" />}
      <span className="hover:underline underline-offset-2">{fullLabel ? t("chrome:returnTo.backTo", { label: parentLabel }) : parentLabel}</span>
      {!fullLabel && <ChevronRight className="size-3.5 opacity-40" />}
    </button>
  );
}
