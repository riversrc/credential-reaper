// In-memory seed data standing in for SpacetimeDB until the module in
// spacetime/module is wired up to this Worker. Shapes match the shared
// domain types so swapping the storage layer later won't change callers.
import type {
  AuditEvent,
  CredentialMetadata,
  IdentityDependency,
  Investigation,
  MachineIdentity,
  PermissionGrant,
  RemediationPlan,
  UsageEvent,
} from '@credential-reaper/shared';

export const identities: MachineIdentity[] = [
  {
    id: 'id-001',
    name: 'payments-svc-prod',
    type: 'service-account',
    owner: 'Priya Natarajan',
    team: 'Payments',
    environment: 'production',
    status: 'active',
    riskLevel: 'medium',
    riskScore: 45,
    createdAt: '2022-03-14T00:00:00Z',
    lastUsedAt: '2026-11-06T14:22:00Z',
    tags: ['pci-scope', 'tier-1'],
    description: 'Processes outbound payment capture calls to the acquirer network.',
  },
  {
    id: 'id-005',
    name: 'old-slack-integration',
    type: 'oauth-app',
    owner: 'Unassigned',
    team: 'Marketing',
    environment: 'production',
    status: 'orphaned',
    riskLevel: 'critical',
    riskScore: 93,
    createdAt: '2018-09-09T00:00:00Z',
    lastUsedAt: '2023-05-02T11:00:00Z',
    tags: ['no-owner', 'oauth', 'broad-scope'],
    description: 'Legacy OAuth app granting workspace-wide Slack access; original owner has left the company.',
  },
  {
    id: 'id-009',
    name: 'deprecated-webhook-relay',
    type: 'webhook',
    owner: 'Unassigned',
    team: 'Growth',
    environment: 'production',
    status: 'orphaned',
    riskLevel: 'critical',
    riskScore: 88,
    createdAt: '2017-12-05T00:00:00Z',
    lastUsedAt: '2022-01-15T00:00:00Z',
    tags: ['no-owner', 'deprecated'],
    description: 'Relayed marketing signup events to a third-party tool that was decommissioned in 2022.',
  },
  {
    id: 'id-012',
    name: 'contractor-api-key-q3',
    type: 'api-key',
    owner: 'R. Chen (ext. contractor)',
    team: 'Platform Engineering',
    environment: 'production',
    status: 'stale',
    riskLevel: 'high',
    riskScore: 82,
    createdAt: '2024-07-01T00:00:00Z',
    lastUsedAt: '2024-10-15T13:20:00Z',
    tags: ['contractor', 'offboarding-risk'],
    description: 'Issued for a Q3 2024 contract engagement; contract ended but the key was never revoked.',
  },
];

export const permissions: PermissionGrant[] = [
  { id: 'perm-001', identityId: 'id-001', resource: 'acquirer-gateway::capture', scope: 'invoke', grantedAt: '2022-03-14T00:00:00Z', grantedBy: 'Priya Natarajan' },
  { id: 'perm-002', identityId: 'id-005', resource: 'slack::workspace', scope: 'admin', grantedAt: '2018-09-09T00:00:00Z', grantedBy: 'Unassigned' },
  { id: 'perm-003', identityId: 'id-009', resource: 'growth-events::signup', scope: 'write', grantedAt: '2017-12-05T00:00:00Z', grantedBy: 'Unassigned' },
  { id: 'perm-004', identityId: 'id-012', resource: 'staging-cluster::deploy', scope: 'deploy', grantedAt: '2024-07-01T00:00:00Z', grantedBy: 'Jordan Lee' },
];

export const dependencies: IdentityDependency[] = [
  { id: 'dep-001', identityId: 'id-001', name: 'checkout-api', kind: 'service', relationship: 'provides' },
];

export const credentials: CredentialMetadata[] = [
  { id: 'cred-001', identityId: 'id-001', kind: 'api-key', storageLocation: 'Secrets Manager / payments/prod', maskedPreview: 'sk-live-****7f2a', createdAt: '2022-03-14T00:00:00Z', lastRotatedAt: '2026-05-01T00:00:00Z', expiresAt: null },
  { id: 'cred-002', identityId: 'id-005', kind: 'oauth-token', storageLocation: 'Vault / marketing/legacy', maskedPreview: 'xoxb-****112b', createdAt: '2018-09-09T00:00:00Z', lastRotatedAt: null, expiresAt: null },
  { id: 'cred-003', identityId: 'id-009', kind: 'api-key', storageLocation: 'Vault / growth/legacy', maskedPreview: '****0091', createdAt: '2017-12-05T00:00:00Z', lastRotatedAt: null, expiresAt: null },
  { id: 'cred-004', identityId: 'id-012', kind: 'api-key', storageLocation: 'Secrets Manager / platform/contractors', maskedPreview: 'sk-ext-****3b9c', createdAt: '2024-07-01T00:00:00Z', lastRotatedAt: null, expiresAt: '2024-10-01T00:00:00Z' },
];

export const usageHistory: UsageEvent[] = [
  { id: 'usage-001', identityId: 'id-001', timestamp: '2026-11-06T14:22:00Z', action: 'capture.charge', source: 'checkout-api', result: 'success' },
  { id: 'usage-002', identityId: 'id-005', timestamp: '2023-05-02T11:00:00Z', action: 'slack.post_message', source: 'unknown-source', result: 'success' },
  { id: 'usage-003', identityId: 'id-009', timestamp: '2022-01-15T00:00:00Z', action: 'relay.forward', source: 'signup-service', result: 'failure' },
  { id: 'usage-004', identityId: 'id-012', timestamp: '2024-10-15T13:20:00Z', action: 'repo.push', source: 'laptop-rchen', result: 'success' },
];

export const investigations: Investigation[] = [
  {
    id: 'inv-001',
    identityId: 'id-005',
    identityName: 'old-slack-integration',
    status: 'completed',
    startedAt: '2026-11-01T10:00:00Z',
    completedAt: '2026-11-01T10:02:14Z',
    requestedBy: 'workspace.river@gmail.com',
    source: 'mock',
    recommendedAction: 'retire',
    aiSummary:
      'This OAuth app has workspace-wide Slack admin scope but has not been used in over 3 years. Recommend immediate retirement.',
    findings: [
      {
        id: 'find-001',
        category: 'ownership',
        severity: 'critical',
        description: 'No active owner on record.',
        evidence: 'Owner field resolves to a deactivated directory account.',
      },
    ],
  },
];

export const remediationPlans: RemediationPlan[] = [
  {
    id: 'rem-001',
    identityId: 'id-005',
    identityName: 'old-slack-integration',
    investigationId: 'inv-001',
    action: 'retire',
    justification: 'No owner, no dependents, 3.5 years dormant, excessive admin scope.',
    status: 'proposed',
    createdAt: '2026-11-01T10:05:00Z',
    simulatedAt: null,
    steps: [
      { id: 'step-001', order: 1, description: 'Confirm no dependent services reference this OAuth app.', automatable: true },
      { id: 'step-002', order: 2, description: 'Revoke Slack OAuth grant and remove app from workspace.', automatable: true },
    ],
  },
];

export const auditEvents: AuditEvent[] = [
  {
    id: 'audit-001',
    timestamp: '2026-11-01T10:00:00Z',
    action: 'investigation-started',
    actor: 'workspace.river@gmail.com',
    identityId: 'id-005',
    identityName: 'old-slack-integration',
    investigationId: 'inv-001',
    remediationId: null,
    details: 'Investigation started for old-slack-integration.',
  },
  {
    id: 'audit-002',
    timestamp: '2026-11-01T10:02:14Z',
    action: 'investigation-completed',
    actor: 'nemotron-ai',
    identityId: 'id-005',
    identityName: 'old-slack-integration',
    investigationId: 'inv-001',
    remediationId: null,
    details: 'Investigation completed: recommend retirement.',
  },
];
