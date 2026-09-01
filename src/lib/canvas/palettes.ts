export const CANVAS_PALETTE_CONFIG_VERSION = 1;

export interface CanvasPalette {
  id: string;
  name: string;
  colors: string[];
}

export interface CanvasPaletteConfig {
  version: typeof CANVAS_PALETTE_CONFIG_VERSION;
  selectedPalette: string;
  palettes: CanvasPalette[];
}

const MAX_PALETTES = 24;
const MAX_COLORS = 12;
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,47}$/;
const HEX_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

export const DEFAULT_CANVAS_PALETTE_CONFIG: CanvasPaletteConfig = {
  version: CANVAS_PALETTE_CONFIG_VERSION,
  selectedPalette: "cabinet",
  palettes: [
    { id: "cabinet", name: "Cabinet", colors: ["#F2C94C", "#F2994A", "#EB5757", "#9B51E0", "#2D9CDB", "#27AE60"] },
    { id: "pastel", name: "Pastel", colors: ["#FFD6A5", "#FDFFB6", "#CAFFBF", "#9BF6FF", "#BDB2FF", "#FFC6FF"] },
    { id: "earth", name: "Earth", colors: ["#DDA15E", "#BC6C25", "#606C38", "#283618", "#8D6E63", "#457B9D"] },
  ],
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isCanvasColor(value: unknown): value is string {
  return typeof value === "string" && HEX_COLOR_PATTERN.test(value);
}

export function isCanvasPaletteId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

/** Parse palette configuration from the API or disk without accepting unknown fields. */
export function parseCanvasPaletteConfig(value: unknown): CanvasPaletteConfig | null {
  if (!isRecord(value) || Object.keys(value).some((key) => !["version", "selectedPalette", "palettes"].includes(key))) return null;
  if (value.version !== CANVAS_PALETTE_CONFIG_VERSION || !isCanvasPaletteId(value.selectedPalette) || !Array.isArray(value.palettes)) return null;
  if (value.palettes.length < 1 || value.palettes.length > MAX_PALETTES) return null;

  const ids = new Set<string>();
  const palettes: CanvasPalette[] = [];
  for (const raw of value.palettes) {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !["id", "name", "colors"].includes(key))) return null;
    if (!isCanvasPaletteId(raw.id) || ids.has(raw.id)) return null;
    if (typeof raw.name !== "string" || raw.name.trim().length < 1 || raw.name.length > 80) return null;
    if (!Array.isArray(raw.colors) || raw.colors.length < 1 || raw.colors.length > MAX_COLORS || !raw.colors.every(isCanvasColor)) return null;
    ids.add(raw.id);
    palettes.push({ id: raw.id, name: raw.name.trim(), colors: [...raw.colors] });
  }
  if (!ids.has(value.selectedPalette)) return null;
  return { version: CANVAS_PALETTE_CONFIG_VERSION, selectedPalette: value.selectedPalette, palettes };
}
