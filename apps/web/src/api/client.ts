// Frontend data client. Currently backed by in-memory synthetic data so the
// UI works end-to-end before the Cloudflare Worker API is live. Function
// signatures mirror the planned `/api/*` routes in
// packages/shared/src/api.ts, so swapping these for real `fetch` calls later
// should not require any page-level changes.
import type { AuditEvent, Investigation, MachineIdentity, RemediationPlan } from '@credential-reaper/shared';
import {
  auditEvents as seedAuditEvents,
  identities,
  investigations as seedInvestigations,
  relatedData,
  remediationPlans as seedRemediationPlans,
} from '../data';

const investigationsStore: Investigation[] = [...seedInvestigations];
const remediationStore: RemediationPlan[] = [...seedRemediationPlans];
const auditStore: AuditEvent[] = [...seedAuditEvents];

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
let idSeq = 1000;
const nextId = (prefix: string) => `${prefix}-${++idSeq}`;

export async function fetchIdentities(): Promise<MachineIdentity[]> {
  await delay(150);
  return identities;
}

export async function fetchIdentityDetail(id: string) {
  await delay(150);
  const identity = identities.find((i) => i.id === id);
  if (!identity) throw new Error(`Identity ${id} not found`);
  const related = relatedData[id] ?? { permissions: [], dependencies: [], credentials: [], usageHistory: [] };
  return { identity, ...related };
}

export async function fetchInvestigations(): Promise<Investigation[]> {
  await delay(150);
  return [...investigationsStore].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}

export async function fetchAuditEvents(): Promise<AuditEvent[]> {
  await delay(150);
  return [...auditStore].sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

export async function fetchRemediationPlans(): Promise<RemediationPlan[]> {
  await delay(150);
  return [...remediationStore];
}

/**
 * Starts a mock investigation: returns immediately with status "running",
 * then resolves to "completed" with generated findings after a short delay.
 * This stands in for a real NVIDIA Nemotron call made by the Worker.
 */
export async function startInvestigation(identityId: string, requestedBy: string): Promise<Investigation> {
  const identity = identities.find((i) => i.id === identityId);
  if (!identity) throw new Error(`Identity ${identityId} not found`);

  const startedAt = new Date().toISOString();
  const investigation: Investigation = {
    id: nextId('inv'),
    identityId: identity.id,
    identityName: identity.name,
    status: 'running',
    startedAt,
    completedAt: null,
    requestedBy,
    findings: [],
    aiSummary: null,
    recommendedAction: null,
    source: 'mock',
  };
  investigationsStore.unshift(investigation);
  auditStore.unshift({
    id: nextId('audit'),
    timestamp: startedAt,
    action: 'investigation-started',
    actor: requestedBy,
    identityId: identity.id,
    identityName: identity.name,
    investigationId: investigation.id,
    remediationId: null,
    details: `Investigation started for ${identity.name}.`,
  });

  await delay(1400);

  const dormant = identity.lastUsedAt === null || new Date(identity.lastUsedAt).getTime() < Date.now() - 1000 * 60 * 60 * 24 * 180;
  const orphaned = identity.status === 'orphaned';
  const recommendedAction = orphaned ? 'retire' : identity.riskLevel === 'critical' || identity.riskLevel === 'high' ? 'rotate' : 'monitor';

  investigation.status = 'completed';
  investigation.completedAt = new Date().toISOString();
  investigation.recommendedAction = recommendedAction;
  investigation.findings = [
    orphaned && {
      id: nextId('find'),
      category: 'ownership',
      severity: 'critical' as const,
      description: 'No active owner on record for this identity.',
      evidence: `owner = "${identity.owner}"`,
    },
    dormant && {
      id: nextId('find'),
      category: 'dormancy',
      severity: 'high' as const,
      description: 'No recent usage observed.',
      evidence: identity.lastUsedAt ? `last used ${identity.lastUsedAt}` : 'no usage events on record',
    },
    {
      id: nextId('find'),
      category: 'risk-posture',
      severity: identity.riskLevel,
      description: `Current risk score is ${identity.riskScore}/100 (${identity.riskLevel}).`,
      evidence: `type=${identity.type}, environment=${identity.environment}, status=${identity.status}`,
    },
  ].filter(Boolean) as Investigation['findings'];
  investigation.aiSummary = `Mock analysis of ${identity.name}: ${
    orphaned
      ? 'identity has no active owner and should be considered for retirement.'
      : dormant
        ? 'identity shows low recent usage relative to its granted scope.'
        : 'identity appears actively used; recommend ongoing monitoring.'
  }`;

  auditStore.unshift({
    id: nextId('audit'),
    timestamp: investigation.completedAt,
    action: 'investigation-completed',
    actor: 'nemotron-ai (mock)',
    identityId: identity.id,
    identityName: identity.name,
    investigationId: investigation.id,
    remediationId: null,
    details: `Investigation completed: recommend ${recommendedAction}.`,
  });

  return investigation;
}

export async function simulateRemediation(planId: string): Promise<RemediationPlan> {
  const plan = remediationStore.find((p) => p.id === planId);
  if (!plan) throw new Error(`Remediation plan ${planId} not found`);
  await delay(800);
  plan.status = 'simulated';
  plan.simulatedAt = new Date().toISOString();
  auditStore.unshift({
    id: nextId('audit'),
    timestamp: plan.simulatedAt,
    action: 'remediation-simulated',
    actor: 'workspace.river@gmail.com',
    identityId: plan.identityId,
    identityName: plan.identityName,
    investigationId: plan.investigationId,
    remediationId: plan.id,
    details: `Dry-run simulation completed for "${plan.action}" plan. No live credential was touched.`,
  });
  return plan;
}
