// Acceptance tests for the offline scanner against the Arasaka demo repo. Read-only: the repo is exported
// with `git archive` into a temp dir and scenarios are applied to that copy, never to the checkout.
//   node --test scripts/test-scan-arasaka.ts      (ARASAKA_REPO / ARASAKA_REF override path and ref)
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, describe, it } from 'node:test';
import type { RepositoryScan } from '@credential-reaper/shared';
import { diffScans } from '../src/sync/diff.ts';
import type { ScanChange } from '../src/sync/diff.ts';
import { scanRepository } from '../src/sync/scan.ts';
import { ARASAKA_EXPECTED } from './arasaka-expected.ts';
import { fsSource } from './fs-source.ts';

const REPO = process.env.ARASAKA_REPO ?? '/home/riversrc/credential-reaper-demo-app';
const REF = process.env.ARASAKA_REF ?? 'demo';
const CTX = { repo: 'arasaka/test', commitSha: 'test-sha', now: '2026-01-01T00:00:00.000Z' };
const available = existsSync(join(REPO, 'scenarios'));
const temps: string[] = [];

function exportTree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'arasaka-scan-'));
  temps.push(dir);
  execFileSync('sh', ['-c', `git -C "${REPO}" archive "${REF}" | tar -x -C "${dir}"`]);
  return dir;
}

function scanWithScenario(id: string | null): RepositoryScan {
  const dir = exportTree();
  if (id) execFileSync('git', ['apply', join(REPO, 'scenarios', id, 'changes.patch')], { cwd: dir });
  return scanRepository(fsSource(dir), CTX);
}

after(() => {
  for (const d of temps) rmSync(d, { recursive: true, force: true });
});

describe('Arasaka baseline', { skip: !available && `no Arasaka checkout at ${REPO}` }, () => {
  const baseline = available ? scanWithScenario(null) : (undefined as never);

  it('matches the documented inventory counts', () => {
    for (const [name, expected] of Object.entries(ARASAKA_EXPECTED)) {
      assert.equal(baseline.counts[name as keyof typeof baseline.counts], expected, name);
    }
  });

  it('scans completely with no warnings', () => {
    assert.equal(baseline.status, 'complete');
    assert.deepEqual(baseline.warnings, []);
  });

  it('records secondary inventory the manifest declares', () => {
    assert.equal(baseline.counts.serviceOwnership, 12);
    assert.equal(baseline.counts.identityOwnership, 44);
    assert.equal(baseline.counts.externalProviders, 5);
    assert.equal(baseline.counts.gatewayRoutes, 11);
  });

  it('keeps every key unique within its list', () => {
    for (const list of ['services', 'endpoints', 'machineIdentities', 'permissions', 'assignments', 'permissionHistory', 'teams', 'people', 'serviceDependencies', 'providerDependencies'] as const) {
      const keys = baseline[list].map((r) => r.key);
      assert.equal(new Set(keys).size, keys.length, list);
    }
  });

  it('attaches provenance to every record, with repo, path and commit', () => {
    for (const list of ['machineIdentities', 'permissions', 'assignments', 'endpoints', 'serviceDependencies', 'providerDependencies', 'identityOwnership'] as const) {
      for (const record of baseline[list]) {
        assert.ok(record.provenance.length > 0, `${list} ${record.key} has no provenance`);
        for (const p of record.provenance) {
          assert.equal(p.repo, CTX.repo);
          assert.equal(p.commitSha, CTX.commitSha);
          assert.ok(p.sourcePath.length > 0);
        }
      }
    }
  });

  it('only claims repository evidence, never runtime evidence', () => {
    const allowed = new Set(['repository-declaration', 'source-reference']);
    const json = JSON.stringify(baseline);
    for (const list of ['machineIdentities', 'permissions', 'assignments', 'endpoints', 'serviceDependencies', 'providerDependencies']) {
      for (const record of baseline[list as 'endpoints']) for (const p of record.provenance) assert.ok(allowed.has(p.evidenceType), p.evidenceType);
    }
    assert.ok(!/lastUsed|usageEvent|lastSeen|deployed/i.test(json), 'scan output must not carry usage or deployment fields');
  });

  it('declares each identity from its inventory file with high confidence', () => {
    for (const identity of baseline.machineIdentities) {
      const primary = identity.provenance.find((p) => p.sourcePath.startsWith('inventory/identities/'));
      assert.ok(primary, identity.key);
      assert.equal(primary.evidenceType, 'repository-declaration');
      assert.equal(primary.confidence, 'high');
    }
  });

  it('rates regex-derived source references at most medium confidence', () => {
    for (const record of [...baseline.endpoints, ...baseline.machineIdentities]) {
      for (const p of record.provenance) {
        if (p.evidenceType === 'source-reference') assert.notEqual(p.confidence, 'high', `${record.key} ${p.sourcePath}`);
      }
    }
  });

  it('labels all five provider edges configuration-only with no call sites', () => {
    assert.equal(baseline.providerDependencies.length, 5);
    for (const d of baseline.providerDependencies) {
      assert.equal(d.declaredEvidence, 'configuration-only', d.key);
      assert.equal(d.callSiteCount, 0, d.key);
    }
  });

  it('contains no credential material', () => {
    for (const i of baseline.machineIdentities) {
      assert.ok(i.credential.maskedPreview === null || /\*/.test(i.credential.maskedPreview), `${i.id} preview is not masked`);
    }
  });

  it('keeps declared ownership separate from identity records', () => {
    const identity = baseline.machineIdentities[0]!;
    assert.ok(!('primaryOwnerId' in identity) && !('ownershipStatus' in identity));
    assert.equal(baseline.identityOwnership.length, baseline.machineIdentities.length);
  });

  it('is deterministic: a rescan with a different timestamp and commit has no changes', () => {
    const dir = exportTree();
    const again = scanRepository(fsSource(dir), { repo: CTX.repo, commitSha: 'another-sha', now: '2027-06-01T00:00:00.000Z' });
    assert.deepEqual(diffScans(baseline, again), []);
  });
});

describe('Arasaka scenarios', { skip: !available && `no Arasaka checkout at ${REPO}` }, () => {
  const baseline = available ? scanWithScenario(null) : (undefined as never);
  const changes = (id: string): { scan: RepositoryScan; diff: ScanChange[] } => {
    const scan = scanWithScenario(id);
    assert.equal(scan.status, 'complete', `${id} scan status`);
    assert.deepEqual(scan.warnings, [], `${id} warnings`);
    return { scan, diff: diffScans(baseline, scan) };
  };
  const find = (diff: ScanChange[], list: string, kind: ScanChange['kind'], key?: string): ScanChange | undefined =>
    diff.find((c) => c.list === list && c.kind === kind && (key === undefined || c.key === key || c.key.startsWith(key)));

  it('every scenario scans cleanly and changes something', () => {
    const ids = readdirSync(join(REPO, 'scenarios'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
    assert.equal(ids.length, 13);
    for (const id of ids) assert.ok(changes(id).diff.length > 0, `${id} produced no scan changes`);
  });

  it('new-machine-identity: adds MI-0045, its endpoint, assignments and ownership', () => {
    const { scan, diff } = changes('new-machine-identity');
    assert.ok(find(diff, 'machineIdentities', 'added', 'MI-0045'));
    assert.ok(find(diff, 'endpoints', 'added'));
    assert.equal(diff.filter((c) => c.list === 'assignments' && c.kind === 'added').length, 2);
    assert.ok(find(diff, 'identityOwnership', 'added', 'MI-0045'));
    const identity = scan.machineIdentities.find((i) => i.id === 'MI-0045')!;
    assert.ok(identity.provenance.some((p) => p.sourcePath.startsWith('inventory/identities/')));
    assert.equal(scan.counts.machineIdentities, 45);
  });

  it('unprotected-endpoint: adds an unauthenticated endpoint with no permission', () => {
    const { diff } = changes('unprotected-endpoint');
    const added = diff.filter((c) => c.list === 'endpoints' && c.kind === 'added');
    assert.equal(added.length, 1);
    const endpoint = added[0]!.after as unknown as { authenticated: boolean; permissionId: string | null; authMode: string | null; declaredInOpenApi: boolean; declaredInRouteSource: boolean };
    assert.equal(endpoint.authenticated, false);
    assert.equal(endpoint.permissionId, null);
    assert.equal(endpoint.authMode, 'none');
    assert.ok(endpoint.declaredInOpenApi && endpoint.declaredInRouteSource);
  });

  it('permission-escalation: adds finance.*:admin on MI-0023 and a history entry', () => {
    const { diff } = changes('permission-escalation');
    const added = find(diff, 'assignments', 'added', 'MI-0023|finance.*:admin');
    assert.ok(added);
    assert.equal((added.after as unknown as { reviewStatus: string }).reviewStatus, 'excessive');
    const history = find(diff, 'permissionHistory', 'added');
    assert.ok(history);
    assert.equal((history.after as unknown as { ticket: string }).ticket, 'SEC-5120');
  });

  it('owner-departure: marks the person as left and updates their identities without overwriting ownership records elsewhere', () => {
    const { diff } = changes('owner-departure');
    const person = find(diff, 'people', 'modified', 'p-tomoe-sakurai');
    assert.ok(person && person.changedFields.includes('status') && person.changedFields.includes('left'));
    const owners = diff.filter((c) => c.list === 'identityOwnership' && c.kind === 'modified');
    assert.deepEqual(owners.map((c) => c.key).sort(), ['MI-0002', 'MI-0021', 'MI-0023', 'MI-0024']);
    for (const o of owners) assert.ok(!o.changedFields.includes('primaryOwnerId'), `${o.key}: primary owner must be unchanged`);
  });

  it('new-service-dependency: adds the intelligence-analytics to secure-communications edge', () => {
    const { scan, diff } = changes('new-service-dependency');
    assert.ok(find(diff, 'serviceDependencies', 'added', 'intelligence-analytics->secure-communications'));
    assert.equal(scan.counts.serviceDependencies, 39);
    assert.ok(find(diff, 'machineIdentities', 'modified', 'MI-0006')?.changedFields.includes('bindings'));
  });

  it('credential-rotation: only the credential block of MI-0001 changes', () => {
    const { diff } = changes('credential-rotation');
    assert.equal(diff.length, 1);
    assert.equal(diff[0]!.key, 'MI-0001');
    assert.deepEqual(diff[0]!.changedFields, ['credential']);
  });

  it('shared-identity-spread: MI-0007 gains bindings', () => {
    const { diff } = changes('shared-identity-spread');
    const change = find(diff, 'machineIdentities', 'modified', 'MI-0007');
    assert.ok(change?.changedFields.includes('bindings'));
    const before = (change.before as unknown as { bindings: unknown[] }).bindings.length;
    const afterCount = (change.after as unknown as { bindings: unknown[] }).bindings.length;
    assert.ok(afterCount > before);
  });

  it('deprecated-endpoint-in-use: one endpoint becomes deprecated', () => {
    const { diff } = changes('deprecated-endpoint-in-use');
    assert.equal(diff.length, 1);
    assert.deepEqual(diff[0]!.changedFields, ['deprecated']);
    assert.equal((diff[0]!.after as unknown as { deprecated: boolean }).deprecated, true);
  });

  it('dormant-identity-reactivated: MI-0008 gains a source reference and a provider edge, without runtime claims', () => {
    const { scan, diff } = changes('dormant-identity-reactivated');
    const identity = find(diff, 'machineIdentities', 'modified', 'MI-0008');
    assert.ok(identity?.changedFields.includes('homeServiceMode'));
    const edge = find(diff, 'providerDependencies', 'added', 'external-integration->northgate-contractor-portal');
    assert.ok(edge);
    const mi = scan.machineIdentities.find((i) => i.id === 'MI-0008')!;
    assert.ok(mi.provenance.some((p) => p.evidenceType === 'source-reference'));
    assert.ok(mi.provenance.every((p) => p.evidenceType === 'source-reference' || p.evidenceType === 'repository-declaration'));
    assert.ok(!('lastUsed' in mi));
  });

  it('expiring-credential: MI-0014 and MI-0026 expiry dates change', () => {
    const { diff } = changes('expiring-credential');
    assert.deepEqual(diff.map((c) => c.key).sort(), ['MI-0014', 'MI-0026']);
    for (const c of diff) assert.deepEqual(c.changedFields, ['expiresOn']);
  });

  it('assign-owner: ownership records gain a primary owner', () => {
    const { diff } = changes('assign-owner');
    const owners = diff.filter((c) => c.list === 'identityOwnership');
    assert.deepEqual(owners.map((c) => c.key).sort(), ['MI-0036', 'MI-0041']);
    for (const o of owners) assert.ok(o.changedFields.includes('primaryOwnerId'));
  });

  it('least-privilege-reduction: assignments are removed and history records the reduction', () => {
    const { scan, diff } = changes('least-privilege-reduction');
    assert.equal(diff.filter((c) => c.list === 'assignments' && c.kind === 'removed').length, 3);
    assert.equal(diff.filter((c) => c.list === 'permissionHistory' && c.kind === 'added').length, 3);
    assert.equal(scan.counts.assignments, 90);
  });

  it('retire-declared-only-identity: MI-0018 and MI-0025 disappear with their assignments', () => {
    const { scan, diff } = changes('retire-declared-only-identity');
    assert.deepEqual(diff.filter((c) => c.list === 'machineIdentities' && c.kind === 'removed').map((c) => c.key).sort(), ['MI-0018', 'MI-0025']);
    assert.equal(scan.counts.machineIdentities, 42);
    assert.equal(scan.counts.assignments, 93 - 5);
  });
});

describe('Scanner robustness', () => {
  const minimal = (files: Record<string, string>) => ({
    paths: Object.keys(files).sort(),
    read(p: string): string {
      const text = files[p];
      if (text === undefined) throw new Error(`ENOENT ${p}`);
      return text;
    },
  });

  it('refuses a repository without a manifest', () => {
    assert.throws(() => scanRepository(minimal({ 'README.md': '' }), CTX), /manifest/);
  });

  it('reports malformed YAML as a parse error and marks the scan partial instead of throwing', () => {
    const scan = scanRepository(
      minimal({
        'inventory/manifest.yaml': 'schemaVersion: 1\nsources:\n  machineIdentities:\n    declarations: inventory/identities/*.yaml\n',
        'inventory/identities/bad.yaml': 'id: [unclosed\n  : :',
      }),
      CTX
    );
    assert.equal(scan.status, 'partial');
    assert.ok(scan.warnings.some((w) => w.code === 'parse-error' && w.sourcePath === 'inventory/identities/bad.yaml'));
    assert.equal(scan.counts.machineIdentities, 0);
  });

  it('flags an identity that does not declare containsRealSecret: false and drops its credential fields', () => {
    const scan = scanRepository(
      minimal({
        'inventory/manifest.yaml': 'schemaVersion: 1\nsources:\n  machineIdentities:\n    declarations: inventory/identities/*.yaml\n',
        'inventory/identities/x.yaml': 'id: MI-0001\nname: x\ntype: api-key\ncredential:\n  secretRef: should-not-appear\n  maskedPreview: sk-live-1234\n',
      }),
      CTX
    );
    assert.ok(scan.warnings.some((w) => w.code === 'secret-flag'));
    assert.equal(scan.machineIdentities[0]!.credential.secretRef, null);
    assert.equal(scan.machineIdentities[0]!.credential.maskedPreview, null);
  });

  it('writes a scan that round-trips through JSON unchanged', () => {
    if (!available) return;
    const scan = scanWithScenario(null);
    const dir = mkdtempSync(join(tmpdir(), 'arasaka-json-'));
    temps.push(dir);
    const file = join(dir, 'scan.json');
    writeFileSync(file, JSON.stringify(scan));
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), scan);
  });
});
