// Frontend data client. Talks to the Cloudflare Worker API (workers/api)
// over HTTP. Function signatures match the shared `ApiRoutes` contract in
// packages/shared/src/api.ts, so page components don't need to know
// anything about the transport.
import type {
  ApiError,
  AuditEvent,
  CredentialMetadata,
  IdentityDependency,
  Investigation,
  MachineIdentity,
  PermissionGrant,
  RemediationPlan,
  StartInvestigationRequest,
  UsageEvent,
} from '@credential-reaper/shared';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new Error(`Could not reach the API at ${API_BASE_URL}. Is the Worker running (pnpm dev:api)?`);
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new Error(body?.message ?? `Request to ${path} failed with status ${response.status}`);
  }

  return response.json() as Promise<T>;
}

export function fetchIdentities(): Promise<MachineIdentity[]> {
  return request('/api/identities');
}

export function fetchIdentityDetail(id: string): Promise<{
  identity: MachineIdentity;
  permissions: PermissionGrant[];
  dependencies: IdentityDependency[];
  credentials: CredentialMetadata[];
  usageHistory: UsageEvent[];
}> {
  return request(`/api/identities/${encodeURIComponent(id)}`);
}

export function fetchInvestigations(): Promise<Investigation[]> {
  return request('/api/investigations');
}

export function fetchAuditEvents(): Promise<AuditEvent[]> {
  return request('/api/audit-events');
}

export function fetchRemediationPlans(): Promise<RemediationPlan[]> {
  return request('/api/remediation-plans');
}

/**
 * Starts an investigation and waits for the Worker to finish it. The Worker
 * runs the full investigate-and-complete cycle synchronously within this one
 * request, so the returned investigation is already in its final state
 * ("completed" or "failed") — there's no separate polling step.
 */
export function startInvestigation(identityId: string, requestedBy: string): Promise<Investigation> {
  const body: StartInvestigationRequest = { identityId, requestedBy };
  return request('/api/investigations', { method: 'POST', body: JSON.stringify(body) });
}

export function simulateRemediation(planId: string): Promise<RemediationPlan> {
  return request(`/api/remediation-plans/${encodeURIComponent(planId)}/simulate`, { method: 'POST' });
}
