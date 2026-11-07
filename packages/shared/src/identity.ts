export type IdentityType =
  | 'service-account'
  | 'api-key'
  | 'oauth-app'
  | 'ssh-key'
  | 'certificate'
  | 'bot-account'
  | 'webhook';

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export type IdentityStatus = 'active' | 'stale' | 'orphaned' | 'retired';

export interface MachineIdentity {
  id: string;
  name: string;
  type: IdentityType;
  owner: string;
  team: string;
  environment: 'production' | 'staging' | 'development';
  status: IdentityStatus;
  riskLevel: RiskLevel;
  riskScore: number; // 0-100
  createdAt: string; // ISO 8601
  lastUsedAt: string | null; // ISO 8601, null if never observed
  tags: string[];
  description: string;
}

export interface PermissionGrant {
  id: string;
  identityId: string;
  resource: string;
  scope: string;
  grantedAt: string;
  grantedBy: string;
}

export interface IdentityDependency {
  id: string;
  identityId: string;
  name: string;
  kind: 'service' | 'pipeline' | 'application' | 'data-store';
  relationship: 'consumes' | 'provides' | 'shared-with';
}

/** Metadata about a credential only — never the secret value itself. */
export interface CredentialMetadata {
  id: string;
  identityId: string;
  kind: 'api-key' | 'password' | 'certificate' | 'oauth-token' | 'ssh-key';
  storageLocation: string;
  maskedPreview: string; // e.g. "sk-live-****ab12"
  createdAt: string;
  lastRotatedAt: string | null;
  expiresAt: string | null;
}

export interface UsageEvent {
  id: string;
  identityId: string;
  timestamp: string;
  action: string;
  source: string;
  result: 'success' | 'failure' | 'denied';
}
