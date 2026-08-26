"use client";

import { useState } from "react";
import { ExternalLink, Copy, Check, Play, Terminal as TerminalIcon } from "lucide-react";
import { cn } from "@/lib/utils";

// Shared, official rendering of a provider's setup steps — used by both the
// Settings → Providers guide and the setup dialog, so the two never drift.
// Command boxes are theme-colored (no hardcoded green/black). When `onRun` is
// provided (dialog, which embeds a terminal), each command gets a Run button
// that types it into that terminal; otherwise commands are copy-only.

export interface SetupStep {
  title: string;
  detail: string;
  command?: string;
  link?: { label: string; url: string };
  openTerminal?: boolean;
}

function CommandBox({ command, onRun }: { command: string; onRun?: (cmd: string) => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className="mt-1.5 flex items-center gap-1.5 rounded-md border border-border bg-muted/60 px-2 py-1.5 font-mono text-[11px]">
      <span className="shrink-0 select-none text-muted-foreground">$</span>
      <span className="flex-1 overflow-x-auto whitespace-nowrap text-foreground/90">{command}</span>
      {onRun && (
        <button
          onClick={() => onRun(command)}
          className="inline-flex shrink-0 items-center gap-1 rounded bg-primary px-1.5 py-0.5 text-[10px] font-medium text-primary-foreground hover:opacity-90"
          title="Run in the terminal"
        >
          <Play className="h-3 w-3" /> Run
        </button>
      )}
      <button
        onClick={() => { void navigator.clipboard?.writeText(command); setCopied(true); setTimeout(() => setCopied(false), 1500); }}
        className="shrink-0 rounded p-0.5 text-muted-foreground hover:text-foreground"
        aria-label="Copy command"
      >
        {copied ? <Check className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />}
      </button>
    </div>
  );
}

export function ProviderSetupSteps({
  steps,
  onRunCommand,
  onOpenTerminal,
  failedStepTitle,
  passed,
}: {
  steps: SetupStep[];
  /** Present when an embedded terminal exists (dialog): renders Run buttons. */
  onRunCommand?: (command: string) => void;
  /** Handler for an "Open a terminal" step (Settings uses the OS terminal). */
  onOpenTerminal?: () => void;
  failedStepTitle?: string;
  passed?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      {steps.map((step, i) => {
        const isFailed =
          !!failedStepTitle && !passed &&
          step.title.toLowerCase() === failedStepTitle.toLowerCase();
        const isPass = !!passed && /verify\s+setup/i.test(step.title);
        return (
          <div
            key={i}
            className={cn(
              "flex items-start gap-2.5 rounded-md p-1.5",
              isFailed && "bg-rose-500/5 ring-1 ring-rose-500/30",
              isPass && "bg-emerald-500/5 ring-1 ring-emerald-500/30",
            )}
          >
            <span
              className={cn(
                "mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full text-[10px] font-bold",
                isFailed ? "bg-rose-500 text-white" : isPass ? "bg-emerald-500 text-white" : "bg-primary text-primary-foreground",
              )}
            >
              {isFailed ? "!" : isPass ? "✓" : i + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-[13px] font-medium">{step.title}</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{step.detail}</p>
              {step.command && <CommandBox command={step.command} onRun={onRunCommand} />}
              {step.openTerminal && onOpenTerminal && (
                <button
                  onClick={onOpenTerminal}
                  className="mt-1.5 inline-flex items-center gap-1.5 rounded-full border border-border px-3 py-1.5 text-[11px] font-medium hover:bg-muted"
                >
                  <TerminalIcon className="size-3" /> Open terminal
                </button>
              )}
              {step.link && (
                <a
                  href={step.link.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="mt-1.5 inline-flex items-center gap-1 text-[11px] font-medium text-primary hover:underline"
                >
                  {step.link.label}
                  <ExternalLink className="size-3" />
                </a>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
