"use client";

import dynamic from "next/dynamic";
import { useState } from "react";

// The vendored GenOffice renderers must never run on the server — they are
// browser-only code loaded exclusively inside this iframe page.
const DocxEditorFrame = dynamic(
  () => import("@/components/editor/documents/docx-editor-frame"),
  { ssr: false },
);
const PdfEditorFrame = dynamic(
  () => import("@/components/editor/documents/pdf-editor-frame"),
  { ssr: false },
);

function formatFromHash(): string {
  if (typeof window === "undefined") return "docx";
  return new URLSearchParams(window.location.hash.slice(1)).get("format") ?? "docx";
}

export default function DocumentEditorPage() {
  // Lazy init reads the hash once on the client (the frames are ssr:false, so
  // this branch renders nothing on the server either way).
  const [format] = useState(formatFromHash);
  return (
    <>
      {/* Bundled metric-compatible fonts (SIL OFL / Apache-2.0 — see
          public/document-editor/fonts/README.md) and the vendored UI token
          sheet, served as static assets. */}
      <link rel="stylesheet" href="/document-editor/fonts/fonts.css" />
      <link rel="stylesheet" href="/document-editor/tokens.css" />
      {format === "pdf" ? <PdfEditorFrame /> : <DocxEditorFrame />}
    </>
  );
}
