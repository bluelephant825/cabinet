import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";

interface MarkdownNode { type: string; value?: string; url?: string; children?: MarkdownNode[] }
export function cleanBriefMarkdown(output: string, sources: string[]): string {
  const processor = unified().use(remarkParse).use(remarkStringify);
  const root = processor.parse(output) as unknown as MarkdownNode;
  const allowed = new Set(sources);
  function clean(node: MarkdownNode): MarkdownNode[] {
    if (["html", "image", "imageReference", "definition"].includes(node.type)) return [];
    if (node.children) node.children = node.children.flatMap(clean);
    if (node.type === "linkReference" || node.type === "link" && !allowed.has(node.url || "")) return node.children || [];
    return [node];
  }
  clean(root);
  return processor.stringify(root as Parameters<typeof processor.stringify>[0]).trim();
}
