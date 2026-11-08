import type { FindingBasis, RiskLevel } from '@credential-reaper/shared';

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

export function BasisTag({ basis }: { basis: FindingBasis }) {
  const tone = basis === 'confirmed' ? 'low' : basis === 'inferred' ? 'medium' : 'neutral';
  return <span className={`badge badge-${tone} badge-basis-${basis}`}>{basis}</span>;
}

export function AutomationTag({ automatable }: { automatable: boolean }) {
  return <span className={`badge ${automatable ? 'badge-auto' : 'badge-manual'}`}>{automatable ? 'auto' : 'manual'}</span>;
}
