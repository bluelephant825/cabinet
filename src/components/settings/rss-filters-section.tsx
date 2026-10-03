"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useRssText, type RssAction } from "@/components/rss/use-rss";
import type { RssConfig, RssRule, RuleField, RuleOperator } from "@/lib/rss/types";

export function RssFeedSelection({ config, feedIds, folders, onChange }: { config: RssConfig; feedIds: string[]; folders: string[]; onChange: (feedIds: string[], folders: string[]) => void }) {
  const text = useRssText();
  return <fieldset className="space-y-2 rounded-md border p-3"><legend className="text-xs">{text("scope")}</legend><div className="max-h-36 overflow-auto">{config.feeds.map((feed) => <label key={feed.id} className="flex gap-2 text-sm py-1"><input type="checkbox" checked={feedIds.includes(feed.id)} onChange={(event) => onChange(event.target.checked ? [...feedIds, feed.id] : feedIds.filter((id) => id !== feed.id), folders)} />{feed.name}</label>)}</div><label className="block text-xs">{text("folderScope")}<textarea className="block w-full rounded border bg-background p-2 mt-1" value={folders.join("\n")} onChange={(event) => onChange(feedIds, event.target.value.split("\n").filter(Boolean))} /></label></fieldset>;
}
export function RssFiltersSection({ config, act, busy }: { config: RssConfig; act: RssAction; busy: boolean }) {
  const text = useRssText();
  const [draft, setDraft] = useState<RssRule | null>(null);
  const [draftRevision, setDraftRevision] = useState(0);
  const [preview, setPreview] = useState<{ count: number; matches: { title: string; feedName: string }[] } | null>(null);
  const fields: [RuleField, Parameters<typeof text>[0]][] = [["title", "titleField"], ["body", "body"], ["author", "author"], ["category", "category"], ["language", "language"], ["url", "url"], ["domain", "domain"], ["age", "age"], ["date", "date"]];
  const operators: [RuleOperator, Parameters<typeof text>[0]][] = [["contains", "contains"], ["does-not-contain", "doesNotContain"], ["equals", "equals"], ["not-equals", "notEquals"], ["is-missing", "missing"], ["is-present", "present"], ["before", "before"], ["after", "after"], ["greater-than", "greater"], ["less-than", "less"]];
  const newRule = () => { setDraftRevision(config.revision); setDraft({ id: crypto.randomUUID(), name: "", enabled: true, feedIds: [], folders: [], mode: "all", conditions: [{ field: "title", operator: "contains", value: "" }] }); setPreview(null); };
  return <section className="space-y-3" aria-label={text("filtering")}><h3 className="font-semibold">{text("filtering")}</h3><p className="text-sm text-muted-foreground">{text("filterHint")}</p>
    {config.rules.map((rule) => <div key={rule.id} className="flex items-center gap-2 rounded border p-2"><label className="flex gap-2 flex-1 text-sm"><input type="checkbox" checked={rule.enabled} disabled={busy} onChange={() => void act({ action: "rule-save", revision: config.revision, rule: { ...rule, enabled: !rule.enabled } })} />{rule.name}</label><Button variant="ghost" size="sm" onClick={() => { setDraft(structuredClone(rule)); setDraftRevision(config.revision); setPreview(null); }}>{text("edit")}</Button><Button variant="ghost" size="sm" disabled={busy} onClick={() => { if (window.confirm(text("removeRuleConfirm"))) void act({ action: "rule-remove", id: rule.id, revision: config.revision }); }}>{text("remove")}</Button></div>)}
    {!draft ? <Button variant="outline" onClick={newRule}>{text("addRule")}</Button> : <form className="space-y-3 rounded-lg border p-3" onSubmit={async (event) => { event.preventDefault(); if (await act({ action: "rule-save", revision: draftRevision, rule: { ...draft, needsSelection: false } })) setDraft(null); }}>
      <label className="block text-sm">{text("ruleName")}<Input required maxLength={200} value={draft.name} onChange={(event) => setDraft({ ...draft, name: event.target.value })} /></label>
      <RssFeedSelection config={config} feedIds={draft.feedIds} folders={draft.folders} onChange={(feedIds, folders) => setDraft({ ...draft, feedIds, folders })} />
      <select aria-label={text("all")} className="rounded border bg-background p-2 text-sm" value={draft.mode} onChange={(event) => setDraft({ ...draft, mode: event.target.value as "all" | "any" })}><option value="all">{text("all")}</option><option value="any">{text("any")}</option></select>
      {draft.conditions.map((condition, index) => <div key={index} className="flex flex-wrap gap-2">
        <select aria-label={`${text("field")} ${index + 1}`} className="rounded border bg-background p-2 text-sm" value={condition.field} onChange={(event) => { const field = event.target.value as RuleField; setDraft({ ...draft, conditions: draft.conditions.map((c, i) => i === index ? { field, operator: field === "age" ? "greater-than" : field === "date" ? "before" : "contains", value: "" } : c) }); }}>{fields.map(([value, label]) => <option key={value} value={value}>{text(label)}</option>)}</select>
        <select aria-label={`${text("operator")} ${index + 1}`} className="rounded border bg-background p-2 text-sm" value={condition.operator} onChange={(event) => setDraft({ ...draft, conditions: draft.conditions.map((c, i) => i === index ? { ...c, operator: event.target.value as RuleOperator } : c) })}>{operators.filter(([value]) => value.startsWith("is-") || (condition.field === "age" ? ["greater-than", "less-than"].includes(value) : condition.field === "date" ? ["before", "after"].includes(value) : ["contains", "does-not-contain", "equals", "not-equals"].includes(value))).map(([value, label]) => <option key={value} value={value}>{text(label)}</option>)}</select>
        {!condition.operator.startsWith("is-") && <Input className="flex-1 min-w-32" aria-label={`${text("value")} ${index + 1}`} required maxLength={500} type={condition.field === "date" ? "date" : condition.field === "age" ? "number" : "text"} value={condition.value} onChange={(event) => setDraft({ ...draft, conditions: draft.conditions.map((c, i) => i === index ? { ...c, value: event.target.value } : c) })} />}
        {draft.conditions.length > 1 && <Button type="button" variant="ghost" onClick={() => setDraft({ ...draft, conditions: draft.conditions.filter((_, i) => i !== index) })}>{text("remove")}</Button>}
      </div>)}
      <div className="flex flex-wrap gap-2"><Button type="button" variant="outline" disabled={draft.conditions.length >= 20} onClick={() => setDraft({ ...draft, conditions: [...draft.conditions, { field: "title", operator: "contains", value: "" }] })}>{text("addCondition")}</Button><Button type="button" variant="outline" disabled={busy} onClick={async () => setPreview(await act({ action: "rule-preview", rule: draft }))}>{text("preview")}</Button><Button type="submit" disabled={busy}>{text("save")}</Button><Button type="button" variant="ghost" onClick={() => setDraft(null)}>{text("cancel")}</Button></div>
      {preview && <div role="status" className="text-sm"><p>{text("matches")}: {preview.count}</p><ul>{preview.matches.map((match, i) => <li key={i}>{match.feedName}: {match.title}</li>)}</ul></div>}
    </form>}
  </section>;
}
