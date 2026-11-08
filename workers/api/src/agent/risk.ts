// Deterministic risk scoring. The AI never produces or adjusts these numbers:
// the Worker computes them from rows read out of SpacetimeDB, and the same
// input always yields the same score.
import type {
  CredentialMetadata,
  MachineIdentity,
  PermissionGrant,
  RemediationAction,
  RiskAssessment,
  UsageEvent,
} from '@credential-reaper/shared';

const DAY_MS = 24 * 60 * 60 * 1000;

export interface RiskInput {
  identity: MachineIdentity;
  permissions: PermissionGrant[];
  credentials: CredentialMetadata[];
  usageHistory: UsageEvent[];
}

export interface RiskResult extends RiskAssessment {
  suggestedAction: RemediationAction | 'no-action';
}

export function isUnowned(owner: string): boolean {
  return /^(unassigned|unknown|none|n\/a|-)?$/i.test(owner.trim());
}

export function isExternalOwner(identity: Pick<MachineIdentity, 'owner' | 'tags'>): boolean {
  return /\b(ext\.?|external|contractor|vendor)\b/i.test(identity.owner) || identity.tags.includes('contractor');
}

export function daysSince(iso: string | null, now: Date): number | null {
  if (!iso) return null;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? null : Math.floor((now.getTime() - t) / DAY_MS);
}

/** Most recent evidence of use: the later of the identity's lastUsedAt and its newest usage event. */
export function lastActivityAt(identity: MachineIdentity, usageHistory: UsageEvent[]): string | null {
  const stamps = [identity.lastUsedAt, ...usageHistory.map((u) => u.timestamp)].filter((s): s is string => !!s);
  return stamps.length === 0 ? null : stamps.reduce((a, b) => (a > b ? a : b));
}

export function computeRisk(input: RiskInput, now: Date = new Date()): RiskResult {
  const { identity, permissions, credentials, usageHistory } = input;
  const factors: string[] = [];
  let score = 0;
  const add = (points: number, reason: string) => {
    score += points;
    factors.push(`+${points} ${reason}`);
  };

  const unowned = isUnowned(identity.owner);
  if (unowned) add(30, `no assigned owner (owner = "${identity.owner}")`);
  else if (isExternalOwner(identity)) add(10, `owner is external or a contractor (owner = "${identity.owner}")`);

  const idleDays = daysSince(lastActivityAt(identity, usageHistory), now);
  // A repository scan carries no runtime evidence, so absent usage is unknown rather than evidence of dormancy.
  const usageUnknown = idleDays === null && identity.dataSource === 'repository';
  if (usageUnknown) factors.push('+0 usage unknown: repository scans carry no runtime evidence');
  else if (idleDays === null) add(25, 'no usage ever observed');
  else if (idleDays > 365) add(25, `dormant for ${idleDays} days (over 365)`);
  else if (idleDays > 180) add(18, `dormant for ${idleDays} days (over 180)`);
  else if (idleDays > 90) add(10, `dormant for ${idleDays} days (over 90)`);

  if (permissions.some((p) => /^(admin|owner|\*)$/i.test(p.scope))) {
    add(20, 'holds an administrative or wildcard scope');
  } else if (permissions.some((p) => /^(write|deploy|delete)$/i.test(p.scope))) {
    add(8, 'holds a write or deploy scope');
  }
  if (permissions.length > 3) add(5, `${permissions.length} separate permission grants`);

  const expired = credentials.filter((c) => c.expiresAt && new Date(c.expiresAt).getTime() < now.getTime());
  if (expired.length > 0) add(10, `${expired.length} credential(s) past expiry but still on record`);
  const unrotated = credentials.filter((c) => !c.lastRotatedAt && (daysSince(c.createdAt, now) ?? 0) > 365);
  if (unrotated.length > 0) add(10, `${unrotated.length} credential(s) never rotated in over a year`);

  if (identity.environment === 'production') add(10, 'production environment');
  if (identity.tags.some((t) => /^(pci|pii|phi|sox)/i.test(t))) add(10, 'tagged as handling regulated data');

  const newest = [...usageHistory].sort((a, b) => b.timestamp.localeCompare(a.timestamp))[0];
  if (newest && newest.result !== 'success') add(3, `most recent usage event ended in "${newest.result}"`);
  if (usageHistory.some((u) => /^unknown/i.test(u.source))) add(5, 'usage from an unidentified source');

  score = Math.min(100, score);
  const level: RiskAssessment['level'] = score >= 80 ? 'critical' : score >= 60 ? 'high' : score >= 35 ? 'medium' : 'low';

  const dormant = idleDays === null ? !usageUnknown : idleDays > 180;
  let suggestedAction: RiskResult['suggestedAction'];
  if (dormant && (unowned || score >= 60)) suggestedAction = 'retire';
  else if (unowned) suggestedAction = 'migrate';
  else if (expired.length > 0 || unrotated.length > 0) suggestedAction = 'rotate';
  else if (score >= 35) suggestedAction = 'monitor';
  else suggestedAction = 'no-action';

  return { score, level, factors, suggestedAction };
}
