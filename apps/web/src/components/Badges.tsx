import type { RiskLevel } from '@credential-reaper/shared';

export function RiskBadge({ level }: { level: RiskLevel }) {
  return <span className={`badge badge-${level}`}>{level}</span>;
}

export function StatusBadge({ status }: { status: string }) {
  const toneMap: Record<string, string> = {
    active: 'low',
    stale: 'medium',
    orphaned: 'critical',
    retired: 'neutral',
    queued: 'neutral',
    running: 'medium',
    completed: 'low',
    failed: 'critical',
    proposed: 'neutral',
    approved: 'medium',
    simulated: 'low',
    rejected: 'critical',
  };
  const tone = toneMap[status] ?? 'neutral';
  return <span className={`badge badge-${tone}`}>{status}</span>;
}
