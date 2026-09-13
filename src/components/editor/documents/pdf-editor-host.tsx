"use client";

/**
 * Host side of the PDF editor — thin wrapper over `DocumentEditorHost`.
 */
import { DocumentEditorHost } from "./document-editor-host";

interface Props {
  path: string;
  /** Rendered instead of the iframe when editing is unavailable. */
  fallback: (reason?: string) => React.ReactNode;
  /** Live status forwarded into the toolbar slot by the parent. */
  onStatus?: (s: { dirty: boolean; saving: boolean; error?: string }) => void;
  onNavigate?: (path: string) => void;
}

export function PdfEditorHost(props: Props) {
  return <DocumentEditorHost {...props} format="pdf" />;
}
