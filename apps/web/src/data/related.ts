import type {
  PermissionGrant,
  IdentityDependency,
  CredentialMetadata,
  UsageEvent,
} from '@credential-reaper/shared';

export interface IdentityRelatedData {
  permissions: PermissionGrant[];
  dependencies: IdentityDependency[];
  credentials: CredentialMetadata[];
  usageHistory: UsageEvent[];
}

let seq = 0;
const nextId = (prefix: string) => `${prefix}-${String(++seq).padStart(4, '0')}`;

function perm(identityId: string, resource: string, scope: string, grantedAt: string, grantedBy: string): PermissionGrant {
  return { id: nextId('perm'), identityId, resource, scope, grantedAt, grantedBy };
}
function dep(identityId: string, name: string, kind: IdentityDependency['kind'], relationship: IdentityDependency['relationship']): IdentityDependency {
  return { id: nextId('dep'), identityId, name, kind, relationship };
}
function cred(
  identityId: string,
  kind: CredentialMetadata['kind'],
  storageLocation: string,
  maskedPreview: string,
  createdAt: string,
  lastRotatedAt: string | null,
  expiresAt: string | null,
): CredentialMetadata {
  return { id: nextId('cred'), identityId, kind, storageLocation, maskedPreview, createdAt, lastRotatedAt, expiresAt };
}
function usage(identityId: string, timestamp: string, action: string, source: string, result: UsageEvent['result']): UsageEvent {
  return { id: nextId('usage'), identityId, timestamp, action, source, result };
}

export const relatedData: Record<string, IdentityRelatedData> = {
  'id-001': {
    permissions: [
      perm('id-001', 'acquirer-gateway::capture', 'invoke', '2022-03-14T00:00:00Z', 'Priya Natarajan'),
      perm('id-001', 'payments-db::transactions', 'read-write', '2022-03-14T00:00:00Z', 'Priya Natarajan'),
    ],
    dependencies: [
      dep('id-001', 'checkout-api', 'service', 'provides'),
      dep('id-001', 'ledger-service', 'service', 'shared-with'),
    ],
    credentials: [
      cred('id-001', 'api-key', 'Secrets Manager / payments/prod', 'sk-live-****7f2a', '2022-03-14T00:00:00Z', '2026-05-01T00:00:00Z', null),
    ],
    usageHistory: [
      usage('id-001', '2026-11-06T14:22:00Z', 'capture.charge', 'checkout-api', 'success'),
      usage('id-001', '2026-11-05T09:03:00Z', 'capture.charge', 'checkout-api', 'success'),
      usage('id-001', '2026-11-04T18:47:00Z', 'capture.refund', 'checkout-api', 'success'),
      usage('id-001', '2026-11-02T02:11:00Z', 'capture.charge', 'checkout-api', 'failure'),
    ],
  },
  'id-002': {
    permissions: [
      perm('id-002', 'warehouse::raw_events', 'read', '2019-06-01T00:00:00Z', 'Marcus Webb'),
      perm('id-002', 'warehouse::staging', 'write', '2019-06-01T00:00:00Z', 'Marcus Webb'),
    ],
    dependencies: [
      dep('id-002', 'legacy-cron-host', 'service', 'consumes'),
    ],
    credentials: [
      cred('id-002', 'password', 'Vault / data-platform/legacy', '****a91c', '2019-06-01T00:00:00Z', null, null),
    ],
    usageHistory: [
      usage('id-002', '2025-02-11T09:10:00Z', 'etl.nightly_sync', 'legacy-cron-host', 'success'),
      usage('id-002', '2025-01-10T09:10:00Z', 'etl.nightly_sync', 'legacy-cron-host', 'success'),
    ],
  },
  'id-003': {
    permissions: [
      perm('id-003', 'stripe::webhooks', 'verify', '2023-01-20T00:00:00Z', 'Dana Okafor'),
      perm('id-003', 'billing-db::invoices', 'write', '2023-01-20T00:00:00Z', 'Dana Okafor'),
    ],
    dependencies: [
      dep('id-003', 'invoicing-service', 'service', 'provides'),
    ],
    credentials: [
      cred('id-003', 'api-key', 'Secrets Manager / billing/prod', 'whsec_****c310', '2023-01-20T00:00:00Z', '2025-11-01T00:00:00Z', null),
    ],
    usageHistory: [
      usage('id-003', '2026-11-05T03:41:00Z', 'webhook.invoice.paid', 'stripe', 'success'),
      usage('id-003', '2026-11-03T03:40:00Z', 'webhook.invoice.paid', 'stripe', 'success'),
      usage('id-003', '2026-10-30T03:39:00Z', 'webhook.charge.failed', 'stripe', 'success'),
    ],
  },
  'id-004': {
    permissions: [
      perm('id-004', 'k8s-cluster::prod', 'deploy', '2021-11-02T00:00:00Z', 'Jordan Lee'),
      perm('id-004', 'artifact-registry::images', 'read', '2021-11-02T00:00:00Z', 'Jordan Lee'),
    ],
    dependencies: [
      dep('id-004', 'ci-pipeline', 'pipeline', 'consumes'),
      dep('id-004', 'k8s-cluster-prod', 'service', 'provides'),
    ],
    credentials: [
      cred('id-004', 'oauth-token', 'Workload Identity / ci', '****9d4e', '2021-11-02T00:00:00Z', '2026-10-01T00:00:00Z', '2027-01-01T00:00:00Z'),
    ],
    usageHistory: [
      usage('id-004', '2026-11-07T08:00:00Z', 'deploy.apply', 'ci-pipeline', 'success'),
      usage('id-004', '2026-11-06T19:22:00Z', 'deploy.apply', 'ci-pipeline', 'success'),
      usage('id-004', '2026-11-06T11:05:00Z', 'deploy.apply', 'ci-pipeline', 'success'),
    ],
  },
  'id-005': {
    permissions: [
      perm('id-005', 'slack::workspace', 'admin', '2018-09-09T00:00:00Z', 'Unassigned'),
      perm('id-005', 'slack::channels.all', 'read-write', '2018-09-09T00:00:00Z', 'Unassigned'),
    ],
    dependencies: [],
    credentials: [
      cred('id-005', 'oauth-token', 'Vault / marketing/legacy', 'xoxb-****112b', '2018-09-09T00:00:00Z', null, null),
    ],
    usageHistory: [
      usage('id-005', '2023-05-02T11:00:00Z', 'slack.post_message', 'unknown-source', 'success'),
    ],
  },
  'id-006': {
    permissions: [
      perm('id-006', 'prod01::filesystem', 'read-write', '2020-02-17T00:00:00Z', 'Marcus Webb'),
    ],
    dependencies: [
      dep('id-006', 'backup-job-prod01', 'pipeline', 'consumes'),
    ],
    credentials: [
      cred('id-006', 'ssh-key', 'Vault / infra/break-glass', 'ssh-ed25519 ****c88f', '2020-02-17T00:00:00Z', null, null),
    ],
    usageHistory: [
      usage('id-006', '2025-08-30T22:15:00Z', 'ssh.login', 'ops-laptop-mw', 'success'),
    ],
  },
  'id-007': {
    permissions: [
      perm('id-007', 'warehouse::analytics_marts', 'read', '2024-04-11T00:00:00Z', 'Priya Natarajan'),
    ],
    dependencies: [
      dep('id-007', 'staging-dashboard', 'application', 'provides'),
    ],
    credentials: [
      cred('id-007', 'api-key', 'Secrets Manager / data-platform/staging', 'sk-stg-****22de', '2024-04-11T00:00:00Z', '2026-08-01T00:00:00Z', null),
    ],
    usageHistory: [
      usage('id-007', '2026-11-06T16:45:00Z', 'query.read', 'staging-dashboard', 'success'),
      usage('id-007', '2026-11-05T16:45:00Z', 'query.read', 'staging-dashboard', 'success'),
    ],
  },
  'id-008': {
    permissions: [
      perm('id-008', 'partner-gateway::acme', 'invoke', '2023-07-01T00:00:00Z', 'Dana Okafor'),
    ],
    dependencies: [
      dep('id-008', 'acme-integration-service', 'service', 'provides'),
    ],
    credentials: [
      cred('id-008', 'certificate', 'Secrets Manager / partnerships/prod', 'CN=acme-client ****e04a', '2023-07-01T00:00:00Z', null, '2026-12-15T00:00:00Z'),
    ],
    usageHistory: [
      usage('id-008', '2026-10-29T10:05:00Z', 'mtls.handshake', 'acme-integration-service', 'success'),
      usage('id-008', '2026-10-20T10:02:00Z', 'mtls.handshake', 'acme-integration-service', 'success'),
    ],
  },
  'id-009': {
    permissions: [
      perm('id-009', 'growth-events::signup', 'write', '2017-12-05T00:00:00Z', 'Unassigned'),
    ],
    dependencies: [],
    credentials: [
      cred('id-009', 'api-key', 'Vault / growth/legacy', '****0091', '2017-12-05T00:00:00Z', null, null),
    ],
    usageHistory: [
      usage('id-009', '2022-01-15T00:00:00Z', 'relay.forward', 'signup-service', 'failure'),
    ],
  },
  'id-010': {
    permissions: [
      perm('id-010', 'sandbox-db::*', 'read-write', '2025-01-10T00:00:00Z', 'Jordan Lee'),
    ],
    dependencies: [
      dep('id-010', 'ci-pipeline', 'pipeline', 'consumes'),
    ],
    credentials: [
      cred('id-010', 'api-key', 'Secrets Manager / platform/dev', 'sk-dev-****55aa', '2025-01-10T00:00:00Z', '2026-09-01T00:00:00Z', null),
    ],
    usageHistory: [
      usage('id-010', '2026-11-07T07:30:00Z', 'test.run', 'ci-pipeline', 'success'),
      usage('id-010', '2026-11-06T07:28:00Z', 'test.run', 'ci-pipeline', 'success'),
    ],
  },
  'id-011': {
    permissions: [
      perm('id-011', 'feature-store::transactions', 'read', '2022-09-19T00:00:00Z', 'Priya Natarajan'),
      perm('id-011', 'fraud-model::score', 'invoke', '2022-09-19T00:00:00Z', 'Priya Natarajan'),
    ],
    dependencies: [
      dep('id-011', 'fraud-scoring-service', 'service', 'provides'),
      dep('id-011', 'payments-svc-prod', 'service', 'consumes'),
    ],
    credentials: [
      cred('id-011', 'oauth-token', 'Workload Identity / risk', '****77b1', '2022-09-19T00:00:00Z', '2026-06-01T00:00:00Z', '2027-06-01T00:00:00Z'),
    ],
    usageHistory: [
      usage('id-011', '2026-11-04T05:12:00Z', 'score.predict', 'fraud-scoring-service', 'success'),
      usage('id-011', '2026-11-03T05:12:00Z', 'score.predict', 'fraud-scoring-service', 'success'),
    ],
  },
  'id-012': {
    permissions: [
      perm('id-012', 'internal-tools::repo-access', 'read-write', '2024-07-01T00:00:00Z', 'Jordan Lee'),
      perm('id-012', 'staging-cluster::deploy', 'deploy', '2024-07-01T00:00:00Z', 'Jordan Lee'),
    ],
    dependencies: [],
    credentials: [
      cred('id-012', 'api-key', 'Secrets Manager / platform/contractors', 'sk-ext-****3b9c', '2024-07-01T00:00:00Z', null, '2024-10-01T00:00:00Z'),
    ],
    usageHistory: [
      usage('id-012', '2024-10-15T13:20:00Z', 'repo.push', 'laptop-rchen', 'success'),
      usage('id-012', '2024-10-10T09:00:00Z', 'deploy.apply', 'staging-cluster', 'success'),
    ],
  },
};
