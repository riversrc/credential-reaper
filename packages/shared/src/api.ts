import type { MachineIdentity, PermissionGrant, IdentityDependency, CredentialMetadata, UsageEvent } from './identity.js';
import type { Investigation, StartInvestigationRequest } from './investigation.js';
import type { RemediationPlan, RemediationPrPreview } from './remediation.js';
import type { AuditEvent } from './audit.js';
import type { InvestigationEvent, RemediationDecisionRequest, SecurityEvent } from './activity.js';
import type { RepositoryScan } from './repository-scan.js';
import type { OwnershipUpdateRequest, RepositoryEvidence, RepositoryIngestResponse, RepositoryScanRecord } from './repository-sync.js';

/** Contract for the Cloudflare Worker API consumed by the frontend. */
export interface ApiRoutes {
  'GET /api/identities': { response: MachineIdentity[] };
  'GET /api/identities/:id': {
    response: {
      identity: MachineIdentity;
      permissions: PermissionGrant[];
      dependencies: IdentityDependency[];
      credentials: CredentialMetadata[];
      usageHistory: UsageEvent[];
      /** Present only for identities discovered by a repository scan. */
      repository: RepositoryEvidence | null;
    };
  };
  'GET /api/investigations': { response: Investigation[] };
  'POST /api/investigations': { body: StartInvestigationRequest; response: Investigation };
  'GET /api/investigations/:id': { response: Investigation };
  'GET /api/audit-events': { response: AuditEvent[] };
  'GET /api/remediation-plans': { response: RemediationPlan[] };
  /** Errors: 400 invalid body, 404 unknown identity, 409 duplicate investigationId or a run for this identity started <200s ago. */
  'GET /api/investigations/:id/events': { query: { after?: number }; response: InvestigationEvent[] };
  'GET /api/security-events': { query: { limit?: number }; response: SecurityEvent[] };
  /**
   * Server-Sent Events. Query: investigationId?, invAfter?, secAfter?; header Last-Event-ID (`<invSeq>.<secSeq>`).
   * Events: `investigation-event` (InvestigationEvent), `security-event` (SecurityEvent), `reconnect` (stream is about to
   * close; EventSource resumes from the last id). Comment lines `: ping` are heartbeats.
   */
  'GET /api/events/stream': { query: { investigationId?: string; invAfter?: number; secAfter?: number }; response: never };
  /** 400 malformed or unsupported scan (with a list of problems), 413 body over 5 MB. Idempotent: re-sending the same scan changes nothing. */
  'POST /api/repository/scans': { body: RepositoryScan; response: RepositoryIngestResponse };
  /** Ingestion history, newest first. */
  'GET /api/repository/scans': { response: RepositoryScanRecord[] };
  /** Pin ownership (`owner`, `team`) as curated, or `revert: true` to hand it back to the repository declaration. */
  'POST /api/identities/:id/ownership': { body: OwnershipUpdateRequest; response: { identity: MachineIdentity } };
  /** 409 unless the plan is `proposed`. */
  'POST /api/remediation-plans/:id/approve': { body?: RemediationDecisionRequest; response: RemediationPlan };
  'POST /api/remediation-plans/:id/reject': { body?: RemediationDecisionRequest; response: RemediationPlan };
  /** 409 unless the plan is `approved`. Dry run only; never touches a real credential. */
  'POST /api/remediation-plans/:id/simulate': { body?: RemediationDecisionRequest; response: RemediationPlan };
  /** Read-only: the verified repository change a pull request would make. 409 unless the plan is an approved or simulated `retire` of a declared-only repository identity. */
  'POST /api/remediation-plans/:id/pr-preview': { body?: RemediationDecisionRequest; response: RemediationPrPreview };
  /** Opens the pull request (configuration only, merged by a human). 409 if one is already open; 503 while GITHUB_PR_TOKEN is unset. */
  'POST /api/remediation-plans/:id/open-pr': { body?: RemediationDecisionRequest; response: RemediationPlan };
}

export interface ApiError {
  error: string;
  message: string;
}
