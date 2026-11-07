import type { MachineIdentity, PermissionGrant, IdentityDependency, CredentialMetadata, UsageEvent } from './identity.js';
import type { Investigation, StartInvestigationRequest } from './investigation.js';
import type { RemediationPlan } from './remediation.js';
import type { AuditEvent } from './audit.js';

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
    };
  };
  'GET /api/investigations': { response: Investigation[] };
  'POST /api/investigations': { body: StartInvestigationRequest; response: Investigation };
  'GET /api/investigations/:id': { response: Investigation };
  'GET /api/audit-events': { response: AuditEvent[] };
  'GET /api/remediation-plans': { response: RemediationPlan[] };
  'POST /api/remediation-plans/:id/simulate': { response: RemediationPlan };
}

export interface ApiError {
  error: string;
  message: string;
}
