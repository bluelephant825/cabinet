"use client";

import { useEffect, useState } from "react";
import { ExternalLink, Check, Loader2, Copy } from "lucide-react";
import { siClaude } from "simple-icons";
import { Button } from "@/components/ui/button";
import { track } from "@/components/analytics/posthog-provider";

function ClaudeMark({ className }: { className?: string }) {
  return (
    <svg role="img" viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
      <path d={siClaude.path} />
    </svg>
  );
}

// Cloud (CABINET_CLOUD=1) Connect-Claude card for the Providers settings tab: the full
// `claude setup-token` flow driven in-page — Connect → open the link → paste the code → done —
// so users never touch a terminal. Orchestrated by the in-container daemon (/auth/claude/*,
// proxied through /api/agents/claude-login/*). Renders nothing outside cloud mode.

type Phase = "loading" | "hidden" | "disconnected" | "starting" | "awaiting-code" | "submitting" | "connected";

export function ConnectClaudeCard() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [url, setUrl] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [copied, setCopied] = useState(false);

  const copyUrl = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch { /* clipboard unavailable */ }
  };

  const refresh = async () => {
    try {
      const r = await fetch("/api/cloud/status", { cache: "no-store" });
      if (!r.ok) return setPhase("hidden");
      const d = (await r.json()) as { cloud: boolean; claudeConnected: boolean };
      if (!d.cloud) return setPhase("hidden");
      setPhase(d.claudeConnected ? "connected" : "disconnected");
    } catch {
      setPhase("hidden");
    }
  };
  useEffect(() => { void refresh(); }, []);

  const start = async () => {
    setError(""); setPhase("starting");
    try {
      const r = await fetch("/api/agents/claude-login/start", { method: "POST" });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "could not start login");
      setUrl(d.url);
      setPhase("awaiting-code");
    } catch (e) {
      setError((e as Error).message); setPhase("disconnected");
    }
  };

  const submit = async () => {
    setError(""); setPhase("submitting");
    try {
      const r = await fetch("/api/agents/claude-login/code", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code: code.trim() }),
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || "could not verify the code");
      setCode(""); setUrl(""); setPhase("connected");
      track("claude_connected");
    } catch (e) {
      setError((e as Error).message); setPhase("awaiting-code");
    }
  };

  const disconnect = async () => {
    await fetch("/api/agents/claude-login/clear", { method: "POST" }).catch(() => {});
    setPhase("disconnected");
  };

  if (phase === "loading" || phase === "hidden") return null;

  return (
    <div className="mb-4 rounded-xl border border-primary/25 bg-primary/[0.05] p-4">
      <div className="flex items-start gap-2.5">
        <ClaudeMark className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-[13px] font-semibold">Claude Code</span>
            {phase === "connected" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-primary/10 px-2 py-0.5 text-[11px] font-medium text-primary">
                <Check className="h-3 w-3" /> Connected
              </span>
            )}
          </div>

          {phase === "connected" ? (
            <div className="mt-1 flex items-center justify-between gap-3">
              <p className="text-[12px] text-muted-foreground">Your Claude subscription is powering agents in this cabinet.</p>
              <Button variant="ghost" size="sm" className="shrink-0 text-[12px]" onClick={disconnect}>Disconnect</Button>
            </div>
          ) : (
            <>
              <p className="mt-0.5 text-[12px] text-muted-foreground">
                Bring your own Claude subscription. Connect once to run agents.
              </p>

              {phase === "disconnected" && (
                <Button size="sm" className="mt-2.5 text-[12px]" onClick={start}>
                  <ClaudeMark className="h-3.5 w-3.5" /> Connect Claude
                </Button>
              )}

              {phase === "starting" && (
                <div className="mt-2.5 flex items-center gap-2 text-[12px] text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" /> Preparing your login link…
                </div>
              )}

              {(phase === "awaiting-code" || phase === "submitting") && (
                <div className="mt-2.5 space-y-2.5">
                  <div className="flex items-center gap-2">
                    <a href={url} target="_blank" rel="noopener noreferrer"
                      className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-1.5 text-[12px] font-medium text-primary-foreground transition-colors hover:bg-primary/90">
                      1. Open the Claude login <ExternalLink className="h-3.5 w-3.5" />
                    </a>
                    <button type="button" onClick={copyUrl} title="Copy link"
                      className="inline-flex items-center gap-1 rounded-lg border border-border bg-background px-2.5 py-1.5 text-[12px] font-medium text-muted-foreground transition-colors hover:bg-muted">
                      {copied ? <><Check className="h-3.5 w-3.5 text-primary" /> Copied</> : <><Copy className="h-3.5 w-3.5" /> Copy</>}
                    </button>
                  </div>
                  <div className="flex items-center gap-2">
                    <input
                      value={code} onChange={(e) => setCode(e.target.value)}
                      placeholder="2. Paste the code shown after login"
                      className="min-w-0 flex-1 rounded-lg border border-input bg-background px-3 py-1.5 text-[12px] outline-none focus:border-primary/50"
                      onKeyDown={(e) => { if (e.key === "Enter" && code.trim()) void submit(); }}
                    />
                    <Button size="sm" className="shrink-0 text-[12px]" disabled={phase === "submitting" || !code.trim()} onClick={submit}>
                      {phase === "submitting" ? <><Loader2 className="h-3.5 w-3.5 animate-spin" /> Connecting…</> : "Connect"}
                    </Button>
                  </div>
                </div>
              )}
            </>
          )}

          {error && <p className="mt-2 text-[12px] text-destructive">{error}</p>}
        </div>
      </div>
    </div>
  );
}
