"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_EDITOR_SETTINGS,
  EDITOR_SETTINGS_EVENT,
  EDITOR_SETTINGS_STORAGE_KEY,
  getEditorSettings,
  normalizeEditorSettings,
  type MonacoEditorSettings,
} from "@/lib/ui/editor-settings";

export function useEditorSettings(): MonacoEditorSettings {
  const [settings, setSettings] = useState<MonacoEditorSettings>(() =>
    typeof window === "undefined" ? DEFAULT_EDITOR_SETTINGS : getEditorSettings()
  );

  useEffect(() => {
    const onSettingsChange = (event: Event) => {
      const detail = (event as CustomEvent<unknown>).detail;
      setSettings(detail === undefined ? getEditorSettings() : normalizeEditorSettings(detail));
    };
    const onStorage = (event: StorageEvent) => {
      if (event.key === null || event.key === EDITOR_SETTINGS_STORAGE_KEY) {
        setSettings(getEditorSettings());
      }
    };

    window.addEventListener(EDITOR_SETTINGS_EVENT, onSettingsChange);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(EDITOR_SETTINGS_EVENT, onSettingsChange);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return settings;
}
