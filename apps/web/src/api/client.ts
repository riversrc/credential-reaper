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
  InvestigationEvent,
  MachineIdentity,
  OwnershipUpdateRequest,
  PermissionGrant,
  RemediationPlan,
  RemediationPrPreview,
  RepositoryEvidence,
  SecurityEvent,
  StartInvestigationRequest,
  UsageEvent,
} from '@credential-reaper/shared';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL ?? 'http://localhost:8787';

/** Error carrying the HTTP status and the server's `error` code so callers can tell a 409 from a 502. */
export class ApiRequestError extends Error {
  readonly status: number;
  readonly code: string | null;
  constructor(message: string, status: number, code: string | null) {
    super(message);
    this.name = 'ApiRequestError';
    this.status = status;
    this.code = code;
  }
}

/** The request never produced an HTTP response (network down, CORS, server stopped). */
export class NetworkError extends Error {
  constructor() {
    super('Could not reach the server. Check that the API is running.');
    this.name = 'NetworkError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE_URL}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...init?.headers },
    });
  } catch {
    throw new NetworkError();
  }

  if (!response.ok) {
    const body = (await response.json().catch(() => null)) as ApiError | null;
    throw new ApiRequestError(body?.message ?? `Request to ${path} failed with status ${response.status}`, response.status, body?.error ?? null);
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
  repository: RepositoryEvidence | null;
}> {
  return request(`/api/identities/${encodeURIComponent(id)}`);
}

export function updateOwnership(id: string, body: OwnershipUpdateRequest): Promise<{ identity: MachineIdentity }> {
  return request(`/api/identities/${encodeURIComponent(id)}/ownership`, { method: 'POST', body: JSON.stringify(body) });
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
 * Starts an investigation and waits for the Worker to finish it. The request blocks until the run is
 * "completed" or "failed", so generate `investigationId` first and open the progress feed with it
 * before awaiting this call.
 */
export function startInvestigation(identityId: string, requestedBy: string, investigationId: string): Promise<Investigation> {
  const body: StartInvestigationRequest = { identityId, requestedBy, investigationId };
  return request('/api/investigations', { method: 'POST', body: JSON.stringify(body) });
}

export function fetchInvestigationEvents(investigationId: string, after: number): Promise<InvestigationEvent[]> {
  return request(`/api/investigations/${encodeURIComponent(investigationId)}/events?after=${after}`);
}

export function fetchSecurityEvents(limit: number): Promise<SecurityEvent[]> {
  return request(`/api/security-events?limit=${limit}`);
}

export interface StreamParams {
  investigationId?: string;
  invAfter?: number;
  secAfter?: number;
}

export interface StreamHandlers {
  onInvestigationEvent?: (event: InvestigationEvent) => void;
  onSecurityEvent?: (event: SecurityEvent) => void;
  onOpen: () => void;
  /** The server announced it is closing the connection on purpose; EventSource will resume by itself. */
  onReconnect: () => void;
  onError: () => void;
}

/** Opens the Server-Sent Events stream. Returns a function that closes it. */
export function openEventStream(params: StreamParams, handlers: StreamHandlers): () => void {
  const query = new URLSearchParams();
  if (params.investigationId) query.set('investigationId', params.investigationId);
  if (params.invAfter !== undefined) query.set('invAfter', String(params.invAfter));
  if (params.secAfter !== undefined) query.set('secAfter', String(params.secAfter));
  const source = new EventSource(`${API_BASE_URL}/api/events/stream?${query}`);
  const parse = <T,>(e: MessageEvent): T | null => {
    try {
      return JSON.parse(e.data as string) as T;
    } catch {
      return null;
    }
  };
  source.onopen = () => handlers.onOpen();
  source.onerror = () => handlers.onError();
  source.addEventListener('reconnect', () => handlers.onReconnect());
  source.addEventListener('investigation-event', (e) => {
    const event = parse<InvestigationEvent>(e as MessageEvent);
    if (event) handlers.onInvestigationEvent?.(event);
  });
  source.addEventListener('security-event', (e) => {
    const event = parse<SecurityEvent>(e as MessageEvent);
    if (event) handlers.onSecurityEvent?.(event);
  });
  return () => source.close();
}

function transitionRemediation(planId: string, action: 'approve' | 'reject' | 'simulate'): Promise<RemediationPlan> {
  return request(`/api/remediation-plans/${encodeURIComponent(planId)}/${action}`, { method: 'POST' });
}

/** proposed -> approved. Records a human decision only; nothing is executed. */
export function approveRemediation(planId: string): Promise<RemediationPlan> {
  return transitionRemediation(planId, 'approve');
}

/** proposed -> rejected. */
export function rejectRemediation(planId: string): Promise<RemediationPlan> {
  return transitionRemediation(planId, 'reject');
}

/** approved -> simulated. Dry run only; the Worker answers 409 for any other status. */
export function simulateRemediation(planId: string): Promise<RemediationPlan> {
  return transitionRemediation(planId, 'simulate');
}

/** Read-only. 409 when the plan cannot become a pull request (not a retire of a declared-only repository identity, or not approved). */
export function previewRemediationPr(planId: string): Promise<RemediationPrPreview> {
  return request(`/api/remediation-plans/${encodeURIComponent(planId)}/pr-preview`, { method: 'POST' });
}

/** Opens a pull request that changes repository configuration only; a person still has to merge it. */
export function openRemediationPr(planId: string): Promise<RemediationPlan> {
  return request(`/api/remediation-plans/${encodeURIComponent(planId)}/open-pr`, { method: 'POST' });
}
