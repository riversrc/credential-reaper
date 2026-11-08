import type { RepositoryScan, RepositoryScanCounts, ScanProvenance, ScanWarning } from './repository-scan.js';

/** One ingestion run. The counters describe what that run changed in the database. */
export interface RepositoryScanRecord {
  id: string;
  repo: string;
  commitSha: string | null;
  scannedAt: string;
  ingestedAt: string;
  status: RepositoryScan['status'];
  counts: RepositoryScanCounts;
  warnings: ScanWarning[];
  added: number;
  changed: number;
  unchanged: number;
  reappeared: number;
  /** Declarations that were in an earlier scan but not in this one (complete scans only). */
  removed: number;
  finished: boolean;
  /** Records now stored for this repository, keyed `<list>:<present|removed>`. */
  persisted: Record<string, number>;
}

export interface RepositoryIngestResponse {
  scan: RepositoryScanRecord;
  /** `skipped`: identities not written because a non-repository identity already uses that id. */
  identities: { declared: number; synced: number; skipped: { id: string; reason: string }[] };
}

export interface OwnershipUpdateRequest {
  owner?: string;
  team?: string;
  /** Hand ownership back to what the repository declares. */
  revert?: boolean;
  /** Client-supplied and unauthenticated until real auth lands. 1-100 chars, default 'operator'. */
  actor?: string;
}

/** What the repository says about one identity. Repository evidence only: nothing here is runtime or deployment state. */
export interface RepositoryEvidence {
  repo: string;
  state: 'present' | 'removed';
  firstSeenAt: string | null;
  lastSeenAt: string | null;
  commitSha: string | null;
  declaredStatus: string | null;
  purpose: string | null;
  introducedOn: string | null;
  introducedBy: string | null;
  credential: { storage: string | null; secretRef: string | null; lastRotatedOn: string | null; expiresOn: string | null };
  declaredOwnership: {
    owner: string | null;
    team: string | null;
    ownershipStatus: string | null;
    ownerEmploymentStatus: string | null;
    lastReviewedOn: string | null;
    note: string | null;
    provenance: ScanProvenance[];
  } | null;
  /** True when ownership is curated and the repository declares something different. */
  ownershipDiffers: boolean;
  services: { serviceId: string; name: string; mode: string | null; usage: string | null }[];
  endpoints: { key: string; method: string; path: string; authenticated: boolean }[];
  permissionHistory: { date: string | null; change: string | null; permissionId: string | null; ticket: string | null; note: string | null }[];
  provenance: ScanProvenance[];
}
