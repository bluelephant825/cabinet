"use client";

import { Bot, ChevronDown, ListTodo, PanelRight } from "lucide-react";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useTaskRail } from "@/components/tasks/rail/task-rail-context";
import { useIsMobile } from "@/hooks/use-is-mobile";
import { useEditorStore } from "@/stores/editor-store";
import { useAppStore } from "@/stores/app-store";
import { useLocale } from "@/i18n/use-locale";
import { cn } from "@/lib/utils";

export function PanelsDropdown({ className }: { className?: string }) {
  const { t } = useLocale();
  const isMobile = useIsMobile();
  const taskPanelOpen = useAppStore((s) => s.taskPanelOpen);
  const toggleTaskPanelCompose = useAppStore((s) => s.toggleTaskPanelCompose);
  const taskRailOpen = useAppStore((s) => s.taskRailOpen);
  const toggleTaskRail = useAppStore((s) => s.toggleTaskRail);
  const section = useAppStore((s) => s.section);
  const currentPath = useEditorStore((s) => s.currentPath);
  const { runningCount, flash } = useTaskRail();
  const label = t("common:panels.label");
  const menuTitle =
    runningCount > 0
      ? `${t("common:panels.menuTitle")} · ${t("taskRail:toggleRunning", { count: runningCount })}`
      : t("common:panels.menuTitle");

  const toggleAiPanel = () => {
    toggleTaskPanelCompose(
      section.type === "page" && currentPath
        ? {
            source: "editor",
            pinnedPagePath: currentPath,
            defaultAgentSlug: "editor",
          }
        : undefined
    );
  };

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        type="button"
        aria-label={menuTitle}
        title={menuTitle}
        className={cn(
          "relative inline-flex h-7 shrink-0 items-center justify-center gap-1 rounded-md px-2 text-xs font-medium text-muted-foreground/70 transition-colors hover:bg-accent hover:text-foreground data-[popup-open]:bg-accent data-[popup-open]:text-foreground",
          (taskRailOpen || taskPanelOpen) && "bg-accent text-foreground",
          flash && "animate-pulse !text-emerald-600 dark:!text-emerald-400",
          className
        )}
      >
        <PanelRight className="size-3.5" />
        <span>{label}</span>
        <ChevronDown className="size-3" />
        {runningCount > 0 && (
          <span
            className="cabinet-task-heartbeat absolute -end-0.5 -top-0.5 inline-block size-2 rounded-full bg-emerald-500 shadow-[0_0_4px_rgba(16,185,129,0.7)]"
            aria-hidden="true"
          />
        )}
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" className="w-48">
        <DropdownMenuItem
          onClick={toggleAiPanel}
          className="flex cursor-pointer items-center justify-between"
        >
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-foreground/70" />
            <span>
              {taskPanelOpen
                ? t("common:aiPanel.close")
                : t("common:aiPanel.open")}
            </span>
          </div>
          {taskPanelOpen && (
            <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
          )}
        </DropdownMenuItem>
        {!isMobile && (
          <DropdownMenuItem
            onClick={toggleTaskRail}
            className="flex cursor-pointer items-center justify-between"
          >
            <div className="flex items-center gap-2">
              <ListTodo className="size-4 text-foreground/70" />
              <span>{taskRailOpen ? t("taskRail:hide") : t("taskRail:show")}</span>
            </div>
            {runningCount > 0 ? (
              <span className="size-2 rounded-full bg-emerald-500 animate-pulse" />
            ) : taskRailOpen ? (
              <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
            ) : null}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
