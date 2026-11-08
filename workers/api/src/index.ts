import type { ApiError, RemediationPlan, StartInvestigationRequest } from '@credential-reaper/shared';
import { InvestigationFailedError, runInvestigation } from './agent/investigate.js';
import { getAiProvider, type AiProviderEnv } from './providers/index.js';
import { REDUCER_REJECTED_STATUS, SpacetimeError, type SpacetimeEnv } from './spacetime/client.js';
import {
  decideRemediationRow,
  ensureSeeded,
  fetchAuditEvents,
  fetchIdentities,
  fetchIdentityDetail,
  fetchInvestigation,
  fetchInvestigationEvents,
  fetchInvestigations,
  fetchRemediationPlan,
  fetchRemediationPlans,
  fetchRunningInvestigations,
  fetchSecurityEvents,
  investigationExists,
  MAX_EVENT_ROWS,
  simulateRemediationRow,
} from './spacetime/repository.js';
import { openEventStream, parseEventId } from './stream.js';
import { fetchRepoScans, fetchRepositoryEvidence, ingestScan, updateOwnership } from './sync/store.ts';
import { MAX_SCAN_BODY_CHARS, validateScan } from './sync/validate.ts';

export interface Env extends AiProviderEnv, SpacetimeEnv {}

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_BODY_CHARS = 10_000;
const MAX_ACTOR_CHARS = 100;
const DEFAULT_ACTOR = 'operator';
const DEFAULT_SECURITY_EVENT_LIMIT = 100;
/** A 'running' investigation younger than this blocks a new one for the same identity (keeps repeat clicks from burning model calls). Older ones are treated as stale. Keep in sync with the module's startInvestigation. */
const RUNNING_INVESTIGATION_WINDOW_MS = 200_000;

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS, ...init.headers },
  });
}

function apiError(status: number, error: string, message: string): Response {
  return json({ error, message } satisfies ApiError, { status });
}

const notFound = (message: string) => apiError(404, 'not_found', message);
const badRequest = (message: string) => apiError(400, 'bad_request', message);
const conflict = (message: string) => apiError(409, 'conflict', message);
const badGateway = () => apiError(502, 'spacetimedb_unavailable', 'The data store is unavailable.');
const internalError = () => apiError(500, 'internal_error', 'Something went wrong.');

/** Reads an optional JSON object body. Returns a Response on failure so the caller can return it directly. */
async function readJsonObject(request: Request, required: boolean): Promise<Record<string, unknown> | Response> {
  const text = await request.text();
  if (text.length > MAX_BODY_CHARS) return badRequest('Request body is too large.');
  if (text.trim() === '') return required ? badRequest('A JSON body is required.') : {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badRequest('Request body must be valid JSON.');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return badRequest('Request body must be a JSON object.');
  return parsed as Record<string, unknown>;
}

function validName(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length >= 1 && value.trim().length <= MAX_ACTOR_CHARS && !CONTROL_CHARS.test(value);
}

/** Non-negative integer from a query parameter; null when absent, undefined when present but invalid. */
function intParam(url: URL, name: string): number | null | undefined {
  const raw = url.searchParams.get(name);
  if (raw === null) return null;
  return /^\d{1,15}$/.test(raw) ? Number(raw) : undefined;
}

/** Checks that make a new investigation unacceptable right now; null when it may start. */
async function investigationConflict(env: Env, identityId: string, investigationId: string | null): Promise<Response | null> {
  if (investigationId !== null && (await investigationExists(env, investigationId))) {
    return conflict(`Investigation ${investigationId} already exists.`);
  }
  const running = await fetchRunningInvestigations(env, identityId);
  const now = Date.now();
  if (running.some((r) => now - Date.parse(r.startedAt) < RUNNING_INVESTIGATION_WINDOW_MS)) {
    return conflict(`An investigation of ${identityId} is already running. Wait for it to finish.`);
  }
  return null;
}

async function handleInvestigationStart(request: Request, env: Env): Promise<Response> {
  const body = await readJsonObject(request, true);
  if (body instanceof Response) return body;

  const { identityId, requestedBy, investigationId } = body as Partial<Record<keyof StartInvestigationRequest, unknown>>;
  if (typeof identityId !== 'string' || !ID_PATTERN.test(identityId)) return badRequest('identityId must match [A-Za-z0-9._:-]{1,64}.');
  if (!validName(requestedBy)) return badRequest(`requestedBy must be 1-${MAX_ACTOR_CHARS} characters without control characters.`);
  if (investigationId !== undefined && (typeof investigationId !== 'string' || !UUID_V4_PATTERN.test(investigationId))) {
    return badRequest('investigationId must be a UUID v4.');
  }

  const detail = await fetchIdentityDetail(env, identityId);
  if (!detail) return notFound(`Identity ${identityId} not found`);

  const clientId = (investigationId as string | undefined) ?? null;
  const blocked = await investigationConflict(env, identityId, clientId);
  if (blocked) return blocked;

  try {
    const investigation = await runInvestigation(env, getAiProvider(env), {
      identity: detail.identity,
      requestedBy: requestedBy.trim(),
      investigationId: clientId ?? undefined,
    });
    return json(investigation, { status: 201 });
  } catch (e) {
    if (e instanceof InvestigationFailedError) {
      return apiError(502, 'investigation_failed', `${e.message} (investigation ${e.investigationId})`);
    }
    // The start reducer refuses duplicates and concurrent runs atomically; report that as a conflict rather than a crash.
    if (e instanceof SpacetimeError && e.status === REDUCER_REJECTED_STATUS) {
      const raced = await investigationConflict(env, identityId, clientId);
      if (raced) return raced;
    }
    throw e;
  }
}

/** approve / reject / simulate share the same shape: pre-check the status, run the reducer, return the stored plan. */
async function handleRemediationTransition(
  request: Request,
  env: Env,
  planId: string,
  action: 'approve' | 'reject' | 'simulate'
): Promise<Response> {
  const body = await readJsonObject(request, false);
  if (body instanceof Response) return body;
  // The actor is client-supplied and unauthenticated until real auth lands.
  const actor = body.actor === undefined ? DEFAULT_ACTOR : body.actor;
  if (!validName(actor)) return badRequest(`actor must be 1-${MAX_ACTOR_CHARS} characters without control characters.`);

  const required = action === 'simulate' ? 'approved' : 'proposed';
  const mismatch = (plan: RemediationPlan) =>
    conflict(`Remediation plan ${planId} is "${plan.status}"; ${action} requires a "${required}" plan.`);

  const plan = await fetchRemediationPlan(env, planId);
  if (!plan) return notFound(`Remediation plan ${planId} not found`);
  if (plan.status !== required) return mismatch(plan);

  const at = new Date().toISOString();
  try {
    // Dry run / bookkeeping only: none of these reducers calls any IdP or secrets manager.
    if (action === 'simulate') await simulateRemediationRow(env, planId, at, actor.trim());
    else await decideRemediationRow(env, action, planId, at, actor.trim());
  } catch (e) {
    if (e instanceof SpacetimeError && e.status === REDUCER_REJECTED_STATUS) {
      const current = await fetchRemediationPlan(env, planId);
      if (current && current.status !== required) return mismatch(current);
    }
    throw e;
  }

  const updated = await fetchRemediationPlan(env, planId);
  return json(updated ?? { ...plan });
}

async function handleRepositoryScan(request: Request, env: Env): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_SCAN_BODY_CHARS) return apiError(413, 'payload_too_large', `Scan body is larger than ${MAX_SCAN_BODY_CHARS} characters.`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badRequest('Request body must be valid JSON.');
  }
  const result = validateScan(parsed);
  if (!result.ok) return json({ error: 'invalid_scan', message: 'The scan is malformed or unsupported. Nothing was stored.', problems: result.problems }, { status: 400 });
  return json(await ingestScan(env, result.scan, new Date()), { status: 201 });
}

async function handleOwnershipUpdate(request: Request, env: Env, identityId: string): Promise<Response> {
  const body = await readJsonObject(request, true);
  if (body instanceof Response) return body;
  const actor = body.actor === undefined ? DEFAULT_ACTOR : body.actor;
  if (!validName(actor)) return badRequest(`actor must be 1-${MAX_ACTOR_CHARS} characters without control characters.`);

  const identity = (await fetchIdentityDetail(env, identityId))?.identity;
  if (!identity) return notFound(`Identity ${identityId} not found`);
  if (identity.dataSource !== 'repository') return conflict('Only repository-discovered identities have repository-managed ownership.');

  const revert = body.revert === true;
  if (!revert) {
    if (!validName(body.owner)) return badRequest(`owner must be 1-${MAX_ACTOR_CHARS} characters without control characters.`);
    if (body.team !== undefined && (typeof body.team !== 'string' || body.team.length > MAX_ACTOR_CHARS || CONTROL_CHARS.test(body.team))) {
      return badRequest(`team must be a string of at most ${MAX_ACTOR_CHARS} characters without control characters.`);
    }
  }
  const updated = await updateOwnership(
    env,
    identity,
    { owner: revert ? '' : (body.owner as string).trim(), team: revert ? '' : ((body.team as string | undefined) ?? identity.team).trim(), revert, actor: actor.trim() },
    new Date()
  );
  return json({ identity: updated });
}

async function route(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const { pathname } = url;
  const method = request.method;

  try {
    await ensureSeeded(env);
  } catch (e) {
    logError('seed_check_failed', e, method, pathname);
    return badGateway();
  }

  if (pathname === '/api/identities' && method === 'GET') {
    return json(await fetchIdentities(env));
  }

  const identityMatch = pathname.match(/^\/api\/identities\/([^/]+)$/);
  if (identityMatch && method === 'GET') {
    const id = identityMatch[1]!;
    if (!ID_PATTERN.test(id)) return badRequest('Invalid identity id.');
    const detail = await fetchIdentityDetail(env, id);
    if (!detail) return notFound(`Identity ${id} not found`);
    return json({ ...detail, repository: await fetchRepositoryEvidence(env, detail.identity) });
  }

  const ownershipMatch = pathname.match(/^\/api\/identities\/([^/]+)\/ownership$/);
  if (ownershipMatch && method === 'POST') {
    const id = ownershipMatch[1]!;
    if (!ID_PATTERN.test(id)) return badRequest('Invalid identity id.');
    return handleOwnershipUpdate(request, env, id);
  }

  if (pathname === '/api/repository/scans' && method === 'POST') return handleRepositoryScan(request, env);
  if (pathname === '/api/repository/scans' && method === 'GET') return json(await fetchRepoScans(env));

  if (pathname === '/api/investigations' && method === 'GET') {
    return json(await fetchInvestigations(env));
  }

  if (pathname === '/api/investigations' && method === 'POST') {
    return handleInvestigationStart(request, env);
  }

  const eventsMatch = pathname.match(/^\/api\/investigations\/([^/]+)\/events$/);
  if (eventsMatch && method === 'GET') {
    const id = eventsMatch[1]!;
    if (!ID_PATTERN.test(id)) return badRequest('Invalid investigation id.');
    const after = intParam(url, 'after');
    if (after === undefined) return badRequest('after must be a non-negative integer.');
    return json(await fetchInvestigationEvents(env, id, after ?? 0, MAX_EVENT_ROWS));
  }

  const investigationMatch = pathname.match(/^\/api\/investigations\/([^/]+)$/);
  if (investigationMatch && method === 'GET') {
    const id = investigationMatch[1]!;
    if (!ID_PATTERN.test(id)) return badRequest('Invalid investigation id.');
    const investigation = await fetchInvestigation(env, id);
    if (!investigation) return notFound(`Investigation ${id} not found`);
    return json(investigation);
  }

  if (pathname === '/api/audit-events' && method === 'GET') {
    return json(await fetchAuditEvents(env));
  }

  if (pathname === '/api/security-events' && method === 'GET') {
    const limit = intParam(url, 'limit') ?? DEFAULT_SECURITY_EVENT_LIMIT;
    if (limit === undefined || limit < 1 || limit > MAX_EVENT_ROWS) return badRequest(`limit must be an integer from 1 to ${MAX_EVENT_ROWS}.`);
    return json(await fetchSecurityEvents(env, limit));
  }

  if (pathname === '/api/events/stream' && method === 'GET') {
    const investigationId = url.searchParams.get('investigationId');
    if (investigationId !== null && !ID_PATTERN.test(investigationId)) return badRequest('Invalid investigationId.');
    const invAfter = intParam(url, 'invAfter');
    const secAfter = intParam(url, 'secAfter');
    if (invAfter === undefined || secAfter === undefined) return badRequest('invAfter and secAfter must be non-negative integers.');
    // A reconnecting EventSource sends Last-Event-ID, which wins over the query cursors.
    const resume = parseEventId(request.headers.get('Last-Event-ID'));
    return openEventStream(
      env,
      request,
      { investigationId, invAfter: resume ? resume.inv : invAfter, secAfter: resume ? resume.sec : secAfter },
      CORS_HEADERS
    );
  }

  if (pathname === '/api/remediation-plans' && method === 'GET') {
    return json(await fetchRemediationPlans(env));
  }

  const transitionMatch = pathname.match(/^\/api\/remediation-plans\/([^/]+)\/(approve|reject|simulate)$/);
  if (transitionMatch && method === 'POST') {
    const planId = transitionMatch[1]!;
    if (!ID_PATTERN.test(planId)) return badRequest('Invalid remediation plan id.');
    return handleRemediationTransition(request, env, planId, transitionMatch[2] as 'approve' | 'reject' | 'simulate');
  }

  return notFound(`No route for ${method} ${pathname}`);
}

/** Server-side only: error kind and a short message, never request bodies, upstream response text or secrets. */
function logError(event: string, e: unknown, method: string, pathname: string): void {
  const err = e instanceof Error ? e : new Error('non-error thrown');
  console.error(JSON.stringify({ event, method, pathname, name: err.name, message: err.message.slice(0, 200), upstreamStatus: e instanceof SpacetimeError ? e.status : undefined }));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    try {
      return await route(request, env);
    } catch (e) {
      const url = new URL(request.url);
      logError('unhandled_error', e, request.method, url.pathname);
      return e instanceof SpacetimeError ? badGateway() : internalError();
    }
  },
} satisfies ExportedHandler<Env>;
