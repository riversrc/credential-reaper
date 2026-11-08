import type { ApiError, StartInvestigationRequest } from '@credential-reaper/shared';
import { InvestigationFailedError, runInvestigation } from './agent/investigate.js';
import { getAiProvider, type AiProviderEnv } from './providers/index.js';
import type { SpacetimeEnv } from './spacetime/client.js';
import {
  ensureSeeded,
  fetchAuditEvents,
  fetchIdentities,
  fetchIdentityDetail,
  fetchInvestigation,
  fetchInvestigations,
  fetchRemediationPlan,
  fetchRemediationPlans,
  simulateRemediationRow,
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

      try {
        const investigation = await runInvestigation(env, getAiProvider(env), { identity, requestedBy: body.requestedBy });
        return json(investigation, { status: 201 });
      } catch (e) {
        if (e instanceof InvestigationFailedError) {
          return json({ error: 'investigation_failed', message: `${e.message} (investigation ${e.investigationId})` } satisfies ApiError, { status: 502 });
        }
        throw e;
      }
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
