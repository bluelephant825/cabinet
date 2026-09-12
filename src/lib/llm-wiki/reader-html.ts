import { parseFragment, serialize, type DefaultTreeAdapterMap } from "parse5";
import { unified } from "unified";
import remarkParse from "remark-parse";
import remarkGfm from "remark-gfm";
import remarkRehype from "remark-rehype";
import rehypeStringify from "rehype-stringify";
import type { Root, RootContent } from "mdast";

type Node = DefaultTreeAdapterMap["node"];
const tags = new Set("p div span article section header footer main h1 h2 h3 h4 h5 h6 strong em b i u s del pre code blockquote ul ol li table thead tbody tfoot tr th td caption figure figcaption img a hr br sup sub details summary input".split(" "));
/** Allowlisted markup only. Original documents cannot navigate; images must be
 * resolved from captured bytes by the caller. No imported CSS or executable HTML. */
export async function safeHtml(html: string, image: (url: string) => Promise<string | null>, original = false) {
  const tree = parseFragment(html);
  const walk = async (node: Node): Promise<void> => {
    if (!("childNodes" in node)) return;
    node.childNodes = node.childNodes.filter((child) => child.nodeName === "#text" ||
      ("tagName" in child && tags.has(child.tagName)));
    for (const child of node.childNodes) {
      if (!("tagName" in child)) continue;
      const attrs = child.attrs;
      const get = (name: string) => attrs.find((attr) => attr.name === name)?.value;
      child.attrs = attrs.filter((attr) => ["title", "alt", "colspan", "rowspan"].includes(attr.name));
      if (child.tagName === "a" && !original) {
        const href = get("href") ?? "";
        if (/^https?:\/\//i.test(href)) child.attrs.push({ name: "href", value: href }, { name: "target", value: "_blank" }, { name: "rel", value: "noopener noreferrer" });
        else if (/^#[a-zA-Z0-9_-]+$/.test(href)) child.attrs.push({ name: "href", value: href });
      }
      const id = get("id");
      if (id && /^user-content-[a-zA-Z0-9_-]+$/.test(id)) child.attrs.push({ name: "id", value: id });
      if (child.tagName === "img") {
        const src = await image(get("src") ?? "");
        if (src) child.attrs.push({ name: "src", value: src });
        else child.attrs.push({ name: "alt", value: get("alt") || "Image unavailable in this capture" });
      }
      if (child.tagName === "input") child.attrs.push({ name: "type", value: "checkbox" }, { name: "disabled", value: "" }, ...(get("checked") !== undefined ? [{ name: "checked", value: "" }] : []));
      await walk(child);
    }
  };
  await walk(tree);
  return serialize(tree);
}
export async function readerHtml(markdown: string, image: (url: string) => Promise<string | null>) {
  // Deliberately no MDX, raw HTML, embed or live-code transforms.
  const callouts = () => (tree: Root) => {
    const visit = (node: Root | RootContent) => {
      if (node.type === "blockquote") {
        const paragraph = node.children[0];
        const first = paragraph?.type === "paragraph" ? paragraph.children[0] : undefined;
        const match = first?.type === "text" ? /^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\](?:\s|$)/.exec(first.value) : null;
        if (match && first?.type === "text" && paragraph.type === "paragraph") {
          first.value = first.value.slice(match[0].length);
          paragraph.children.unshift({ type: "strong", children: [{ type: "text", value: `${match[1][0]}${match[1].slice(1).toLowerCase()}: ` }] });
        }
      }
      if ("children" in node) for (const child of node.children) visit(child as RootContent);
    };
    visit(tree);
  };
  const rendered = await unified().use(remarkParse).use(remarkGfm).use(callouts).use(remarkRehype).use(rehypeStringify).process(markdown);
  return safeHtml(String(rendered), image);
}

/** Static notebook cells and text outputs only; never start a kernel or render
 * executable rich outputs. Uses the same sanitizer as the Reader. */
export async function notebookHtml(text: string) {
  const notebook = JSON.parse(text);
  if (!Array.isArray(notebook.cells) || notebook.cells.length > 500) throw new Error("Notebook preview limit exceeded");
  const join = (value: unknown): string => typeof value === "string" ? value : Array.isArray(value) && value.every((item) => typeof item === "string") ? value.join("") : "";
  const escape = (value: string) => value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const cells: string[] = [];
  for (const cell of notebook.cells) {
    const source = join(cell.source);
    if (cell.cell_type === "markdown") cells.push(await readerHtml(source, async () => null));
    else cells.push(`<pre><code>${escape(source)}</code></pre>`);
    if (Array.isArray(cell.outputs)) for (const output of cell.outputs) {
      const captured = join(output.text ?? output.data?.["text/plain"]);
      if (captured) cells.push(`<pre>${escape(captured)}</pre>`);
    }
  }
  return originalDocument(cells.join("\n"));
}
export const ORIGINAL_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-src 'none'; connect-src 'none'";
export function originalDocument(body: string) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${ORIGINAL_CSP}"><style>body{font:16px/1.65 system-ui;margin:32px;color:#202020;background:#fff}img{max-width:100%}pre{white-space:pre-wrap}table{border-collapse:collapse}td,th{border:1px solid #ddd;padding:8px}</style></head><body>${body}</body></html>`;
}
