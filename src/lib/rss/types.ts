export interface RssFeed {
  id: string;
  url: string;
  name: string;
  folder: string;
  enabled: boolean;
  addedAt: string;
}
export interface RssArticle {
  id: string;
  feedId: string;
  title: string;
  url: string | null;
  html: string;
  text: string;
  authors: string[];
  categories: string[];
  language: string | null;
  publishedAt: string | null;
  firstSeenAt: string;
  read: boolean;
}
export type RuleField = "title" | "body" | "author" | "category" | "language" | "url" | "domain" | "age" | "date";
export type RuleOperator = "contains" | "does-not-contain" | "equals" | "not-equals" | "is-missing" | "is-present" | "before" | "after" | "greater-than" | "less-than";
export interface RssCondition { field: RuleField; operator: RuleOperator; value: string }
export interface RssRule { id: string; name: string; enabled: boolean; needsSelection?: boolean; feedIds: string[]; folders: string[]; mode: "all" | "any"; conditions: RssCondition[] }
export interface RssBrief {
  id: string;
  needsSelection?: boolean;
  name: string;
  agentSlug: string;
  feedIds: string[];
  folders: string[];
  instructions: string;
  schedule: string;
  enabled: boolean;
  outputFolder: string;
  maxArticles: number;
  maxBytes: number;
}
export interface RssConfig { version: 1; revision: number; automatic: boolean; intervalMinutes: number; retention: number; feeds: RssFeed[]; rules: RssRule[]; briefs: RssBrief[] }
export interface RssCache { version: 1; articles: RssArticle[]; seen: string[]; deleted?: string[]; checkedAt: string | null; etag?: string; lastModified?: string; error: string | null; nextAttemptAt?: string; failures?: number }
export type BriefStatus = "preparing" | "running" | "uncertain" | "publish-pending" | "completed" | "failed" | "no-input";
export interface RssBriefRun {
  id: string;
  briefId: string;
  occurrence: string;
  createdAt: string;
  status: BriefStatus;
  configRevision: number;
  brief: RssBrief;
  articles: RssArticle[];
  prompt: string;
  conversationId?: string;
  output?: string;
  pagePath?: string;
  error?: string;
  omitted: number;
}
export type RssRunSummary = Pick<RssBriefRun, "id" | "briefId" | "createdAt" | "status" | "conversationId" | "pagePath" | "error" | "omitted">;
export interface RssState { room: string; nextRuns: Record<string, string | null>; config: RssConfig; feeds: (RssFeed & { unread: number; excluded: number; checkedAt: string | null; error: string | null; refreshing: boolean })[]; runs: RssRunSummary[]; timezone: string }
export const emptyConfig = (): RssConfig => ({ version: 1, revision: 0, automatic: false, intervalMinutes: 30, retention: 500, feeds: [], rules: [], briefs: [] });
export const emptyCache = (): RssCache => ({ version: 1, articles: [], seen: [], checkedAt: null, error: null });
