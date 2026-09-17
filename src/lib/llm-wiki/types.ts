/**
 * Portable LLM Wiki domain contracts. No filesystem, database, provider, or UI
 * imports: importing these types must not initialize Cabinet's runtime.
 * Runtime validation and persistence belong at the future store/API boundary.
 */
declare const identity: unique symbol;
type Identity<Kind extends string> = string & { readonly [identity]: Kind };

/** Stable opaque identities, never directory names or virtual page paths. */
export type CabinetId = Identity<"root-cabinet">;
export type SourceId = Identity<"source">;
export type SourceVersionId = Identity<"source-version">;
export type IngestionJobId = Identity<"ingestion-job">;

/** Explicit root identity; existing cabinetPath parameters often mean rooms. */
export interface CabinetContext {
  readonly cabinetId: CabinetId;
  /** Runtime-only absolute root; never serialize this into portable manifests. */
  readonly rootPath: string;
}

/**
 * Paths are slash-separated, relative to the indicated root, with no traversal.
 * These contracts describe paths; they do not authorize or validate access.
 */
export type SourceLocation =
  | { readonly kind: "cabinet"; readonly path: string }
  | {
      readonly kind: "knowledge-mount";
      /** Existing KnowledgeSource.id, resolved under the owning room. */
      readonly mountId: string;
      readonly roomPath: string;
      readonly path: string;
    };

export type SourceStatus = "active" | "deleted" | "archived";
export type SourceMode = "snapshot" | "managed";

interface SourceBase {
  readonly id: SourceId;
  readonly cabinetId: CabinetId;
  /** Root-relative room path, or null for root-owned material. */
  readonly roomPath: string | null;
  title: string;
  /** Mutable navigation label, not identity. */
  slug: string;
  /** Root-relative source directory containing the manifest and vN folders. */
  rawPath: string;
  /** Original managed path used for the human-readable Raw directory layout. */
  mirroredFrom?: string;
  /** Logical category; legacy manifests derive it from rawPath. Reclassification
   * changes this value, not historical evidence locations. */
  classification?: string;
  status: SourceStatus;
  currentVersionId: SourceVersionId | null;
  /** May lag currentVersionId after successful capture but failed compilation. */
  lastCompiledVersionId: SourceVersionId | null;
  readonly createdAt: string;
  updatedAt: string;
  /** ISO 8601 timestamp when marked deleted; cleared when restored. */
  deletedAt?: string;
  /** Missing-file deletion may be automatically restored; user removal may not. */
  deletionReason?: "missing" | "user";
  lifecycle?: {
    revision: number;
    action: "remove" | "restore" | "purge";
    reconciliation: "pending" | "complete";
  };
}

/** Snapshot inputs need no ongoing working-file binding. */
export type Source = SourceBase & (
  | { mode: "snapshot"; managedLocation?: never }
  | { mode: "managed"; managedLocation: SourceLocation }
);

export interface ConverterProvenance {
  readonly name: string;
  readonly version: string;
}

export type SourceType = "markdown" | "html" | "pdf" | "document" | "presentation" | "latex" | "typst" | "notebook";

/** Small immutable document description captured with a version. */
export interface SourceDocumentMetadata {
  readonly title: string;
  readonly sourceType: SourceType;
  readonly originalFilename: string;
  readonly language?: string;
}

/**
 * Immutable evidence metadata, including nested converter provenance.
 * All stored paths are root-Cabinet-relative. Current/superseded is derived
 * from Source.currentVersionId; it must never require rewriting old evidence.
 * TypeScript readonly is not disk protection or runtime validation.
 */
export interface SourceVersion {
  readonly id: SourceVersionId;
  readonly sourceId: SourceId;
  readonly cabinetId: CabinetId;
  /** Positive, monotonically allocated integer within this logical Source. */
  readonly version: number;
  /** SHA-256 of captured original bytes; never of a subsequently reread input. */
  readonly contentHash: string;
  readonly originalPath: string;
  /** Faithful ordinary Markdown, never executable MDX or a Wiki summary. */
  readonly markdownPath: string;
  readonly assetsPath?: string;
  /** Original extension without a leading dot, for example "ipynb". */
  readonly originalFormat: string;
  readonly createdAt: string;
  readonly converter?: ConverterProvenance;
  /** Optional for pre-provenance manifests; new evidence includes this snapshot. */
  readonly document?: SourceDocumentMetadata;
}

/** Mutable registry/UI projection only; not part of immutable version files. */
export type SourceVersionStatus = "current" | "superseded";

export type IngestionStatus =
  | "discovered"
  | "queued"
  | "normalizing"
  | "classifying"
  | "promoting"
  | "compiling"
  | "reconciling"
  | "linking"
  | "complete"
  | "failed"
  | "needs-review";

export type IngestionOperation = "create" | "update" | "delete" | "reprocess" | "consolidate" | "lint" | "graph";

interface IngestionJobBase {
  readonly id: IngestionJobId;
  readonly cabinetId: CabinetId;
  readonly roomPath: string | null;
  status: IngestionStatus;
  readonly createdAt: string;
  updatedAt: string;
  error?: string;
}

/**
 * Operationally durable intent, not knowledge or a disposable search cache.
 * A discovered input can be unhashed. Deletion must not require reading a
 * missing file, and reprocessing can operate on already captured evidence.
 * Queue leases, attempts, and transition enforcement are later queue concerns.
 */
export type IngestionJob = IngestionJobBase & (
  | {
      operation: "create";
      sourceId: SourceId | null;
      input: SourceLocation;
      contentHash: string | null;
    }
  | {
      operation: "update";
      sourceId: SourceId;
      input: SourceLocation;
      contentHash: string | null;
    }
  | {
      operation: "delete";
      sourceId: SourceId;
      input?: never;
      contentHash?: never;
    }
  | {
      operation: "reprocess";
      sourceId: SourceId;
      /** Previously committed input version; independent of working-file state. */
      sourceVersionId: SourceVersionId;
      input?: never;
      contentHash?: never;
    }
  | {
      /** Whole-wiki maintenance; no Source identity or captured input. */
      operation: "consolidate" | "lint" | "graph";
      sourceId: null;
      input?: never;
      contentHash?: never;
    }
);

export type SourceViewMode = "reader" | "original" | "markdown";

/** Version selection and presentation preference are independent. */
export interface SourceViewSelection {
  readonly cabinetId: CabinetId;
  readonly sourceId: SourceId;
  /** null follows the current version rather than pinning a historical one. */
  selectedVersionId: SourceVersionId | null;
  mode: SourceViewMode;
}
