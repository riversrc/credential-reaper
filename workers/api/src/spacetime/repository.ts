// Domain-level data access backed by SpacetimeDB, replacing the old
// in-memory arrays in workers/api/src/data.ts. Route handlers in index.ts
// call these functions instead of touching arrays directly; the HTTP
// response shapes are unchanged.
import type {
  AuditEvent,
  CredentialMetadata,
  IdentityDependency,
  FindingBasis,
  Investigation,
  InvestigationFinding,
  MachineIdentity,
  PermissionGrant,
  RemediationPlan,
  RemediationStep,
  RiskAssessment,
  ToolTraceEntry,
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

export async function fetchIdentity(env: SpacetimeEnv, id: string): Promise<MachineIdentity | null> {
  const rows = await sqlQuery<MachineIdentity>(env, `SELECT * FROM machine_identity WHERE id = ${sqlString(id)}`);
  return rows[0] ?? null;
}

export function fetchPermissions(env: SpacetimeEnv, identityId: string): Promise<PermissionGrant[]> {
  return sqlQuery<PermissionGrant>(env, `SELECT * FROM permission_grant WHERE identity_id = ${sqlString(identityId)}`);
}

export function fetchDependencies(env: SpacetimeEnv, identityId: string): Promise<IdentityDependency[]> {
  return sqlQuery<IdentityDependency>(env, `SELECT * FROM identity_dependency WHERE identity_id = ${sqlString(identityId)}`);
}

export function fetchCredentials(env: SpacetimeEnv, identityId: string): Promise<CredentialMetadata[]> {
  return sqlQuery<CredentialMetadata>(env, `SELECT * FROM credential_metadata WHERE identity_id = ${sqlString(identityId)}`);
}

export function fetchUsageEvents(env: SpacetimeEnv, identityId: string): Promise<UsageEvent[]> {
  return sqlQuery<UsageEvent>(env, `SELECT * FROM usage_event WHERE identity_id = ${sqlString(identityId)}`);
}

export async function fetchIdentityDetail(env: SpacetimeEnv, id: string) {
  const [identity, permissions, dependencies, credentials, usageHistory] = await Promise.all([
    fetchIdentity(env, id),
    fetchPermissions(env, id),
    fetchDependencies(env, id),
    fetchCredentials(env, id),
    fetchUsageEvents(env, id),
  ]);
  if (!identity) return null;
  return { identity, permissions, dependencies, credentials, usageHistory };
}

/** Row shape as stored: the nested finding has no `basis`, and the new columns are flat. */
type InvestigationRow = Omit<Investigation, 'findings' | 'riskAssessment'> & {
  findings: Omit<InvestigationFinding, 'basis'>[];
  findingBases: FindingBasis[];
  riskScore: number;
  riskLevel: string;
  riskFactors: string[];
};

/**
 * Rows written before finding bases existed (e.g. the seeded demo investigation)
 * have no entry in `findingBases`; those findings are treated as confirmed.
 */
function toInvestigation(row: InvestigationRow): Investigation {
  const { findingBases, riskScore, riskLevel, riskFactors, findings, ...rest } = row;
  return {
    ...rest,
    findings: findings.map((f, i) => ({ ...f, basis: findingBases[i] ?? 'confirmed' })),
    riskAssessment: riskLevel
      ? { score: riskScore, level: riskLevel as RiskAssessment['level'], factors: riskFactors }
      : null,
  };
}

export async function fetchInvestigations(env: SpacetimeEnv): Promise<Investigation[]> {
  const rows = await sqlQuery<InvestigationRow>(env, 'SELECT * FROM investigation');
  return rows.map(toInvestigation).sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function fetchInvestigation(env: SpacetimeEnv, id: string): Promise<Investigation | null> {
  const rows = await sqlQuery<InvestigationRow>(env, `SELECT * FROM investigation WHERE id = ${sqlString(id)}`);
  return rows[0] ? toInvestigation(rows[0]) : null;
}

export async function startInvestigationRow(
  env: SpacetimeEnv,
  args: { id: string; identityId: string; identityName: string; requestedBy: string; startedAt: string; source: string }
): Promise<void> {
  await callReducer(env, 'start_investigation', args);
}

/** Reducer args take top-level keys in camelCase but nested object fields under their snake_case wire names. */
function encodeTrace(trace: ToolTraceEntry[]) {
  return trace.map(({ durationMs, ...rest }) => ({ ...rest, duration_ms: durationMs }));
}

export async function recordFindingRow(env: SpacetimeEnv, investigationId: string, finding: InvestigationFinding): Promise<void> {
  await callReducer(env, 'record_finding', { investigationId, ...finding });
}

export async function completeInvestigationRow(
  env: SpacetimeEnv,
  args: {
    investigationId: string;
    completedAt: string;
    aiSummary: string;
    recommendedAction: string;
    riskScore: number;
    riskLevel: string;
    riskFactors: string[];
    toolTrace: ToolTraceEntry[];
    actor: string;
  }
): Promise<void> {
  await callReducer(env, 'complete_investigation', { ...args, toolTrace: encodeTrace(args.toolTrace) });
}

export async function failInvestigationRow(
  env: SpacetimeEnv,
  args: { investigationId: string; completedAt: string; reason: string; toolTrace: ToolTraceEntry[]; actor: string }
): Promise<void> {
  await callReducer(env, 'fail_investigation', { ...args, toolTrace: encodeTrace(args.toolTrace) });
}

export async function proposeRemediationRow(
  env: SpacetimeEnv,
  args: {
    id: string;
    identityId: string;
    identityName: string;
    investigationId: string | null;
    action: string;
    justification: string;
    steps: RemediationStep[];
    createdAt: string;
    actor: string;
  }
): Promise<void> {
  await callReducer(env, 'propose_remediation', { ...args, investigationId: encodeOption(args.investigationId) });
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
  for (const finding of findings) {
    await recordFindingRow(env, seedInvestigation.id, finding);
  }
  await completeInvestigationRow(env, {
    investigationId: seedInvestigation.id,
    completedAt,
    aiSummary,
    recommendedAction,
    riskScore: 93,
    riskLevel: 'critical',
    riskFactors: ['seeded demo data'],
    toolTrace: [],
    actor: 'nemotron-ai (mock)',
  });

  await callReducer(env, 'propose_remediation', {
    ...seedRemediationPlan,
    investigationId: encodeOption(seedRemediationPlan.investigationId),
    actor: 'workspace.river@gmail.com',
  });

  seeded = true;
}
