export const CABINET_CSV_DRAG_TYPE = "application/x-cabinet-csv";

export const CSV_DROP_LIMITS = {
  maxBytes: 1024 * 1024,
  maxChars: 1024 * 1024,
  maxRows: 500,
  maxColumns: 100,
  maxCells: 20_000,
  maxPathChars: 4096,
} as const;

export const DEFAULT_CSV_LIMITS = {
  maxChars: 5 * 1024 * 1024,
  maxRows: 10_000,
  maxColumns: 500,
  maxCells: 200_000,
} as const;

export interface CsvParseLimits {
  maxChars?: number;
  maxRows?: number;
  maxColumns?: number;
  maxCells?: number;
}

export class CsvLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CsvLimitError";
  }
}

function positiveIntegerLimit(name: string, value: number): number {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new TypeError(`${name} must be a positive safe integer`);
  }
  return value;
}

/**
 * Parse RFC 4180-style CSV without splitting quoted records. Bare CR, LF and
 * CRLF are accepted as record separators; line breaks inside quotes are kept.
 */
export function parseCsv(text: string, limits: CsvParseLimits = {}): string[][] {
  const maxChars = positiveIntegerLimit(
    "maxChars",
    limits.maxChars ?? DEFAULT_CSV_LIMITS.maxChars
  );
  const maxRows = positiveIntegerLimit("maxRows", limits.maxRows ?? DEFAULT_CSV_LIMITS.maxRows);
  const maxColumns = positiveIntegerLimit(
    "maxColumns",
    limits.maxColumns ?? DEFAULT_CSV_LIMITS.maxColumns
  );
  const maxCells = positiveIntegerLimit("maxCells", limits.maxCells ?? DEFAULT_CSV_LIMITS.maxCells);

  if (text.length > maxChars) {
    throw new CsvLimitError(`CSV exceeds the ${maxChars}-character limit`);
  }

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let justClosedQuote = false;
  let cellCount = 0;
  let i = text.charCodeAt(0) === 0xfeff ? 1 : 0;

  const pushField = () => {
    if (row.length >= maxColumns) {
      throw new CsvLimitError(`CSV exceeds the ${maxColumns}-column limit`);
    }
    cellCount += 1;
    if (cellCount > maxCells) {
      throw new CsvLimitError(`CSV exceeds the ${maxCells}-cell limit`);
    }
    row.push(field);
    field = "";
    justClosedQuote = false;
  };

  const pushRow = () => {
    pushField();
    if (rows.length >= maxRows) {
      throw new CsvLimitError(`CSV exceeds the ${maxRows}-row limit`);
    }
    rows.push(row);
    row = [];
  };

  for (; i < text.length; i += 1) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
          justClosedQuote = true;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"' && field.length === 0 && !justClosedQuote) {
      quoted = true;
    } else if (char === ",") {
      pushField();
    } else if (char === "\n" || char === "\r") {
      pushRow();
      if (char === "\r" && text[i + 1] === "\n") i += 1;
    } else {
      // Be permissive with malformed input after a closing quote. Keeping the
      // character is safer than silently discarding user data.
      field += char;
      justClosedQuote = false;
    }
  }

  // A trailing record separator already flushed the last record. Empty input
  // is an empty table, while commas still produce the expected empty fields.
  if (field.length > 0 || row.length > 0 || quoted || justClosedQuote) pushRow();
  return rows;
}

export interface TiptapContent {
  type: string;
  text?: string;
  content?: TiptapContent[];
}

function textContent(value: string): TiptapContent[] | undefined {
  const parts = value.split(/\r\n|\r|\n/);
  const content: TiptapContent[] = [];
  parts.forEach((part, index) => {
    if (part) content.push({ type: "text", text: part });
    if (index < parts.length - 1) content.push({ type: "hardBreak" });
  });
  return content.length > 0 ? content : undefined;
}

/** Build Tiptap/ProseMirror table JSON so insertion uses the editor's schema. */
export function csvRowsToTableContent(rows: string[][]): Record<string, unknown> | null {
  if (rows.length === 0) return null;
  const columnCount = Math.max(1, ...rows.map((row) => row.length));

  return {
    type: "table",
    content: rows.map((row, rowIndex) => ({
      type: "tableRow",
      content: Array.from({ length: columnCount }, (_, columnIndex) => ({
        type: rowIndex === 0 ? "tableHeader" : "tableCell",
        content: [
          {
            type: "paragraph",
            content: textContent(row[columnIndex] ?? ""),
          },
        ],
      })),
    })),
  };
}

export async function responseTextWithinLimit(
  response: Response,
  maxBytes = CSV_DROP_LIMITS.maxBytes
): Promise<string> {
  positiveIntegerLimit("maxBytes", maxBytes);
  const contentLength = response.headers.get("content-length");
  const declaredLength = contentLength === null ? null : Number(contentLength);
  if (declaredLength !== null && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new CsvLimitError(`CSV exceeds the ${maxBytes}-byte drop limit`);
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new CsvLimitError(`CSV exceeds the ${maxBytes}-byte drop limit`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    byteCount += value.byteLength;
    if (byteCount > maxBytes) {
      await reader.cancel();
      throw new CsvLimitError(`CSV exceeds the ${maxBytes}-byte drop limit`);
    }
    text += decoder.decode(value, { stream: true });
  }
  return text + decoder.decode();
}

export function csvPathFromDataTransfer(
  dataTransfer: Pick<DataTransfer, "types" | "getData">
): string | null {
  if (!Array.from(dataTransfer.types).includes(CABINET_CSV_DRAG_TYPE)) return null;

  const path = dataTransfer.getData(CABINET_CSV_DRAG_TYPE);
  if (
    !path ||
    path !== path.trim() ||
    path.length > CSV_DROP_LIMITS.maxPathChars ||
    path.startsWith("/") ||
    path.includes("\\") ||
    path.includes("?") ||
    path.includes("#") ||
    /[\u0000-\u001f\u007f]/.test(path) ||
    /^[a-zA-Z]:/.test(path) ||
    !path.toLowerCase().endsWith(".csv")
  ) {
    return null;
  }

  const segments = path.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return path;
}

/** Clamp an asynchronous drop position to the editor's current document bounds. */
export function csvDropInsertionPosition(position: number, docContentSize: number): number | null {
  if (!Number.isSafeInteger(position) || position < 0) return null;
  if (!Number.isSafeInteger(docContentSize) || docContentSize < 0) return null;
  return Math.min(position, docContentSize);
}
