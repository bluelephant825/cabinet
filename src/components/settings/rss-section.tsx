"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useRssState, useRssText, type RssAction } from "@/components/rss/use-rss";
import { useRoomsStore } from "@/stores/rooms-store";
import { useAppStore } from "@/stores/app-store";
import { RssFiltersSection } from "./rss-filters-section";
import { RssBriefsSection } from "./rss-briefs-section";
import type { RssConfig, RssFeed } from "@/lib/rss/types";

function RefreshSettings({ config, act, busy }: { config: RssConfig; act: RssAction; busy: boolean }) {
  const text = useRssText();
  const [automatic, setAutomatic] = useState(config.automatic);
  const [interval, setInterval] = useState(config.intervalMinutes);
  const [retention, setRetention] = useState(config.retention);
  return <form className="space-y-3 rounded border p-3" onSubmit={(event) => { event.preventDefault(); void act({ action: "settings", revision: config.revision, automatic, intervalMinutes: interval, retention }); }}>
    <label className="flex gap-2 text-sm"><input type="checkbox" checked={automatic} onChange={(event) => setAutomatic(event.target.checked)} />{text("automatic")}</label>
    <div className="grid sm:grid-cols-2 gap-3"><label className="text-sm">{text("interval")}<Input required type="number" min={5} max={1440} value={interval} onChange={(event) => setInterval(Number(event.target.value))} /></label><label className="text-sm">{text("retention")}<Input required type="number" min={10} max={2000} value={retention} onChange={(event) => setRetention(Number(event.target.value))} /></label></div>
    <Button type="submit" disabled={busy}>{text("saveSettings")}</Button>
  </form>;
}
function RoomRssSettings({ room }: { room: string }) {
  const { state, error, busy, act } = useRssState(room);
  const text = useRssText();
  const [draft, setDraft] = useState<Partial<RssFeed> | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [opml, setOpml] = useState<{ content: string; added: RssFeed[]; duplicates: number; invalid: number } | null>(null);
  const [fileError, setFileError] = useState("");
  const [report, setReport] = useState<{ imported: number; duplicates: number; invalid: number } | null>(null);
  const [removeTarget, setRemoveTarget] = useState<RssFeed | null>(null);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");
  useEffect(() => { if (removeTarget && error) setRemoveError(error); }, [removeTarget, error]);
  const removeFeed = async () => {
    if (!removeTarget || !state || removing || busy) return;
    setRemoveError(""); setRemoving(true);
    try {
      if (await act({ action: "feed-remove", id: removeTarget.id, revision: state.config.revision })) {
        if (draft?.id === removeTarget.id) setDraft(null);
        setRemoveTarget(null);
      }
    } finally { setRemoving(false); }
  };
  if (!state) return <div>{error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <p role="status">{text("loading")}</p>}</div>;
  const config = state.config;
  return <div className="space-y-6">{(error || fileError) && <p role="alert" className="text-sm text-destructive">{error || fileError}</p>}
    <div className="flex flex-wrap gap-2"><Button variant="outline" onClick={() => useAppStore.getState().setSection({ type: "rss", cabinetPath: room })}>{text("reader")}</Button><Button variant="outline" disabled={busy} onClick={() => void act({ action: "refresh" })}>{text("refreshAll")}</Button></div>
    <RefreshSettings key={config.revision} config={config} act={act} busy={busy} />
    <section className="space-y-3" aria-label={text("subscriptions")}><h3 className="font-semibold">{text("subscriptions")}</h3>
      {!state.feeds.length && <p className="text-sm text-muted-foreground">{text("noFeeds")}</p>}
      {state.feeds.map((feed) => <div key={feed.id} className="rounded border p-3 space-y-2"><div className="flex flex-wrap items-center gap-2"><label className="flex items-center gap-2 flex-1 font-medium"><input type="checkbox" checked={feed.enabled} disabled={busy} onChange={() => void act({ action: "feed-save", ...feed, enabled: !feed.enabled, revision: config.revision })} />{feed.name}</label><span className="text-xs text-muted-foreground">{text("unread")}: {feed.unread}{feed.folder && ` · ${feed.folder}`}</span><Button size="sm" variant="ghost" onClick={() => { setDraft(feed); setDraftRevision(config.revision); }}>{text("edit")}</Button><Button size="sm" variant="ghost" disabled={busy} onClick={() => { setRemoveError(""); setRemoveTarget(feed); }}>{text("remove")}</Button><Button size="sm" variant="outline" disabled={busy || feed.refreshing || !feed.enabled} onClick={() => void act({ action: "refresh", feedId: feed.id })}>{text("refresh")}</Button></div><p className="text-xs text-muted-foreground break-all">{feed.url}</p>{feed.checkedAt && <p className="text-xs text-muted-foreground">{new Date(feed.checkedAt).toLocaleString()}</p>}{feed.error && <p className="text-xs text-destructive">{feed.error}</p>}</div>)}
      {!draft ? <Button variant="outline" onClick={() => { setDraft({ name: "", url: "", folder: "", enabled: true }); setDraftRevision(config.revision); }}>{text("addFeed")}</Button> : <form className="space-y-3 rounded-lg border p-3" onSubmit={async (event) => { event.preventDefault(); if (await act({ action: "feed-save", ...draft, revision: draftRevision })) setDraft(null); }}>
        <label className="block text-sm">{text("url")}<Input required type="url" maxLength={4000} value={draft.url || ""} onChange={(event) => setDraft({ ...draft, url: event.target.value })} /></label>
        <label className="block text-sm">{text("name")}<Input maxLength={200} value={draft.name || ""} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
        <label className="block text-sm">{text("folder")}<Input maxLength={500} value={draft.folder || ""} onChange={(event) => setDraft({ ...draft, folder: event.target.value })} /></label>
        <div className="flex gap-2"><Button type="submit" disabled={busy}>{text("save")}</Button><Button type="button" variant="ghost" onClick={() => setDraft(null)}>{text("cancel")}</Button></div>
      </form>}
      <div className="flex flex-wrap gap-3 items-center"><label className="text-sm">{text("import")}<input className="block text-xs mt-1" type="file" accept=".opml,.xml,text/xml,application/xml" disabled={busy} onChange={async (event) => { const file = event.target.files?.[0]; event.target.value = ""; if (!file) return; setFileError(""); try { if (file.size > 1024 * 1024) throw new Error("OPML exceeds the 1 MB limit"); const content = await file.text(); const result = await act<{ added: RssFeed[]; duplicates: number; invalid: number }>({ action: "opml-preview", content }); if (result) setOpml({ content, ...result }); } catch (failure) { setFileError(failure instanceof Error ? failure.message : text("unavailable")); } }} /></label><a className="text-sm underline" href={`/api/rss/export?room=${encodeURIComponent(room)}`} download="cabinet-feeds.opml">{text("export")}</a></div>
      {opml && <div className="rounded border p-3 text-sm space-y-2"><p>{text("count")}: {opml.added.length} · {text("duplicates")}: {opml.duplicates} · {text("invalid")}: {opml.invalid}</p><ul className="max-h-32 overflow-auto">{opml.added.slice(0, 50).map((feed) => <li key={feed.id}>{feed.folder ? `${feed.folder}/` : ""}{feed.name}</li>)}</ul><Button disabled={busy || !opml.added.length} onClick={async () => { const result = await act<{ report: { imported: number; duplicates: number; invalid: number } }>({ action: "opml-import", content: opml.content, revision: config.revision }); if (result) { setReport(result.report); setOpml(null); } }}>{text("importConfirm")}</Button><Button variant="ghost" onClick={() => setOpml(null)}>{text("cancel")}</Button></div>}
      {report && <p role="status" className="text-sm">{text("imported")}: {report.imported} · {text("duplicates")}: {report.duplicates} · {text("invalid")}: {report.invalid}</p>}
    </section>
    <Dialog open={!!removeTarget} onOpenChange={(open) => { if (!open && !removing) setRemoveTarget(null); }}>
      <DialogContent showCloseButton={!removing}>
        <DialogHeader><DialogTitle>{text("remove")}</DialogTitle><DialogDescription>{text("removeConfirm")}</DialogDescription></DialogHeader>
        <p className="text-sm font-medium wrap-break-word">{removeTarget?.name}</p>
        {removeError && <p role="alert" className="text-sm text-destructive">{removeError}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={removing || busy} onClick={() => setRemoveTarget(null)}>{text("cancel")}</Button>
          <Button type="button" variant="destructive" disabled={removing || busy} onClick={() => void removeFeed()}>{removing ? text("loading") : text("remove")}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
    <RssFiltersSection config={config} act={act} busy={busy} />
    <RssBriefsSection state={state} act={act} busy={busy} error={error} />
  </div>;
}
export function RssSection() {
  const text = useRssText();
  const rooms = useRoomsStore((store) => store.rooms);
  const defaultRoom = useRoomsStore((store) => store.defaultRoom);
  const load = useRoomsStore((store) => store.load);
  const contextRoom = useAppStore((store) => store.section.cabinetPath);
  const [selected, setSelected] = useState("");
  useEffect(() => { void load(); }, [load]);
  const room = selected || (rooms.some((r) => r.path === contextRoom) ? contextRoom : null) || defaultRoom || rooms[0]?.path || "";
  return <section className="space-y-5" aria-label={text("title")}><h2 className="text-lg font-semibold">{text("title")}</h2><label className="block text-sm">{text("room")}<select aria-label={text("room")} className="block rounded border bg-background p-2 mt-1" value={room} onChange={(event) => setSelected(event.target.value)}>{rooms.map((r) => <option key={r.path} value={r.path}>{r.name}</option>)}</select></label>{rooms.some((r) => r.path === room) ? <RoomRssSettings key={room} room={room} /> : <p className="text-sm text-muted-foreground">{text("noRooms")}</p>}</section>;
}
