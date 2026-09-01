"use client";

export type MonacoEditorTheme = "app" | "vs-dark" | "light";

export interface MonacoEditorSettings {
  theme: MonacoEditorTheme;
  fontFamily: string;
  fontSize: number;
  lineHeight: number;
  fontWeight: string;
  fontLigatures: boolean;
  minimap: boolean;
  tabSize: number;
}

export const EDITOR_SETTINGS_EVENT = "cabinet:editor-settings-changed";
export const EDITOR_SETTINGS_STORAGE_KEY = "cabinet.editor-settings";

export const DEFAULT_EDITOR_SETTINGS: MonacoEditorSettings = {
  theme: "app",
  fontFamily: "'JetBrains Mono', Menlo, Monaco, Consolas, 'Courier New', monospace",
  fontSize: 13,
  lineHeight: 19,
  fontWeight: "normal",
  fontLigatures: true,
  minimap: true,
  tabSize: 2,
};

function boundedNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.min(max, Math.max(min, Math.round(value)))
    : fallback;
}

export function normalizeEditorSettings(value: unknown): MonacoEditorSettings {
  const settings = value && typeof value === "object"
    ? value as Partial<MonacoEditorSettings>
    : {};
  const theme = settings.theme === "vs-dark" || settings.theme === "light" || settings.theme === "app"
    ? settings.theme
    : DEFAULT_EDITOR_SETTINGS.theme;

  return {
    theme,
    fontFamily: typeof settings.fontFamily === "string" && settings.fontFamily.trim()
      ? settings.fontFamily
      : DEFAULT_EDITOR_SETTINGS.fontFamily,
    fontSize: boundedNumber(settings.fontSize, DEFAULT_EDITOR_SETTINGS.fontSize, 8, 36),
    lineHeight: boundedNumber(settings.lineHeight, DEFAULT_EDITOR_SETTINGS.lineHeight, 10, 60),
    fontWeight: typeof settings.fontWeight === "string" && settings.fontWeight.trim()
      ? settings.fontWeight
      : DEFAULT_EDITOR_SETTINGS.fontWeight,
    fontLigatures: typeof settings.fontLigatures === "boolean"
      ? settings.fontLigatures
      : DEFAULT_EDITOR_SETTINGS.fontLigatures,
    minimap: typeof settings.minimap === "boolean"
      ? settings.minimap
      : DEFAULT_EDITOR_SETTINGS.minimap,
    tabSize: boundedNumber(settings.tabSize, DEFAULT_EDITOR_SETTINGS.tabSize, 1, 8),
  };
}

export function getEditorSettings(): MonacoEditorSettings {
  if (typeof window === "undefined") return DEFAULT_EDITOR_SETTINGS;
  try {
    const raw = window.localStorage.getItem(EDITOR_SETTINGS_STORAGE_KEY);
    return raw ? normalizeEditorSettings(JSON.parse(raw)) : DEFAULT_EDITOR_SETTINGS;
  } catch {
    return DEFAULT_EDITOR_SETTINGS;
  }
}

export function saveEditorSettings(update: Partial<MonacoEditorSettings>): void {
  if (typeof window === "undefined") return;
  const settings = normalizeEditorSettings({ ...getEditorSettings(), ...update });
  try {
    window.localStorage.setItem(EDITOR_SETTINGS_STORAGE_KEY, JSON.stringify(settings));
    window.dispatchEvent(new CustomEvent(EDITOR_SETTINGS_EVENT, { detail: settings }));
  } catch {
    // Browsers can deny local storage. Keep the editor usable with defaults.
  }
}
