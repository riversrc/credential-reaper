// Repository Sync persistence: runs a validated scan through the SpacetimeDB reducers and reads the stored
// evidence back. Ordering matters (begin, records, identities, finish) because only `finish` may mark
// declarations as removed, and only for a complete scan.
import type {
  MachineIdentity,
  RepositoryEvidence,
  RepositoryIngestResponse,
  RepositoryScan,
  RepositoryScanCounts,
  RepositoryScanRecord,
  ScanProvenance,
  ScanWarning,
  ScannedIdentity,
  ScannedIdentityOwnership,
  ScannedPerson,
  ScannedService,
  ScannedTeam,
} from '@credential-reaper/shared';
import { computeRisk } from '../agent/risk.ts';
import { callReducer, encodeOption, sqlQuery, sqlString, type SpacetimeEnv } from '../spacetime/client.js';
import { fetchCredentials, fetchIdentities, fetchIdentity, fetchPermissions, fetchUsageEvents } from '../spacetime/repository.js';
import { buildIdentitySync, buildRecordInputs, deriveStatus, ownerLabel, type RecordInput } from './project.ts';

const CHUNK_CHARS = 200_000;

interface RepoScanRow {
  id: string;
  repo: string;
  commitSha: string | null;
  scannedAt: string;
  ingestedAt: string;
  status: 'complete' | 'partial';
  countsJson: string;
  warningsJson: string;
  added: number;
  changed: number;
  unchanged: number;
  reappeared: number;
  removed: number;
  finished: boolean;
  persistedJson: string;
}

interface RepoRecordRow {
  id: string;
  repo: string;
  list: string;
  key: string;
  state: 'present' | 'removed';
  payload: string;
  provenance: string;
  firstSeenScanId: string;
  lastSeenScanId: string;
}

const toScanRecord = (row: RepoScanRow): RepositoryScanRecord => ({
  id: row.id,
  repo: row.repo,
  commitSha: row.commitSha,
  scannedAt: row.scannedAt,
  ingestedAt: row.ingestedAt,
  status: row.status,
  counts: JSON.parse(row.countsJson) as RepositoryScanCounts,
  warnings: JSON.parse(row.warningsJson) as ScanWarning[],
  added: row.added,
  changed: row.changed,
  unchanged: row.unchanged,
  reappeared: row.reappeared,
  removed: row.removed,
  finished: row.finished,
  persisted: JSON.parse(row.persistedJson) as Record<string, number>,
});

async function fetchScanRows(env: SpacetimeEnv): Promise<RepoScanRow[]> {
  const rows = await sqlQuery<RepoScanRow>(env, 'SELECT * FROM v_repo_scan');
  return rows.sort((a, b) => b.ingestedAt.localeCompare(a.ingestedAt));
}

export async function fetchRepoScans(env: SpacetimeEnv): Promise<RepositoryScanRecord[]> {
  return (await fetchScanRows(env)).map(toScanRecord);
}

function chunkRecords(records: RecordInput[]): RecordInput[][] {
  const chunks: RecordInput[][] = [];
  let current: RecordInput[] = [];
  let size = 0;
  for (const r of records) {
    const weight = r.payload.length + r.provenance.length + r.key.length + 200;
    if (current.length > 0 && size + weight > CHUNK_CHARS) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(r);
    size += weight;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

export async function ingestScan(env: SpacetimeEnv, scan: RepositoryScan, now: Date): Promise<RepositoryIngestResponse> {
  const ingestedAt = now.toISOString();
  const scanId = `scan-${now.getTime().toString(36)}-${(scan.commitSha ?? 'nocommit').slice(0, 12)}`;
  const records = await buildRecordInputs(scan);
  const existing = new Map((await fetchIdentities(env)).map((i) => [i.id, i]));

  await callReducer(env, 'begin_repo_scan', {
    id: scanId,
    repo: scan.repo,
    commitSha: encodeOption(scan.commitSha),
    scannedAt: scan.scannedAt,
    ingestedAt,
    status: scan.status,
    countsJson: JSON.stringify(scan.counts),
    warningsJson: JSON.stringify(scan.warnings),
  });

  for (const chunk of chunkRecords(records)) {
    await callReducer(env, 'ingest_repo_records', { scanId, records: chunk });
  }

  const skipped: { id: string; reason: string }[] = [];
  let synced = 0;
  for (const identity of scan.machineIdentities) {
    const current = existing.get(identity.id) ?? null;
    if (current && current.dataSource !== 'repository') {
      skipped.push({ id: identity.id, reason: `an existing ${current.dataSource} identity already uses this id` });
      continue;
    }
    const args = buildIdentitySync(scan, identity, current, now, scan.status === 'complete');
    await callReducer(env, 'sync_repo_identity', {
      ...args,
      grants: args.grants.map(({ grantedAt, grantedBy, ...rest }) => ({ ...rest, granted_at: grantedAt, granted_by: grantedBy })),
      lastRotatedAt: encodeOption(args.lastRotatedAt),
      expiresAt: encodeOption(args.expiresAt),
    });
    synced++;
  }

  await callReducer(env, 'finish_repo_scan', { scanId });
  const row = (await sqlQuery<RepoScanRow>(env, `SELECT * FROM v_repo_scan WHERE id = ${sqlString(scanId)}`))[0];
  return { scan: toScanRecord(row), identities: { declared: scan.machineIdentities.length, synced, skipped } };
}

// ---- reading evidence back -------------------------------------------------------------------------

async function fetchRecordsById(env: SpacetimeEnv, repo: string, refs: { list: string; key: string }[]): Promise<RepoRecordRow[]> {
  const ids = [...new Set(refs.map((r) => `${repo}|${r.list}|${r.key}`))];
  const out: RepoRecordRow[] = [];
  for (let i = 0; i < ids.length; i += 25) {
    const where = ids.slice(i, i + 25).map((id) => `id = ${sqlString(id)}`).join(' OR ');
    out.push(...(await sqlQuery<RepoRecordRow>(env, `SELECT * FROM v_repo_record WHERE ${where}`)));
  }
  return out;
}

const parse = <T>(row: RepoRecordRow | undefined): (T & { provenance: ScanProvenance[] }) | null =>
  row ? { ...(JSON.parse(row.payload) as T), provenance: JSON.parse(row.provenance) as ScanProvenance[] } : null;

function declaredFrom(ownership: ScannedIdentityOwnership | null, person: ScannedPerson | null, team: ScannedTeam | null) {
  if (!ownership) return null;
  return {
    owner: person ? ownerLabel(person.name, ownership.ownerEmploymentStatus) : null,
    team: team?.name ?? null,
    ownershipStatus: ownership.ownershipStatus,
    ownerEmploymentStatus: ownership.ownerEmploymentStatus,
    lastReviewedOn: ownership.lastReviewedOn,
    note: ownership.note,
  };
}

/** Everything stored about one repository identity, or null for identities that did not come from a scan. */
export async function fetchRepositoryEvidence(env: SpacetimeEnv, identity: MachineIdentity): Promise<RepositoryEvidence | null> {
  if (identity.dataSource !== 'repository') return null;
  const found = await sqlQuery<RepoRecordRow>(
    env,
    `SELECT * FROM v_repo_record WHERE list = 'machineIdentities' AND key = ${sqlString(identity.id)}`
  );
  const identityRow = found[0];
  if (!identityRow) return null;
  const repo = identityRow.repo;
  const declared = parse<ScannedIdentity>(identityRow)!;

  const [ownershipRow] = await fetchRecordsById(env, repo, [{ list: 'identityOwnership', key: identity.id }]);
  const ownership = parse<ScannedIdentityOwnership>(ownershipRow);
  const refs = [
    ...(ownership?.primaryOwnerId ? [{ list: 'people', key: ownership.primaryOwnerId }] : []),
    ...(ownership?.owningTeamId ? [{ list: 'teams', key: ownership.owningTeamId }] : []),
    ...(declared.introducedBy ? [{ list: 'people', key: declared.introducedBy }] : []),
    ...declared.bindings.map((b) => ({ list: 'services', key: b.serviceId })),
    ...declared.actsOnEndpointKeys.map((key) => ({ list: 'endpoints', key })),
  ];
  const [related, historyRows, scans] = await Promise.all([
    fetchRecordsById(env, repo, refs),
    sqlQuery<RepoRecordRow>(env, `SELECT * FROM v_repo_record WHERE list = 'permissionHistory'`),
    fetchScanRows(env),
  ]);
  const byRef = (list: string, key: string | null) => (key ? related.find((r) => r.list === list && r.key === key) : undefined);

  const person = parse<ScannedPerson>(byRef('people', ownership?.primaryOwnerId ?? null));
  const team = parse<ScannedTeam>(byRef('teams', ownership?.owningTeamId ?? null));
  const introducer = parse<ScannedPerson>(byRef('people', declared.introducedBy));
  const declaredOwnership = declaredFrom(ownership, person, team);
  const scanTime = (id: string) => scans.find((s) => s.id === id)?.ingestedAt ?? null;

  const ownershipDiffers =
    identity.ownerSource === 'curated' && declaredOwnership !== null && (declaredOwnership.owner !== identity.owner || (declaredOwnership.team ?? '') !== identity.team);

  return {
    repo,
    state: identityRow.state,
    firstSeenAt: scanTime(identityRow.firstSeenScanId),
    lastSeenAt: scanTime(identityRow.lastSeenScanId),
    commitSha: declared.provenance[0]?.commitSha ?? null,
    declaredStatus: declared.declaredStatus,
    purpose: declared.purpose,
    introducedOn: declared.introducedOn,
    introducedBy: introducer?.name ?? declared.introducedBy,
    credential: { storage: declared.credential.storage, secretRef: declared.credential.secretRef, lastRotatedOn: declared.credential.lastRotatedOn, expiresOn: declared.expiresOn },
    declaredOwnership: declaredOwnership && ownership ? { ...declaredOwnership, provenance: ownership.provenance } : null,
    ownershipDiffers,
    services: declared.bindings.map((b) => ({
      serviceId: b.serviceId,
      name: parse<ScannedService>(byRef('services', b.serviceId))?.name ?? b.serviceId,
      mode: b.mode,
      usage: b.usage,
    })),
    endpoints: declared.actsOnEndpointKeys.flatMap((key) => {
      const e = parse<{ method: string; path: string; authenticated: boolean }>(byRef('endpoints', key));
      return e ? [{ key, method: e.method, path: e.path, authenticated: e.authenticated }] : [];
    }),
    permissionHistory: historyRows
      .map((r) => parse<{ identityId: string; permissionId: string | null; date: string | null; change: string | null; ticket: string | null; note: string | null }>(r)!)
      .filter((h) => h.identityId === identity.id)
      .map(({ date, change, permissionId, ticket, note }) => ({ date, change, permissionId, ticket, note }))
      .sort((a, b) => (a.date ?? '').localeCompare(b.date ?? '')),
    provenance: declared.provenance,
  };
}

/** Pins ownership as curated (or hands it back to the repository declaration) and recomputes risk from the stored rows. */
export async function updateOwnership(
  env: SpacetimeEnv,
  identity: MachineIdentity,
  request: { owner: string; team: string; revert: boolean; actor: string },
  now: Date
): Promise<MachineIdentity | null> {
  let owner = request.owner;
  let team = request.team;
  let declaredStatus: string | null = null;
  if (request.revert) {
    const evidence = await fetchRepositoryEvidence(env, identity);
    owner = evidence?.declaredOwnership?.owner ?? 'Unassigned';
    team = evidence?.declaredOwnership?.team ?? '';
    declaredStatus = evidence?.declaredOwnership?.ownershipStatus ?? null;
  }
  const curated = !request.revert;
  const status = deriveStatus(owner, declaredStatus, curated);
  const [permissions, credentials, usageHistory] = await Promise.all([
    fetchPermissions(env, identity.id),
    fetchCredentials(env, identity.id),
    fetchUsageEvents(env, identity.id),
  ]);
  const risk = computeRisk({ identity: { ...identity, owner, team, status }, permissions, credentials, usageHistory }, now);
  const details = curated
    ? `Ownership of ${identity.name} set to ${owner}${team ? ` (${team})` : ''} by ${request.actor}; was ${identity.owner}${identity.team ? ` (${identity.team})` : ''}. Repository scans no longer replace it.`
    : `Ownership of ${identity.name} handed back to the repository declaration: ${owner}${team ? ` (${team})` : ''}; was ${identity.owner}.`;
  await callReducer(env, 'set_identity_ownership', {
    identityId: identity.id,
    owner,
    team,
    ownerSource: curated ? 'curated' : 'repository',
    status,
    riskLevel: risk.level,
    riskScore: risk.score,
    actor: request.actor,
    timestamp: now.toISOString(),
    auditId: `own-${identity.id}-${now.getTime().toString(36)}`,
    details,
  });
  return fetchIdentity(env, identity.id);
}
