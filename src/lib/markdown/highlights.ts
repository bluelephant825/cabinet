import { parseFragment, type DefaultTreeAdapterMap } from "parse5";

type HtmlNode = DefaultTreeAdapterMap["node"];

function textContent(node: HtmlNode): string {
  if ("value" in node) return node.value;
  return "childNodes" in node ? node.childNodes.map(textContent).join("") : "";
}

/** Read annotation attributes as HTML, including mixed quotes and entities. */
export function extractHighlights(content: string) {
  const highlights: {
    id: number;
    text: string;
    color: string | null;
    note: string | null;
    tags: string[];
  }[] = [];

  function visit(node: HtmlNode) {
    if ("tagName" in node && node.tagName === "mark") {
      const attrs = new Map(node.attrs.map(({ name, value }) => [name, value]));
      const style = attrs.get("style") ?? "";
      const color = attrs.get("data-color") ?? attrs.get("color") ??
        style.match(/(?:background-color|background)\s*:\s*([^;]+)/i)?.[1];
      const tags = Array.from(new Set(
        (attrs.get("data-tags") ?? "")
          .split(/[\s,]+/)
          .map((tag) => tag.replace(/^#/, ""))
          .filter(Boolean)
      ));
      highlights.push({
        id: highlights.length,
        text: textContent(node).trim(),
        color: color?.trim() || null,
        note: attrs.get("data-note") || null,
        tags,
      });
    }
    if ("childNodes" in node) node.childNodes.forEach(visit);
  }

  visit(parseFragment(content));
  return highlights.filter((highlight) => highlight.text.length > 0);
}
