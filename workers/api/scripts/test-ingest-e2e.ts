// End-to-end Repository Sync checks against a RUNNING Worker + SpacetimeDB. This writes to the database the
// Worker points at (scans, repository identities, and a temporary curated owner), so INGEST_TEST_API must be set
// explicitly and should target a sync/test database. Scenarios come from the Arasaka repo's own patches.
//   INGEST_TEST_API=http://localhost:8788 node --test scripts/test-ingest-e2e.ts
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { MachineIdentity, RepositoryEvidence, RepositoryIngestResponse, RepositoryScan, RepositoryScanRecord } from '@credential-reaper/shared';
import { scanRepository } from '../src/sync/scan.ts';
import { fsSource } from './fs-source.ts';

const API = process.env.INGEST_TEST_API;
const REPO = process.env.ARASAKA_REPO ?? '/home/riversrc/credential-reaper-demo-app';
const REF = process.env.ARASAKA_REF ?? 'demo';
const REPO_NAME = 'riversrc/credential-reaper-demo-app';
const available = !!API && existsSync(join(REPO, 'scenarios'));
const temps: string[] = [];

after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

const sha = () => execFileSync('git', ['-C', REPO, 'rev-parse', REF]).toString().trim();

function scan(scenario: string | null): RepositoryScan {
  const dir = mkdtempSync(join(tmpdir(), 'arasaka-ingest-'));
  temps.push(dir);
  execFileSync('sh', ['-c', `git -C "${REPO}" archive "${REF}" | tar -x -C "${dir}"`]);
  if (scenario) execFileSync('git', ['apply', join(REPO, 'scenarios', scenario, 'changes.patch')], { cwd: dir });
  return scanRepository(fsSource(dir), { repo: REPO_NAME, commitSha: sha() });
}

async function call<T>(path: string, init?: RequestInit): Promise<{ status: number; body: T }> {
  const res = await fetch(`${API}${path}`, init);
  return { status: res.status, body: (await res.json()) as T };
}
const post = (path: string, body: unknown) => call<any>(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const ingest = async (s: RepositoryScan) => {
  const r = await post('/api/repository/scans', s);
  assert.equal(r.status, 201, JSON.stringify(r.body));
  return r.body as RepositoryIngestResponse;
};
const identities = async () => (await call<MachineIdentity[]>('/api/identities')).body;
const repoIdentities = async () => (await identities()).filter((i) => i.dataSource === 'repository');
const detail = async (id: string) => (await call<{ identity: MachineIdentity; permissions: unknown[]; credentials: unknown[]; usageHistory: unknown[]; repository: RepositoryEvidence | null }>(`/api/identities/${id}`)).body;
const present = (r: RepositoryScanRecord, list: string) => r.persisted[`${list}:present`] ?? 0;

describe('Repository Sync end to end', { skip: !available && 'set INGEST_TEST_API and provide an Arasaka checkout' }, () => {
  it('persists the baseline: 44 identities, every list, and the demo data is untouched', async () => {
    const before = (await identities()).filter((i) => i.dataSource === 'seeded-demo').length;
    const r = await ingest(scan(null));
    assert.equal(r.identities.synced, 44);
    assert.equal(r.scan.finished, true);
    for (const [list, n] of Object.entries(r.scan.counts)) if (list !== 'warnings') assert.equal(present(r.scan, list), n, list);
    assert.equal((await repoIdentities()).length, 44);
    assert.equal((await identities()).filter((i) => i.dataSource === 'seeded-demo').length, before);
  });

  it('is idempotent: a second ingest adds and changes nothing and creates no duplicate rows', async () => {
    const first = await detail('MI-0001');
    const r = await ingest(scan(null));
    assert.deepEqual([r.scan.added, r.scan.changed, r.scan.reappeared, r.scan.removed], [0, 0, 0, 0]);
    assert.equal(r.scan.unchanged, Object.entries(r.scan.counts).filter(([k]) => k !== 'warnings').reduce((n, [, v]) => n + v, 0));
    assert.equal((await repoIdentities()).length, 44);
    const second = await detail('MI-0001');
    assert.equal(second.permissions.length, first.permissions.length);
    assert.equal(second.credentials.length, 1);
    assert.equal(new Set((await repoIdentities()).map((i) => i.id)).size, 44);
  });

  it('keeps provenance with source path, commit SHA, evidence type and confidence', async () => {
    const { repository } = await detail('MI-0001');
    assert.ok(repository);
    assert.equal(repository.repo, REPO_NAME);
    assert.equal(repository.commitSha, sha());
    const paths = repository.provenance.map((p) => p.sourcePath);
    assert.ok(paths.includes('inventory/identities/arasaka-payment-processor-prod.yaml'));
    for (const p of repository.provenance) {
      assert.equal(p.commitSha, sha());
      assert.ok(p.evidenceType === 'repository-declaration' || p.evidenceType === 'source-reference');
      assert.ok(['high', 'medium', 'low'].includes(p.confidence));
    }
    assert.ok(repository.provenance.some((p) => p.evidenceType === 'source-reference' && p.confidence === 'medium'));
  });

  it('never invents runtime evidence', async () => {
    for (const i of await repoIdentities()) assert.equal(i.lastUsedAt, null, i.id);
    const d = await detail('MI-0001');
    assert.deepEqual(d.usageHistory, []);
  });

  it('rejects malformed and unsupported scans without storing anything', async () => {
    const scansBefore = (await call<RepositoryScanRecord[]>('/api/repository/scans')).body.length;
    const base = JSON.parse(JSON.stringify(scan(null)));
    const cases: [string, (s: any) => void][] = [
      ['unsupported schemaVersion', (s) => (s.schemaVersion = 2)],
      ['runtime evidence type', (s) => (s.machineIdentities[0].provenance[0].evidenceType = 'runtime-observation')],
      ['unsupported identity type', (s) => (s.machineIdentities[0].type = 'laptop')],
      ['unmasked credential preview', (s) => (s.machineIdentities[0].credential.maskedPreview = 'arsk-0123456789abcdef')],
      ['counts that disagree with the lists', (s) => (s.counts.services = 99)],
      ['missing list', (s) => delete s.assignments],
    ];
    for (const [name, mutate] of cases) {
      const s = JSON.parse(JSON.stringify(base));
      mutate(s);
      const r = await post('/api/repository/scans', s);
      assert.equal(r.status, 400, name);
      assert.equal(r.body.error, 'invalid_scan', name);
      assert.ok(r.body.problems.length > 0, name);
    }
    assert.equal((await post('/api/repository/scans', [1, 2])).status, 400);
    assert.equal((await call<RepositoryScanRecord[]>('/api/repository/scans')).body.length, scansBefore);
  });

  it('never lets a scan overwrite curated ownership, and keeps the repository declaration alongside it', async () => {
    const set = await post('/api/identities/MI-0036/ownership', { owner: 'Test Curator', team: 'Curated Team', actor: 'e2e' });
    assert.equal(set.status, 200);
    assert.equal(set.body.identity.ownerSource, 'curated');
    // assign-owner moves MI-0036 and MI-0041 to Takumi Ishikawa in the repository.
    await ingest(scan('assign-owner'));
    const pinned = await detail('MI-0036');
    assert.equal(pinned.identity.owner, 'Test Curator');
    assert.equal(pinned.identity.team, 'Curated Team');
    assert.equal(pinned.identity.ownerSource, 'curated');
    assert.equal(pinned.repository?.declaredOwnership?.owner, 'Takumi Ishikawa');
    assert.equal(pinned.repository?.ownershipDiffers, true);
    const followed = await detail('MI-0041');
    assert.equal(followed.identity.owner, 'Takumi Ishikawa');
    assert.equal(followed.identity.ownerSource, 'repository');
    assert.equal(followed.identity.status, 'active');

    const reverted = await post('/api/identities/MI-0036/ownership', { revert: true, actor: 'e2e' });
    assert.equal(reverted.body.identity.owner, 'Takumi Ishikawa');
    assert.equal(reverted.body.identity.ownerSource, 'repository');
    const audit = (await call<{ action: string; identityId: string }[]>('/api/audit-events')).body;
    assert.ok(audit.some((a) => a.action === 'ownership-curated' && a.identityId === 'MI-0036'));
  });

  it('detects removed assignments and removed identities without retiring anything', async () => {
    const reduced = await ingest(scan('least-privilege-reduction'));
    assert.ok(reduced.scan.removed > 0);
    assert.ok((reduced.scan.persisted['assignments:removed'] ?? 0) > 0);

    const retired = await ingest(scan('retire-declared-only-identity'));
    assert.ok(retired.scan.removed > 0);
    for (const id of ['MI-0018', 'MI-0025']) {
      const d = await detail(id);
      assert.equal(d.identity.repoState, 'removed', id);
      assert.notEqual(d.identity.status, 'retired', id);
      assert.equal(d.repository?.state, 'removed', id);
      assert.equal(d.credentials.length, 1, `${id} credential metadata is kept`);
    }
    assert.equal((await repoIdentities()).length, 44);
  });

  it('brings removed declarations back when they reappear, and a partial scan never removes anything', async () => {
    const back = await ingest(scan(null));
    assert.ok(back.scan.reappeared > 0);
    assert.equal((await detail('MI-0018')).identity.repoState, 'present');

    const partial = JSON.parse(JSON.stringify(scan(null))) as RepositoryScan;
    partial.status = 'partial';
    partial.machineIdentities = partial.machineIdentities.filter((i) => i.id !== 'MI-0018');
    partial.counts.machineIdentities = partial.machineIdentities.length;
    const r = await ingest(partial);
    assert.equal(r.scan.removed, 0);
    assert.equal((await detail('MI-0018')).identity.repoState, 'present');
    await ingest(scan(null));
  });
});
