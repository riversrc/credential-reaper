// GitHub push webhook checks. The first two suites need nothing running. The end-to-end suite needs a RUNNING
// Worker started with a fake GitHub (this test serves it) and writes to the database that Worker points at, so use
// a test database, never the demo one: it adds the "new-machine-identity" scenario identity.
//   wrangler dev --port 8790 --var GITHUB_WEBHOOK_SECRET:test-secret --var GITHUB_API_BASE:http://localhost:8799 \
//     --var GITHUB_SYNC_BRANCH:demo --var SPACETIME_DB_NAME:<test-db>
//   WEBHOOK_TEST_API=http://localhost:8790 WEBHOOK_TEST_SECRET=test-secret node --test scripts/test-github-webhook.ts
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import { gzipSync } from 'node:zlib';
import type { MachineIdentity, RepositoryScanRecord } from '@credential-reaper/shared';
import { ignoredReason, parsePushEvent, tarSource, verifyGithubSignature } from '../src/sync/github.ts';
import { scanRepository } from '../src/sync/scan.ts';
import { fsSource } from './fs-source.ts';

const REPO = process.env.ARASAKA_REPO ?? '/home/riversrc/credential-reaper-demo-app';
const REF = process.env.ARASAKA_REF ?? 'demo';
const REPO_NAME = 'riversrc/credential-reaper-demo-app';
const hasRepo = existsSync(join(REPO, 'scenarios'));
const temps: string[] = [];
after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const sign = (secret: string, body: string) => `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
const headSha = () => execFileSync('git', ['-C', REPO, 'rev-parse', REF]).toString().trim();

/** A checkout of the demo branch (optionally patched) as a tar, laid out like a GitHub tarball: one top-level directory. */
function makeTar(scenario: string | null): Buffer {
  const dir = mkdtempSync(join(tmpdir(), 'arasaka-webhook-'));
  temps.push(dir);
  const root = join(dir, 'riversrc-credential-reaper-demo-app-abc1234');
  mkdirSync(root);
  execFileSync('sh', ['-c', `git -C "${REPO}" archive "${REF}" | tar -x -C "${root}"`]);
  if (scenario) execFileSync('git', ['apply', join(REPO, 'scenarios', scenario, 'changes.patch')], { cwd: root });
  return execFileSync('tar', ['-C', dir, '-cf', '-', 'riversrc-credential-reaper-demo-app-abc1234'], { maxBuffer: 200_000_000 });
}

describe('signature check', () => {
  const body = '{"a":1}';
  it('accepts the right signature', async () => assert.equal(await verifyGithubSignature('s3cret', body, sign('s3cret', body)), true));
  it('rejects a wrong secret, a changed body, a missing header and a malformed header', async () => {
    assert.equal(await verifyGithubSignature('s3cret', body, sign('other', body)), false);
    assert.equal(await verifyGithubSignature('s3cret', '{"a":2}', sign('s3cret', body)), false);
    assert.equal(await verifyGithubSignature('s3cret', body, null), false);
    assert.equal(await verifyGithubSignature('s3cret', body, 'sha1=abc'), false);
    assert.equal(await verifyGithubSignature('s3cret', body, 'sha256=zz'), false);
  });
});

describe('push payload handling', () => {
  const good = { ref: 'refs/heads/demo', after: 'a'.repeat(40), repository: { full_name: REPO_NAME, default_branch: 'main' }, pusher: { name: 'river' } };
  it('parses a branch push', () => assert.deepEqual(parsePushEvent(good), { repo: REPO_NAME, sha: 'a'.repeat(40), ref: 'refs/heads/demo', defaultBranch: 'main', pusher: 'river' }));
  it('rejects deletions, zero shas, malformed repos and shas', () => {
    assert.equal(parsePushEvent({ ...good, deleted: true }), null);
    assert.equal(parsePushEvent({ ...good, after: '0'.repeat(40) }), null);
    assert.equal(parsePushEvent({ ...good, after: 'xyz' }), null);
    assert.equal(parsePushEvent({ ...good, repository: { full_name: '../../etc/passwd' } }), null);
    assert.equal(parsePushEvent(null), null);
  });
  it('drops an odd pusher name instead of trusting it', () => assert.equal(parsePushEvent({ ...good, pusher: { name: 'a b<script>' } })?.pusher, null));
  it('scans only the configured or default branch and repository', () => {
    const push = parsePushEvent(good)!;
    assert.equal(ignoredReason({ GITHUB_SYNC_BRANCH: 'demo' }, push), null);
    assert.match(ignoredReason({}, push) ?? '', /not a push to main/);
    assert.match(ignoredReason({ GITHUB_SYNC_BRANCH: 'demo', GITHUB_SYNC_REPO: 'someone/else' }, push) ?? '', /not the configured/);
  });
});

describe('tarball source', { skip: !hasRepo && 'needs the Arasaka checkout' }, () => {
  it('scans identically to the filesystem source, with and without gzip', async () => {
    const tar = makeTar(null);
    const fromTar = scanRepository(tarSource(new Uint8Array(tar)), { repo: REPO_NAME, commitSha: 'x', now: '2026-01-01T00:00:00.000Z' });
    const dir = mkdtempSync(join(tmpdir(), 'arasaka-fs-'));
    temps.push(dir);
    execFileSync('sh', ['-c', `git -C "${REPO}" archive "${REF}" | tar -x -C "${dir}"`]);
    const fromFs = scanRepository(fsSource(dir), { repo: REPO_NAME, commitSha: 'x', now: '2026-01-01T00:00:00.000Z' });
    assert.equal(fromTar.machineIdentities.length, 44);
    assert.deepEqual(fromTar, fromFs);
    const unzipped = await new Response(new Blob([gzipSync(tar)]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    assert.equal(tarSource(new Uint8Array(unzipped)).paths.length, tarSource(new Uint8Array(tar)).paths.length);
  });
  it('flags symlinks as incomplete and drops traversal paths', () => {
    const header = (name: string, type: string, size = 0): Buffer => {
      const h = Buffer.alloc(512);
      h.write(name, 0);
      h.write(size.toString(8).padStart(11, '0'), 124);
      h.write(type, 156);
      return h;
    };
    const content = Buffer.alloc(512);
    content.write('hi');
    const tar = Buffer.concat([header('top/a.txt', '0', 2), content, header('top/../evil.txt', '0', 2), content, header('top/link', '2'), Buffer.alloc(1024)]);
    const source = tarSource(new Uint8Array(tar));
    assert.deepEqual(source.paths, ['a.txt']);
    assert.equal(source.incomplete, true);
    assert.equal(source.read('a.txt'), 'hi');
  });
});

const API = process.env.WEBHOOK_TEST_API;
const SECRET = process.env.WEBHOOK_TEST_SECRET;
const MOCK_PORT = Number(process.env.WEBHOOK_MOCK_PORT ?? 8799);
const e2e = !!API && !!SECRET && hasRepo;

describe('webhook end to end', { skip: !e2e && 'set WEBHOOK_TEST_API and WEBHOOK_TEST_SECRET and start the Worker as described at the top' }, () => {
  let archive: Buffer = Buffer.alloc(0);
  let server: Server;
  const fetched: string[] = [];

  it('starts a fake GitHub that serves the current archive', async () => {
    server = createServer((req, res) => {
      fetched.push(req.url ?? '');
      res.setHeader('Content-Type', 'application/gzip');
      res.end(gzipSync(archive));
    });
    await new Promise<void>((resolve) => server.listen(MOCK_PORT, resolve));
  });
  after(() => server?.close());

  const send = async (event: string, payload: unknown, signature?: string) => {
    const body = JSON.stringify(payload);
    const res = await fetch(`${API}/api/webhooks/github`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-GitHub-Event': event, 'X-Hub-Signature-256': signature ?? sign(SECRET!, body) },
      body,
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const push = (sha: string, ref = `refs/heads/${REF}`) => ({ ref, after: sha, repository: { full_name: REPO_NAME, default_branch: 'main' }, pusher: { name: 'river' } });
  const scans = async () => (await (await fetch(`${API}/api/repository/scans`)).json()) as RepositoryScanRecord[];
  async function scanFor(sha: string): Promise<RepositoryScanRecord> {
    for (let i = 0; i < 60; i++) {
      const found = (await scans()).find((s) => s.commitSha === sha && s.finished);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 500));
    }
    assert.fail(`no finished scan for ${sha}`);
  }

  it('rejects unsigned and wrongly signed requests, and ignores ping and other branches', async () => {
    assert.equal((await send('push', push('b'.repeat(40)), 'sha256=' + '0'.repeat(64))).status, 401);
    assert.equal((await send('ping', { zen: 'x' })).status, 200);
    const other = await send('push', push('b'.repeat(40), 'refs/heads/feature'));
    assert.equal(other.status, 202);
    assert.match(other.body.ignored, /not a push to/);
    assert.equal(fetched.length, 0);
  });

  it('ingests a pushed baseline, and pushing it again changes nothing', async () => {
    archive = makeTar(null);
    const sha1 = 'c'.repeat(40);
    assert.equal((await send('push', push(sha1))).status, 202);
    await scanFor(sha1);
    const sha2 = 'd'.repeat(40);
    assert.equal((await send('push', push(sha2))).status, 202);
    const second = await scanFor(sha2);
    assert.equal(second.added, 0);
    assert.equal(second.changed, 0);
    assert.equal(second.removed, 0);
    assert.ok(fetched.every((u) => u.startsWith('/repos/riversrc/credential-reaper-demo-app/tarball/')));
  });

  it('a push that adds a machine identity logs it by name in the security feed and audit history', async () => {
    archive = makeTar('new-machine-identity');
    const sha = 'e'.repeat(40);
    assert.equal((await send('push', push(sha))).status, 202);
    const scan = await scanFor(sha);
    assert.ok(scan.added > 0);
    const identities = (await (await fetch(`${API}/api/identities`)).json()) as MachineIdentity[];
    const added = identities.find((i) => i.name === 'analytics-report-publisher');
    assert.ok(added, 'the new identity is in the inventory');
    assert.equal(added.dataSource, 'repository');
    assert.equal(added.lastUsedAt, null);

    const feed = (await (await fetch(`${API}/api/security-events?limit=20`)).json()) as any;
    const events: any[] = Array.isArray(feed) ? feed : feed.events;
    const event = events.find((e) => e.type === 'repo-scan-ingested' && /analytics-report-publisher/.test(e.summary));
    assert.ok(event, 'security event names the new identity');
    assert.match(event.summary, /^New identities \(1\): analytics-report-publisher\./);
    assert.match(event.details, /Triggered by push eeeeeee by river/);
    const audit = (await (await fetch(`${API}/api/audit-events`)).json()) as any[];
    assert.ok(audit.some((a) => a.action === 'repo-scan-ingested' && /New identities \(1\): analytics-report-publisher/.test(a.details)));
  });

  it('pushing the baseline again flags the identity as removed but never retires it', async () => {
    archive = makeTar(null);
    const sha = 'f'.repeat(40);
    assert.equal((await send('push', push(sha))).status, 202);
    const scan = await scanFor(sha);
    assert.ok(scan.removed > 0);
    const identities = (await (await fetch(`${API}/api/identities`)).json()) as MachineIdentity[];
    const gone = identities.find((i) => i.name === 'analytics-report-publisher');
    assert.equal(gone?.repoState, 'removed');
    assert.equal(gone?.status, 'active');
  });
});
