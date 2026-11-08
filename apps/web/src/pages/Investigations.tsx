import { useEffect, useState } from 'react';
import type { FindingBasis, Investigation, MachineIdentity } from '@credential-reaper/shared';
import { fetchIdentities, fetchInvestigations, startInvestigation } from '../api/client';
import { RiskBadge, StatusBadge } from '../components/Badges';

const BASIS_TONE: Record<FindingBasis, string> = { confirmed: 'low', inferred: 'medium', unknown: 'neutral' };

const REQUESTED_BY = 'workspace.river@gmail.com';

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function Investigations() {
  const [identities, setIdentities] = useState<MachineIdentity[]>([]);
  const [investigations, setInvestigations] = useState<Investigation[] | null>(null);
  const [selectedId, setSelectedId] = useState('');
  const [starting, setStarting] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  useEffect(() => {
    fetchIdentities()
      .then((list) => {
        setIdentities(list);
        setSelectedId(list[0]?.id ?? '');
      })
      .catch((e) => setLoadError(String(e.message ?? e)));
    fetchInvestigations()
      .then(setInvestigations)
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  async function handleStart() {
    if (!selectedId) return;
    setStarting(true);
    setStartError(null);
    try {
      // startInvestigation resolves once the Worker has run the full
      // investigate-and-complete cycle. Refresh right away in case a
      // "running" entry is briefly visible, then again once it settles.
      const pending = startInvestigation(selectedId, REQUESTED_BY);
      setInvestigations(await fetchInvestigations());
      await pending;
      setInvestigations(await fetchInvestigations());
    } catch (e) {
      setStartError(String((e as Error).message ?? e));
    } finally {
      setStarting(false);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Investigations</h1>
        <p>Kick off an AI-assisted investigation into a machine identity, then review findings and recommendations.</p>
      </div>

      <div className="card">
        <h3>Start a new investigation</h3>
        <div style={{ display: 'flex', gap: '0.6rem', alignItems: 'center' }}>
          <select value={selectedId} onChange={(e) => setSelectedId(e.target.value)} disabled={starting}>
            {identities.map((i) => (
              <option key={i.id} value={i.id}>
                {i.name} ({i.riskLevel})
              </option>
            ))}
          </select>
          <button className="btn" onClick={handleStart} disabled={starting || !selectedId}>
            {starting ? 'Investigating…' : 'Start investigation'}
          </button>
        </div>
        <p className="muted" style={{ marginTop: '0.6rem', marginBottom: 0, fontSize: '0.8rem' }}>
          The Netrunner agent runs on the Worker with Nemotron when NVIDIA_API_KEY is configured, otherwise with a scripted mock. The NVIDIA key is never sent to the browser.
        </p>
        {startError && (
          <p className="error-state" style={{ padding: '0.5rem 0 0', margin: 0 }}>
            {startError}
          </p>
        )}
      </div>

      {loadError && <div className="error-state">{loadError}</div>}
      {!loadError && investigations === null && <div className="empty-state">Loading investigations…</div>}
      {!loadError && investigations && investigations.length === 0 && <div className="empty-state">No investigations yet.</div>}

      {investigations?.map((inv) => (
        <div className="card" key={inv.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>{inv.identityName}</h3>
            <StatusBadge status={inv.status} />
          </div>
          <p className="muted" style={{ fontSize: '0.8rem', margin: '0.35rem 0 0.75rem' }}>
            Requested by {inv.requestedBy} · started {formatDateTime(inv.startedAt)}
            {inv.completedAt ? ` · completed ${formatDateTime(inv.completedAt)}` : ''} · source: {inv.source}
          </p>

          {inv.status === 'running' && <p className="muted">Analysis in progress…</p>}
          {inv.status === 'failed' && inv.aiSummary && <p className="error-state" style={{ padding: 0 }}>{inv.aiSummary}</p>}

          {inv.status === 'completed' && (
            <>
              {inv.aiSummary && <p style={{ whiteSpace: 'pre-line' }}>{inv.aiSummary}</p>}
              {inv.riskAssessment && (
                <details style={{ marginBottom: '0.75rem' }}>
                  <summary>
                    <span className="muted">Risk score (computed by the backend, not the AI):</span>{' '}
                    <strong>{inv.riskAssessment.score}/100</strong> <RiskBadge level={inv.riskAssessment.level} />
                  </summary>
                  <ul className="mono muted" style={{ fontSize: '0.8rem' }}>
                    {inv.riskAssessment.factors.map((factor) => (
                      <li key={factor}>{factor}</li>
                    ))}
                  </ul>
                </details>
              )}
              {inv.recommendedAction && (
                <p>
                  <span className="muted">Recommended action:</span> <strong>{inv.recommendedAction}</strong>
                </p>
              )}
              {inv.findings.length > 0 && (
                <table>
                  <thead>
                    <tr>
                      <th>Severity</th>
                      <th>Category</th>
                      <th>Basis</th>
                      <th>Finding</th>
                      <th>Evidence</th>
                    </tr>
                  </thead>
                  <tbody>
                    {inv.findings.map((f) => (
                      <tr key={f.id} style={{ cursor: 'default' }}>
                        <td>
                          <RiskBadge level={f.severity === 'info' ? 'low' : f.severity} />
                        </td>
                        <td className="muted">{f.category}</td>
                        <td>
                          <span className={`badge badge-${BASIS_TONE[f.basis]}`}>{f.basis}</span>
                        </td>
                        <td>{f.description}</td>
                        <td className="mono muted">{f.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}

          {inv.toolTrace.length > 0 && (
            <details style={{ marginTop: '0.75rem' }}>
              <summary className="muted">Agent tool calls ({inv.toolTrace.length})</summary>
              <ul className="mono muted" style={{ fontSize: '0.8rem' }}>
                {inv.toolTrace.map((call) => (
                  <li key={call.seq}>
                    {call.seq}. {call.tool} [{call.status}] {call.summary} ({call.durationMs}ms)
                  </li>
                ))}
              </ul>
            </details>
          )}
        </div>
      ))}
    </>
  );
}
