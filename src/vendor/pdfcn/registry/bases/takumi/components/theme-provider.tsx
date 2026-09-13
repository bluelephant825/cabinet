import { AsyncLocalStorage } from "node:async_hooks";
import { isValidElement } from "react";
import type { DependencyList, ReactNode } from "react";

import { professionalTheme } from "@/vendor/pdfcn/registry/themes/professional";

export type PdfcnTheme = typeof professionalTheme;

/**
 * ADAPTED (Cabinet): upstream kept the active theme in a module-global
 * `serializedTheme` variable, so two concurrent renders with different themes
 * raced — whichever provider ran last won for both documents. The store is now
 * request-local via AsyncLocalStorage: a render establishes its theme inside
 * `runWithPdfcnTheme`, and `usePdfcnTheme` reads the theme for that async
 * context only. `PdfcnThemeProvider` also works standalone (inline provider),
 * establishing the context for the synchronous child invocation it performs.
 */
const themeStorage = new AsyncLocalStorage<PdfcnTheme>();

export const runWithPdfcnTheme = <T,>(
  theme: PdfcnTheme,
  fn: () => T
): T => themeStorage.run(theme, fn);

export interface PdfcnThemeProviderProps {
  theme?: PdfcnTheme;
  children: ReactNode;
}

const renderForSerializer = (
  children: ReactNode,
  theme: PdfcnTheme
): ReactNode => {
  if (!isValidElement(children) || typeof children.type !== "function") {
    return children;
  }

  return runWithPdfcnTheme(theme, () =>
    (children.type as (props: unknown) => ReactNode)(children.props)
  );
};

export const PdfcnThemeProvider = ({
  theme,
  children,
}: PdfcnThemeProviderProps) =>
  renderForSerializer(children, theme ?? professionalTheme);

export const usePdfcnTheme = (): PdfcnTheme =>
  themeStorage.getStore() ?? professionalTheme;

export const useSafeMemo = <T,>(factory: () => T, _deps: DependencyList): T =>
  factory();
