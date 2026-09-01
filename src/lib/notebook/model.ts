export type NotebookSource = string | string[];
export type NotebookMimeValue = unknown;

export class NotebookRevisionTracker {
  private revision = 0;

  current(): number {
    return this.revision;
  }

  changed(): number {
    this.revision += 1;
    return this.revision;
  }

  reset(): void {
    this.revision = 0;
  }

  isCurrent(revision: number): boolean {
    return revision === this.revision;
  }
}

export interface NotebookOutputBase {
  output_type: string;
  [key: string]: unknown;
}

export interface StreamOutput extends NotebookOutputBase {
  output_type: "stream";
  name: "stdout" | "stderr";
  text: NotebookSource;
}

export interface DataOutput extends NotebookOutputBase {
  output_type: "execute_result" | "display_data";
  execution_count?: number | null;
  data: Record<string, NotebookMimeValue>;
  metadata?: Record<string, unknown>;
}

export interface ErrorOutput extends NotebookOutputBase {
  output_type: "error";
  ename: string;
  evalue: string;
  traceback: string[];
}

export type NotebookOutput = StreamOutput | DataOutput | ErrorOutput | NotebookOutputBase;

export interface NotebookCellBase {
  cell_type: "code" | "markdown" | "raw";
  source: NotebookSource;
  metadata?: Record<string, unknown>;
  id?: string;
  [key: string]: unknown;
}

export interface CodeCell extends NotebookCellBase {
  cell_type: "code";
  execution_count?: number | null;
  outputs?: NotebookOutput[];
}

export interface MarkdownCell extends NotebookCellBase {
  cell_type: "markdown";
  attachments?: Record<string, unknown>;
}

export interface RawCell extends NotebookCellBase {
  cell_type: "raw";
}

export type NotebookCell = CodeCell | MarkdownCell | RawCell;

export interface NotebookDocument {
  cells: NotebookCell[];
  metadata: Record<string, unknown> & {
    kernelspec?: { name?: string; display_name?: string };
    language_info?: { name?: string };
  };
  nbformat: number;
  nbformat_minor: number;
  [key: string]: unknown;
}

export function joinNotebookSource(source: NotebookSource | undefined): string {
  return Array.isArray(source) ? source.join("") : source ?? "";
}

export function splitNotebookSource(source: string): string[] {
  if (!source) return [];
  const lines = source.match(/.*(?:\n|$)/g) ?? [];
  return lines.filter((line, index) => line.length > 0 || index < lines.length - 1);
}

export function replaceCellSource(cell: NotebookCell, source: string): NotebookCell {
  return {
    ...cell,
    source: Array.isArray(cell.source) ? splitNotebookSource(source) : source,
  } as NotebookCell;
}

export function createNotebookCell(cellType: NotebookCell["cell_type"]): NotebookCell {
  if (cellType === "code") {
    return { cell_type: "code", execution_count: null, metadata: {}, outputs: [], source: [] };
  }
  return { cell_type: cellType, metadata: {}, source: [] } as NotebookCell;
}

export function moveNotebookCell(cells: NotebookCell[], from: number, to: number): NotebookCell[] {
  if (from === to || from < 0 || from >= cells.length || to < 0 || to >= cells.length) {
    return cells;
  }
  const next = [...cells];
  const [cell] = next.splice(from, 1);
  next.splice(to, 0, cell);
  return next;
}

export function parseNotebook(value: unknown): NotebookDocument {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Notebook must be a JSON object");
  }
  const input = value as Record<string, unknown>;
  if (!Array.isArray(input.cells)) throw new Error("Notebook is missing a cells array");

  const cells = input.cells.map((candidate, index) => {
    if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
      throw new Error(`Cell ${index + 1} must be an object`);
    }
    const cell = candidate as Record<string, unknown>;
    if (cell.cell_type !== "code" && cell.cell_type !== "markdown" && cell.cell_type !== "raw") {
      throw new Error(`Cell ${index + 1} has an unsupported type`);
    }
    if (typeof cell.source !== "string" && !(
      Array.isArray(cell.source) && cell.source.every((line) => typeof line === "string")
    )) {
      throw new Error(`Cell ${index + 1} has an invalid source`);
    }
    return cell as unknown as NotebookCell;
  });

  return {
    ...input,
    cells,
    metadata: input.metadata && typeof input.metadata === "object" && !Array.isArray(input.metadata)
      ? input.metadata as NotebookDocument["metadata"]
      : {},
    nbformat: typeof input.nbformat === "number" ? input.nbformat : 4,
    nbformat_minor: typeof input.nbformat_minor === "number" ? input.nbformat_minor : 5,
  } as NotebookDocument;
}

export function serializeNotebook(notebook: NotebookDocument): string {
  return `${JSON.stringify(notebook, null, 2)}\n`;
}
