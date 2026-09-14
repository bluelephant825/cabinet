/**
 * Inline-level Markdown emission shared by the DOCX and PDF-IR converters.
 * CommonMark escaping + delimiter flanking rules; no block structure here.
 */

export interface MdRun {
  text: string;
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  link?: { href: string };
  /** Footnote anchor — emitted as `[^id]` instead of text. */
  noteRef?: string;
}

const ALLOWED_LINK_SCHEMES = /^(https?:|mailto:)/i;

/**
 * Escape Markdown-significant characters. `#`/`>`/`-`/`+`/`N.` are only
 * special at line start, `|` only inside table cells — callers opt in via
 * opts so mid-paragraph text stays readable.
 */
export function escapeMd(
  text: string,
  opts: { lineStart?: boolean; inTable?: boolean } = {},
): string {
  let out = text.replace(/([\\`*_[\]<>~])/g, "\\$1");
  if (opts.lineStart) {
    out = out
      .replace(/^(#{1,6})(\s|$)/, "\\$1$2")
      .replace(/^>/, "\\>")
      .replace(/^([-+])(\s|$)/, "\\$1$2")
      .replace(/^(\d{1,9})([.)])(\s|$)/, "$1\\$2$3");
  }
  if (opts.inTable) out = out.replace(/\|/g, "\\|");
  return out;
}

/** Escape `]`/`)` inside a link label/destination (text already escaped). */
function escapeHref(href: string): string {
  return href.replace(/\s/g, "%20").replace(/\)/g, "%29");
}

function marksOf(run: MdRun): string {
  return `${run.bold ? "b" : ""}${run.italic ? "i" : ""}${run.strike ? "s" : ""}${
    run.link ? `L:${run.link.href}` : ""
  }`;
}

/**
 * Runs → inline markdown. Adjacent runs with identical marks merge; leading
 * and trailing whitespace moves outside the delimiters so `**bold **` never
 * produces a broken `**` pair (CommonMark flanking rule). Links are emitted
 * only for http(s)/mailto hrefs — anything else degrades to plain text.
 */
export function emitRuns(
  runs: MdRun[],
  opts: { lineStart?: boolean; inTable?: boolean } = {},
): string {
  const merged: MdRun[] = [];
  for (const run of runs) {
    if (run.noteRef) {
      merged.push(run);
      continue;
    }
    const prev = merged[merged.length - 1];
    if (prev && !prev.noteRef && marksOf(prev) === marksOf(run)) {
      prev.text += run.text;
    } else {
      merged.push({ ...run });
    }
  }

  let out = "";
  let atLineStart = opts.lineStart === true;
  for (const run of merged) {
    if (run.noteRef) {
      out += `[^${run.noteRef}]`;
      atLineStart = false;
      continue;
    }
    const text = run.text;
    if (!text) continue;

    const lead = /^\s+/.exec(text)?.[0] ?? "";
    const trail = /\s+$/.exec(text)?.[0] ?? "";
    const core = text.slice(lead.length, text.length - trail.length || undefined);
    const escapedCore = escapeMd(core, { lineStart: atLineStart && lead === "", inTable: opts.inTable });
    const escapedTrail = escapeMd(trail, { inTable: opts.inTable });

    if (!core) {
      out += escapeMd(text, { lineStart: atLineStart, inTable: opts.inTable });
      atLineStart = atLineStart && text.length === 0;
      continue;
    }

    const delimiter =
      (run.bold ? "**" : "") + (run.italic ? "*" : "") + (run.strike ? "~~" : "");
    const closing = (run.strike ? "~~" : "") + (run.italic ? "*" : "") + (run.bold ? "**" : "");
    const body = `${delimiter}${escapedCore}${closing}`;
    if (run.link && ALLOWED_LINK_SCHEMES.test(run.link.href)) {
      out += `${lead}[${body}](${escapeHref(run.link.href)})${escapedTrail}`;
    } else {
      out += `${lead}${body}${escapedTrail}`;
    }
    atLineStart = false;
  }
  return out;
}
