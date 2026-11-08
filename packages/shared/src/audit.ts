export type AuditAction =
  | 'investigation-started'
  | 'investigation-completed'
  | 'investigation-failed'
  | 'remediation-proposed'
  | 'remediation-approved'
  | 'remediation-simulated'
  | 'remediation-rejected'
  | 'identity-retired';

/** An entry in "The Afterlife" — history of investigations and remediation events. */
export interface AuditEvent {
  id: string;
  timestamp: string;
  action: AuditAction;
  actor: string;
  identityId: string | null;
  identityName: string | null;
  investigationId: string | null;
  remediationId: string | null;
  details: string;
}
