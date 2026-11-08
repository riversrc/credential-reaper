import type { MachineIdentity } from '@credential-reaper/shared';

type SourceFields = Pick<MachineIdentity, 'dataSource' | 'repoState'>;

export function SourceTag({ identity }: { identity: SourceFields }) {
  if (identity.dataSource !== 'repository') return <span className="src-tag src-demo" title="Seeded demonstration data">Demo</span>;
  if (identity.repoState === 'removed') {
    return (
      <span className="src-tag src-removed" title="No longer declared in the repository. The credential has not been retired.">
        Removed from repo
      </span>
    );
  }
  return (
    <span className="src-tag src-repo" title="Discovered from repository declarations">
      Repo
    </span>
  );
}

/** Repository scans carry no runtime evidence, so "never used" would be a claim we cannot make. */
export function lastUsedLabel(identity: Pick<MachineIdentity, 'dataSource' | 'lastUsedAt'>, format: (iso: string) => string): string {
  if (identity.lastUsedAt) return format(identity.lastUsedAt);
  return identity.dataSource === 'repository' ? 'unknown' : 'never';
}
