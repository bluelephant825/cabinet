import {
  LOCALE_STORAGE_KEY,
  SUPPORTED_LOCALES,
  matchSupportedLocale,
  type Locale,
} from "./index";
import { getHost } from "@/lib/host";

/**
 * True when a locale was already chosen — by the user, or by a prior
 * auto-detect that persisted one. Onboarding auto-detection must never
 * override this: an explicit choice always wins.
 */
export function hasExplicitLocale(): boolean {
  if (typeof window === "undefined") return false;
  const stored = window.localStorage.getItem(LOCALE_STORAGE_KEY);
  return (
    !!stored && (SUPPORTED_LOCALES as readonly string[]).includes(stored)
  );
}

/**
 * Resolve the OS keyboard / input language to a shipped app locale so
 * onboarding is localized out of the box. Priority: the host's preferred
 * system languages (reflects the macOS/Windows language & keyboard
 * ordering) → its app/system locale → `navigator.languages` →
 * `navigator.language`. Returns null when nothing maps to a shipped locale.
 */
export async function detectSystemLocale(): Promise<Locale | null> {
  if (typeof window === "undefined") return null;
  const candidates: string[] = [];

  const host = getHost();
  if (host.capabilities.preferredLanguages) {
    try {
      const res = await host.system.preferredLanguages();
      if (Array.isArray(res?.preferred)) candidates.push(...res.preferred);
      if (res?.locale) candidates.push(res.locale);
      if (res?.system) candidates.push(res.system);
    } catch {
      /* fall through to the navigator-based candidates */
    }
  }

  if (Array.isArray(navigator.languages)) {
    candidates.push(...navigator.languages);
  }
  if (navigator.language) candidates.push(navigator.language);

  return matchSupportedLocale(candidates);
}
