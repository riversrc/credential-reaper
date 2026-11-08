import type { ApiError, Investigation, StartInvestigationRequest } from '@credential-reaper/shared';
import { getAiProvider, type AiProviderEnv } from './providers/index.js';
import type { SpacetimeEnv } from './spacetime/client.js';
import {
  completeInvestigationRow,
  ensureSeeded,
  fetchAuditEvents,
  fetchIdentities,
  fetchIdentityDetail,
  fetchInvestigation,
  fetchInvestigations,
  fetchRemediationPlan,
  fetchRemediationPlans,
  simulateRemediationRow,
  startInvestigationRow,
} from './spacetime/repository.js';

export interface Env extends AiProviderEnv, SpacetimeEnv {}

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

function badGateway(message: string): Response {
  return json({ error: 'spacetimedb_unavailable', message } satisfies ApiError, { status: 502 });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const { pathname } = url;
    const method = request.method;

    if (method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      await ensureSeeded(env);
    } catch (e) {
      return badGateway(`Could not reach SpacetimeDB at ${env.SPACETIME_URL}: ${(e as Error).message}`);
    }

    if (pathname === '/api/identities' && method === 'GET') {
      return json(await fetchIdentities(env));
    }

    const identityMatch = pathname.match(/^\/api\/identities\/([^/]+)$/);
    if (identityMatch && method === 'GET') {
      const detail = await fetchIdentityDetail(env, identityMatch[1]!);
      if (!detail) return notFound(`Identity ${identityMatch[1]} not found`);
      return json(detail);
    }

    if (pathname === '/api/investigations' && method === 'GET') {
      return json(await fetchInvestigations(env));
    }

    if (pathname === '/api/investigations' && method === 'POST') {
      const body = (await request.json()) as StartInvestigationRequest;
      const detail = await fetchIdentityDetail(env, body.identityId);
      if (!detail) return notFound(`Identity ${body.identityId} not found`);
      const { identity } = detail;

      const provider = getAiProvider(env);
      const id = crypto.randomUUID();
      const startedAt = new Date().toISOString();
      await startInvestigationRow(env, {
        id,
        identityId: identity.id,
        identityName: identity.name,
        requestedBy: body.requestedBy,
        startedAt,
        source: provider.name,
      });

      const result = await provider.investigate({
        identityName: identity.name,
        identityType: identity.type,
        owner: identity.owner,
        environment: identity.environment,
        lastUsedAt: identity.lastUsedAt,
        permissionsSummary: detail.permissions.map((p) => `${p.resource}:${p.scope}`),
        dependenciesSummary: detail.dependencies.map((d) => d.name),
        recentUsageSummary: detail.usageHistory.map((u) => u.action),
      });

      const completedAt = new Date().toISOString();
      const recommendedAction = result.recommendedAction;
      await completeInvestigationRow(env, {
        investigationId: id,
        completedAt,
        findings: result.findings,
        aiSummary: result.summary,
        recommendedAction,
        actor: provider.name === 'nemotron' ? 'nemotron-ai' : 'nemotron-ai (mock)',
      });

      const investigation: Investigation = {
        id,
        identityId: identity.id,
        identityName: identity.name,
        status: 'completed',
        startedAt,
        completedAt,
        requestedBy: body.requestedBy,
        findings: result.findings,
        aiSummary: result.summary,
        recommendedAction,
        source: provider.name,
      };
      return json(investigation, { status: 201 });
    }

    const investigationMatch = pathname.match(/^\/api\/investigations\/([^/]+)$/);
    if (investigationMatch && method === 'GET') {
      const investigation = await fetchInvestigation(env, investigationMatch[1]!);
      if (!investigation) return notFound(`Investigation ${investigationMatch[1]} not found`);
      return json(investigation);
    }

    if (pathname === '/api/audit-events' && method === 'GET') {
      return json(await fetchAuditEvents(env));
    }

    if (pathname === '/api/remediation-plans' && method === 'GET') {
      return json(await fetchRemediationPlans(env));
    }

    const simulateMatch = pathname.match(/^\/api\/remediation-plans\/([^/]+)\/simulate$/);
    if (simulateMatch && method === 'POST') {
      const planId = simulateMatch[1]!;
      const plan = await fetchRemediationPlan(env, planId);
      if (!plan) return notFound(`Remediation plan ${planId} not found`);

      const simulatedAt = new Date().toISOString();
      await simulateRemediationRow(env, planId, simulatedAt, 'workspace.river@gmail.com');

      return json({ ...plan, status: 'simulated', simulatedAt });
    }

    return notFound(`No route for ${method} ${pathname}`);
  },
} satisfies ExportedHandler<Env>;
