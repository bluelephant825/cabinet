"use client";

import { createElement, useMemo, type ComponentPropsWithoutRef, type ElementType, type Ref } from "react";
import { sanitizeHtml, type SanitizeProfile } from "@/lib/security/sanitize";

/**
 * The ONLY sanctioned way to render an HTML string into the DOM (#66).
 *
 * Every string that reaches `dangerouslySetInnerHTML` in this app originates
 * somewhere untrusted — agent output, a note on disk, a registry README pulled
 * over the network, an .xlsx or .ipynb the user opened — and it renders inside
 * Cabinet's own origin, next to the daemon auth token. Centralizing the render
 * makes the invariant greppable: a raw `dangerouslySetInnerHTML` in a component
 * is now a bug you can find with one search, instead of a hole you find with a
 * CVE.
 *
 * Pick the `profile` that matches the PRODUCER, not the vibe:
 *   rich  — markdown/prose HTML (agent messages, notes, READMEs)
 *   svg   — mermaid diagrams, notebook image/svg+xml outputs
 *   code  — lowlight syntax-highlighted spans
 *   table — SheetJS sheet_to_html output
 *
 * Sanitizing is memoized on (html, profile): mermaid and the source viewer
 * re-render on every pan/zoom frame, and re-scrubbing a large SVG each frame
 * would be visible jank.
 */
type SafeHtmlProps<T extends ElementType> = {
  html: string;
  profile: SanitizeProfile;
  /** Element to render. Defaults to a <div>. */
  as?: T;
  ref?: Ref<HTMLElement>;
} & Omit<ComponentPropsWithoutRef<T>, "children" | "dangerouslySetInnerHTML" | "as" | "html">;

export function SafeHtml<T extends ElementType = "div">({
  html,
  profile,
  as,
  ...rest
}: SafeHtmlProps<T>) {
  const clean = useMemo(() => sanitizeHtml(html, profile), [html, profile]);
  const Tag = (as ?? "div") as ElementType;
  return createElement(Tag, {
    ...rest,
    dangerouslySetInnerHTML: { __html: clean },
  });
}
