"use client";

import { DocumentEditorHost } from "./document-editor-host";

interface Props {
  path: string;
  fallback: (reason?: string) => React.ReactNode;
  onStatus?: (status: { dirty: boolean; saving: boolean; error?: string }) => void;
  onNavigate?: (path: string) => void;
}

export function XlsxEditorHost(props: Props) {
  return <DocumentEditorHost {...props} format="xlsx" />;
}
