"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRssText, type RssAction } from "@/components/rss/use-rss";
import { RssFeedSelection } from "./rss-filters-section";
import type { RssState, RssBrief } from "@/lib/rss/types";
import { useTreeStore } from "@/stores/tree-store";

export function RssBriefsSection({ state, act, busy }: { state: RssState; act: RssAction; busy: boolean }) {
  const text = useRssText();
  const [agents, setAgents] = useState<{ slug: string; name: string; active: boolean }[]>([]);
  const [draft, setDraft] = useState<RssBrief | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [agentError, setAgentError] = useState("");
  const published = state.runs.filter((run) => run.pagePath).map((run) => run.pagePath).join("|");
  useEffect(() => { if (published) void useTreeStore.getState().loadTree({ fresh: true }); }, [published]);
  useEffect(() => {
    const controller = new AbortController();
    fetch(`/api/agents/personas?cabinetPath=${encodeURIComponent(state.room)}`, { signal: controller.signal }).then(async (res) => { if (!res.ok) throw new Error(text("noAgents")); return res.json(); }).then((data) => { if (!controller.signal.aborted) { setAgents(data.personas.filter((agent: { scope?: string }) => agent.scope !== "global")); setAgentError(""); } }).catch(() => { if (!controller.signal.aborted) setAgentError(text("noAgents")); });
    return () => controller.abort();
  }, [state.room, text]);
  const add = () => { setDraftRevision(state.config.revision); setDraft({ id: crypto.randomUUID(), name: "", agentSlug: agents[0]?.slug || "", feedIds: [], folders: [], instructions: "Summarize the most important developments, grouped by topic. Cite sources.", schedule: "0 9 * * *", enabled: false, outputFolder: "RSS Briefs", maxArticles: 30, maxBytes: 60000 }); };
  return <section className="space-y-3" aria-label={text("briefs")}><h3 className="font-semibold">{text("briefs")}</h3><p className="text-sm text-muted-foreground">{text("briefHint")}</p><p className="text-xs text-muted-foreground">{text("timezone")}: {state.timezone}. {text("activeRequired")}</p>
    {agentError && <p role="alert" className="text-sm text-destructive">{agentError}</p>}
    {state.config.briefs.map((brief) => <div key={brief.id} className="rounded border p-3 space-y-2"><div className="flex flex-wrap items-center gap-2"><span className="font-medium flex-1">{brief.name}</span><span className="text-xs text-muted-foreground">{brief.agentSlug} · {brief.enabled ? brief.schedule : text("disabled")}{state.nextRuns?.[brief.id] && ` · ${text("next")}: ${new Date(state.nextRuns[brief.id]!).toLocaleString()}`}</span><Button size="sm" variant="ghost" onClick={() => { setDraft(structuredClone(brief)); setDraftRevision(state.config.revision); }}>{text("edit")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { if (window.confirm(text("removeBriefConfirm"))) void act({ action: "brief-remove", id: brief.id, revision: state.config.revision }); }}>{text("remove")}</Button><Button size="sm" disabled={busy} onClick={() => { if (window.confirm(text("runConfirm"))) void act({ action: "brief-run", id: brief.id }); }}>{text("run")}</Button></div>
      {state.runs.filter((run) => run.briefId === brief.id).slice(-5).reverse().map((run) => <div key={run.id} className="text-xs space-y-1"><p>{new Date(run.createdAt).toLocaleString()} · {run.status} {run.omitted > 0 && `(${text("omitted")}: ${run.omitted})`}</p>{run.error && <p role="alert" className="text-destructive">{run.error}</p>}<div className="flex gap-3">{run.pagePath && <a className="underline" href={`/room/${run.pagePath.split("/").map(encodeURIComponent).join("/")}`}>{text("openBrief")}</a>}{run.conversationId && <a className="underline" href={state.room === "." ? `/tasks/${encodeURIComponent(run.conversationId)}` : `/room/${encodeURIComponent(state.room)}/-/tasks/${encodeURIComponent(run.conversationId)}`}>{text("openRun")}</a>}{["failed", "uncertain"].includes(run.status) && <Button size="sm" variant="outline" disabled={busy} onClick={() => { if (window.confirm(`${run.error || ""}\n${text("runConfirm")}`)) void act({ action: "brief-run", id: brief.id, retryRunId: run.id }); }}>{text("run")}</Button>}{run.status === "publish-pending" && <Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: "brief-retry", id: run.id })}>{text("publishRetry")}</Button>}</div></div>)}
    </div>)}
    {!draft ? <Button variant="outline" disabled={!agents.length} onClick={add}>{text("addBrief")}</Button> : <form className="space-y-3 rounded-lg border p-3" onSubmit={async (event) => { event.preventDefault(); if (draft.enabled && !window.confirm(text("runConfirm"))) return; if (await act({ action: "brief-save", brief: { ...draft, needsSelection: false }, revision: draftRevision })) setDraft(null); }}>
      <label className="block text-sm">{text("name")}<Input required value={draft.name} maxLength={200} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <label className="block text-sm">{text("agent")}<select aria-label={text("agent")} className="block mt-1 rounded border bg-background p-2" required value={draft.agentSlug} onChange={(event) => setDraft({ ...draft, agentSlug: event.target.value })}>{!agents.some((agent) => agent.slug === draft.agentSlug) && <option value="">{text("agent")}</option>}{agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.name || agent.slug}{agent.active ? "" : ` (${text("disabled")})`}</option>)}</select></label>
      <RssFeedSelection config={state.config} feedIds={draft.feedIds} folders={draft.folders} onChange={(feedIds, folders) => setDraft({ ...draft, feedIds, folders })} />
      <label className="block text-sm">{text("template")}<select aria-label={text("template")} className="block mt-1 rounded border bg-background p-2" defaultValue="custom" onChange={(event) => { if (event.target.value !== "custom") setDraft({ ...draft, instructions: event.target.value === "daily" ? "Produce a daily brief grouped by topic, highlight important changes, and cite source articles." : "Write a concise summary of the selected stories with source citations." }); }}><option value="custom">{text("custom")}</option><option value="daily">{text("daily")}</option><option value="summary">{text("summary")}</option></select></label>
      <label className="block text-sm">{text("instructions")}<textarea className="block mt-1 min-h-24 w-full rounded border bg-background p-2" maxLength={10000} value={draft.instructions} onChange={(event) => setDraft({ ...draft, instructions: event.target.value })} /></label>
      <label className="flex gap-2 text-sm"><input type="checkbox" checked={draft.enabled} onChange={(event) => setDraft({ ...draft, enabled: event.target.checked })} />{text("scheduleEnabled")}</label>
      <label className="block text-sm">{text("cron")}<Input required value={draft.schedule} onChange={(event) => setDraft({ ...draft, schedule: event.target.value })} /></label>
      <label className="block text-sm">{text("outputFolder")}<Input required value={draft.outputFolder} onChange={(event) => setDraft({ ...draft, outputFolder: event.target.value })} /></label>
      <div className="grid grid-cols-2 gap-3"><label className="text-sm">{text("maxArticles")}<Input required type="number" min={1} max={100} value={draft.maxArticles} onChange={(event) => setDraft({ ...draft, maxArticles: Number(event.target.value) })} /></label><label className="text-sm">{text("maxBytes")}<Input required type="number" min={1000} max={100000} value={draft.maxBytes} onChange={(event) => setDraft({ ...draft, maxBytes: Number(event.target.value) })} /></label></div>
      <div className="flex gap-2"><Button type="submit" disabled={busy}>{text("save")}</Button><Button type="button" variant="ghost" onClick={() => setDraft(null)}>{text("cancel")}</Button></div>
    </form>}
  </section>;
}
