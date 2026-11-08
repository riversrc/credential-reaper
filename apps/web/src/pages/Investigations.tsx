import { useEffect, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Investigation, MachineIdentity } from '@credential-reaper/shared';
import { ApiRequestError, NetworkError, fetchIdentities, fetchInvestigations, startInvestigation } from '../api/client';
import { FilterSelect } from '../components/FilterSelect';
import { InvestigationActivityPanel } from '../components/InvestigationActivityPanel';
import { InvestigationCard } from '../components/InvestigationCard';
import { StateMessage } from '../components/StateMessage';
import type { ActivityOutcome } from '../lib/investigationActivity';
import { uuid } from '../lib/uuid';

const REQUESTED_BY = 'workspace.river@gmail.com';

const FILTERS = [
  { value: 'all', label: 'All' },
  { value: 'completed', label: 'Completed' },
  { value: 'failed', label: 'Failed' },
  { value: 'active', label: 'In progress' },
];

export function Investigations() {
  const [identities, setIdentities] = useState<MachineIdentity[]>([]);
  const [investigations, setInvestigations] = useState<Investigation[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [starting, setStarting] = useState(false);
  const [params] = useSearchParams();
  const preselect = params.get('identity');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);
  const [filter, setFilter] = useState('all');
  const [run, setRun] = useState<{ id: string; identityName: string; outcome: ActivityOutcome | null } | null>(null);

  useEffect(() => {
    fetchIdentities()
      .then((list) => {
        setIdentities(list);
        setSelectedId(list.find((i) => i.id === preselect)?.id ?? list[0]?.id ?? '');
      })
      .catch((e) => setLoadError(String(e.message ?? e)));
    fetchInvestigations()
      .then(setInvestigations)
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, [preselect]);

  const shown = useMemo(() => {
    const sorted = [...(investigations ?? [])].sort((a, b) => Date.parse(b.startedAt) - Date.parse(a.startedAt));
    if (filter === 'all') return sorted;
    return sorted.filter((i) => (filter === 'active' ? i.status === 'running' || i.status === 'queued' : i.status === filter));
  }, [investigations, filter]);

  async function handleStart() {
    if (!selectedId) return;
    const id = uuid();
    const identityName = identities.find((i) => i.id === selectedId)?.name ?? selectedId;
    const settle = (outcome: ActivityOutcome) => setRun((r) => (r && r.id === id ? { ...r, outcome } : r));
    setStarting(true);
    setStartError(null);
    // The start request blocks until the run ends; the panel follows its real events meanwhile.
    setRun({ id, identityName, outcome: null });
    try {
      await startInvestigation(selectedId, REQUESTED_BY, id);
      settle({ status: 'completed' });
    } catch (e) {
      if (e instanceof ApiRequestError && e.status === 409) {
        setRun(null);
        setStartError(e.message);
      } else {
        settle({ status: 'failed', message: String((e as Error).message ?? e), interrupted: e instanceof NetworkError });
      }
    } finally {
      setStarting(false);
      fetchInvestigations()
        .then(setInvestigations)
        .catch((e) => setLoadError(String(e.message ?? e)));
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Investigations</h1>
        <p>AI-assisted reviews of machine identities.</p>
      </div>

      <div className="cmdbar">
        <span className="prompt" aria-hidden="true">
          $
        </span>
        <label htmlFor="investigate-identity">investigate</label>
        <select id="investigate-identity" value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={starting}>
          {identities.map((i) => (
            <option key={i.id} value={i.id}>
              {i.name} ({i.riskLevel})
            </option>
          ))}
        </select>
        <button className="btn btn-sm" onClick={handleStart} disabled={starting || !selectedId}>
          {starting ? 'Investigating…' : 'Run'}
        </button>
      </div>
      {startError && <StateMessage kind="error">{startError}</StateMessage>}
      {run && <InvestigationActivityPanel key={run.id} investigationId={run.id} identityName={run.identityName} outcome={run.outcome} />}

      {loadError && <StateMessage kind="error">{loadError}</StateMessage>}
      {!loadError && investigations === null && <StateMessage kind="loading">loading investigations…</StateMessage>}
      {!loadError && investigations && investigations.length === 0 && <StateMessage kind="empty">no investigations yet.</StateMessage>}

      {investigations && investigations.length > 0 && (
        <>
          <div className="filter-bar inv-filter">
            <FilterSelect label="Status" value={filter} options={FILTERS} onChange={setFilter} />
            <span className="muted-sm" role="status">
              {shown.length} of {investigations.length} shown
            </span>
          </div>
          {shown.length === 0 ? (
            <StateMessage kind="empty">no investigations match this filter.</StateMessage>
          ) : (
            <div className="inv-list">
              {shown.map((inv, index) => (
                <InvestigationCard key={inv.id} inv={inv} defaultOpen={index === 0} />
              ))}
            </div>
          )}
        </>
      )}
    </>
  );
}
