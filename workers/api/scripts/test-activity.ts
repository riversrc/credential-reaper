// Integration test for activity events, security events, validation, approval flow and SSE.
// Runs against the KEY-LESS QA Worker (scripts/qa-worker.sh start -> http://localhost:8788) and the
// credential-reaper-qa database. Refuses any other target. Never starts an investigation anywhere
// but the QA Worker, and aborts unless that Worker reports source "mock".
//
//   workers/api/scripts/qa-worker.sh start && cd workers/api && npx tsx scripts/test-activity.ts
import type { AuditEvent, Investigation, InvestigationEvent, RemediationPlan, SecurityEvent } from '@credential-reaper/shared';

const BASE = process.env.QA_BASE ?? 'http://localhost:8788';
if (!BASE.includes(':8788')) {
  console.error('refusing to run against anything but the QA Worker on :8788');
  process.exit(2);
}

let failures = 0;
function check(name: string, ok: boolean, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `  -> ${detail}`}`);
}

async function api(method: string, path: string, body?: unknown, raw?: string): Promise<{ status: number; data: any; text: string }> {
  const res = await fetch(BASE + path, { method, headers: { 'Content-Type': 'application/json' }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
  const text = await res.text();
  let data: any = null;
  try {
    data = JSON.parse(text);
  } catch {
    // non-JSON body
  }
  return { status: res.status, data, text };
}

interface SseMessage { id: string | null; event: string; data: string }
function openStream(path: string, headers: Record<string, string> = {}) {
  const ac = new AbortController();
  const messages: SseMessage[] = [];
  const times: number[] = [];
  const t0 = Date.now();
  let comments = 0;
  const done = (async () => {
    const res = await fetch(BASE + path, { headers, signal: ac.signal });
    const ctype = res.headers.get('content-type') ?? '';
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let buf = '';
    for (;;) {
      const { value, done: d } = await reader.read();
      if (d) break;
      buf += dec.decode(value, { stream: true });
      let i: number;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        let id: string | null = null, event = 'message', data = '';
        for (const line of block.split('\n')) {
          if (line.startsWith(':')) comments++;
          else if (line.startsWith('id: ')) id = line.slice(4);
          else if (line.startsWith('event: ')) event = line.slice(7);
          else if (line.startsWith('data: ')) data += line.slice(6);
        }
        if (data !== '') { messages.push({ id, event, data }); times.push(Date.now()); }
        else if (id !== null) { messages.push({ id, event: '(id-only)', data: '' }); times.push(Date.now()); }
      }
    }
    return { ctype, endedAfterMs: Date.now() - t0, comments };
  })().catch((e) => ({ ctype: 'aborted', endedAfterMs: Date.now() - t0, comments, err: (e as Error).name }));
  return { messages, times, done, abort: () => ac.abort() };
}
const lastId = (m: SseMessage[]) => [...m].reverse().find((x) => x.id)?.id ?? null;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---- long-lived unfiltered stream (live tail from "now"), must end cleanly by itself
const stream1 = openStream('/api/events/stream');
await sleep(500);

// ---- 1. mock investigation with a client-supplied id, watched live by a filtered stream
const invId = crypto.randomUUID();
const watch = openStream(`/api/events/stream?investigationId=${invId}`);
await sleep(300);
const postStart = Date.now();
const post = await api('POST', '/api/investigations', { identityId: 'id-012', requestedBy: 'qa-tester', investigationId: invId });
const postMs = Date.now() - postStart;
check('POST /api/investigations 201 with client investigationId', post.status === 201 && post.data?.id === invId, `${post.status} ${post.text.slice(0, 200)}`);
if (post.data?.source !== 'mock') {
  console.error(`ABORT: Worker reported source=${post.data?.source}, not "mock". Not trusting this target.`);
  process.exit(3);
}
check('MOCK MODE PROVEN: investigation source is "mock"', true);
const inv = post.data as Investigation;
await sleep(2500);
watch.abort();

const evRes = await api('GET', `/api/investigations/${invId}/events?after=0`);
const events: InvestigationEvent[] = evRes.data;
check('GET events 200 and non-empty', evRes.status === 200 && events.length > 0, String(evRes.status));
check('seq strictly increasing', events.every((e, i) => i === 0 || e.seq > events[i - 1]!.seq));
check('first event is investigation-started in stage waiting', events[0]?.eventType === 'investigation-started' && events[0]?.stage === 'waiting');
const stageChanges = events.filter((e) => e.eventType === 'stage-changed').map((e) => e.stage);
check('stage changes are exactly gathering, analyzing, completing in order', stageChanges.join() === 'gathering,analyzing,completing', stageChanges.join());
const idxOf = (pred: (e: InvestigationEvent) => boolean) => events.findIndex(pred);
check('gathering emitted right before the first tool-started', events[idxOf((e) => e.eventType === 'tool-started') - 1]?.stage === 'gathering');
const firstFindingStart = idxOf((e) => e.eventType === 'tool-started' && e.toolName === 'record_finding');
check('analyzing emitted right before the first record_finding starts', events[firstFindingStart - 1]?.eventType === 'stage-changed' && events[firstFindingStart - 1]?.stage === 'analyzing');
check('completing precedes investigation-completed; completed is last', events.at(-1)?.eventType === 'investigation-completed' && events.at(-2)?.stage === 'completing');

const started = events.filter((e) => e.eventType === 'tool-started');
const completed = events.filter((e) => e.eventType === 'tool-completed');
check('tool-started/tool-completed counts equal toolTrace length', started.length === inv.toolTrace.length && completed.length === inv.toolTrace.length, `${started.length}/${completed.length}/${inv.toolTrace.length}`);
const pairOk = inv.toolTrace.every((t, i) => {
  const c = completed[i]!;
  const ms = Number(/(\d+) ms/.exec(c.details)?.[1]);
  const seq = Number(/Tool call (\d+)/.exec(c.details)?.[1]);
  const status = t.status === 'ok' ? 'completed' : t.status === 'rejected' ? 'rejected' : 'failed';
  return started[i]!.toolName === t.tool && c.toolName === t.tool && c.status === status && ms === t.durationMs && seq === t.seq && events.indexOf(started[i]!) < events.indexOf(c);
});
check('each pair matches the final toolTrace exactly (tool, status, durationMs, seq)', pairOk);
check('finding-recorded count equals findings', events.filter((e) => e.eventType === 'finding-recorded').length === inv.findings.length);
const blob = JSON.stringify(events);
check('no event contains tool argument keys or finding text/evidence', !blob.includes('identity_id') && inv.findings.every((f) => !blob.includes(f.description) && !blob.includes(f.evidence.slice(0, 20))));
check('mock run has no tool-call limit text (limit only reported for the real provider)', !blob.includes('at most'));

const watched = watch.messages.filter((m) => m.event === 'investigation-event').map((m) => JSON.parse(m.data) as InvestigationEvent);
check('filtered SSE delivered every event once, in order, no gaps', watched.map((e) => e.seq).join() === events.map((e) => e.seq).join(), `${watched.length} vs ${events.length}`);
// The mock run (~0.7s) is shorter than one 1s poll, so prove liveness by delivery lag, not by "before the POST returned".
const lags = watch.messages.flatMap((m, i) => (m.event === 'investigation-event' ? [watch.times[i]! - Date.parse((JSON.parse(m.data) as InvestigationEvent).timestamp)] : []));
check('filtered SSE delivered each event within ~1.5s of its timestamp (live, not replayed later)', watched.length > 0 && lags.every((l) => l >= -50 && l < 1500), `lags=${lags.join(',')} postMs=${postMs}`);
check('filtered SSE carried no security events', watch.messages.every((m) => m.event !== 'security-event'));

// resume mid-run
const mid = events[Math.floor(events.length / 2)]!;
const resume = openStream(`/api/events/stream?investigationId=${invId}`, { 'Last-Event-ID': `${mid.seq}.0` });
await sleep(1800);
resume.abort();
const resumed = resume.messages.filter((m) => m.event === 'investigation-event').map((m) => (JSON.parse(m.data) as InvestigationEvent).seq);
const expected = events.filter((e) => e.seq > mid.seq).map((e) => e.seq);
check('Last-Event-ID resume: exactly the events after the cursor (no dupes, no gaps)', resumed.join() === expected.join(), `${resumed.join()} vs ${expected.join()}`);
const resumeQ = openStream(`/api/events/stream?investigationId=${invId}&invAfter=${mid.seq}`);
await sleep(1500);
resumeQ.abort();
check('?invAfter= resume behaves the same', resumeQ.messages.filter((m) => m.event === 'investigation-event').length === expected.length);
const polled = await api('GET', `/api/investigations/${invId}/events?after=${mid.seq}`);
check('GET events?after= returns the tail only', (polled.data as InvestigationEvent[]).map((e) => e.seq).join() === expected.join());

// security events for this run
const sec = ((await api('GET', '/api/security-events?limit=500')).data as SecurityEvent[]).filter((e) => e.investigationId === invId);
const findingEvents = sec.filter((e) => e.type === 'finding-discovered');
check('one finding-discovered security event per finding with FULL description and evidence', findingEvents.length === inv.findings.length && inv.findings.every((f) => findingEvents.some((e) => e.id === `${invId}-finding-${f.id}` && e.details.includes(f.description) && e.details.includes(f.evidence) && e.kind === 'ai-finding' && e.severity === f.severity && e.source === 'mock' && e.summary.length <= 140)));
const done = sec.find((e) => e.type === 'investigation-completed');
check('investigation-completed security event carries score, level, factors, action', !!done && done.details.includes(String(inv.riskAssessment!.score)) && done.details.includes(inv.riskAssessment!.level) && done.details.includes(inv.recommendedAction!) && done.severity === inv.riskAssessment!.level && inv.riskAssessment!.factors.every((f) => done.details.includes(f)));
check('investigation-started and remediation-proposed security events exist', sec.some((e) => e.type === 'investigation-started' && e.kind === 'user-action') && sec.some((e) => e.type === 'remediation-proposed' && e.kind === 'ai-finding'));
check('security-events newest first', ((await api('GET', '/api/security-events?limit=50')).data as SecurityEvent[]).every((e, i, a) => i === 0 || e.seq < a[i - 1]!.seq));

// ---- 2. validation
const v = async (name: string, status: number, r: { status: number; text: string }) => check(name, r.status === status, `${r.status} ${r.text.slice(0, 160)}`);
await v('malformed JSON -> 400', 400, await api('POST', '/api/investigations', undefined, '{not json'));
await v('missing identityId -> 400', 400, await api('POST', '/api/investigations', { requestedBy: 'qa' }));
await v('identityId with illegal chars -> 400', 400, await api('POST', '/api/investigations', { identityId: "id-1'; DROP", requestedBy: 'qa' }));
await v('requestedBy empty -> 400', 400, await api('POST', '/api/investigations', { identityId: 'id-012', requestedBy: '  ' }));
await v('requestedBy too long -> 400', 400, await api('POST', '/api/investigations', { identityId: 'id-012', requestedBy: 'x'.repeat(101) }));
await v('bad investigationId (not a uuid) -> 400', 400, await api('POST', '/api/investigations', { identityId: 'id-012', requestedBy: 'qa', investigationId: 'abc' }));
await v('non-object JSON body -> 400', 400, await api('POST', '/api/investigations', undefined, '[1]'));
await v('unknown identity -> 404', 404, await api('POST', '/api/investigations', { identityId: 'id-does-not-exist', requestedBy: 'qa' }));
const dup = await api('POST', '/api/investigations', { identityId: 'id-012', requestedBy: 'qa', investigationId: invId });
await v('duplicate investigationId -> 409', 409, dup);
await v('invalid id in URL -> 400', 400, await api('GET', '/api/identities/a%27b'));
await v('events?after=abc -> 400', 400, await api('GET', `/api/investigations/${invId}/events?after=abc`));
await v('security-events?limit=0 -> 400', 400, await api('GET', '/api/security-events?limit=0'));
await v('security-events?limit=501 -> 400', 400, await api('GET', '/api/security-events?limit=501'));
check('security-events?limit=2 honored', ((await api('GET', '/api/security-events?limit=2')).data as unknown[]).length === 2);
await v('stream with bad investigationId -> 400', 400, await api('GET', '/api/events/stream?investigationId=a%27b'));

// concurrent runs on the same identity: exactly one wins
const [c1, c2] = await Promise.all([
  api('POST', '/api/investigations', { identityId: 'id-012', requestedBy: 'qa-a' }),
  api('POST', '/api/investigations', { identityId: 'id-012', requestedBy: 'qa-b' }),
]);
const codes = [c1.status, c2.status].sort();
check('concurrent runs on one identity: one 201, one 409', codes.join() === '201,409', codes.join());
const winner = (c1.status === 201 ? c1 : c2).data as Investigation;

// ---- 3. approval flow
const plans = (await api('GET', '/api/remediation-plans')).data as RemediationPlan[];
const planA = plans.find((p) => p.investigationId === invId);
const planB = plans.find((p) => p.investigationId === winner.id);
check('both mock runs proposed a plan (status proposed)', planA?.status === 'proposed' && planB?.status === 'proposed');
if (planA && planB) {
  const A = planA.id, B = planB.id;
  await v('simulate on proposed plan -> 409', 409, await api('POST', `/api/remediation-plans/${A}/simulate`, {}));
  await v('bad actor -> 400', 400, await api('POST', `/api/remediation-plans/${A}/approve`, { actor: 'x'.repeat(101) }));
  await v('unknown plan -> 404', 404, await api('POST', '/api/remediation-plans/nope/approve', {}));
  const ap = await api('POST', `/api/remediation-plans/${A}/approve`, { actor: 'qa-approver' });
  check('approve -> 200 approved with decidedBy/decidedAt', ap.status === 200 && ap.data.status === 'approved' && ap.data.decidedBy === 'qa-approver' && !!ap.data.decidedAt, ap.text.slice(0, 200));
  await v('approve again -> 409', 409, await api('POST', `/api/remediation-plans/${A}/approve`, {}));
  await v('reject an approved plan -> 409', 409, await api('POST', `/api/remediation-plans/${A}/reject`, {}));
  const sim = await api('POST', `/api/remediation-plans/${A}/simulate`);
  check('simulate approved plan -> 200 simulated (default actor operator)', sim.status === 200 && sim.data.status === 'simulated' && !!sim.data.simulatedAt, sim.text.slice(0, 200));
  await v('simulate again -> 409', 409, await api('POST', `/api/remediation-plans/${A}/simulate`));
  const rj = await api('POST', `/api/remediation-plans/${B}/reject`, { actor: 'qa-rejecter' });
  check('reject proposed -> 200 rejected', rj.status === 200 && rj.data.status === 'rejected' && rj.data.decidedBy === 'qa-rejecter', rj.text.slice(0, 200));
  await v('simulate rejected plan -> 409', 409, await api('POST', `/api/remediation-plans/${B}/simulate`));
  await v('approve rejected plan -> 409', 409, await api('POST', `/api/remediation-plans/${B}/approve`));
  const audit = (await api('GET', '/api/audit-events')).data as AuditEvent[];
  const acts = (id: string) => audit.filter((a) => a.remediationId === id).map((a) => a.action).sort().join();
  check('audit trail: A proposed,approved,simulated; B proposed,rejected', acts(A) === 'remediation-approved,remediation-proposed,remediation-simulated' && acts(B) === 'remediation-proposed,remediation-rejected', `${acts(A)} | ${acts(B)}`);
  const secA = ((await api('GET', '/api/security-events?limit=500')).data as SecurityEvent[]).filter((e) => e.remediationId === A || e.remediationId === B);
  check('security events: approved, simulated (dry-run statement kept), rejected are user-action', ['remediation-approved', 'remediation-simulated', 'remediation-rejected'].every((t) => secA.some((e) => e.type === t && e.kind === 'user-action')) && secA.find((e) => e.type === 'remediation-simulated')!.details.includes('No live credential was touched'));
  check('actor recorded as supplied / default', secA.some((e) => e.type === 'remediation-approved' && e.actor === 'qa-approver') && secA.some((e) => e.type === 'remediation-simulated' && e.actor === 'operator'));
}

// ---- 4. error paths do not leak internals (imports the Worker directly, with deliberately broken envs)
const worker = (await import('../src/index.js')).default;
const goodEnv = { SPACETIME_URL: 'http://localhost:3000', SPACETIME_DB_NAME: 'credential-reaper-qa' } as any;
await worker.fetch(new Request('http://x/api/identities'), goodEnv, {} as any); // marks the Worker as seeded
const origErr = console.error;
console.error = () => {};
const dead = await worker.fetch(new Request('http://x/api/identities'), { ...goodEnv, SPACETIME_URL: 'http://127.0.0.1:1' }, {} as any);
const wrongDb = await worker.fetch(new Request('http://x/api/identities'), { ...goodEnv, SPACETIME_DB_NAME: 'no-such-db-xyz' }, {} as any);
console.error = origErr;
const deadText = await dead.text();
const wrongText = await wrongDb.text();
check('unreachable store -> generic 500 internal_error, no URL/path leak', dead.status === 500 && JSON.parse(deadText).error === 'internal_error' && !/127\.0\.0\.1|localhost|fetch|\/v1\//.test(deadText) && dead.headers.get('access-control-allow-origin') === '*', `${dead.status} ${deadText}`);
check('upstream error -> generic 502, no db name/URL/upstream text', wrongDb.status === 502 && !/no-such-db|localhost|3000|\/v1\//.test(wrongText), `${wrongDb.status} ${wrongText}`);

// ---- 5. end of the long stream, then resume it without gaps or duplicates
const s1 = await stream1.done;
check('unfiltered stream ended by itself within its lifetime bound', s1.endedAfterMs <= 36_000 && (s1 as any).err === undefined, JSON.stringify(s1));
check('stream content-type is text/event-stream', s1.ctype.startsWith('text/event-stream'), s1.ctype);
const lastMsg = stream1.messages.filter((m) => m.event !== '(id-only)').at(-1);
check('stream ends with an `event: reconnect` carrying a resume id', lastMsg?.event === 'reconnect' && /^\d+\.\d+$/.test(lastMsg.id ?? ''), JSON.stringify(lastMsg));
const resumeFrom = lastId(stream1.messages)!;
const stream2 = openStream('/api/events/stream', { 'Last-Event-ID': resumeFrom });
await sleep(800);
const extra = await api('POST', '/api/investigations', { identityId: 'id-005', requestedBy: 'qa-tester' });
check('third mock run (id-005) 201 and mock', extra.status === 201 && extra.data.source === 'mock', extra.text.slice(0, 150));
await sleep(2500);
stream2.abort();
await stream2.done;
const seqs = (ms: SseMessage[]) => ms.filter((m) => m.event === 'security-event').map((m) => (JSON.parse(m.data) as SecurityEvent).seq);
const s1seqs = seqs(stream1.messages), s2seqs = seqs(stream2.messages);
const all = ((await api('GET', '/api/security-events?limit=500')).data as SecurityEvent[]).map((e) => e.seq).sort((a, b) => a - b);
const union = [...s1seqs, ...s2seqs];
const firstSeen = union[0]!;
const want = all.filter((s) => s >= firstSeen);
check('stream1 + resumed stream2 = every security event since start, once each, in order', union.join() === want.join() && s2seqs.length > 0 && s1seqs.length > 0, `got ${union.length} want ${want.length}; s1=${s1seqs.length} s2=${s2seqs.length}`);
check('stream carries both event kinds and heartbeat-capable comments', stream1.messages.some((m) => m.event === 'security-event') && stream1.messages.some((m) => m.event === 'investigation-event'));

console.log(failures === 0 ? '\nALL PASSED' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
