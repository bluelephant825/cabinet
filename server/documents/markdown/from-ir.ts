/**
 * PDF-IR → Markdown/MDX. Reads the pdf2docx `IrDocument` block model in
 * reading order and emits CommonMark/GFM; `<Callout>` (the only registered
 * MDX component we use) wraps card regions for the `mdx` target.
 */
import type { IrDocument } from "../../../src/vendor/genoffice/packages/pdf2docx/src/pipeline";
import type {
  ImageBlock,
  IrPage,
  Line,
  TableBlock,
  TextBlock,
} from "../../../src/vendor/genoffice/packages/pdf2docx/src/ir";
import { HF_PAGE_MARK } from "../../../src/vendor/genoffice/packages/pdf2docx/src/analyze/furniture";
import { emitRuns, type MdRun } from "./inline";
import type { AssetSink } from "./assets";

export interface IrToMarkdownOptions {
  target: "md" | "mdx";
  assets: AssetSink;
}

function lineText(line: Line): string {
  return line.spans.map((s) => s.text).join("");
}

function blockText(block: TextBlock): string {
  return block.lines.map(lineText).join(" ");
}

function spansToRuns(block: TextBlock): MdRun[][] {
  return block.lines.map((line) =>
    line.spans
      .filter((s) => !s.invisible)
      .map((s) => ({
        text: s.text,
        bold: s.bold,
        italic: s.italic,
        strike: s.strike,
        noteRef: s.noteRef,
      })),
  );
}

/**
 * One text block → a single paragraph string. Lines soft-join with a space;
 * an `endsWithHyphen` line drops the hyphen and joins without a space; a
 * `hardBreakBefore` line starts on a markdown hard break (two trailing
 * spaces). Runs of invisible spans are filtered out first.
 */
function textBlockToMd(block: TextBlock): string {
  const runLines = spansToRuns(block);
  let out = "";
  runLines.forEach((runs, i) => {
    const line = block.lines[i]!;
    const chunk = emitRuns(runs, { lineStart: i === 0 });
    if (i > 0) {
      const prev = block.lines[i - 1]!;
      if (line.hardBreakBefore) {
        out += "  \n" + chunk;
      } else if (prev.endsWithHyphen) {
        // Drop the emitted hyphen at the join point.
        out = out.replace(/(?:\\-|-)\s*$/, "");
        out += chunk.replace(/^\s+/, "");
      } else {
        out += " " + chunk.replace(/^\s+/, "");
      }
    } else {
      out = chunk;
    }
  });
  return out;
}

function tableBlockToMd(block: TableBlock): string {
  const rows = block.rows;
  if (rows.length === 0) return "";
  const width = Math.max(
    ...rows.map((row) => row.reduce((n, c) => n + (c.gridSpan ?? 1), 0)),
  );
  const renderRow = (row: TableBlock["rows"][number]): string[] => {
    const cells: string[] = [];
    for (const cell of row) {
      if (cell.vMerge === "continue") {
        cells.push("");
      } else {
        const text = cell.blocks
          .map((b) => textBlockToMd(b))
          .filter(Boolean)
          .join("<br>")
          .replace(/\|/g, "\\|");
        cells.push(text);
      }
      for (let i = 1; i < (cell.gridSpan ?? 1); i++) cells.push("");
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

/** Char-weighted median font size, rounded to the nearest 0.5pt. */
function bodyFontSize(pages: IrPage[]): number {
  const samples: { size: number; weight: number }[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== "text" || block.list) continue;
      for (const line of block.lines) {
        for (const span of line.spans) {
          if (span.invisible) continue;
          samples.push({ size: span.fontSize, weight: Math.max(span.text.length, 1) });
        }
      }
    }
  }
  if (samples.length === 0) return 0;
  const total = samples.reduce((n, s) => n + s.weight, 0);
  const sorted = [...samples].sort((a, b) => a.size - b.size);
  let acc = 0;
  for (const s of sorted) {
    acc += s.weight;
    if (acc >= total / 2) return Math.round(s.size * 2) / 2;
  }
  return Math.round(sorted[sorted.length - 1]!.size * 2) / 2;
}

/**
 * Map heading-candidate font sizes to levels. Candidates: ≤3 lines, ≤30
 * words, not a list, and either ≥115% of body size or a single all-bold line
 * ≥105%. Distinct sizes (rounded 0.5pt) sorted descending → H1…H6.
 */
function headingLevels(pages: IrPage[], body: number, warnings: string[]): Map<number, number> {
  const levels = new Map<number, number>();
  if (body <= 0) return levels;
  let bodyParas = 0;
  const candidates: { block: TextBlock; size: number }[] = [];
  for (const page of pages) {
    for (const block of page.blocks) {
      if (block.kind !== "text" || block.list || block.tocEntry) continue;
      const sizes = block.lines.flatMap((l) =>
        l.spans.filter((s) => !s.invisible).map((s) => Math.round(s.fontSize * 2) / 2),
      );
      const size = sizes.length ? Math.max(...sizes) : 0;
      if (size >= body * 1.05) {
        candidates.push({ block, size });
      } else {
        bodyParas++;
      }
    }
  }
  if (bodyParas < 2) {
    if (candidates.length > 0 || bodyParas > 0) {
      warnings.push("not enough body text to infer headings — all text kept as paragraphs");
    }
    return levels;
  }
  const sizes = [
    ...new Set(
      candidates
        .filter(({ block, size }) => {
          const words = blockText(block).trim().split(/\s+/).filter(Boolean).length;
          const allBold = block.lines.every((l) =>
            l.spans.filter((s) => !s.invisible && s.text.trim()).every((s) => s.bold),
          );
          const oneLine = block.lines.length === 1;
          return (
            block.lines.length <= 3 &&
            words <= 30 &&
            (size >= body * 1.15 || (allBold && size >= body * 1.05 && oneLine))
          );
        })
        .map((c) => c.size),
    ),
  ].sort((a, b) => b - a);
  sizes.forEach((size, i) => {
    if (i < 6) levels.set(size, i + 1);
  });
  return levels;
}

/** Normalized compare key for furniture line dropping (page marks/digits out). */
function normFurniture(text: string): string {
  return text.replace(HF_PAGE_MARK, "").replace(/[0-9０-９]+/g, "").toLowerCase().replace(/\s+/g, " ").trim();
}

export async function irToMarkdown(
  doc: IrDocument,
  opts: IrToMarkdownOptions,
): Promise<{ markdown: string; warnings: string[]; title?: string }> {
  const warnings: string[] = [];
  const out: { text: string; listItem?: boolean }[] = [];
  const push = (text: string, opts2?: { listItem?: boolean }) => {
    if (text) out.push({ text, listItem: opts2?.listItem });
  };

  const furniture = new Set(doc.furnitureHf.map((hf) => normFurniture(hf.text)).filter(Boolean));
  const body = bodyFontSize(doc.irPages);
  const levels = headingLevels(doc.irPages, body, warnings);
  let tocWarned = false;
  let title: string | undefined;

  // Ordered-list ordinals: seqId → next ordinal.
  const ordinals = new Map<number, number>();
  const endList = () => ordinals.clear();

  for (const page of doc.irPages) {
    // Whole-page fallback: a scanned/degraded page with a render but no blocks.
    if ((page.scanned || page.degraded) && page.blocks.length === 0) {
      if (page.render) {
        const name = `page-${String(page.index + 1).padStart(2, "0")}.png`;
        const ref = await opts.assets.add(page.render.data, "png", name);
        push(`![Page ${page.index + 1}](${ref})`);
        warnings.push(`page ${page.index + 1}: kept as page image (no text layer)`);
      } else {
        warnings.push(`page ${page.index + 1}: produced no content`);
      }
      continue;
    }

    // Card regions: collect member text blocks per card, emitted once at the
    // position of the card's first member.
    const cardEmitted = new Set<number>();
    const cardBlocks = new Map<number, TextBlock[]>();
    for (const block of page.blocks) {
      if (block.kind === "text" && block.cardId !== undefined) {
        const list = cardBlocks.get(block.cardId) ?? [];
        list.push(block);
        cardBlocks.set(block.cardId, list);
      }
    }

    for (const block of page.blocks) {
      if (block.kind === "image") {
        const img = block as ImageBlock;
        // Card plates paint the backdrop — their text blocks carry the content.
        if (img.cardId !== undefined) continue;
        if (img.float?.wrap === "behind") continue;
        if (img.pixelWidth < 8 || img.pixelHeight < 8) continue;
        const ext = img.mime === "image/jpeg" ? "jpg" : "png";
        const ref = await opts.assets.add(img.data, ext);
        push(`![](${ref})`);
        endList();
        continue;
      }

      if (block.kind === "table") {
        push(tableBlockToMd(block as TableBlock));
        endList();
        continue;
      }

      const tb = block as TextBlock;
      if (tb.tocEntry) {
        if (!tocWarned) {
          warnings.push("table of contents omitted");
          tocWarned = true;
        }
        continue;
      }

      // Card member → emit the whole card group once, in first-member order.
      if (tb.cardId !== undefined) {
        if (cardEmitted.has(tb.cardId)) continue;
        cardEmitted.add(tb.cardId);
        const bodyText = (cardBlocks.get(tb.cardId) ?? [])
          .map((b) => textBlockToMd(b))
          .filter(Boolean)
          .join("\n\n");
        if (bodyText) {
          if (opts.target === "mdx") {
            push(`<Callout>\n\n${bodyText}\n\n</Callout>`);
          } else {
            push(bodyText.split("\n").map((l) => (l ? `> ${l}` : ">")).join("\n"));
          }
        }
        endList();
        continue;
      }

      const text = textBlockToMd(tb);
      if (!text.trim()) continue;
      // Furniture check: headers/footers are lifted out of `blocks` upstream,
      // but any that slipped through match an hf slot's text.
      if (furniture.has(normFurniture(blockText(tb)))) continue;

      if (tb.list) {
        const indent = "  ".repeat(Math.min(tb.list.level, 8));
        if (tb.list.kind === "ordered") {
          const key = tb.list.seqId ?? 0;
          const next = tb.list.start !== undefined && !ordinals.has(key)
            ? tb.list.start
            : (ordinals.get(key) ?? 0) + 1;
          ordinals.set(key, next);
          push(`${indent}${next}. ${text}`, { listItem: true });
        } else {
          push(`${indent}- ${text}`, { listItem: true });
        }
        continue;
      }
      endList();

      const size = Math.max(
        ...tb.lines.flatMap((l) =>
          l.spans.filter((s) => !s.invisible).map((s) => Math.round(s.fontSize * 2) / 2),
        ),
        0,
      );
      const level = levels.get(size);
      if (level) {
        const plain = blockText(tb).trim();
        push(`${"#".repeat(level)} ${text}`);
        if (!title) title = plain || undefined;
      } else {
        push(text);
      }
    }
  }

  // Footnote definitions at the end.
  const defs: string[] = [];
  for (const page of doc.irPages) {
    for (const note of page.footnotes ?? []) {
      const text = note.blocks
        .map((b) => textBlockToMd(b))
        .filter(Boolean)
        .join(" ");
      if (text) defs.push(`[^${note.id}]: ${text}`);
    }
  }
  if (defs.length > 0) push(defs.join("\n"));

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
