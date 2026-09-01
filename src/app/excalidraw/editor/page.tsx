"use client";

import dynamic from "next/dynamic";
import { useSearchParams } from "next/navigation";
import { Suspense } from "react";

const ExcalidrawEditor = dynamic(
  () =>
    import("@/components/excalidraw/excalidraw-editor").then(
      (module) => module.ExcalidrawEditor
    ),
  {
    ssr: false,
    loading: () => (
      <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
        Loading drawing...
      </div>
    ),
  }
);

function EditorFromSearchParams() {
  const path = useSearchParams().get("path");
  return (
    <div className="h-screen">
      <ExcalidrawEditor key={path} path={path} />
    </div>
  );
}

export default function ExcalidrawEditorPage() {
  return (
    <Suspense
      fallback={
        <div className="flex h-screen items-center justify-center bg-background text-sm text-muted-foreground">
          Loading drawing...
        </div>
      }
    >
      <EditorFromSearchParams />
    </Suspense>
  );
}
