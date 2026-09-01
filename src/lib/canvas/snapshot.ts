export const CANVAS_SNAPSHOT_VERSION = 2;
export const CANVAS_MIN_ZOOM = 0.4;
export const CANVAS_MAX_ZOOM = 2.5;
export const CANVAS_MIN_CARD_WIDTH = 220;
export const CANVAS_MAX_CARD_WIDTH = 1200;
export const CANVAS_MIN_CARD_HEIGHT = 120;
export const CANVAS_MAX_CARD_HEIGHT = 1000;

export interface CanvasCardState {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface CanvasBoardState {
  zoom: number;
  manualLayout: boolean;
  cards: Record<string, CanvasCardState>;
}

export interface CanvasSnapshot {
  version: typeof CANVAS_SNAPSHOT_VERSION;
  boards: Record<string, CanvasBoardState>;
}

const MAX_BOARDS = 250;
const MAX_CARDS_PER_BOARD = 2_000;
const MAX_PATH_LENGTH = 2_048;
const MAX_COORDINATE = 100_000;
const CANVAS_WORLD_CENTER = 4_000;
const CANVAS_CARD_GAP = 28;

export function computeCanvasAutoLayout(
  cards: Array<{ path: string; width: number; height: number }>,
): Record<string, CanvasCardState> {
  if (!cards.length) return {};

  const measured = cards.map((card) => ({
    ...card,
    width: Math.min(CANVAS_MAX_CARD_WIDTH, Math.max(CANVAS_MIN_CARD_WIDTH, Math.round(card.width))),
    height: Math.min(CANVAS_MAX_CARD_HEIGHT, Math.max(CANVAS_MIN_CARD_HEIGHT, Math.round(card.height))),
  }));
  const averageWidth = measured.reduce((sum, card) => sum + card.width, 0) / measured.length;
  const averageHeight = measured.reduce((sum, card) => sum + card.height, 0) / measured.length;
  const idealRows = Math.sqrt((measured.length * 9 * averageWidth) / (16 * averageHeight));
  const rowCandidates = new Set([
    Math.max(1, Math.min(measured.length, Math.floor(idealRows))),
    Math.max(1, Math.min(measured.length, Math.ceil(idealRows))),
  ]);

  let columnCount = measured.length;
  let bestScore = Number.POSITIVE_INFINITY;
  for (const rowCount of rowCandidates) {
    const columns = Math.ceil(measured.length / rowCount);
    const actualRows = Math.ceil(measured.length / columns);
    const ratio = (columns * averageWidth) / (actualRows * averageHeight);
    const score = Math.abs(ratio - 16 / 9);
    if (score < bestScore) {
      bestScore = score;
      columnCount = columns;
    }
  }

  const rows: typeof measured[] = [];
  for (let index = 0; index < measured.length; index += columnCount) {
    rows.push(measured.slice(index, index + columnCount));
  }
  const columnWidths: number[] = [];
  for (const row of rows) {
    row.forEach((card, column) => {
      columnWidths[column] = Math.max(columnWidths[column] || 0, card.width);
    });
  }
  const rowHeights = rows.map((row) => Math.max(...row.map((card) => card.height)));
  const layoutWidth = columnWidths.reduce((sum, width) => sum + width, 0) +
    Math.max(0, columnWidths.length - 1) * CANVAS_CARD_GAP;
  const layoutHeight = rowHeights.reduce((sum, height) => sum + height, 0) +
    Math.max(0, rowHeights.length - 1) * CANVAS_CARD_GAP;
  const startX = CANVAS_WORLD_CENTER - Math.round(layoutWidth / 2);
  let y = CANVAS_WORLD_CENTER - Math.round(layoutHeight / 2);
  const layout: Record<string, CanvasCardState> = {};

  rows.forEach((row, rowIndex) => {
    let x = startX;
    row.forEach((card, column) => {
      layout[card.path] = {
        x: x + Math.round((columnWidths[column] - card.width) / 2),
        y: y + Math.round((rowHeights[rowIndex] - card.height) / 2),
        width: card.width,
        height: card.height,
      };
      x += columnWidths[column] + CANVAS_CARD_GAP;
    });
    y += rowHeights[rowIndex] + CANVAS_CARD_GAP;
  });
  return layout;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function isSafeCanvasPath(value: string): boolean {
  return (
    value.length > 0 &&
    value.length <= MAX_PATH_LENGTH &&
    !value.includes("\0") &&
    !value.includes("\\") &&
    !value.startsWith("/") &&
    (value === "." || value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."))
  );
}

function isFiniteInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= min && value <= max;
}

/** Parse untrusted route or disk data. V1 boards migrate conservatively to manual layout. */
export function parseCanvasSnapshot(value: unknown): CanvasSnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "boards"])) return null;
  if ((value.version !== 1 && value.version !== CANVAS_SNAPSHOT_VERSION) || !isRecord(value.boards)) return null;
  const sourceVersion = value.version;

  const boardEntries = Object.entries(value.boards);
  if (boardEntries.length > MAX_BOARDS) return null;
  const boards: Record<string, CanvasBoardState> = {};

  for (const [boardPath, rawBoard] of boardEntries) {
    if (!isSafeCanvasPath(boardPath) || !isRecord(rawBoard)) return null;
    const boardKeys = sourceVersion === 1 ? ["zoom", "cards"] : ["zoom", "manualLayout", "cards"];
    if (!hasOnlyKeys(rawBoard, boardKeys)) return null;
    if (!isFiniteInRange(rawBoard.zoom, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM)) return null;
    if (sourceVersion === CANVAS_SNAPSHOT_VERSION && typeof rawBoard.manualLayout !== "boolean") return null;
    if (!isRecord(rawBoard.cards)) return null;

    const cardEntries = Object.entries(rawBoard.cards);
    if (cardEntries.length > MAX_CARDS_PER_BOARD) return null;
    const cards: Record<string, CanvasCardState> = {};
    for (const [cardPath, rawCard] of cardEntries) {
      if (!isSafeCanvasPath(cardPath) || !isRecord(rawCard)) return null;
      if (!hasOnlyKeys(rawCard, ["x", "y", "width", "height"])) return null;
      if (
        !isFiniteInRange(rawCard.x, -MAX_COORDINATE, MAX_COORDINATE) ||
        !isFiniteInRange(rawCard.y, -MAX_COORDINATE, MAX_COORDINATE) ||
        !isFiniteInRange(rawCard.width, CANVAS_MIN_CARD_WIDTH, CANVAS_MAX_CARD_WIDTH) ||
        !isFiniteInRange(rawCard.height, CANVAS_MIN_CARD_HEIGHT, CANVAS_MAX_CARD_HEIGHT)
      ) return null;
      cards[cardPath] = {
        x: rawCard.x,
        y: rawCard.y,
        width: rawCard.width,
        height: rawCard.height,
      };
    }
    boards[boardPath] = {
      zoom: rawBoard.zoom,
      manualLayout: sourceVersion === 1 ? cardEntries.length > 0 : rawBoard.manualLayout as boolean,
      cards,
    };
  }

  return { version: CANVAS_SNAPSHOT_VERSION, boards };
}

export function emptyCanvasSnapshot(): CanvasSnapshot {
  return { version: CANVAS_SNAPSHOT_VERSION, boards: {} };
}
