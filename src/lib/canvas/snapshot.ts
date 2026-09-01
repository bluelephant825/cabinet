export const CANVAS_SNAPSHOT_VERSION = 1;
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

/** Parse untrusted route or disk data. Unknown fields are rejected deliberately. */
export function parseCanvasSnapshot(value: unknown): CanvasSnapshot | null {
  if (!isRecord(value) || !hasOnlyKeys(value, ["version", "boards"])) return null;
  if (value.version !== CANVAS_SNAPSHOT_VERSION || !isRecord(value.boards)) return null;

  const boardEntries = Object.entries(value.boards);
  if (boardEntries.length > MAX_BOARDS) return null;
  const boards: Record<string, CanvasBoardState> = {};

  for (const [boardPath, rawBoard] of boardEntries) {
    if (!isSafeCanvasPath(boardPath) || !isRecord(rawBoard)) return null;
    if (!hasOnlyKeys(rawBoard, ["zoom", "cards"])) return null;
    if (!isFiniteInRange(rawBoard.zoom, CANVAS_MIN_ZOOM, CANVAS_MAX_ZOOM)) return null;
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
    boards[boardPath] = { zoom: rawBoard.zoom, cards };
  }

  return { version: CANVAS_SNAPSHOT_VERSION, boards };
}

export function emptyCanvasSnapshot(): CanvasSnapshot {
  return { version: CANVAS_SNAPSHOT_VERSION, boards: {} };
}
