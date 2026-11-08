// Access-control check for a published Credential Reaper module.
//
//   anon  mode: no credentials. Every table is unreadable, every view is empty, every reducer is rejected.
//   token mode: a registered service token. Views return data, but tables, raw SQL writes and logs stay denied.
//
//   npx tsx spacetime/scripts/verify-access.ts <anon|token> <database> [token-file]
//
// SPACETIME_URL defaults to http://localhost:3000. In anon mode a FAILING run means a reducer
// accepted an anonymous call and wrote a (clearly marked) row, so this refuses to target the
// real `credential-reaper` database unless ALLOW_MAIN_DB=1.
import { readFileSync } from 'node:fs';

const [mode, db, tokenFile] = process.argv.slice(2);
const base = process.env.SPACETIME_URL ?? 'http://localhost:3000';
if ((mode !== 'anon' && mode !== 'token') || !db || (mode === 'token' && !tokenFile)) {
  console.error('usage: verify-access.ts <anon|token> <database> [token-file]');
  process.exit(2);
}
if (db === 'credential-reaper' && process.env.ALLOW_MAIN_DB !== '1') {
  console.error('refusing to probe the main database (set ALLOW_MAIN_DB=1 to override)');
  process.exit(2);
}
const auth: Record<string, string> = mode === 'token' ? { Authorization: `Bearer ${readFileSync(tokenFile!, 'utf8').trim()}` } : {};

const TABLES = ['machine_identity', 'permission_grant', 'identity_dependency', 'credential_metadata', 'usage_event', 'investigation', 'remediation_plan', 'audit_event', 'investigation_event', 'security_event', 'authorized_caller'];
const VIEWS = TABLES.filter((t) => t !== 'authorized_caller').map((t) => `v_${t}`);

const MARK = 'verify-access-probe';
const s = MARK;
const step = { id: s, order: 1, description: s, automatable: false };
const trace = [{ seq: 1, tool: s, status: 'ok', summary: s, duration_ms: 1 }];
const REDUCER_ARGS: Record<string, unknown> = {
  seed_identity: { id: s, name: s, type: 'api-key', owner: s, team: s, environment: 'dev', status: 'active', riskLevel: 'low', riskScore: 0, createdAt: s, lastUsedAt: { none: {} }, tags: [], description: s },
  seed_permission: { id: s, identityId: s, resource: s, scope: s, grantedAt: s, grantedBy: s },
  seed_dependency: { id: s, identityId: s, name: s, kind: s, relationship: s },
  seed_credential: { id: s, identityId: s, kind: s, storageLocation: s, maskedPreview: s, createdAt: s, lastRotatedAt: { none: {} }, expiresAt: { none: {} } },
  seed_usage_event: { id: s, identityId: s, timestamp: s, action: s, source: s, result: s },
  start_investigation: { id: s, identityId: s, identityName: s, requestedBy: s, startedAt: s, source: s },
  record_finding: { investigationId: s, id: s, category: s, severity: 'low', basis: 'unknown', description: s, evidence: s, recordedAt: s },
  complete_investigation: { investigationId: s, completedAt: s, aiSummary: s, recommendedAction: s, riskScore: 0, riskLevel: 'low', riskFactors: [], toolTrace: trace, actor: s },
  fail_investigation: { investigationId: s, completedAt: s, reason: s, toolTrace: trace, actor: s },
  propose_remediation: { id: s, identityId: s, identityName: s, investigationId: { none: {} }, action: 'monitor', justification: s, steps: [step], createdAt: s, actor: s },
  approve_remediation: { planId: s, decidedAt: s, actor: s },
  reject_remediation: { planId: s, decidedAt: s, actor: s },
  simulate_remediation: { planId: s, simulatedAt: s, actor: s },
  record_investigation_event: { investigationId: s, timestamp: s, eventType: s, stage: s, toolName: { none: {} }, status: s, message: s, details: s },
};

let failures = 0;
const check = (ok: boolean, label: string, detail = '') => {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  (${detail})` : ''}`);
};

async function sql(query: string): Promise<{ status: number; rows: number }> {
  const r = await fetch(`${base}/v1/database/${db}/sql`, { method: 'POST', headers: { 'Content-Type': 'text/plain', ...auth }, body: query });
  let rows = 0;
  if (r.ok) rows = ((await r.json()) as { rows: unknown[] }[])[0]?.rows.length ?? 0;
  else await r.text();
  return { status: r.status, rows };
}

async function reducer(name: string, body: unknown): Promise<number> {
  const r = await fetch(`${base}/v1/database/${db}/call/${name}`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...auth }, body: JSON.stringify(body) });
  await r.text();
  return r.status;
}

for (const t of TABLES) {
  const r = await sql(`SELECT * FROM ${t}`);
  check(r.status >= 400, `table ${t} is not readable`, `HTTP ${r.status}`);
}

for (const v of VIEWS) {
  const r = await sql(`SELECT * FROM ${v}`);
  if (mode === 'anon') check(r.status === 200 && r.rows === 0, `view ${v} returns no rows`, `HTTP ${r.status}, ${r.rows} rows`);
  else if (['v_machine_identity', 'v_permission_grant', 'v_credential_metadata', 'v_usage_event'].includes(v)) check(r.status === 200 && r.rows > 0, `view ${v} returns data`, `HTTP ${r.status}, ${r.rows} rows`);
  else check(r.status === 200, `view ${v} is queryable`, `HTTP ${r.status}, ${r.rows} rows`);
}

for (const stmt of [
  `INSERT INTO authorized_caller (identity, label, added_at) VALUES (0x${'0'.repeat(63)}1, '${MARK}', '${MARK}')`,
  `DELETE FROM machine_identity WHERE id = '${MARK}'`,
  `UPDATE machine_identity SET status = 'retired' WHERE id = '${MARK}'`,
]) {
  const r = await sql(stmt);
  check(r.status >= 400, `raw SQL DML rejected: ${stmt.split(' ').slice(0, 3).join(' ')}`, `HTTP ${r.status}`);
}

const logs = await fetch(`${base}/v1/database/${db}/logs`, { headers: auth });
await logs.text();
check(logs.status >= 400, 'module logs are not readable', `HTTP ${logs.status}`);

if (mode === 'anon') {
  for (const [name, body] of Object.entries(REDUCER_ARGS)) {
    const status = await reducer(name, body);
    check(status === 530, `reducer ${name} rejects the caller`, `HTTP ${status}`);
  }
}

console.log(failures === 0 ? `\nALL CHECKS PASSED (${mode})` : `\n${failures} CHECK(S) FAILED (${mode})`);
process.exit(failures === 0 ? 0 : 1);
