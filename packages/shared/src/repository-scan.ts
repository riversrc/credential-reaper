// Output of an offline repository scan. Everything here is repository evidence only:
// `ScanEvidenceType` deliberately has no runtime-evidence member, so a scanner cannot
// claim a credential is used or a service is deployed.

export type ScanEvidenceType = 'repository-declaration' | 'source-reference';
export type ScanConfidence = 'high' | 'medium' | 'low';

export interface ScanProvenance {
  repo: string;
  sourcePath: string;
  commitSha: string | null;
  discoveredAt: string;
  evidenceType: ScanEvidenceType;
  confidence: ScanConfidence;
}

interface ScannedRecord {
  /** Stable natural key, unique within its list. */
  key: string;
  provenance: ScanProvenance[];
}

export interface ScannedService extends ScannedRecord {
  id: string;
  name: string;
  description: string | null;
  lifecycle: string | null;
  tier: string | null;
  dataClassification: string | null;
  owningTeamId: string | null;
  port: number | null;
  basePath: string | null;
}

export interface ScannedEndpoint extends ScannedRecord {
  serviceId: string;
  method: string;
  path: string;
  operationId: string | null;
  permissionId: string | null;
  identityId: string | null;
  /** From the OpenAPI `security` requirement; `security: []` means no authentication. */
  authenticated: boolean;
  /** The route source's `auth:` value (for example `service-token`), when present. */
  authMode: string | null;
  deprecated: boolean;
  declaredInOpenApi: boolean;
  declaredInRouteSource: boolean;
}

export interface ScannedIdentityBinding {
  serviceId: string;
  usage: string | null;
  /** `active` = that service's code names the identity; `declared-only` = configuration only. */
  mode: string | null;
  declaredInIdentityBindingsSource: boolean;
}

export interface ScannedIdentity extends ScannedRecord {
  id: string;
  name: string;
  type: string;
  purpose: string | null;
  environment: string | null;
  /** The repository's own status label (`active`, `legacy`, `deprecated`); not an app IdentityStatus. */
  declaredStatus: string | null;
  owningServiceId: string | null;
  introducedOn: string | null;
  introducedBy: string | null;
  expiresOn: string | null;
  credential: {
    storage: string | null;
    secretRef: string | null;
    secretRefEnv: string | null;
    maskedPreview: string | null;
    lastRotatedOn: string | null;
  };
  tags: string[];
  homeServiceMode: string | null;
  bindings: ScannedIdentityBinding[];
  actsOnEndpointKeys: string[];
}

export interface ScannedPermission extends ScannedRecord {
  id: string;
  resource: string | null;
  action: string | null;
  level: string | null;
  sensitivity: string | null;
  description: string | null;
}

export interface ScannedAssignment extends ScannedRecord {
  identityId: string;
  permissionId: string;
  environment: string | null;
  resource: string | null;
  reviewStatus: string | null;
  grantedOn: string | null;
}

export interface ScannedPermissionHistory extends ScannedRecord {
  identityId: string;
  permissionId: string | null;
  date: string | null;
  change: string | null;
  ticket: string | null;
  note: string | null;
}

export interface ScannedTeam extends ScannedRecord {
  id: string;
  name: string;
  leadId: string | null;
  securityContactId: string | null;
  channel: string | null;
  githubTeam: string | null;
  memberIds: string[];
}

export interface ScannedPerson extends ScannedRecord {
  id: string;
  name: string;
  title: string | null;
  teamId: string | null;
  status: string | null;
  repositoryRole: string | null;
  githubHandle: string | null;
  joined: string | null;
  left: string | null;
}

export interface ScannedServiceOwnership extends ScannedRecord {
  serviceId: string;
  owningTeamId: string | null;
  maintainerIds: string[];
  tier: string | null;
  status: string | null;
  reviewCadence: string | null;
}

/** Declared ownership observed in the repository. A consumer must never let this overwrite curated ownership. */
export interface ScannedIdentityOwnership extends ScannedRecord {
  identityId: string;
  owningTeamId: string | null;
  owningServiceId: string | null;
  primaryOwnerId: string | null;
  ownershipStatus: string | null;
  ownerEmploymentStatus: string | null;
  lastReviewedOn: string | null;
  note: string | null;
}

export interface ScannedCodeowner extends ScannedRecord {
  pattern: string;
  owners: string[];
}

export interface ScannedExternalProvider extends ScannedRecord {
  id: string;
  name: string;
  category: string | null;
  domain: string | null;
  baseUrlEnv: string | null;
  contractEndsOn: string | null;
  owningTeamId: string | null;
}

export interface ScannedServiceDependency extends ScannedRecord {
  fromServiceId: string;
  toServiceId: string;
  baseUrlEnv: string | null;
  callsAs: string[];
  clientDeclaredInSource: boolean;
  callSiteCount: number;
}

export interface ScannedProviderDependency extends ScannedRecord {
  serviceId: string;
  providerId: string;
  baseUrlEnv: string | null;
  callsAs: string[];
  /** The repository's own label: `configuration-only` or `source-and-configuration`. */
  declaredEvidence: string | null;
  clientDeclaredInSource: boolean;
  callSiteCount: number;
}

export interface ScannedGatewayRoute extends ScannedRecord {
  pathPrefix: string;
  upstreamServiceId: string | null;
  authMode: string | null;
  forwardAsIdentityId: string | null;
}

export type ScanWarningCode = 'parse-error' | 'missing-source' | 'unknown-reference' | 'cross-source-mismatch' | 'duplicate-key' | 'secret-flag';

export interface ScanWarning {
  code: ScanWarningCode;
  sourcePath: string;
  message: string;
}

export interface RepositoryScanCounts {
  services: number;
  endpoints: number;
  machineIdentities: number;
  permissions: number;
  assignments: number;
  permissionHistory: number;
  teams: number;
  people: number;
  serviceOwnership: number;
  identityOwnership: number;
  serviceDependencies: number;
  providerDependencies: number;
  externalProviders: number;
  gatewayRoutes: number;
  codeowners: number;
  warnings: number;
}

export interface RepositoryScan {
  schemaVersion: 1;
  repo: string;
  commitSha: string | null;
  scannedAt: string;
  manifestPath: string;
  /** `partial` when any file failed to parse; consumers must not treat absence as removal in that case. */
  status: 'complete' | 'partial';
  counts: RepositoryScanCounts;
  services: ScannedService[];
  endpoints: ScannedEndpoint[];
  machineIdentities: ScannedIdentity[];
  permissions: ScannedPermission[];
  assignments: ScannedAssignment[];
  permissionHistory: ScannedPermissionHistory[];
  teams: ScannedTeam[];
  people: ScannedPerson[];
  serviceOwnership: ScannedServiceOwnership[];
  identityOwnership: ScannedIdentityOwnership[];
  serviceDependencies: ScannedServiceDependency[];
  providerDependencies: ScannedProviderDependency[];
  externalProviders: ScannedExternalProvider[];
  gatewayRoutes: ScannedGatewayRoute[];
  codeowners: ScannedCodeowner[];
  warnings: ScanWarning[];
}
