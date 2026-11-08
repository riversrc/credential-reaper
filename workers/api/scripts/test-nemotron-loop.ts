// Manual integration test for the real Nemotron agent loop WITHOUT an NVIDIA key.
// Only the NVIDIA chat-completions endpoint is faked (scripted OpenAI-style
// tool_calls responses); every tool call still executes against the real
// local SpacetimeDB. Requires `spacetime start` + the published module.
//
//   cd workers/api && QA_TOKEN_FILE=<token-file> SPACETIME_DB_NAME=credential-reaper-qa npx tsx scripts/test-nemotron-loop.ts
import { readFileSync } from 'node:fs';
import { runInvestigation, InvestigationFailedError } from '../src/agent/investigate.js';
import { computeRisk } from '../src/agent/risk.js';
import { createNemotronProvider, LIMITS } from '../src/providers/nemotron.js';
import { ensureSeeded, fetchIdentityDetail, fetchInvestigation, fetchRemediationPlans } from '../src/spacetime/repository.js';

// Point at a throwaway database (e.g. SPACETIME_DB_NAME=credential-reaper-qa) to keep test investigations out of the main one.
const env = { SPACETIME_URL: process.env.SPACETIME_URL ?? 'http://localhost:3000', SPACETIME_DB_NAME: process.env.SPACETIME_DB_NAME ?? 'credential-reaper', SPACETIME_AUTH_TOKEN: process.env.QA_TOKEN_FILE ? readFileSync(process.env.QA_TOKEN_FILE, 'utf8').trim() : undefined };
const FAKE_KEY = 'nvapi-FAKE-KEY-for-test-0123456789';
const IDENTITY = 'id-012';

type Turn = { content?: string | null; toolCalls?: { name: string; args: unknown }[]; status?: number };
let script: Turn[] = [];
let requests: { body: any; auth: string | null }[] = [];

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = typeof input === 'string' ? input : input.url;
  if (!url.startsWith('https://integrate.api.nvidia.com/')) return realFetch(input, init);
  requests.push({ body: JSON.parse(init.body), auth: new Headers(init.headers).get('authorization') });
  const turn = script[Math.min(requests.length - 1, script.length - 1)]!;
  if (turn.status) return new Response(JSON.stringify({ detail: `fake error echoing ${FAKE_KEY}` }), { status: turn.status });
  const tool_calls = turn.toolCalls?.map((tc, i) => ({
    id: `call_${requests.length}_${i}`,
    type: 'function',
    function: { name: tc.name, arguments: typeof tc.args === 'string' ? tc.args : JSON.stringify(tc.args) },
  }));
  return new Response(
    JSON.stringify({ choices: [{ finish_reason: tool_calls ? 'tool_calls' : 'stop', message: { role: 'assistant', content: turn.content ?? null, tool_calls } }] })
  );
}) as typeof fetch;

const logs: string[] = [];
const origLog = console.log;
console.log = (...a: unknown[]) => logs.push(a.join(' '));

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  origLog(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

const provider = createNemotronProvider(FAKE_KEY, 'nvidia/nemotron-3-super-120b-a12b');
const id = { identity_id: IDENTITY };
const retrieval = ['get_identity_details', 'get_ownership', 'get_permissions', 'get_dependencies', 'get_usage_history', 'get_risk_assessment'];

await ensureSeeded(env);
const detail = (await fetchIdentityDetail(env, IDENTITY))!;
const expectedRisk = computeRisk(detail);

// 1. Happy path including hostile / malformed tool calls the Worker must reject.
script = [
  { toolCalls: retrieval.map((name) => ({ name, args: id })) },
  {
    toolCalls: [
      { name: 'get_permissions', args: { identity_id: 'id-001' } }, // other identity
      { name: 'revoke_credential', args: id }, // tool that does not exist
      { name: 'get_usage_history', args: '{not json' }, // malformed arguments
      { name: 'get_usage_history', args: { identity_id: IDENTITY, limit: 5000 } }, // out of range
      { name: 'record_finding', args: { category: 'ownership', severity: 'high', basis: 'confirmed', description: 'Owner left the company last year.', evidence: 'HR system says so', sources: ['get_ownership'] } }, // fabricated evidence
      { name: 'record_finding', args: { category: 'ownership', severity: 'high', basis: 'confirmed', description: 'Owner is an external contractor.', evidence: 'owner = R. Chen (ext. contractor)', sources: ['get_ownership'] } },
      { name: 'record_finding', args: { category: 'dormancy', severity: 'high', basis: 'confirmed', description: 'Key unused since October 2024.', evidence: 'lastActivityAt 2024-10-15T13:20:00Z', sources: ['get_usage_history'] } },
      { name: 'record_finding', args: { category: 'credential-hygiene', severity: 'high', basis: 'inferred', description: 'Key likely still valid in the vendor system.', evidence: 'sk-ext-****3b9c expiresAt 2024-10-01T00:00:00Z', sources: ['get_identity_details'] } },
      { name: 'record_finding', args: { category: 'dependencies', severity: 'low', basis: 'unknown', description: 'Cannot tell whether any pipeline still uses this key.', evidence: 'no dependency records' } },
    ], // 9 calls: the 9th exceeds the per-turn cap and must be dropped
  },
  {
    toolCalls: [
      { name: 'record_finding', args: { category: 'dependencies', severity: 'low', basis: 'unknown', description: 'Cannot tell whether any pipeline still uses this key.', evidence: 'no dependency records' } },
      { name: 'recommend_remediation', args: { action: 'retire', justification: 'Contract ended, key dormant and expired, no owner accountable.' } },
    ],
  },
  { content: '<think>internal reasoning</think>Confirmed: dormant since 2024-10-15. Inferred: key may still be valid. Unknown: dependents.' },
];
requests = [];
logs.length = 0;
const inv = await runInvestigation(env, provider, { identity: { id: IDENTITY, name: detail.identity.name }, requestedBy: 'fake-nemotron-test' });
const stored = (await fetchInvestigation(env, inv.id))!;
const plans = (await fetchRemediationPlans(env)).filter((p) => p.investigationId === inv.id);

check('completed with source nemotron', stored.status === 'completed' && stored.source === 'nemotron');
check('4 model turns', requests.length === 4, String(requests.length));
check('Authorization header carries the key only toward NVIDIA', requests.every((r) => r.auth === `Bearer ${FAKE_KEY}`));
check('tools + tool_choice auto sent in request', requests[0]!.body.tools?.length === 8 && requests[0]!.body.tool_choice === 'auto');
check('tool results fed back as role=tool messages; per-turn cap of 8 enforced', requests[3]!.body.messages.filter((m: any) => m.role === 'tool').length === 6 + 8 + 2);
const statusOf = (tool: string) => stored.toolTrace.filter((t) => t.tool === tool).map((t) => t.status);
check('cross-identity request rejected', stored.toolTrace.some((t) => t.tool === 'get_permissions' && t.status === 'rejected'));
check('unknown tool rejected', statusOf('revoke_credential').join() === 'rejected');
check('malformed args + out-of-range limit rejected', statusOf('get_usage_history').filter((s) => s === 'rejected').length === 2);
check('fabricated evidence rejected', statusOf('record_finding')[0] === 'rejected');
check('4 grounded findings persisted in SpacetimeDB', stored.findings.length === 4, String(stored.findings.length));
check('bases persisted (confirmed x2, inferred, unknown)', stored.findings.map((f) => f.basis).sort().join() === 'confirmed,confirmed,inferred,unknown', stored.findings.map((f) => f.basis).join());
check('risk score is the backend value, not model-provided', stored.riskAssessment?.score === expectedRisk.score && stored.riskAssessment?.level === expectedRisk.level);
check('think tags stripped from summary', !!stored.aiSummary && !stored.aiSummary.includes('<think>') && stored.aiSummary.startsWith('Confirmed'));
check('recommendation stored and plan proposed (not executed)', stored.recommendedAction === 'retire' && plans.length === 1 && plans[0]!.status === 'proposed' && plans[0]!.steps.every((s) => !s.automatable));

// 2. Credentials rejected -> failed investigation, key never surfaces.
script = [{ status: 401 }];
requests = [];
logs.length = 0;
let failedId = '';
let failedMsg = '';
try {
  await runInvestigation(env, provider, { identity: { id: IDENTITY, name: detail.identity.name }, requestedBy: 'fake-nemotron-test' });
} catch (e) {
  failedMsg = (e as Error).message;
  failedId = (e as InvestigationFailedError).investigationId;
}
const failed = (await fetchInvestigation(env, failedId))!;
check('401 -> investigation marked failed in SpacetimeDB', failed?.status === 'failed' && /credentials/i.test(failed.aiSummary ?? ''));
check('401 -> API key not in error or stored summary', !failedMsg.includes(FAKE_KEY) && !(failed.aiSummary ?? '').includes(FAKE_KEY));

// 3. 500 with an echoed key in the body, twice -> redacted.
script = [{ status: 500 }];
requests = [];
try {
  await runInvestigation(env, provider, { identity: { id: IDENTITY, name: detail.identity.name }, requestedBy: 'fake-nemotron-test' });
} catch (e) {
  failedMsg = (e as Error).message;
}
check('5xx retried once then failed; echoed key redacted', requests.length === 2 && failedMsg.includes('[redacted]') && !failedMsg.includes(FAKE_KEY), failedMsg);

// 4. Model that never stops calling tools -> bounded by the turn limit.
script = [{ toolCalls: [{ name: 'get_permissions', args: id }] }];
requests = [];
try {
  await runInvestigation(env, provider, { identity: { id: IDENTITY, name: detail.identity.name }, requestedBy: 'fake-nemotron-test' });
  check('runaway loop is stopped', false, 'did not fail');
} catch (e) {
  check('runaway loop stopped at the turn limit (no findings -> failed)', requests.length === LIMITS.maxTurns && /Stopped early/.test((e as Error).message), `${requests.length} requests: ${(e as Error).message}`);
  check('final turn forces tool_choice none', requests[LIMITS.maxTurns - 1]!.body.tool_choice === 'none');
}

check('logs never contain the API key', !logs.some((l) => l.includes(FAKE_KEY)));
origLog(`\nsample log lines:\n${logs.slice(0, 3).join('\n')}`);
origLog(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
