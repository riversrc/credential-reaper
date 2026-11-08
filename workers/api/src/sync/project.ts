// Turns a validated scan into the rows Repository Sync persists. Pure: no I/O, no clock (callers pass `now`).
// Everything here is repository evidence. Usage, last-used time, deployment state and telemetry are never
// derived from it: lastUsedAt stays unset and no usage events are created.
import type {
  CredentialMetadata,
  IdentityStatus,
  MachineIdentity,
  PermissionGrant,
  RepositoryScan,
  ScannedIdentity,
} from '@credential-reaper/shared';
import { computeRisk, isUnowned } from '../agent/risk.ts';
import { SCAN_LIST_NAMES } from './validate.ts';

export interface RecordInput {
  list: string;
  key: string;
  projected: string;
  hash: string;
  payload: string;
  provenance: string;
}

export interface IdentitySyncArgs {
  id: string;
  name: string;
  type: string;
  owner: string;
  team: string;
  environment: string;
  status: IdentityStatus;
  riskLevel: string;
  riskScore: number;
  createdAt: string;
  tags: string[];
  description: string;
  grants: { id: string; resource: string; scope: string; grantedAt: string; grantedBy: string }[];
  dependencies: { id: string; name: string; kind: string; relationship: string }[];
  prune: boolean;
  hasCredential: boolean;
  credentialId: string;
  credentialKind: string;
  storageLocation: string;
  maskedPreview: string;
  credentialCreatedAt: string;
  lastRotatedAt: string | null;
  expiresAt: string | null;
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Row ids written into the regular inventory tables. The `rp|` prefix marks them as repository-derived. */
const grantId = (assignmentKey: string) => `rp|grant|${assignmentKey}`;
const dependencyId = (identityId: string, serviceId: string) => `rp|dep|${identityId}|${serviceId}`;
const credentialId = (identityId: string) => `rp|cred|${identityId}`;

/** One row per declared record. The hash covers content only, so a rescan that moves provenance does not look like a change. */
export async function buildRecordInputs(scan: RepositoryScan): Promise<RecordInput[]> {
  const out: RecordInput[] = [];
  for (const list of SCAN_LIST_NAMES) {
    for (const record of scan[list as keyof RepositoryScan] as unknown as { key: string; provenance: unknown[] }[]) {
      const { provenance, ...content } = record;
      const payload = JSON.stringify(content);
      const projected = list === 'assignments' ? grantId(record.key) : list === 'machineIdentities' ? record.key : '';
      out.push({ list, key: record.key, projected, hash: await sha256Hex(payload), payload, provenance: JSON.stringify(provenance) });
    }
  }
  return out;
}

const isoDate = (date: string | null): string => {
  if (!date) return '';
  const ms = Date.parse(date);
  return Number.isNaN(ms) ? '' : new Date(ms).toISOString();
};

const CREDENTIAL_KINDS: Record<string, CredentialMetadata['kind']> = {
  'api-key': 'api-key',
  'ssh-key': 'ssh-key',
  certificate: 'certificate',
  'oauth-app': 'oauth-token',
};

/** A repository declaration that says the owner left or is missing marks the identity orphaned; curated ownership overrides that. */
export function deriveStatus(owner: string, declaredOwnershipStatus: string | null, curated: boolean): IdentityStatus {
  const flagged = !curated && declaredOwnershipStatus !== null && declaredOwnershipStatus !== 'owned';
  return isUnowned(owner) || flagged ? 'orphaned' : 'active';
}

/** The repository's own person names sometimes already carry the marker, e.g. "Leo Castellan (contractor)". */
export function ownerLabel(name: string, employmentStatus: string | null): string {
  const marker = employmentStatus === 'departed' || employmentStatus === 'contractor' ? employmentStatus : null;
  return marker && !name.toLowerCase().includes(marker) ? `${name} (${marker})` : name;
}

export function declaredOwner(scan: RepositoryScan, identityId: string): { owner: string | null; team: string | null; status: string | null } {
  const ownership = scan.identityOwnership.find((o) => o.identityId === identityId);
  if (!ownership) return { owner: null, team: null, status: null };
  const person = scan.people.find((p) => p.id === ownership.primaryOwnerId);
  const team = scan.teams.find((t) => t.id === ownership.owningTeamId);
  return { owner: person ? ownerLabel(person.name, ownership.ownerEmploymentStatus) : null, team: team?.name ?? null, status: ownership.ownershipStatus };
}

/**
 * `existing` is the current row, if any. Curated ownership wins over the declaration, so risk and status are
 * computed from the owner that will actually be stored.
 */
export function buildIdentitySync(scan: RepositoryScan, identity: ScannedIdentity, existing: MachineIdentity | null, now: Date, prune: boolean): IdentitySyncArgs {
  const declared = declaredOwner(scan, identity.id);
  const curated = existing?.ownerSource === 'curated';
  const owner = curated ? existing.owner : (declared.owner ?? 'Unassigned');
  const team = curated ? existing.team : (declared.team ?? '');
  const status = deriveStatus(owner, declared.status, curated);

  const knownEnvironment = identity.environment === 'production' || identity.environment === 'staging' || identity.environment === 'development';
  const environment = knownEnvironment ? (identity.environment as MachineIdentity['environment']) : 'development';
  const tags = [...identity.tags];
  if (!knownEnvironment && identity.environment) tags.push(`env:${identity.environment}`);
  if (identity.declaredStatus && identity.declaredStatus !== 'active') tags.push(`declared:${identity.declaredStatus}`);

  const grants = scan.assignments
    .filter((a) => a.identityId === identity.id)
    .map((a) => {
      const permission = scan.permissions.find((p) => p.id === a.permissionId);
      return {
        id: grantId(a.key),
        resource: `${a.resource ?? permission?.resource ?? a.permissionId} (${a.permissionId})`,
        scope: permission?.level ?? permission?.action ?? a.permissionId,
        grantedAt: isoDate(a.grantedOn),
        grantedBy: 'unknown',
      };
    });

  const dependencies = identity.bindings.map((b) => ({
    id: dependencyId(identity.id, b.serviceId),
    name: scan.services.find((s) => s.id === b.serviceId)?.name ?? b.serviceId,
    kind: 'service',
    relationship: b.serviceId === identity.owningServiceId ? 'provides' : 'shared-with',
  }));

  const createdAt = isoDate(identity.introducedOn);
  const credential = identity.credential;
  const hasCredential = !!(credential.maskedPreview || credential.secretRef);
  const credentialRow: CredentialMetadata = {
    id: credentialId(identity.id),
    identityId: identity.id,
    kind: CREDENTIAL_KINDS[identity.type] ?? 'secret-reference',
    storageLocation: credential.secretRef ?? credential.storage ?? 'unknown',
    maskedPreview: credential.maskedPreview ?? '',
    createdAt,
    lastRotatedAt: credential.lastRotatedOn ? isoDate(credential.lastRotatedOn) : null,
    expiresAt: identity.expiresOn ? isoDate(identity.expiresOn) : null,
  };

  const projected: MachineIdentity = {
    id: identity.id,
    name: identity.name,
    type: identity.type as MachineIdentity['type'],
    owner,
    team,
    environment,
    status,
    riskLevel: 'low',
    riskScore: 0,
    createdAt,
    lastUsedAt: null,
    tags,
    description: identity.purpose ?? '',
    dataSource: 'repository',
    ownerSource: curated ? 'curated' : 'repository',
    repoState: 'present',
  };
  const permissions: PermissionGrant[] = grants.map((g) => ({ ...g, identityId: identity.id }));
  const risk = computeRisk({ identity: projected, permissions, credentials: hasCredential ? [credentialRow] : [], usageHistory: [] }, now);

  return {
    id: identity.id,
    name: projected.name,
    type: projected.type,
    owner,
    team,
    environment,
    status,
    riskLevel: risk.level,
    riskScore: risk.score,
    createdAt,
    tags,
    description: projected.description,
    grants,
    dependencies,
    prune,
    hasCredential,
    credentialId: credentialRow.id,
    credentialKind: credentialRow.kind,
    storageLocation: credentialRow.storageLocation,
    maskedPreview: credentialRow.maskedPreview,
    credentialCreatedAt: credentialRow.createdAt,
    lastRotatedAt: credentialRow.lastRotatedAt,
    expiresAt: credentialRow.expiresAt,
  };
}
