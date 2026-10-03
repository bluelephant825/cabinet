"use client";

import { useEffect, useState } from "react";
import { Rss } from "lucide-react";
import { Button } from "@/components/ui/button";
import { ContentSheet } from "@/components/layout/content-sheet";
import { NavArrows } from "@/components/layout/nav-arrows";
import { SafeHtml } from "@/components/ui/safe-html";
import { useAppStore } from "@/stores/app-store";
import { useRoomsStore } from "@/stores/rooms-store";
import { getHost } from "@/lib/host";
import { rssGet, useRssState, useRssText } from "./use-rss";
import type { RssArticle } from "@/lib/rss/types";

type Article = RssArticle & { excludedBy: string[]; feedName: string };
function RoomReader({ room }: { room: string }) {
  const text = useRssText();
  const { state, error, busy, act, refresh } = useRssState(room);
  const [feedId, setFeedId] = useState("");
  const [unread, setUnread] = useState(false);
  const [excluded, setExcluded] = useState(false);
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState("");
  const [listing, setListing] = useState<{ articles: Article[]; total: number }>({ articles: [], total: 0 });
  const [detail, setDetail] = useState<Article | null>(null);
  const [readError, setReadError] = useState("");
  const revision = state ? `${state.config.revision}:${state.feeds.map((f) => `${f.unread}:${f.checkedAt}`).join("|")}` : "";
  useEffect(() => {
    const controller = new AbortController();
    void rssGet<{ articles: Article[]; total: number }>("articles", room, { feedId, unread: unread ? "1" : "0", excluded: excluded ? "1" : "0", offset: String(offset) }, controller.signal).then((result) => { if (!controller.signal.aborted) { setListing(result); setReadError(""); } }).catch((failure) => { if (!controller.signal.aborted) setReadError(failure.message); });
    return () => controller.abort();
  }, [room, feedId, unread, excluded, offset, revision]);
  useEffect(() => {
    if (!selected) return;
    const controller = new AbortController();
    void rssGet<{ articles: Article[] }>("articles", room, { id: selected, excluded: "1" }, controller.signal).then((result) => { if (!controller.signal.aborted) setDetail(result.articles[0] || null); }).catch((failure) => { if (!controller.signal.aborted) setReadError(failure.message); });
    return () => controller.abort();
  }, [room, selected, revision]);
  const selectFeed = (id: string) => { setFeedId(id); setOffset(0); setSelected(""); };
  return <ContentSheet className="flex-1 min-h-0 overflow-hidden"><div className="h-full flex flex-col">
    <div className="flex flex-wrap gap-2 items-center border-b p-3"><Button variant="outline" disabled={busy} onClick={() => void act({ action: "refresh", ...(feedId ? { feedId } : {}) })}>{text("refresh")}</Button><label className="flex gap-2 text-sm"><input type="checkbox" checked={unread} onChange={(event) => { setUnread(event.target.checked); setOffset(0); }} />{text("unread")}</label><label className="flex gap-2 text-sm"><input type="checkbox" checked={excluded} onChange={(event) => { setExcluded(event.target.checked); setOffset(0); }} />{text("excluded")}</label><Button variant="ghost" size="sm" disabled={busy} onClick={() => void act({ action: "read", feedId, read: true })}>{text("markAll")}</Button></div>
    {(error || readError) && <p role="alert" className="p-3 text-sm text-destructive">{error || readError}</p>}
    <div className="flex flex-1 min-h-0 flex-col md:flex-row">
      <aside className="border-b md:border-b-0 md:border-e p-2 md:w-44 md:shrink-0 overflow-auto max-h-36 md:max-h-none"><button className="block w-full rounded p-2 text-start text-sm hover:bg-accent" onClick={() => selectFeed("")}>{text("allFeeds")}</button>{[...new Set(state?.feeds.map((feed) => feed.folder) || [])].sort().map((folder) => <div key={folder}>{folder && <h3 className="text-xs text-muted-foreground p-2 font-semibold">{folder}</h3>}{state?.feeds.filter((feed) => feed.folder === folder).map((feed) => <button key={feed.id} className={`block w-full rounded p-2 text-start text-sm hover:bg-accent ${feedId === feed.id ? "bg-accent" : ""}`} onClick={() => selectFeed(feed.id)}>{feed.name} <span className="text-xs text-muted-foreground">{feed.unread}</span>{feed.error && <span className="block text-xs text-destructive">{feed.error}</span>}</button>)}</div>)}</aside>
      <div className={`md:w-72 md:shrink-0 border-e overflow-auto ${selected ? "hidden md:block" : "flex-1 md:flex-none"}`}><div className="divide-y">{listing.articles.map((article) => <button key={article.id} className={`block w-full p-3 text-start hover:bg-accent ${selected === article.id ? "bg-accent" : ""}`} onClick={() => { setDetail(null); setSelected(article.id); void act({ action: "read", id: article.id, read: true }); }}><p className={`text-sm ${article.read ? "text-muted-foreground" : "font-semibold"}`}>{article.title}</p><p className="text-xs text-muted-foreground mt-1">{article.feedName} · {new Date(article.publishedAt || article.firstSeenAt).toLocaleDateString()}</p><p className="text-xs text-muted-foreground mt-2 line-clamp-2">{article.text}</p>{article.excludedBy.length > 0 && <p className="text-xs text-amber-600 mt-1">{text("excludedBy")}: {article.excludedBy.join(", ")}</p>}</button>)}</div>{!listing.total && <p className="p-3 text-sm text-muted-foreground">{text("noArticles")}</p>}<div className="flex gap-2 p-3"><Button size="sm" variant="outline" disabled={!offset} onClick={() => setOffset(Math.max(0, offset - 50))}>{text("previous")}</Button><Button size="sm" variant="outline" disabled={offset + 50 >= listing.total} onClick={() => setOffset(offset + 50)}>{text("next")}</Button></div></div>
      <article className={`flex-1 min-w-0 overflow-auto p-5 ${selected ? "block" : "hidden md:block"}`}>
        {selected && <Button size="sm" variant="ghost" className="md:hidden mb-3" onClick={() => setSelected("")}>{text("previous")}</Button>}
        {!selected ? <p className="text-sm text-muted-foreground">{text("selectArticle")}</p> : !detail ? <p role="status">{text("loading")}</p> : <><h1 className="text-xl font-semibold mb-2">{detail.title}</h1><p className="text-xs text-muted-foreground mb-3">{detail.feedName}{detail.authors.length ? ` · ${detail.authors.join(", ")}` : ""}</p><div className="flex gap-3 items-center mb-4"><Button size="sm" variant="outline" disabled={busy} onClick={async () => { await act({ action: "read", id: detail.id, read: !detail.read }); void refresh(); }}>{detail.read ? text("markUnread") : text("markRead")}</Button>{detail.url && <a className="text-sm underline" href={detail.url} target="_blank" rel="noopener noreferrer" referrerPolicy="no-referrer" onClick={(event) => { event.preventDefault(); if (new URL(detail.url!).origin !== window.location.origin) void getHost().system.openExternal(detail.url!); }}>{text("original")}</a>}</div>{detail.excludedBy.length > 0 && <p className="text-xs text-amber-600 mb-4">{text("excludedBy")}: {detail.excludedBy.join(", ")}</p>}<p className="text-xs text-muted-foreground mb-4">{text("privacy")}</p>{detail.html ? <SafeHtml html={detail.html} profile="rss" className="prose prose-sm dark:prose-invert max-w-none" onClick={(event) => { const link = (event.target as Element).closest("a"); if (!link) return; const url = new URL(link.href); event.preventDefault(); if (["http:", "https:"].includes(url.protocol) && url.origin !== window.location.origin) void getHost().system.openExternal(url.toString()); }} /> : <p className="whitespace-pre-wrap text-sm">{detail.text}</p>}</>}
      </article>
    </div>
  </div></ContentSheet>;
}
export function RssReader() {
  const text = useRssText();
  const room = useAppStore((store) => store.section.cabinetPath) || ".";
  const rooms = useRoomsStore((store) => store.rooms);
  const load = useRoomsStore((store) => store.load);
  useEffect(() => { void load(); }, [load]);
  return <div className="flex-1 flex flex-col min-h-0 overflow-hidden"><header className="flex h-10 shrink-0 items-center justify-between gap-2 px-4" style={{ paddingInlineStart: "calc(1rem + var(--sidebar-toggle-offset, 0px))" }}><div className="flex items-center gap-2"><Rss className="h-4 w-4" /><h1 className="text-sm font-semibold">{text("title")}</h1><select aria-label={text("room")} className="text-sm bg-transparent max-w-40" value={room} onChange={(event) => useAppStore.getState().setSection({ type: "rss", cabinetPath: event.target.value })}>{rooms.map((entry) => <option key={entry.path} value={entry.path}>{entry.name}</option>)}</select></div><div className="flex gap-2"><Button variant="ghost" size="sm" onClick={() => useAppStore.getState().setSection({ type: "settings", slug: "rss", cabinetPath: room })}>{text("settings")}</Button><NavArrows /></div></header><RoomReader key={room} room={room} /></div>;
}
