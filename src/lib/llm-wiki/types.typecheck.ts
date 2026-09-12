/** Compile-time boundary checks, exercised by tsc --noEmit. No runtime code. */
import type {
  CabinetId,
  IngestionJob,
  Source,
  SourceId,
  SourceVersion,
  SourceVersionId,
} from "./types";

type Expect<T extends true> = T;
type NotAssignable<From, To> = [From] extends [To] ? false : true;
type Equal<A, B> =
  (<T>() => T extends A ? 1 : 2) extends
  (<T>() => T extends B ? 1 : 2) ? true : false;

type Managed = Extract<Source, { mode: "managed" }>;
type Snapshot = Extract<Source, { mode: "snapshot" }>;
type Deletion = Extract<IngestionJob, { operation: "delete" }>;
type Update = Extract<IngestionJob, { operation: "update" }>;
type Reprocess = Extract<IngestionJob, { operation: "reprocess" }>;

export type DomainContractChecks = [
  Expect<NotAssignable<string, CabinetId>>,
  Expect<NotAssignable<CabinetId, SourceId>>,
  Expect<NotAssignable<SourceId, SourceVersionId>>,
  Expect<NotAssignable<Omit<Managed, "managedLocation">, Managed>>,
  Expect<Equal<Snapshot["managedLocation"], undefined>>,
  Expect<Equal<Deletion["input"], undefined>>,
  Expect<Equal<Deletion["contentHash"], undefined>>,
  Expect<NotAssignable<Omit<Update, "sourceId">, Update>>,
  Expect<NotAssignable<Omit<Reprocess, "sourceVersionId">, Reprocess>>,
  Expect<Equal<SourceVersion, Readonly<SourceVersion>>>,
  Expect<Equal<NonNullable<SourceVersion["converter"]>, Readonly<NonNullable<SourceVersion["converter"]>>>>,
  Expect<NotAssignable<"status", keyof SourceVersion>>,
];
