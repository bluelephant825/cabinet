"use client";

import dynamic from "next/dynamic";

// The vendored GenOffice renderer must never run on the server — it is
// browser-only code loaded exclusively inside this iframe page.
const DocxEditorFrame = dynamic(
  () => import("@/components/editor/documents/docx-editor-frame"),
  { ssr: false },
);

export default function DocumentEditorPage() {
  return (
    <>
      {/* Bundled metric-compatible fonts (SIL OFL / Apache-2.0 — see
          public/document-editor/fonts/README.md) and the vendored UI token
          sheet, served as static assets. */}
      <link rel="stylesheet" href="/document-editor/fonts/fonts.css" />
      <link rel="stylesheet" href="/document-editor/tokens.css" />
      <DocxEditorFrame />
    </>
  );
}
