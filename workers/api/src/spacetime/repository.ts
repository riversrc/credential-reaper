// Domain-level data access backed by SpacetimeDB, replacing the old
// in-memory arrays in workers/api/src/data.ts. Route handlers in index.ts
// call these functions instead of touching arrays directly; the HTTP
// response shapes are unchanged.
import type {
  AuditEvent,
  CredentialMetadata,
  IdentityDependency,
  Investigation,
  InvestigationFinding,
  MachineIdentity,
  PermissionGrant,
  RemediationPlan,
  UsageEvent,
} from '@credential-reaper/shared';
import { callReducer, encodeOption, sqlQuery, sqlString, type SpacetimeEnv } from './client.js';
import {
  seedCredentials,
  seedDependencies,
  seedIdentities,
  seedInvestigation,
  seedPermissions,
  seedRemediationPlan,
  seedUsageEvents,
} from './seed-data.js';

export async function fetchIdentities(env: SpacetimeEnv): Promise<MachineIdentity[]> {
  return sqlQuery<MachineIdentity>(env, 'SELECT * FROM machine_identity');
}

export async function fetchIdentityDetail(env: SpacetimeEnv, id: string) {
  const idLiteral = sqlString(id);
  const [identities, permissions, dependencies, credentials, usageHistory] = await Promise.all([
    sqlQuery<MachineIdentity>(env, `SELECT * FROM machine_identity WHERE id = ${idLiteral}`),
    sqlQuery<PermissionGrant>(env, `SELECT * FROM permission_grant WHERE identity_id = ${idLiteral}`),
    sqlQuery<IdentityDependency>(env, `SELECT * FROM identity_dependency WHERE identity_id = ${idLiteral}`),
    sqlQuery<CredentialMetadata>(env, `SELECT * FROM credential_metadata WHERE identity_id = ${idLiteral}`),
    sqlQuery<UsageEvent>(env, `SELECT * FROM usage_event WHERE identity_id = ${idLiteral}`),
  ]);
  const identity = identities[0];
  if (!identity) return null;
  return { identity, permissions, dependencies, credentials, usageHistory };
}

export async function fetchInvestigations(env: SpacetimeEnv): Promise<Investigation[]> {
  const rows = await sqlQuery<Investigation>(env, 'SELECT * FROM investigation');
  return rows.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function fetchInvestigation(env: SpacetimeEnv, id: string): Promise<Investigation | null> {
  const rows = await sqlQuery<Investigation>(env, `SELECT * FROM investigation WHERE id = ${sqlString(id)}`);
  return rows[0] ?? null;
}

export async function startInvestigationRow(
  env: SpacetimeEnv,
  args: { id: string; identityId: string; identityName: string; requestedBy: string; startedAt: string; source: string }
): Promise<void> {
  await callReducer(env, 'start_investigation', args);
}

export async function completeInvestigationRow(
  env: SpacetimeEnv,
  args: {
    investigationId: string;
    completedAt: string;
    findings: InvestigationFinding[];
    aiSummary: string;
    recommendedAction: string;
    actor: string;
  }
): Promise<void> {
  await callReducer(env, 'complete_investigation', args);
}

export async function fetchAuditEvents(env: SpacetimeEnv): Promise<AuditEvent[]> {
  const rows = await sqlQuery<AuditEvent>(env, 'SELECT * FROM audit_event');
  return rows.sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function fetchRemediationPlans(env: SpacetimeEnv): Promise<RemediationPlan[]> {
  return sqlQuery<RemediationPlan>(env, 'SELECT * FROM remediation_plan');
}

export async function fetchRemediationPlan(env: SpacetimeEnv, id: string): Promise<RemediationPlan | null> {
  const rows = await sqlQuery<RemediationPlan>(env, `SELECT * FROM remediation_plan WHERE id = ${sqlString(id)}`);
  return rows[0] ?? null;
}

export async function simulateRemediationRow(env: SpacetimeEnv, planId: string, simulatedAt: string, actor: string): Promise<void> {
  await callReducer(env, 'simulate_remediation', { planId, simulatedAt, actor });
}

let seeded = false;

/**
 * Bootstraps demo data into a freshly published module, exactly once.
 * Checked against the live `machine_identity` table (not just a Worker-local
 * flag) so it's safe across Worker restarts/isolate evictions and never
 * double-inserts into an already-seeded database.
 */
export async function ensureSeeded(env: SpacetimeEnv): Promise<void> {
  if (seeded) return;

  const existing = await sqlQuery(env, 'SELECT id FROM machine_identity LIMIT 1');
  if (existing.length > 0) {
    seeded = true;
    return;
  }

  for (const identity of seedIdentities) {
    await callReducer(env, 'seed_identity', { ...identity, lastUsedAt: encodeOption(identity.lastUsedAt) });
  }
  for (const permission of seedPermissions) {
    await callReducer(env, 'seed_permission', permission);
  }
  for (const dependency of seedDependencies) {
    await callReducer(env, 'seed_dependency', dependency);
  }
  for (const credential of seedCredentials) {
    await callReducer(env, 'seed_credential', {
      ...credential,
      lastRotatedAt: encodeOption(credential.lastRotatedAt),
      expiresAt: encodeOption(credential.expiresAt),
    });
  }
  for (const usageEvent of seedUsageEvents) {
    await callReducer(env, 'seed_usage_event', usageEvent);
  }

  const { completedAt, findings, aiSummary, recommendedAction, ...startArgs } = seedInvestigation;
  await callReducer(env, 'start_investigation', startArgs);
  await callReducer(env, 'complete_investigation', {
    investigationId: seedInvestigation.id,
    completedAt,
    findings,
    aiSummary,
    recommendedAction,
    actor: 'nemotron-ai (mock)',
  });

  await callReducer(env, 'propose_remediation', {
    ...seedRemediationPlan,
    investigationId: encodeOption(seedRemediationPlan.investigationId),
    actor: 'workspace.river@gmail.com',
  });

  seeded = true;
}
