export type RawReaderResult = { kind: "file"; title: string; text?: string; image?: string; download?: string } | { kind: "ordinary"; capturePath?: string; pending?: boolean } | { kind: "directory"; sources: { id: string; title: string; path: string; status: string }[] } | {
  kind: "source"; cabinetId: string; sourceId: string; title: string; status: string;
  versionId: string; version: number; format: string; filename: string; markdown: string;
  sourcePath: string; currentVersionId: string;
  versions: { id: string; version: number; createdAt: string; status: "current" | "superseded" }[];
  readerHtml: string; original: { kind: "html" | "text" | "pdf" | "download"; content?: string };
};
