export interface InboxCandidate {
  path: string;
  status: "checking" | "awaiting" | "queued" | "error";
  jobId?: string;
  error?: string;
}

export interface InboxStatus {
  enabled: boolean;
  autoIngestInbox: boolean;
  watching: boolean;
  pending: number;
  queued: number;
  failed: number;
  error: string | null;
  items: InboxCandidate[];
}
