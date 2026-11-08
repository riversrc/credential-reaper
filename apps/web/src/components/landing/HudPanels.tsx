import type { AuditEvent, Investigation, MachineIdentity, RemediationPlan, RiskLevel } from '@credential-reaper/shared';
import { Panel } from '../Panel';
import { StateMessage } from '../StateMessage';
import { DemoChip } from '../DemoChip';
import { ACTION_TITLE, buildHistory, formatStamp } from '../../lib/history';
import type { IdentityDetail } from '../../lib/networkGraph';

const PIPS: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };

export function Pips({ level }: { level: RiskLevel }) {
  return (
    <span className={`pips risk-${level}`} role="img" aria-label={`${level} risk`}>
      {[1, 2, 3, 4].map((n) => (
        <i key={n} className={n <= PIPS[level] ? 'on' : undefined} />
      ))}
    </span>
  );
}

interface HygieneProps {
  identities: MachineIdentity[];
  investigations: Investigation[] | null;
  plans: RemediationPlan[] | null;
}

export function HygienePanel({ identities, investigations, plans }: HygieneProps) {
  const score = identities.length ? Math.round(100 - identities.reduce((s, i) => s + i.riskScore, 0) / identities.length) : null;
  const orphaned = identities.filter((i) => i.status === 'orphaned').length;
  const investigated = investigations ? new Set(investigations.filter((i) => i.status === 'completed').map((i) => i.identityId)).size : null;
  const simulated = plans ? plans.filter((p) => p.status === 'simulated').length : null;
  const chip = (label: string, value: number | null) => (
    <li className={value ? undefined : 'is-off'}>
      <span className="lcd">{value ?? '—'}</span>
      <span className="muted-sm">{label}</span>
    </li>
  );
  return (
    <Panel title="Hygiene score" bracketed actions={<DemoChip />}>
      <div className="hygiene">
        <span className="lcd hygiene-score">{score ?? '—'}</span>
        <p className="muted-sm">
          100 minus mean risk across {identities.length} identities. Not a compliance rating.
        </p>
      </div>
      <ul className="stat-chips">
        {chip('Orphaned', orphaned)}
        {chip('Investigated', investigated)}
        {chip('Simulated', simulated)}
      </ul>
    </Panel>
  );
}

interface EventsProps {
  audit: AuditEvent[] | null;
  focused: MachineIdentity | null;
  focusedDetail: IdentityDetail | undefined;
}

export function EventsPanel({ audit, focused, focusedDetail }: EventsProps) {
  const entries = focused
    ? buildHistory(focused, focusedDetail, audit).map((h) => ({ key: `${h.ts}${h.title}`, ts: h.ts, title: h.title, meta: h.meta }))
    : (audit ?? []).slice(0, 12).map((a) => ({
        key: a.id,
        ts: a.timestamp,
        title: ACTION_TITLE[a.action],
        meta: `${a.identityName ?? 'system'} · ${a.details}`,
      }));
  return (
    <Panel title={focused ? `History · ${focused.name}` : 'Events log'} bracketed>
      {audit === null && <StateMessage kind="error">audit events could not be loaded.</StateMessage>}
      {audit !== null && entries.length === 0 && <StateMessage kind="empty">no audit events yet.</StateMessage>}
      <ol className="events fade-bottom" tabIndex={0} aria-label={focused ? `History of ${focused.name}` : 'Latest audit events'}>
        {entries.map((e) => (
          <li key={e.key} className="bracketed event-card">
            <strong>{e.title}</strong>
            <span className="muted-sm event-meta">{e.meta}</span>
            <span className="muted-sm">{formatStamp(e.ts)}</span>
          </li>
        ))}
      </ol>
    </Panel>
  );
}
