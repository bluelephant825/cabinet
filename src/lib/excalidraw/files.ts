const EXCALIDRAW_FILE_SUFFIXES = [".excalidraw.svg", ".excalidraw"] as const;

export function isExcalidrawFilePath(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return EXCALIDRAW_FILE_SUFFIXES.some((suffix) => lower.endsWith(suffix));
}

export function excalidrawFileTitle(filePath: string): string {
  const filename = filePath.split(/[\\/]/).pop() || filePath;
  const lower = filename.toLowerCase();
  const suffix = EXCALIDRAW_FILE_SUFFIXES.find((candidate) =>
    lower.endsWith(candidate)
  );
  return suffix ? filename.slice(0, -suffix.length) : filename;
}

export function isExcalidrawSvgPath(filePath: string): boolean {
  return filePath.toLowerCase().endsWith(".excalidraw.svg");
}
