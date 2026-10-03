import type { RssArticle, RssCondition, RssRule } from "./types";

const fold = (value: string) => value.normalize("NFKC").toLocaleLowerCase("en");
function matches(article: RssArticle, condition: RssCondition, now: number): boolean {
  const values: string[] = (() => {
    switch (condition.field) {
      case "title": return [article.title];
      case "body": return [article.text];
      case "author": return article.authors;
      case "category": return article.categories;
      case "language": return article.language ? [article.language] : [];
      case "url": return article.url ? [article.url] : [];
      case "domain": return article.url ? [new URL(article.url).hostname] : [];
      case "date": return article.publishedAt ? [article.publishedAt] : [];
      case "age": return article.publishedAt ? [String((now - Date.parse(article.publishedAt)) / 86400000)] : [];
    }
  })().filter(Boolean);
  if (condition.operator === "is-missing") return values.length === 0;
  if (condition.operator === "is-present") return values.length > 0;
  if (!values.length) return false;
  const target = fold(condition.value);
  if (condition.operator === "not-equals") return values.every((value) => fold(value) !== target);
  if (condition.operator === "does-not-contain") return values.every((value) => !fold(value).includes(target));
  return values.some((value) => {
    switch (condition.operator) {
      case "contains": return fold(value).includes(target);
      case "equals": return fold(value) === target;
      case "before": return Date.parse(value) < Date.parse(condition.value);
      case "after": return Date.parse(value) > Date.parse(condition.value);
      case "greater-than": return Number(value) > Number(condition.value);
      case "less-than": return Number(value) < Number(condition.value);
      default: return false;
    }
  });
}
export function matchingRules(article: RssArticle, rules: RssRule[], folder: string, now = Date.now()): string[] {
  return rules.filter((rule) => rule.enabled && (!rule.feedIds.length && !rule.folders.length || rule.feedIds.includes(article.feedId) || rule.folders.some((f) => folder === f || folder.startsWith(`${f}/`))) && rule.conditions.length > 0 && (rule.mode === "all" ? rule.conditions.every((c) => matches(article, c, now)) : rule.conditions.some((c) => matches(article, c, now)))).map((rule) => rule.name);
}
