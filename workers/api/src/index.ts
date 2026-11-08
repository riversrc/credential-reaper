import type { ApiError, RemediationPlan, RemediationPrPreview, StartInvestigationRequest } from '@credential-reaper/shared';
import { InvestigationFailedError, runInvestigation } from './agent/investigate.js';
import { getAiProvider, type AiProviderEnv } from './providers/index.js';
import { REDUCER_REJECTED_STATUS, SpacetimeError, type SpacetimeEnv } from './spacetime/client.js';
import {
  decideRemediationRow,
  ensureSeeded,
  fetchAuditEvents,
  fetchIdentities,
  fetchIdentity,
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
  recordRemediationPrRow,
  simulateRemediationRow,
} from './spacetime/repository.js';
import { openEventStream, parseEventId } from './stream.js';
import { fetchGithubSource, ignoredReason, MAX_WEBHOOK_BODY_CHARS, parsePushEvent, verifyGithubSignature, type GithubEnv, type PushEvent } from './sync/github.ts';
import { branchFor, GithubError, loadRetirement, openPullRequest, prTitle, type LoadedRetirement } from './sync/pr.ts';
import { RetireRefused } from './sync/retire.ts';
import { scanRepository } from './sync/scan.ts';
import { fetchRepoScans, fetchRepositoryEvidence, hasUnfinishedScan, ingestScan, updateOwnership } from './sync/store.ts';
import { MAX_SCAN_BODY_CHARS, validateScan } from './sync/validate.ts';

export interface Env extends AiProviderEnv, SpacetimeEnv, GithubEnv {
  /** Secret. Bearer token required by POST /api/repository/scans; ingest is refused (503) while unset. */
  INGEST_TOKEN?: string;
  /** Comma-separated browser origins allowed to call the API. */
  ALLOWED_ORIGINS?: string;
}

const DEFAULT_ALLOWED_ORIGINS = 'http://localhost:5173,http://localhost:5174';
const OPERATOR_ACTOR = 'web-operator';
const MAX_SCAN_IDENTITIES = 500;
const SCAN_BODY_LIMIT_MESSAGE = `Scan body is larger than ${MAX_SCAN_BODY_CHARS} characters.`;

const ID_PATTERN = /^[A-Za-z0-9._:-]{1,64}$/;
const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;
const MAX_BODY_CHARS = 10_000;
const MAX_ACTOR_CHARS = 100;
const DEFAULT_SECURITY_EVENT_LIMIT = 100;
/** A 'running' investigation younger than this blocks a new one for the same identity (keeps repeat clicks from burning model calls). Older ones are treated as stale. Keep in sync with the module's startInvestigation. */
const RUNNING_INVESTIGATION_WINDOW_MS = 200_000;

function json(data: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(data), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
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
const unsupportedMediaType = () => apiError(415, 'unsupported_media_type', 'Content-Type must be application/json.');

function allowedOrigins(env: Env): string[] {
  return (env.ALLOWED_ORIGINS ?? DEFAULT_ALLOWED_ORIGINS).split(',').map((o) => o.trim()).filter(Boolean);
}

const isJson = (request: Request) => request.headers.get('Content-Type')?.split(';')[0]?.trim().toLowerCase() === 'application/json';

/** Constant-time string comparison: both sides are hashed first so neither the content nor the length leaks through timing. */
async function safeEqual(a: string, b: string): Promise<boolean> {
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  let diff = 0;
  for (let i = 0; i < x.length; i++) diff |= x[i]! ^ y[i]!;
  return diff === 0;
}

/** Fails closed: with no INGEST_TOKEN configured nothing can be ingested. */
async function ingestAuthFailure(request: Request, env: Env): Promise<Response | null> {
  if (!env.INGEST_TOKEN) return apiError(503, 'ingest_unavailable', 'Repository ingest is not available.');
  const match = request.headers.get('Authorization')?.match(/^Bearer (.+)$/);
  if (!match || !(await safeEqual(match[1]!, env.INGEST_TOKEN))) return apiError(401, 'unauthorized', 'Authentication required.');
  return null;
}

/** Reads an optional JSON object body. Returns a Response on failure so the caller can return it directly. */
async function readJsonObject(request: Request, required: boolean): Promise<Record<string, unknown> | Response> {
  if (!isJson(request)) return unsupportedMediaType();
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
  // Any actor in the body is ignored: it is client-supplied and unauthenticated until real auth lands.
  const actor = OPERATOR_ACTOR;

  const required = action === 'simulate' ? 'approved' : 'proposed';
  const mismatch = (plan: RemediationPlan) =>
    conflict(`Remediation plan ${planId} is "${plan.status}"; ${action} requires a "${required}" plan.`);

  const plan = await fetchRemediationPlan(env, planId);
  if (!plan) return notFound(`Remediation plan ${planId} not found`);
  if (plan.status !== required) return mismatch(plan);

  const at = new Date().toISOString();
  try {
    // Dry run / bookkeeping only: none of these reducers calls any IdP or secrets manager.
    if (action === 'simulate') await simulateRemediationRow(env, planId, at, actor);
    else await decideRemediationRow(env, action, planId, at, actor);
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

/**
 * Builds the verified change for a plan, or answers why none can be made. Only an approved or simulated `retire` of a
 * declared-only identity that the configured repository still declares qualifies.
 */
async function loadPlanRetirement(env: Env, planId: string): Promise<{ plan: RemediationPlan; loaded: LoadedRetirement } | Response> {
  const plan = await fetchRemediationPlan(env, planId);
  if (!plan) return notFound(`Remediation plan ${planId} not found`);
  if (plan.action !== 'retire') return conflict('Only retire plans can be turned into a pull request.');
  if (plan.status !== 'approved' && plan.status !== 'simulated') return conflict(`Remediation plan ${planId} is "${plan.status}"; a pull request needs an approved plan.`);
  if (plan.prUrl) return conflict(`A pull request is already open for plan ${planId}.`);
  const identity = await fetchIdentity(env, plan.identityId);
  if (!identity || identity.dataSource !== 'repository' || identity.repoState !== 'present') {
    return conflict(`${plan.identityName} is not an identity declared in the synced repository.`);
  }
  const repo = env.GITHUB_SYNC_REPO;
  const baseBranch = env.GITHUB_SYNC_BRANCH;
  if (!repo || !baseBranch) return apiError(503, 'pull_requests_unavailable', 'Pull requests are not configured (GITHUB_SYNC_REPO and GITHUB_SYNC_BRANCH).');
  try {
    return { plan, loaded: await loadRetirement(env, { repo, baseBranch }, identity.name) };
  } catch (e) {
    if (e instanceof RetireRefused) return conflict(e.message);
    if (e instanceof GithubError) {
      console.error(JSON.stringify({ event: 'remediation_pr_github_failed', status: e.status, message: e.message }));
      return apiError(502, 'github_unavailable', 'GitHub could not be read. Check the repository and token configuration.');
    }
    throw e;
  }
}

async function handlePrPreview(request: Request, env: Env, planId: string): Promise<Response> {
  const body = await readJsonObject(request, false);
  if (body instanceof Response) return body;
  const result = await loadPlanRetirement(env, planId);
  if (result instanceof Response) return result;
  const { plan, loaded } = result;
  const { retirement } = loaded;
  return json({
    planId,
    repo: loaded.repo,
    baseBranch: loaded.baseBranch,
    baseSha: loaded.baseSha,
    branch: branchFor(plan, retirement.identity.name),
    title: prTitle(retirement),
    files: retirement.files.map((f) => ({ path: f.path, change: f.change, removedLines: f.removedLines })),
    verification: retirement.verification,
    leftUntouched: retirement.leftUntouched,
  } satisfies RemediationPrPreview);
}

async function handleOpenPr(request: Request, env: Env, planId: string): Promise<Response> {
  const body = await readJsonObject(request, false);
  if (body instanceof Response) return body;
  if (!env.GITHUB_PR_TOKEN) return apiError(503, 'pull_requests_unavailable', 'Opening pull requests is not enabled: GITHUB_PR_TOKEN is not set.');
  const result = await loadPlanRetirement(env, planId);
  if (result instanceof Response) return result;
  let opened;
  try {
    opened = await openPullRequest(env, result.loaded, result.plan);
  } catch (e) {
    if (e instanceof GithubError) {
      console.error(JSON.stringify({ event: 'remediation_pr_github_failed', status: e.status, message: e.message }));
      const exists = e.status === 422 ? ' A branch for this plan may already exist.' : '';
      return apiError(502, 'github_rejected', `GitHub did not accept the pull request.${exists}`);
    }
    throw e;
  }
  const at = new Date().toISOString();
  try {
    await recordRemediationPrRow(env, { planId, prUrl: opened.url, prBranch: opened.branch, openedAt: at, actor: OPERATOR_ACTOR });
  } catch (e) {
    console.error(JSON.stringify({ event: 'remediation_pr_record_failed', planId, prUrl: opened.url }));
    throw e;
  }
  return json((await fetchRemediationPlan(env, planId)) ?? { ...result.plan, prUrl: opened.url, prBranch: opened.branch, prOpenedAt: at }, { status: 201 });
}

async function handleRepositoryScan(request: Request, env: Env): Promise<Response> {
  const denied = await ingestAuthFailure(request, env);
  if (denied) return denied;
  if (!isJson(request)) return unsupportedMediaType();
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > MAX_SCAN_BODY_CHARS) return apiError(413, 'payload_too_large', SCAN_BODY_LIMIT_MESSAGE);
  const text = await request.text();
  if (text.length > MAX_SCAN_BODY_CHARS) return apiError(413, 'payload_too_large', SCAN_BODY_LIMIT_MESSAGE);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return badRequest('Request body must be valid JSON.');
  }
  const result = validateScan(parsed);
  if (!result.ok) return json({ error: 'invalid_scan', message: 'The scan is malformed or unsupported. Nothing was stored.', problems: result.problems }, { status: 400 });
  if (result.scan.machineIdentities.length > MAX_SCAN_IDENTITIES) {
    return apiError(413, 'payload_too_large', `A scan may declare at most ${MAX_SCAN_IDENTITIES} identities.`);
  }
  const now = new Date();
  if (await hasUnfinishedScan(env, result.scan.repo, now)) return conflict('Another scan of this repository is still running. Try again shortly.');
  try {
    return json(await ingestScan(env, result.scan, now), { status: 201 });
  } catch (e) {
    if (e instanceof SpacetimeError && e.status === REDUCER_REJECTED_STATUS && (await hasUnfinishedScan(env, result.scan.repo, now))) {
      return conflict('Another scan of this repository is still running. Try again shortly.');
    }
    throw e;
  }
}

async function handleOwnershipUpdate(request: Request, env: Env, identityId: string): Promise<Response> {
  const body = await readJsonObject(request, true);
  if (body instanceof Response) return body;

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
    { owner: revert ? '' : (body.owner as string).trim(), team: revert ? '' : ((body.team as string | undefined) ?? identity.team).trim(), revert, actor: OPERATOR_ACTOR },
    new Date()
  );
  return json({ identity: updated });
}

/** Scans the pushed commit and ingests it. Runs after the webhook has answered; failures are logged, never thrown. */
async function syncPush(env: Env, push: PushEvent): Promise<void> {
  try {
    const source = await fetchGithubSource(env, push.repo, push.sha);
    const scan = scanRepository(source, { repo: push.repo, commitSha: push.sha });
    if (source.incomplete) scan.status = 'partial';
    const result = validateScan(scan);
    if (!result.ok) throw new Error('the scan of the pushed commit failed validation');
    if (result.scan.machineIdentities.length > MAX_SCAN_IDENTITIES) throw new Error('the scan declares too many identities');
    const now = new Date();
    if (await hasUnfinishedScan(env, push.repo, now)) throw new Error('another scan of this repository is still running');
    await ingestScan(env, result.scan, now, { trigger: `push ${push.sha.slice(0, 7)}${push.pusher ? ` by ${push.pusher}` : ''}` });
  } catch (e) {
    logError('github_sync_failed', e, 'POST', '/api/webhooks/github');
  }
}

/** GitHub push webhook. Authenticated only by the HMAC signature; answers fast and scans in the background. */
async function handleGithubWebhook(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
  if (!env.GITHUB_WEBHOOK_SECRET) return apiError(503, 'webhook_unavailable', 'The GitHub webhook is not available.');
  if (!isJson(request)) return unsupportedMediaType();
  if (Number(request.headers.get('Content-Length')) > MAX_WEBHOOK_BODY_CHARS) return apiError(413, 'payload_too_large', 'Webhook body is too large.');
  const body = await request.text();
  if (body.length > MAX_WEBHOOK_BODY_CHARS) return apiError(413, 'payload_too_large', 'Webhook body is too large.');
  if (!(await verifyGithubSignature(env.GITHUB_WEBHOOK_SECRET, body, request.headers.get('X-Hub-Signature-256')))) {
    return apiError(401, 'unauthorized', 'Authentication required.');
  }

  const event = request.headers.get('X-GitHub-Event');
  if (event === 'ping') return json({ ok: true, event: 'ping' });
  if (event !== 'push') return json({ ok: true, ignored: `event ${event ?? 'unknown'} is not handled` }, { status: 202 });

  let payload: unknown;
  try {
    payload = JSON.parse(body);
  } catch {
    return badRequest('Request body must be valid JSON.');
  }
  const push = parsePushEvent(payload);
  if (!push) return json({ ok: true, ignored: 'not a branch push with a usable commit' }, { status: 202 });
  const reason = ignoredReason(env, push);
  if (reason) return json({ ok: true, ignored: reason }, { status: 202 });

  ctx.waitUntil(syncPush(env, push));
  return json({ ok: true, accepted: { repo: push.repo, commit: push.sha } }, { status: 202 });
}

async function route(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
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

  if (pathname === '/api/webhooks/github' && method === 'POST') return handleGithubWebhook(request, env, ctx);
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
      {}
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

  const prMatch = pathname.match(/^\/api\/remediation-plans\/([^/]+)\/(pr-preview|open-pr)$/);
  if (prMatch && method === 'POST') {
    const planId = prMatch[1]!;
    if (!ID_PATTERN.test(planId)) return badRequest('Invalid remediation plan id.');
    return prMatch[2] === 'pr-preview' ? handlePrPreview(request, env, planId) : handleOpenPr(request, env, planId);
  }

  return notFound(`No route for ${method} ${pathname}`);
}

/** Server-side only: error kind and a short message, never request bodies, upstream response text or secrets. */
function logError(event: string, e: unknown, method: string, pathname: string): void {
  const err = e instanceof Error ? e : new Error('non-error thrown');
  console.error(JSON.stringify({ event, method, pathname, name: err.name, message: err.message.slice(0, 200), upstreamStatus: e instanceof SpacetimeError ? e.status : undefined }));
}

/** Echoes the caller's origin only when it is allowlisted; other origins get no CORS headers at all. */
function withCors(response: Response, origin: string | null, allowed: boolean): Response {
  const out = new Response(response.body, response);
  out.headers.append('Vary', 'Origin');
  if (origin && allowed) {
    out.headers.set('Access-Control-Allow-Origin', origin);
    out.headers.set('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    out.headers.set('Access-Control-Allow-Headers', 'Content-Type');
  }
  return out;
}

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const origin = request.headers.get('Origin');
    const allowed = origin !== null && allowedOrigins(env).includes(origin);

    if (request.method === 'OPTIONS') {
      return withCors(new Response(null, { status: origin === null || allowed ? 204 : 403 }), origin, allowed);
    }
    // Requests without an Origin (curl, scripts) pass; a browser always sends one on cross-site POSTs.
    if (request.method === 'POST' && origin !== null && !allowed) {
      return withCors(apiError(403, 'forbidden_origin', 'This origin is not allowed.'), origin, false);
    }

    try {
      return withCors(await route(request, env, ctx), origin, allowed);
    } catch (e) {
      const url = new URL(request.url);
      logError('unhandled_error', e, request.method, url.pathname);
      return withCors(e instanceof SpacetimeError ? badGateway() : internalError(), origin, allowed);
    }
  },
} satisfies ExportedHandler<Env>;
