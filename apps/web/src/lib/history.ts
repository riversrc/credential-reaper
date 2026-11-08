import type { AuditEvent, MachineIdentity } from '@credential-reaper/shared';
import type { IdentityDetail } from './networkGraph';

export const ACTION_TITLE: Record<AuditEvent['action'], string> = {
  'investigation-started': 'Investigation started',
  'investigation-completed': 'Investigation completed',
  'investigation-failed': 'Investigation failed',
  'remediation-proposed': 'Remediation proposed',
  'remediation-approved': 'Remediation approved',
  'remediation-simulated': 'Remediation simulated',
  'remediation-rejected': 'Remediation rejected',
  'identity-retired': 'Identity retired',
  'ownership-curated': 'Ownership updated',
  'repo-scan-ingested': 'Repository scan ingested',
};

export interface HistoryEntry {
  ts: string;
  title: string;
  meta: string;
}

/** Newest first: createdAt, lastUsedAt, usage events and this identity's audit events. */
export function buildHistory(identity: MachineIdentity, detail: IdentityDetail | undefined, audit: AuditEvent[] | null): HistoryEntry[] {
  const entries: HistoryEntry[] = [{ ts: identity.createdAt, title: 'Identity created', meta: identity.environment }];
  if (identity.lastUsedAt) entries.push({ ts: identity.lastUsedAt, title: 'Last used', meta: 'last observed use' });
  for (const u of detail?.usageHistory ?? []) entries.push({ ts: u.timestamp, title: `${u.action} · ${u.result}`, meta: u.source });
  for (const a of audit ?? []) if (a.identityId === identity.id) entries.push({ ts: a.timestamp, title: ACTION_TITLE[a.action], meta: a.details });
  return entries.sort((a, b) => b.ts.localeCompare(a.ts));
}

export const formatStamp = (iso: string) =>
  new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
