import type { RepositoryScan } from '@credential-reaper/shared';

export const SCAN_LISTS = [
  'services',
  'endpoints',
  'machineIdentities',
  'permissions',
  'assignments',
  'permissionHistory',
  'teams',
  'people',
  'serviceOwnership',
  'identityOwnership',
  'serviceDependencies',
  'providerDependencies',
  'externalProviders',
  'gatewayRoutes',
  'codeowners',
] as const;

export type ScanListName = (typeof SCAN_LISTS)[number];
type ScanRecord = { key: string; provenance: unknown } & Record<string, unknown>;

export interface ScanChange {
  list: ScanListName;
  key: string;
  kind: 'added' | 'removed' | 'modified';
  changedFields: string[];
  before: ScanRecord | null;
  after: ScanRecord | null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/** Compares two scans by record key. Provenance is ignored: a new commit or timestamp alone is not a change. */
export function diffScans(before: RepositoryScan, after: RepositoryScan): ScanChange[] {
  const changes: ScanChange[] = [];
  for (const list of SCAN_LISTS) {
    const prior = new Map((before[list] as unknown as ScanRecord[]).map((r) => [r.key, r]));
    const next = new Map((after[list] as unknown as ScanRecord[]).map((r) => [r.key, r]));
    for (const [key, record] of next) {
      const old = prior.get(key);
      if (!old) {
        changes.push({ list, key, kind: 'added', changedFields: [], before: null, after: record });
        continue;
      }
      const fields = [...new Set([...Object.keys(old), ...Object.keys(record)])].filter(
        (f) => f !== 'provenance' && f !== 'key' && canonical(old[f]) !== canonical(record[f])
      );
      if (fields.length > 0) changes.push({ list, key, kind: 'modified', changedFields: fields.sort(), before: old, after: record });
    }
    for (const [key, record] of prior) {
      if (!next.has(key)) changes.push({ list, key, kind: 'removed', changedFields: [], before: record, after: null });
    }
  }
  return changes;
}
