"use client";
import { useCallback, useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useTreeStore } from "@/stores/tree-store";

interface Status {
  enabled: boolean; cabinetName: string; running: boolean; busy: boolean; error: string | null; folders: string[]; wikiPath: string; selectedAgent?: string | null;
  agents?: { slug: string; name: string; provider: string; model: string | null; active?: boolean }[];
  provider: { available: boolean; message: string; provider: string; model?: string | null; hardened?: boolean };
  jobs: { id: string; status: string; operation: string; sourceId: string | null; input?: { path: string } | null; error: string | null; updatedAt: string; agentWarnings?: string[] }[];
  sources: { id: string; title: string; path: string | null; rawPath: string; version: number | null; compiled: boolean; status: string; warnings?: { message: string }[] }[];
}
interface Inventory { fingerprint: string; notes: { path: string; bytes: number }[]; skipped: { path: string; reason: string }[] }
const href = (path: string) => `/room/${path.split("/").map(encodeURIComponent).join("/")}`;
const jobStages: Record<string, string> = {
  queued: "Waiting to process", normalizing: "Reading the article", classifying: "Organizing the source",
  promoting: "Saving captured evidence", compiling: "Generating and checking Wiki content",
  reconciling: "Updating and checking Wiki content", linking: "Building Wiki pages", complete: "Completed",
  failed: "Needs attention", "needs-review": "Needs attention",
};
const jobOperations: Record<string, string> = {
  consolidate: "Rebuild overview and concept table", lint: "Wiki health check",
};
const activeStages = new Set(["normalizing", "classifying", "promoting", "compiling", "reconciling", "linking"]);
const folderDraftKey = (cabinetName: string) => `cabinet.wiki.source-folders:${encodeURIComponent(cabinetName)}`;
export function WikiSection() {
  const [status, setStatus] = useState<Status | null>(null);
  const [folders, setFolders] = useState("");
  const loadedFolderCabinet = useRef<string | null>(null);
  const [inventory, setInventory] = useState<Inventory | null>(null);
  const [selection, setSelection] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [lastChecked, setLastChecked] = useState<Date | null>(null);
  const [connectionError, setConnectionError] = useState(false);
  const treeRevision = status?.sources.map((source) => `${source.id}:${source.version}:${source.compiled}:${source.status}`).join("|") ?? "";
  useEffect(() => { if (treeRevision) void useTreeStore.getState().loadTree({ fresh: true }); }, [treeRevision]);
  const refresh = useCallback(async (signal?: AbortSignal) => {
    try {
      const response = await fetch("/api/llm-wiki/workflow", { signal, cache: "no-store" });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      if (!signal?.aborted) {
        if (loadedFolderCabinet.current !== value.cabinetName) {
          let draft: string | null = null;
          try { draft = localStorage.getItem(folderDraftKey(value.cabinetName)); } catch { /* Browser storage may be unavailable. */ }
          setFolders(draft ?? (value.folders.length ? value.folders.join("\n") : "Notes/Apple Notes\nNotes/Eureka"));
          setInventory(null); setSelection([]);
          loadedFolderCabinet.current = value.cabinetName;
        }
        setStatus(value); setLastChecked(new Date()); setConnectionError(false);
      }
    } catch { if (!signal?.aborted) setConnectionError(true); }
  }, []);
  useEffect(() => { const controller = new AbortController(); void refresh(controller.signal); const timer = setInterval(() => void refresh(controller.signal), 3000); return () => { controller.abort(); clearInterval(timer); }; }, [refresh]);
  const act = async (body: Record<string, unknown>) => {
    setBusy(true); setError(null);
    try {
      const response = await fetch("/api/llm-wiki/workflow", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error);
      if (body.action === "inspect") { setInventory(value); setSelection([]); }
      else { setStatus(value); if (body.action === "import") { setInventory(null); setSelection([]); } }
    } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const selectedFolders = folders.split("\n").map((item) => item.trim()).filter(Boolean);
  const agents = status?.agents ?? [];
  const outdatedWikiService = !!status && !Array.isArray(status.agents);
  const registeredPaths = new Set(status?.sources.map((source) => source.path).filter((path): path is string => path !== null));
  const nonIngestedPaths = inventory?.notes.filter((note) => !registeredPaths.has(note.path)).map((note) => note.path) ?? [];
  const jobs = status?.jobs ?? [];
  const completed = jobs.filter((job) => job.status === "complete").length;
  const waiting = jobs.filter((job) => job.status === "queued").length;
  const needsAttention = jobs.filter((job) => ["failed", "needs-review"].includes(job.status)).length;
  const activeJobs = jobs.filter((job) => activeStages.has(job.status));
  const jobTitle = (job: Status["jobs"][number]) => jobOperations[job.operation] ?? status?.sources.find((source) => source.id === job.sourceId)?.title ?? job.input?.path ?? "Source operation";
  const activity = !status?.running ? status?.busy ? "Pausing current operation…" : "Paused"
    : status.busy ? "Processing notes…" : waiting ? "Waiting for the next operation…"
      : needsAttention ? "Finished processing; some operations need attention" : "Watching registered notes";
  return <section className="space-y-4 border-t border-border pt-6" aria-label="LLM Wiki">
    <div><h3 className="text-sm font-semibold">LLM Wiki</h3><p className="mt-1 text-sm text-muted-foreground">Build linked knowledge from existing notes in {status?.cabinetName ?? "this Cabinet"}. Your originals stay editable.</p></div>
    {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
    {connectionError && <p role="alert" className="text-sm text-destructive">Cannot refresh progress. The background service may still be processing. Showing the last received status; reconnecting automatically.</p>}
    {!status ? <p role="status" className="text-sm">Connecting to the Wiki service…</p> : !status.enabled ? <Button disabled={busy} onClick={() => void act({ action: "enable" })}>Enable LLM Wiki</Button> : <>
      <p className={status.provider.available && status.provider.hardened === false ? "text-xs text-amber-600 dark:text-amber-400" : "text-sm text-muted-foreground"}>{status.provider.message} Wiki pages are built by the selected agent with its normal tools inside this Cabinet&apos;s wiki folder.</p>
      <label className="flex items-center gap-2 text-sm">Wiki agent<select aria-label="Wiki agent" className="rounded-md border border-border bg-background p-2" value={status.selectedAgent ?? ""} disabled={busy || status.busy || !agents.length} onChange={(event) => void act({ action: "agent", agentSlug: event.target.value })}><option value="">Choose a Cabinet agent</option>{agents.map((agent) => <option key={agent.slug} value={agent.slug}>{agent.name} ({agent.provider}{agent.active === false ? ", inactive for team runs" : ""})</option>)}</select></label>
      {outdatedWikiService ? <p role="alert" className="text-xs text-destructive">Restart Cabinet’s background service to load the Wiki agent selector. Your current Wiki status remains available.</p> : !agents.length && <p className="text-xs text-destructive">No Cabinet agents are available. Add an agent before building the Wiki.</p>}
      {!!agents.length && agents.some((agent) => agent.active === false) && <p className="text-xs text-muted-foreground">You can use an inactive team agent for the Wiki. This does not activate its team runs.</p>}
      {status.provider.model && <p className="text-xs text-muted-foreground">Model: {status.provider.model}</p>}
      <label className="block text-sm">Source folders, one per line<textarea aria-label="Wiki source folders" className="mt-2 block min-h-20 w-full rounded-md border border-border bg-background p-2" value={folders} onChange={(event) => {
        const draft = event.target.value;
        setFolders(draft); setInventory(null); setSelection([]);
        try { localStorage.setItem(folderDraftKey(status.cabinetName), draft); } catch { /* Keep editing usable without browser storage. */ }
      }} /></label>
      <div className="flex flex-wrap gap-2">
        <Button variant="outline" disabled={busy} onClick={() => void act({ action: "inspect", folders: selectedFolders })}>Preview notes</Button>
        <Button variant="outline" disabled={busy || status.busy || !status.selectedAgent} onClick={() => void act({ action: "consolidate" })}>Rebuild overview and concept table</Button>
        <Button variant="outline" disabled={busy || status.busy || !status.selectedAgent} onClick={() => void act({ action: "lint" })}>Check Wiki health</Button>
        <Button variant="outline" disabled={busy || status.busy || !status.selectedAgent} onClick={() => { if (window.confirm("Rebuild every Wiki page from all captured sources? Existing agent-written pages will be regenerated.")) void act({ action: "reprocess-all" }); }}>Rebuild all Wiki pages</Button>
      </div>
      {inventory && <div className="space-y-3 rounded-md border border-border p-3">
        <p className="text-sm">{inventory.notes.length} notes found. Select a small first batch. Notes are sent to your configured AI provider when processed.</p>
        <p className="text-xs text-muted-foreground">{inventory.skipped.length} other entries retained in place. Attachments are captured when referenced by a selected note. Obsidian note embeds and ambiguous links produce warnings.</p>
        {!!inventory.skipped.length && <details className="text-xs text-muted-foreground"><summary>Review skipped entries</summary><ul className="max-h-40 overflow-auto">{inventory.skipped.map((item) => <li key={item.path} className="py-1 break-all">{item.path}: {item.reason}</li>)}</ul></details>}
        <div className="flex flex-wrap gap-2">
          <Button variant="outline" size="sm" onClick={() => setSelection(selection.length === inventory.notes.length ? [] : inventory.notes.map((item) => item.path))}>{selection.length === inventory.notes.length ? "Clear selection" : "Select all notes"}</Button>
          <Button variant="outline" size="sm" disabled={busy || !nonIngestedPaths.length} title="Select notes not yet registered with the Wiki. Notes already queued or awaiting recovery are excluded." onClick={() => setSelection(nonIngestedPaths)}>Select non ingested notes only</Button>
        </div>
        <div className="max-h-64 overflow-auto">{inventory.notes.map((note) => <label key={note.path} className="flex items-start gap-2 py-1 text-sm"><input type="checkbox" checked={selection.includes(note.path)} onChange={(event) => setSelection((old) => event.target.checked ? [...old, note.path] : old.filter((item) => item !== note.path))} /><span className="break-all">{note.path}</span></label>)}</div>
        <Button disabled={busy || !selection.length || !status.provider.available || !status.selectedAgent} onClick={() => void act({ action: "import", folders: selectedFolders, paths: selection, fingerprint: inventory.fingerprint })}>Build Wiki from {selection.length} selected notes</Button>
      </div>}
      <div className="flex flex-wrap items-center gap-3 text-sm"><span role="status">{connectionError ? "Progress unavailable" : activity}</span><Button size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: status.running ? "pause" : "resume" })}>{status.running ? "Pause" : "Resume"}</Button><a className="underline" href={href(`${status.wikiPath}/index.md`)}>Open Wiki</a></div>
      {status.error && <p role="alert" className="text-sm text-destructive">{status.error}</p>}
      {!!jobs.length && <div className="space-y-3 rounded-md border border-border p-3" aria-label="Wiki ingestion progress" role="region">
        <div className="flex justify-between gap-3 text-sm"><span>{completed} of {jobs.length} operations completed.</span><span>{Math.round(completed / jobs.length * 100)}%</span></div>
        <div role="progressbar" aria-label="Wiki operations completed" aria-valuemin={0} aria-valuemax={jobs.length} aria-valuenow={completed} aria-valuetext={`${completed} of ${jobs.length} completed; ${waiting} waiting; ${needsAttention} need attention`} className="h-2 overflow-hidden rounded-full bg-muted">
          <div className="h-full bg-primary transition-[width] motion-reduce:transition-none" style={{ width: `${completed / jobs.length * 100}%` }} />
        </div>
        <p className="text-sm text-muted-foreground">{activeJobs.length} in progress · {waiting} waiting · {needsAttention} need attention</p>
        <div aria-live="polite" className="space-y-2 text-sm">{activeJobs.map((job) => <div key={job.id}><p className="break-words font-medium">{jobTitle(job)}</p><p>{jobStages[job.status]}</p><p className="text-xs text-muted-foreground">Operation last updated at {new Date(job.updatedAt).toLocaleTimeString()}</p>{!!job.agentWarnings?.length && <details className="mt-1 text-xs text-muted-foreground"><summary>{job.agentWarnings.length} agent warnings</summary><ul>{job.agentWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</div>)}</div>
        <p className="text-xs text-muted-foreground">Progress covers all recorded operations and advances when an operation completes. Invalid AI summaries and evidence quotations get up to two automatic correction attempts within the processing time limit. AI generation and checks can take several minutes; progress within an AI response is not available.</p>
        {lastChecked && <p className="text-xs text-muted-foreground">Status received at {lastChecked.toLocaleTimeString()}. Refreshes every 3 seconds.</p>}
        <details className="text-sm"><summary>View all operations</summary><ul className="mt-2 max-h-64 space-y-2 overflow-auto">{jobs.map((job) => <li key={job.id}><span className="break-words">{jobTitle(job)}</span><span className="ml-2 text-muted-foreground">{jobStages[job.status] ?? job.status}</span>{!!job.agentWarnings?.length && <details className="mt-1 text-xs text-muted-foreground"><summary>{job.agentWarnings.length} agent warnings</summary><ul>{job.agentWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}</li>)}</ul></details>
      </div>}
      {status.jobs.filter((job) => ["failed", "needs-review"].includes(job.status)).map((job) => <div key={job.id} className="rounded-md border border-border p-3 text-sm"><p>{jobTitle(job)}: {job.error}</p>{!!job.agentWarnings?.length && <details className="mt-1 text-xs text-muted-foreground"><summary>{job.agentWarnings.length} agent warnings</summary><ul>{job.agentWarnings.map((warning, index) => <li key={index}>{warning}</li>)}</ul></details>}<Button className="mt-2" size="sm" variant="outline" disabled={busy} onClick={() => void act({ action: "retry", id: job.id, updatedAt: job.updatedAt })}>Retry with recovery checks</Button></div>)}
      <ul className="max-h-64 divide-y divide-border overflow-auto">{status.sources.map((source) => <li key={source.id} className="py-2 text-sm"><span>{source.title}</span><span className="ml-2 text-xs text-muted-foreground">{source.status !== "active" ? source.status : source.compiled ? "Wiki up to date" : source.version ? "Captured; Wiki pending" : "Capture pending"}</span>{source.version && <a className="ml-3 underline" href={href(source.rawPath)}>Read captured source</a>}{!!source.warnings?.length && <details className="mt-1 text-xs text-muted-foreground"><summary>{source.warnings.length} capture warnings</summary><ul>{source.warnings.map((warning, index) => <li key={index}>{warning.message}</li>)}</ul></details>}</li>)}</ul>
    </>}
  </section>;
}
