/**
 * DOCX → Markdown/MDX. Walks the docx-engine `ParsedDoc` block model and
 * emits CommonMark/GFM; the only MDX-only construct emitted is `<Callout>`
 * for anchored textboxes (the one registered component we use).
 */
import type {
  ParsedDoc,
  Run,
  TableCell,
  TableModel,
  TextboxParaDisplay,
} from "../../../src/vendor/genoffice/packages/docx-engine/src/index";
import { emitRuns, escapeMd, type MdRun } from "./inline";
import type { AssetSink } from "./assets";

export interface DocxToMarkdownOptions {
  target: "md" | "mdx";
  assets: AssetSink;
}

const IMAGE_EXT: Record<string, "png" | "jpg" | "gif" | "webp"> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
};

function runToMd(run: Run): MdRun {
  return {
    text: run.text,
    bold: run.bold,
    italic: run.italic,
    strike: run.strike,
    link: run.link ? { href: run.link.href } : undefined,
    noteRef: run.noteRef
      ? run.noteRef.kind === "footnote"
        ? run.noteRef.id
        : `endnote-${run.noteRef.id}`
      : undefined,
  };
}

function emitMdRuns(runs: Run[] | undefined, opts?: { lineStart?: boolean; inTable?: boolean }): string {
  return emitRuns((runs ?? []).filter((r) => !r.del).map(runToMd), opts);
}

function decodeDataUrl(url: string): { mime: string; bytes: Uint8Array } | null {
  const m = /^data:([^;,]+);base64,(.*)$/s.exec(url);
  if (!m) return null;
  try {
    return { mime: m[1]!, bytes: new Uint8Array(Buffer.from(m[2]!, "base64")) };
  } catch {
    return null;
  }
}

function cellText(cell: TableCell, warnings: string[]): string {
  let parts: string[];
  if (cell.richParas && cell.richParas.length > 0) {
    parts = cell.richParas.map((p) => emitMdRuns(p.runs, { inTable: true }));
  } else {
    parts = cell.paras.map((p) => escapeMd(p, { inTable: true }));
  }
  if (cell.nestedTables && cell.nestedTables.length > 0) {
    warnings.push("nested table flattened");
    for (const nested of cell.nestedTables) {
      parts.push(
        nested.rows
          .flat()
          .map((c) => escapeMd(c.paras.join(" "), { inTable: true }))
          .join(" "),
      );
    }
  }
  return parts.filter(Boolean).join("<br>");
}

function tableToMd(table: TableModel, warnings: string[]): string {
  const rows = table.rows;
  if (rows.length === 0) return "";
  const width = Math.max(
    ...rows.map((row) => row.reduce((n, c) => n + (c.colSpan ?? 1), 0)),
  );
  const renderRow = (row: TableCell[]): string[] => {
    const cells: string[] = [];
    for (const cell of row) {
      if (cell.vMerge === "continue" || cell.gridGap) {
        cells.push("");
      } else {
        cells.push(cellText(cell, warnings));
      }
      for (let i = 1; i < (cell.colSpan ?? 1); i++) cells.push("");
    }
    while (cells.length < width) cells.push("");
    return cells;
  };

  const lines: string[] = [];
  const header = renderRow(rows[0]!);
  lines.push(`| ${header.join(" | ")} |`);
  lines.push(`| ${header.map(() => "---").join(" | ")} |`);
  for (const row of rows.slice(1)) {
    lines.push(`| ${renderRow(row).join(" | ")} |`);
  }
  return lines.join("\n");
}

function textboxToMd(paras: TextboxParaDisplay[]): string {
  return paras.map((p) => emitMdRuns(p.runs)).filter(Boolean).join("\n\n");
}

export async function docxToMarkdown(
  doc: ParsedDoc,
  opts: DocxToMarkdownOptions,
): Promise<{ markdown: string; warnings: string[]; title?: string }> {
  const warnings: string[] = [];
  const out: { text: string; listItem?: boolean }[] = [];
  const push = (text: string, opts?: { listItem?: boolean }) => {
    if (text) out.push({ text, listItem: opts?.listItem });
  };
  let title: string | undefined;
  let tocWarned = false;
  // Ordered-list ordinals: running per numId, restarted when the numId changes.
  let lastNumId: string | null = null;
  let ordinal = 0;

  const endBlock = () => {
    lastNumId = null;
    ordinal = 0;
  };

  for (const block of doc.blocks) {
    if (block.hidden || block.invisibleMarker || block.blockRevision?.kind === "del") {
      continue;
    }

    // Anchored textboxes render as callout content on whichever block carries them.
    const emitTextboxes = () => {
      for (const box of block.textboxes ?? []) {
        const body = textboxToMd(box.paras);
        if (!body) continue;
        if (opts.target === "mdx") {
          push(`<Callout>\n\n${body}\n\n</Callout>`);
        } else {
          push(body.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
        }
      }
    };

    switch (block.type) {
      case "heading": {
        const level = Math.min(Math.max(block.level ?? 1, 1), 6);
        const text = emitMdRuns(block.runs);
        push(`${"#".repeat(level)} ${text}`);
        if (!title) title = (block.runs ?? []).map((r) => r.text).join("").trim() || undefined;
        break;
      }
      case "paragraph": {
        const text = emitMdRuns(block.runs, { lineStart: true });
        push(text);
        break;
      }
      case "listItem": {
        const kind = block.list?.kind ?? "bullet";
        const ilvl = block.list?.ilvl ?? 0;
        const text = emitMdRuns(block.runs);
        if (kind === "ordered") {
          const numId = block.list?.numId ?? "";
          ordinal = numId === lastNumId ? ordinal + 1 : 1;
          lastNumId = numId;
          push(`${"   ".repeat(ilvl)}${ordinal}. ${text}`, { listItem: true });
        } else {
          push(`${"  ".repeat(ilvl)}- ${text}`, { listItem: true });
        }
        break;
      }
      case "table": {
        if (block.table) push(tableToMd(block.table, warnings));
        break;
      }
      case "image": {
        if (block.decorative) {
          push("---");
          break;
        }
        if (block.brokenImage) {
          warnings.push(`${block.label ?? "Image"}: image data missing — skipped`);
          break;
        }
        const decoded = block.imageDataUrl ? decodeDataUrl(block.imageDataUrl) : null;
        const ext = decoded ? IMAGE_EXT[decoded.mime] : undefined;
        if (!decoded || !ext) {
          warnings.push(`${block.label ?? "Image"}: unsupported image type — skipped`);
          break;
        }
        const ref = await opts.assets.add(decoded.bytes, ext);
        push(`![${escapeMd(block.label ?? "image")}](${ref})`);
        break;
      }
      case "passthrough": {
        if (block.fieldDisplay) {
          if (!tocWarned) {
            warnings.push("table of contents / field blocks omitted");
            tocWarned = true;
          }
          break;
        }
        const label = block.label ?? "Embedded object";
        if (block.chartDisplay || block.diagramDisplay || block.oleProgId || block.formulaDisplay) {
          const preview = block.previewText?.trim();
          if (preview) {
            push(escapeMd(preview, { lineStart: true }));
            warnings.push(`${label} kept as text`);
          } else {
            push(`<!-- omitted: ${label} -->`);
            warnings.push(`${label} omitted`);
          }
          break;
        }
        const preview = block.previewText?.trim();
        if (preview) {
          push(escapeMd(preview, { lineStart: true }));
          warnings.push(`${label} kept as text`);
        }
        break;
      }
    }

    emitTextboxes();
    const stray = emitMdRuns(block.strayRuns);
    if (stray) push(stray);
    if (block.type !== "listItem") endBlock();
  }

  // Footnote/endnote definitions at the end.
  const footnoteDefs: string[] = [];
  for (const note of doc.footnotes ?? []) {
    footnoteDefs.push(`[^${note.id}]: ${escapeMd(note.text.replace(/\n/g, " "))}`);
  }
  for (const note of doc.endnotes ?? []) {
    footnoteDefs.push(`[^endnote-${note.id}]: ${escapeMd(note.text.replace(/\n/g, " "))}`);
  }
  if (footnoteDefs.length > 0) push(footnoteDefs.join("\n"));

  const markdown = out
    .map((entry, i) =>
      i > 0 && entry.listItem && out[i - 1]!.listItem
        ? `\n${entry.text}`
        : `\n\n${entry.text}`,
    )
    .join("")
    .replace(/^\n+/, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd();
  return { markdown: markdown + "\n", warnings, title };
}
