// Pull-request remediation checks. The first two suites need nothing running (only the Arasaka checkout). The end-to-end
// suite needs a RUNNING Worker started with a fake GitHub (this test serves it) and writes to the database that Worker
// points at, so use a test database, never the demo one: it syncs the baseline and adds one approved retire plan.
//   wrangler dev --port 8790 --var GITHUB_WEBHOOK_SECRET:test-secret --var GITHUB_API_BASE:http://localhost:8799 \
//     --var GITHUB_SYNC_BRANCH:demo --var GITHUB_SYNC_REPO:riversrc/credential-reaper-demo-app \
//     --var GITHUB_PR_TOKEN:test-pr-token --var SPACETIME_DB_NAME:<test-db>
//   PR_TEST_API=http://localhost:8790 PR_TEST_SECRET=test-secret PR_TEST_DB=<test-db> \
//     PR_TEST_TOKEN_FILE=~/.credential-reaper-worker-token node --test scripts/test-remediation-pr.ts
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { MachineIdentity, RemediationPlan, RemediationPrPreview } from '@credential-reaper/shared';
import { branchFor, loadRetirement, openPullRequest, prBody } from '../src/sync/pr.ts';
import { buildRetirement, RetireRefused } from '../src/sync/retire.ts';
import { scanRepository } from '../src/sync/scan.ts';
import { fsSource } from './fs-source.ts';

const REPO = process.env.ARASAKA_REPO ?? '/home/riversrc/credential-reaper-demo-app';
const REF = process.env.ARASAKA_REF ?? 'demo';
const REPO_NAME = 'riversrc/credential-reaper-demo-app';
const BASE_SHA = 'a'.repeat(40);
const NOW = '2026-01-01T00:00:00.000Z';
const hasRepo = existsSync(join(REPO, 'scenarios'));
const ctx = { repo: REPO_NAME, commitSha: BASE_SHA, now: NOW };
const DECLARED_ONLY = ['personnel-hr-export-key', 'billing-legacy-reconciler'];

const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

function checkout(withScenario: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'arasaka-pr-'));
  temps.push(dir);
  execFileSync('sh', ['-c', `git -C "${REPO}" archive "${REF}" | tar -x -C "${dir}"`]);
  if (withScenario) execFileSync('git', ['apply', join(REPO, 'scenarios', 'retire-declared-only-identity', 'changes.patch')], { cwd: dir });
  return dir;
}

function makeTar(): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'arasaka-pr-tar-'));
  temps.push(dir);
  const root = join(dir, 'riversrc-credential-reaper-demo-app-abc1234');
  mkdirSync(root);
  execFileSync('sh', ['-c', `git -C "${REPO}" archive "${REF}" | tar -x -C "${root}"`]);
  return execFileSync('tar', ['-C', dir, '-cf', '-', 'riversrc-credential-reaper-demo-app-abc1234'], { maxBuffer: 200_000_000 });
}

describe('retirement change', { skip: !hasRepo && 'needs the Arasaka checkout' }, () => {
  it('matches the retire-declared-only-identity scenario exactly', () => {
    const mine = checkout(false);
    const theirs = checkout(true);
    for (const name of DECLARED_ONLY) {
      const r = buildRetirement(fsSource(mine), name, ctx);
      assert.ok(r.verification.every((v) => v.ok));
      for (const f of r.files) {
        if (f.change === 'deleted') rmSync(join(mine, f.path));
        else writeFileSync(join(mine, f.path), f.content!);
      }
    }
    assert.equal(execFileSync('diff', ['-r', '-q', mine, theirs]).toString(), '');
  });

  it('refuses identities that are active, unknown, or in an incomplete snapshot', () => {
    const dir = checkout(false);
    const scan = scanRepository(fsSource(dir), ctx);
    const active = scan.machineIdentities.find((i) => i.homeServiceMode !== 'declared-only')!;
    assert.throws(() => buildRetirement(fsSource(dir), active.name, ctx), (e: unknown) => e instanceof RetireRefused && e.code === 'not_declared_only');
    assert.throws(() => buildRetirement(fsSource(dir), 'no-such-identity', ctx), (e: unknown) => e instanceof RetireRefused && e.code === 'identity_not_in_repo');
    assert.throws(() => buildRetirement({ ...fsSource(dir), incomplete: true }, DECLARED_ONLY[0]!, ctx), (e: unknown) => e instanceof RetireRefused && e.code === 'verification_failed');
  });

  it('refuses a layout it does not recognise instead of guessing', () => {
    const dir = checkout(false);
    const source = fsSource(dir);
    const missing = { ...source, paths: source.paths.filter((p) => p !== `inventory/identities/${DECLARED_ONLY[0]}.yaml`) };
    assert.throws(() => buildRetirement(missing, DECLARED_ONLY[0]!, ctx));
  });
});

interface Seen {
  method: string;
  url: string;
  auth: string | undefined;
  body: any;
}

/** A fake GitHub: the Git Data endpoints the PR flow uses plus the tarball, recording every request. */
function fakeGithub(port: number, archive: () => Buffer, opts: { failPulls?: boolean } = {}): { server: Server; seen: Seen[]; ready: Promise<void> } {
  const seen: Seen[] = [];
  const server = createServer(async (req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString();
    const url = req.url ?? '';
    seen.push({ method: req.method ?? '', url, auth: req.headers.authorization, body: text ? JSON.parse(text) : undefined });
    const reply = (status: number, data?: unknown) => {
      res.statusCode = status;
      res.setHeader('Content-Type', 'application/json');
      res.end(data === undefined ? '' : JSON.stringify(data));
    };
    const r = `/repos/${REPO_NAME}`;
    if (url.startsWith(`${r}/tarball/`)) {
      res.setHeader('Content-Type', 'application/gzip');
      return res.end(gzipSync(archive()));
    }
    if (req.method === 'GET' && url === `${r}/git/ref/heads/demo`) return reply(200, { object: { sha: BASE_SHA } });
    if (req.method === 'GET' && url === `${r}/git/commits/${BASE_SHA}`) return reply(200, { tree: { sha: '1'.repeat(40) } });
    if (req.method === 'POST' && url === `${r}/git/trees`) return reply(201, { sha: '2'.repeat(40) });
    if (req.method === 'POST' && url === `${r}/git/commits`) return reply(201, { sha: '3'.repeat(40) });
    if (req.method === 'POST' && url === `${r}/git/refs`) return reply(201, {});
    if (req.method === 'DELETE' && url.startsWith(`${r}/git/refs/heads/`)) return reply(204);
    if (req.method === 'POST' && url === `${r}/pulls`) return opts.failPulls ? reply(422, { message: 'no' }) : reply(201, { html_url: `https://github.com/${REPO_NAME}/pull/7`, number: 7 });
    reply(404, { message: 'unexpected' });
  });
  const ready = new Promise<void>((resolve) => server.listen(port, resolve));
  return { server, seen, ready };
}

/** Drops pooled keep-alive connections so the next fake on the same port starts clean. */
function stop(server: Server): void {
  server.closeAllConnections();
  server.close();
}

const plan = (over: Partial<RemediationPlan> = {}): RemediationPlan => ({
  id: 'plan-1234abcd-ffff',
  identityId: 'x',
  identityName: DECLARED_ONLY[0]!,
  investigationId: null,
  action: 'retire',
  justification: 'Idle @everyone `rm -rf` <b>x</b>\nsecond line',
  steps: [],
  status: 'approved',
  createdAt: NOW,
  simulatedAt: null,
  ...over,
});

describe('pull request flow against a fake GitHub', { skip: !hasRepo && 'needs the Arasaka checkout' }, () => {
  // A fresh port per test: a pooled keep-alive connection to a previous fake would be reset.
  let port = 8780;
  const envFor = (p: number) => ({ GITHUB_API_BASE: `http://localhost:${p}`, GITHUB_PR_TOKEN: 'pr-secret', GITHUB_TOKEN: 'read-secret' });
  let env = envFor(port);
  const nextPort = () => {
    env = envFor(++port);
    return port;
  };
  const target = { repo: REPO_NAME, baseBranch: 'demo' };

  it('commits only the verified change to a new reaper/ branch and opens a pull request into the base branch', async () => {
    const fake = fakeGithub(nextPort(), makeTar);
    await fake.ready;
    try {
      const loaded = await loadRetirement(env, target, DECLARED_ONLY[0]!);
      assert.equal(loaded.baseSha, BASE_SHA);
      const p = plan();
      const pr = await openPullRequest(env, loaded, p);
      assert.equal(pr.url, `https://github.com/${REPO_NAME}/pull/7`);
      assert.equal(pr.branch, branchFor(p, DECLARED_ONLY[0]!));
      assert.match(pr.branch, /^reaper\/retire-personnel-hr-export-key-plan1234$/);

      const posts = fake.seen.filter((s) => s.method !== 'GET');
      assert.deepEqual(posts.map((s) => `${s.method} ${s.url.replace(`/repos/${REPO_NAME}`, '')}`), ['POST /git/trees', 'POST /git/commits', 'POST /git/refs', 'POST /pulls']);
      assert.ok(posts.every((s) => s.auth === 'Bearer pr-secret'), 'writes use the PR token');
      assert.ok(fake.seen.filter((s) => s.method === 'GET' && s.url.includes('/tarball/')).every((s) => s.auth === 'Bearer read-secret'), 'the scan uses the read token');

      const tree = posts[0]!.body;
      assert.equal(tree.base_tree, '1'.repeat(40));
      assert.ok(tree.tree.some((e: any) => e.sha === null && e.path === 'inventory/identities/personnel-hr-export-key.yaml'));
      assert.ok(tree.tree.every((e: any) => (e.sha === null) !== (typeof e.content === 'string')));
      assert.deepEqual(posts[1]!.body.parents, [BASE_SHA]);
      assert.equal(posts[2]!.body.ref, `refs/heads/${pr.branch}`);
      assert.equal(posts[3]!.body.base, 'demo');
      assert.equal(posts[3]!.body.head, pr.branch);
      assert.ok(!fake.seen.some((s) => s.url.includes('/git/refs/heads/demo') && s.method !== 'GET'), 'the base branch is never written');

      const body: string = posts[3]!.body.body;
      assert.match(body, /does not revoke, rotate or delete/);
      assert.doesNotMatch(body, /@everyone|<b>|`rm/);
      assert.equal(prBody(p, loaded.retirement), body);
    } finally {
      stop(fake.server);
    }
  });

  it('removes the branch it created when the pull request cannot be opened', async () => {
    const fake = fakeGithub(nextPort(), makeTar, { failPulls: true });
    await fake.ready;
    try {
      const loaded = await loadRetirement(env, target, DECLARED_ONLY[1]!);
      await assert.rejects(openPullRequest(env, loaded, plan({ identityName: DECLARED_ONLY[1]! })));
      const del = fake.seen.filter((s) => s.method === 'DELETE');
      assert.equal(del.length, 1);
      assert.match(del[0]!.url, /\/git\/refs\/heads\/reaper\/retire-billing-legacy-reconciler-/);
    } finally {
      stop(fake.server);
    }
  });

  it('does nothing without a write token', async () => {
    const fake = fakeGithub(nextPort(), makeTar);
    await fake.ready;
    try {
      const loaded = await loadRetirement({ ...env, GITHUB_PR_TOKEN: undefined }, target, DECLARED_ONLY[0]!);
      await assert.rejects(openPullRequest({ ...env, GITHUB_PR_TOKEN: undefined }, loaded, plan()), /GITHUB_PR_TOKEN/);
      assert.ok(fake.seen.every((s) => s.method === 'GET'));
    } finally {
      stop(fake.server);
    }
  });
});

const API = process.env.PR_TEST_API;
const SECRET = process.env.PR_TEST_SECRET;
const DB = process.env.PR_TEST_DB;
const TOKEN_FILE = process.env.PR_TEST_TOKEN_FILE?.replace(/^~/, process.env.HOME ?? '');
const SPACETIME = process.env.SPACETIME_URL ?? 'http://localhost:3000';
const e2e = !!API && !!SECRET && !!DB && !!TOKEN_FILE && hasRepo;

describe('pull request end to end through the Worker', { skip: !e2e && 'set PR_TEST_API, PR_TEST_SECRET, PR_TEST_DB and PR_TEST_TOKEN_FILE and start the Worker as described at the top' }, () => {
  const fake = e2e ? fakeGithub(8799, makeTar) : null;
  after(() => fake && stop(fake.server));

  const post = async (path: string) => {
    const res = await fetch(`${API}${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    return { status: res.status, body: (await res.json()) as any };
  };
  const plans = async () => (await (await fetch(`${API}/api/remediation-plans`)).json()) as RemediationPlan[];
  const planId = `pr-e2e-${randomUUID().slice(0, 8)}`;
  let identity: MachineIdentity;

  it('syncs the baseline through a signed push', async () => {
    await fake!.ready;
    const sha = 'b'.repeat(40);
    const body = JSON.stringify({ ref: `refs/heads/${REF}`, after: sha, repository: { full_name: REPO_NAME, default_branch: 'main' }, pusher: { name: 'river' } });
    const signature = `sha256=${createHmac('sha256', SECRET!).update(body).digest('hex')}`;
    const res = await fetch(`${API}/api/webhooks/github`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': 'push', 'X-Hub-Signature-256': signature }, body });
    assert.equal(res.status, 202);
    for (let i = 0; i < 60; i++) {
      const found = ((await (await fetch(`${API}/api/identities`)).json()) as MachineIdentity[]).find((x) => x.name === DECLARED_ONLY[0] && x.repoState === 'present');
      if (found) {
        identity = found;
        return;
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.fail('the identity was not synced');
  });

  it('refuses a plan that is not approved, then previews once it is', async () => {
    const token = readFileSync(TOKEN_FILE!, 'utf8').trim();
    const res = await fetch(`${SPACETIME}/v1/database/${DB}/call/propose_remediation`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        id: planId,
        identityId: identity.id,
        identityName: identity.name,
        investigationId: { none: {} },
        action: 'retire',
        justification: 'End-to-end test plan.',
        steps: [{ id: `${planId}-1`, order: 1, description: 'Remove declarations and bindings', automatable: false }],
        createdAt: new Date().toISOString(),
        actor: 'pr-e2e',
      }),
    });
    assert.equal(res.status, 200);
    assert.equal((await post(`/api/remediation-plans/${planId}/pr-preview`)).status, 409);
    assert.equal((await post(`/api/remediation-plans/${planId}/open-pr`)).status, 409);
    assert.equal((await post(`/api/remediation-plans/${planId}/approve`)).status, 200);

    const preview = await post(`/api/remediation-plans/${planId}/pr-preview`);
    assert.equal(preview.status, 200);
    const p = preview.body as RemediationPrPreview;
    assert.equal(p.baseBranch, REF);
    assert.equal(p.baseSha, BASE_SHA);
    assert.ok(p.verification.every((v) => v.ok));
    assert.ok(p.files.some((f) => f.change === 'deleted'));
    assert.equal(fake!.seen.filter((s) => s.method !== 'GET').length, 0, 'a preview writes nothing to GitHub');
  });

  it('opens the pull request once, records it, and refuses a second one', async () => {
    const opened = await post(`/api/remediation-plans/${planId}/open-pr`);
    assert.equal(opened.status, 201);
    assert.equal(opened.body.prUrl, `https://github.com/${REPO_NAME}/pull/7`);
    assert.match(opened.body.prBranch, /^reaper\/retire-personnel-hr-export-key-/);
    assert.equal((await post(`/api/remediation-plans/${planId}/open-pr`)).status, 409);
    assert.equal((await plans()).find((x) => x.id === planId)?.prUrl, opened.body.prUrl);
    const audit = (await (await fetch(`${API}/api/audit-events`)).json()) as any[];
    assert.ok(audit.some((a) => a.action === 'remediation-pr-opened'));
    const live = ((await (await fetch(`${API}/api/identities`)).json()) as MachineIdentity[]).find((x) => x.id === identity.id);
    assert.equal(live?.status, 'active', 'opening a pull request retires nothing');
  });
});
