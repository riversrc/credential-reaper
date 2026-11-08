import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import type { IdentityStatus, IdentityType } from '@credential-reaper/shared';
import { useLandingData } from '../hooks/useLandingData';
import { DAY_MS, stateAt, totalDays, type EffectiveState } from '../lib/networkGraph';
import { DemoChip } from '../components/DemoChip';
import { FilterSelect } from '../components/FilterSelect';
import { IdentityTable } from '../components/IdentityTable';
import { StateMessage } from '../components/StateMessage';
import { ArrowRight } from '../components/Glyph';
import { TYPE_LABEL } from '../lib/typeLabels';
import { MapLegend, NetworkMap } from '../components/map/NetworkMap';
import { MapOverlay } from '../components/map/MapOverlay';
import { TimeScrubber } from '../components/map/TimeScrubber';
import { SecurityActivity } from '../components/SecurityActivity';
import { EventsPanel, HygienePanel } from '../components/landing/HudPanels';
import '../landing.css';

type Period = 'actual' | '30d' | 'all';

const PERIODS = [
  { value: 'all', label: 'All time' },
  { value: '30d', label: '30D' },
  { value: 'actual', label: 'Actual' },
];
const STATUSES = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'stale', label: 'Stale' },
  { value: 'orphaned', label: 'Orphaned' },
  { value: 'retired', label: 'Retired' },
];
const TYPE_OPTIONS = [{ value: 'all', label: 'All' }, ...(Object.keys(TYPE_LABEL) as IdentityType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))];

export function Landing() {
  const { data, reload } = useLandingData();
  const { identities, details, investigations, plans, audit } = data;
  const [nowMs] = useState(() => Date.now());

  const [view, setView] = useState<'map' | 'list'>('map');
  const [period, setPeriod] = useState<Period>('all');
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');
  const [playing, setPlaying] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [focusedId, setFocusedId] = useState<string | null>(null);

  const earliest = useMemo(() => identities.reduce((m, i) => Math.min(m, Date.parse(i.createdAt)), nowMs), [identities, nowMs]);
  const startMs = period === 'actual' ? nowMs : period === '30d' ? nowMs - 30 * DAY_MS : earliest;
  const max = totalDays(startMs, nowMs);
  const [dayRaw, setDay] = useState(Number.MAX_SAFE_INTEGER);
  const day = Math.min(dayRaw, max);
  const atPresent = day >= max;
  const at = atPresent ? nowMs : startMs + day * DAY_MS;

  const retiredAt = useMemo(() => {
    const map: Record<string, number> = {};
    for (const a of audit ?? []) if (a.action === 'identity-retired' && a.identityId) map[a.identityId] = Date.parse(a.timestamp);
    return map;
  }, [audit]);

  const states = useMemo(() => {
    const out: Record<string, EffectiveState> = {};
    for (const i of identities) out[i.id] = stateAt(i, details[i.id], at, retiredAt[i.id], atPresent);
    return out;
  }, [identities, details, at, retiredAt, atPresent]);

  const dimmedIds = useMemo(() => {
    const out = new Set<string>();
    for (const i of identities) {
      const s = states[i.id];
      if (s === 'hidden') continue;
      if ((typeFilter !== 'all' && i.type !== typeFilter) || (statusFilter !== 'all' && s !== (statusFilter as IdentityStatus))) out.add(i.id);
    }
    return out;
  }, [identities, states, typeFilter, statusFilter]);

  const createdMarks = useMemo(() => identities.map((i) => ({ id: i.id, name: i.name, ms: Date.parse(i.createdAt) })), [identities]);
  const shownCount = identities.filter((i) => states[i.id] !== 'hidden' && !dimmedIds.has(i.id)).length;

  const changePeriod = useCallback((p: string) => {
    setPeriod(p as Period);
    setPlaying(false);
    setDay(Number.MAX_SAFE_INTEGER);
  }, []);

  const selected = identities.find((i) => i.id === selectedId) ?? null;
  const focused = identities.find((i) => i.id === focusedId) ?? null;

  const orphaned = identities.filter((i) => i.status === 'orphaned').length;
  const critical = identities.filter((i) => i.riskLevel === 'critical').length;
  const invCount = investigations?.length ?? null;
  const simulatedCount = plans ? plans.filter((p) => p.status === 'simulated').length : null;
  const proposedCount = plans ? plans.filter((p) => p.status === 'proposed' || p.status === 'approved').length : null;
  const toolCalls = investigations ? investigations.reduce((s, i) => s + (i.toolTrace?.length ?? 0), 0) : null;
  const num = (v: number | null) => (v === null ? '—' : v);

  return (
    <main className="landing-main">
      <section className="hero">
        <div className="hero-copy">
          <h1 className="display-xl">
            <span>Every key+</span>
            <span>Every bot+</span>
            <span>Nothing forgotten+</span>
          </h1>
          <p className="hero-body">
            Find every <strong>machine identity</strong>, investigate the stale ones, retire them safely. Dry run first.
          </p>
          <div className="hero-actions">
            <Link to="/grid" className="btn">
              Open the grid <ArrowRight />
            </Link>
            <Link to="/investigations" className="btn btn-secondary">
              Start an investigation
            </Link>
          </div>
          <div className="term-box hero-term" aria-live="polite">
            <div className="cmd">reaper scan</div>
            {data.status === 'loading' && (
              <div className="out">
                scanning<span className="cursor" aria-hidden="true" />
              </div>
            )}
            {data.status === 'error' && <div className="bad">! scan failed: {data.error}</div>}
            {data.status === 'ready' && (
              <>
                <div className="out">
                  {identities.length} identities · {orphaned} orphaned · {critical} critical
                </div>
                <div className={critical + orphaned > 0 ? 'bad' : 'ok'}>{critical + orphaned > 0 ? 'attention' : 'ok'}</div>
              </>
            )}
          </div>
        </div>

        <div className="hero-map">
          <div className="map-panel">
            <div className="map-head">
              <h3>Network map</h3>
              <DemoChip />
              <span className="muted-sm map-count" role="status">
                {data.status === 'ready' ? `${shownCount} of ${identities.length} shown` : ''}
              </span>
              <div className="seg" role="group" aria-label="View">
                <button type="button" aria-pressed={view === 'map'} onClick={() => setView('map')}>
                  Map
                </button>
                <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
                  List
                </button>
              </div>
            </div>

            {data.status === 'loading' && (
              <div className="map-placeholder">
                <StateMessage kind="loading">loading machine identities…</StateMessage>
              </div>
            )}
            {data.status === 'error' && (
              <div className="map-placeholder">
                <StateMessage
                  kind="error"
                  actions={
                    <button type="button" className="btn btn-sm" onClick={reload}>
                      Retry
                    </button>
                  }
                >
                  {data.error}
                </StateMessage>
              </div>
            )}
            {data.status === 'ready' && identities.length === 0 && (
              <div className="map-placeholder">
                <StateMessage kind="empty">no machine identities on record.</StateMessage>
              </div>
            )}

            {data.status === 'ready' && identities.length > 0 && (
              <>
                {view === 'map' ? (
                  <NetworkMap
                    identities={identities}
                    details={details}
                    states={states}
                    dimmedIds={dimmedIds}
                    selectedId={selectedId}
                    onSelect={setSelectedId}
                    onFocusChange={setFocusedId}
                  />
                ) : (
                  <IdentityTable
                    identities={identities.filter((i) => states[i.id] !== 'hidden')}
                    dimIds={dimmedIds}
                  />
                )}
                {view === 'map' && <MapLegend />}
                {data.failedDetails > 0 && (
                  <p className="muted-sm map-note" role="status">
                    {data.failedDetails} identit{data.failedDetails === 1 ? 'y' : 'ies'} shown without dependency links (load failed).
                  </p>
                )}
                <TimeScrubber
                  startMs={startMs}
                  nowMs={nowMs}
                  day={day}
                  onDayChange={setDay}
                  playing={playing}
                  onPlayingChange={setPlaying}
                  createdMarks={createdMarks}
                  locked={period === 'actual'}
                />
                <div className="filter-bar map-filters">
                  <FilterSelect label="Period" value={period} options={PERIODS} onChange={changePeriod} />
                  <FilterSelect label="Type" value={typeFilter} options={TYPE_OPTIONS} onChange={setTypeFilter} />
                  <FilterSelect label="Status" value={statusFilter} options={STATUSES} onChange={setStatusFilter} />
                </div>
              </>
            )}
          </div>
        </div>
      </section>

      <section className="kpis" aria-label="Inventory summary">
        <Kpi label="Identities" value={data.status === 'ready' ? identities.length : null} />
        <Kpi label="Orphaned" value={data.status === 'ready' ? orphaned : null} tone={orphaned ? 'bad' : undefined} />
        <Kpi label="Critical" value={data.status === 'ready' ? critical : null} tone={critical ? 'bad' : undefined} />
        <Kpi label="Investigations" value={invCount} />
        <Kpi label="Simulated" value={simulatedCount} />
      </section>

      <section className="hud" aria-label="Overview panels">
        <HygienePanel identities={identities} investigations={investigations} plans={plans} />
        <SecurityActivity compact />
        <EventsPanel audit={audit} focused={focused} focusedDetail={focused ? details[focused.id] : undefined} />
      </section>

      <section className="verbs" aria-label="How it works">
        <Verb
          label="Investigate"
          command="reaper investigate <identity>"
          output={`${num(toolCalls)} tool calls recorded`}
          prose={
            <>
              Reads ownership, permissions, dependencies and usage. Risk is <strong>backend-computed</strong>.
            </>
          }
          metric={invCount}
          unit="investigations"
        />
        <Verb
          label="Remediate"
          command="reaper plan <identity>"
          output={`${num(proposedCount)} open plans: retire, rotate, migrate or monitor`}
          prose={
            <>
              Ordered steps, automatable or manual. <strong>Nothing runs</strong> until a person acts.
            </>
          }
          metric={proposedCount}
          unit="open plans"
        />
        <Verb
          label="Simulate"
          command="reaper simulate <plan> --dry-run"
          output="no live credential is touched"
          prose={
            <>
              Marks a plan <strong>dry-run complete</strong> and logs it to the audit trail.
            </>
          }
          metric={simulatedCount}
          unit="simulated"
        />
      </section>

      {selected && (
        <MapOverlay
          identity={selected}
          detail={details[selected.id]}
          investigations={investigations}
          audit={audit}
          onClose={() => setSelectedId(null)}
        />
      )}
    </main>
  );
}

function Kpi({ label, value, tone }: { label: string; value: number | null; tone?: 'bad' }) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className={`lcd kpi-value${tone ? ` is-${tone}` : ''}`}>{value ?? '—'}</span>
    </div>
  );
}

function Verb({
  label,
  command,
  output,
  prose,
  metric,
  unit,
}: {
  label: string;
  command: string;
  output: string;
  prose: ReactNode;
  metric: number | null;
  unit: string;
}) {
  return (
    <div className="verb">
      <h2 className="verb-label">{label}+</h2>
      <div className="term-box">
        <div className="cmd">{command}</div>
        <div className="out">{output}</div>
      </div>
      <p className="verb-prose">{prose}</p>
      <div className="verb-metric">
        <span className="lcd">{metric ?? '—'}</span>
        <span className="muted-sm">{unit}</span>
      </div>
    </div>
  );
}
