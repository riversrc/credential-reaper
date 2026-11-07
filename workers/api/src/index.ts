import type { ApiError, AuditAction, Investigation, RemediationPlan, StartInvestigationRequest } from '@credential-reaper/shared';
import { auditEvents, credentials, dependencies, identities, investigations, permissions, remediationPlans, usageHistory } from './data.js';
import { getAiProvider, type AiProviderEnv } from './providers/index.js';

export interface Env extends AiProviderEnv {}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...init.headers },
  });
}

function notFound(message: string): Response {
  return json({ error: 'not_found', message } satisfies ApiError, { status: 404 });
}

function pushAudit(action: AuditAction, actor: string, fields: Partial<(typeof auditEvents)[number]>) {
  auditEvents.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    action,
    actor,
    identityId: null,
    identityName: null,
    investigationId: null,
    remediationId: null,
    details: '',
    ...fields,
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (pathname === '/api/identities' && method === 'GET') {
      return json(identities);
    }

    const identityMatch = pathname.match(/^\/api\/identities\/([^/]+)$/);
    if (identityMatch && method === 'GET') {
      const identity = identities.find((i) => i.id === identityMatch[1]);
      if (!identity) return notFound(`Identity ${identityMatch[1]} not found`);
      return json({
        identity,
        permissions: permissions.filter((p) => p.identityId === identity.id),
        dependencies: dependencies.filter((d) => d.identityId === identity.id),
        credentials: credentials.filter((c) => c.identityId === identity.id),
        usageHistory: usageHistory.filter((u) => u.identityId === identity.id),
      });
    }

    if (pathname === '/api/investigations' && method === 'GET') {
      return json([...investigations].sort((a, b) => b.startedAt.localeCompare(a.startedAt)));
    }

    if (pathname === '/api/investigations' && method === 'POST') {
      const body = (await request.json()) as StartInvestigationRequest;
      const identity = identities.find((i) => i.id === body.identityId);
      if (!identity) return notFound(`Identity ${body.identityId} not found`);

      const provider = getAiProvider(env);
      const startedAt = new Date().toISOString();
      const investigation: Investigation = {
        id: crypto.randomUUID(),
        identityId: identity.id,
        identityName: identity.name,
        status: 'running',
        startedAt,
        completedAt: null,
        requestedBy: body.requestedBy,
        findings: [],
        aiSummary: null,
        recommendedAction: null,
        source: provider.name,
      };
      investigations.unshift(investigation);
      pushAudit('investigation-started', body.requestedBy, {
        identityId: identity.id,
        identityName: identity.name,
        investigationId: investigation.id,
        details: `Investigation started for ${identity.name}.`,
      });

      const result = await provider.investigate({
        identityName: identity.name,
        identityType: identity.type,
        owner: identity.owner,
        environment: identity.environment,
        lastUsedAt: identity.lastUsedAt,
        permissionsSummary: permissions.filter((p) => p.identityId === identity.id).map((p) => `${p.resource}:${p.scope}`),
        dependenciesSummary: dependencies.filter((d) => d.identityId === identity.id).map((d) => d.name),
        recentUsageSummary: usageHistory.filter((u) => u.identityId === identity.id).map((u) => u.action),
      });

      investigation.status = 'completed';
      investigation.completedAt = new Date().toISOString();
      investigation.findings = result.findings;
      investigation.aiSummary = result.summary;
      investigation.recommendedAction = result.recommendedAction === 'no-action' ? 'no-action' : result.recommendedAction;

      pushAudit('investigation-completed', provider.name === 'nemotron' ? 'nemotron-ai' : 'nemotron-ai (mock)', {
        identityId: identity.id,
        identityName: identity.name,
        investigationId: investigation.id,
        details: `Investigation completed: recommend ${investigation.recommendedAction}.`,
      });

      return json(investigation, { status: 201 });
    }

    const investigationMatch = pathname.match(/^\/api\/investigations\/([^/]+)$/);
    if (investigationMatch && method === 'GET') {
      const investigation = investigations.find((i) => i.id === investigationMatch[1]);
      if (!investigation) return notFound(`Investigation ${investigationMatch[1]} not found`);
      return json(investigation);
    }

    if (pathname === '/api/audit-events' && method === 'GET') {
      return json([...auditEvents].sort((a, b) => b.timestamp.localeCompare(a.timestamp)));
    }

    if (pathname === '/api/remediation-plans' && method === 'GET') {
      return json(remediationPlans);
    }

    const simulateMatch = pathname.match(/^\/api\/remediation-plans\/([^/]+)\/simulate$/);
    if (simulateMatch && method === 'POST') {
      const plan: RemediationPlan | undefined = remediationPlans.find((p) => p.id === simulateMatch[1]);
      if (!plan) return notFound(`Remediation plan ${simulateMatch[1]} not found`);
      plan.status = 'simulated';
      plan.simulatedAt = new Date().toISOString();
      pushAudit('remediation-simulated', 'workspace.river@gmail.com', {
        identityId: plan.identityId,
        identityName: plan.identityName,
        investigationId: plan.investigationId,
        remediationId: plan.id,
        details: `Dry-run simulation completed for "${plan.action}" plan. No live credential was touched.`,
      });
      return json(plan);
    }

    return notFound(`No route for ${method} ${pathname}`);
  },
} satisfies ExportedHandler<Env>;
