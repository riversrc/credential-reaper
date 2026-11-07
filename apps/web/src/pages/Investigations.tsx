import { useEffect, useState } from 'react';
import type { Investigation, MachineIdentity } from '@credential-reaper/shared';
import { fetchIdentities, fetchInvestigations, startInvestigation } from '../api/client';
import { RiskBadge, StatusBadge } from '../components/Badges';

const REQUESTED_BY = 'workspace.river@gmail.com';

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function Investigations() {
  const [identities, setIdentities] = useState<MachineIdentity[]>([]);
  const [investigations, setInvestigations] = useState<Investigation[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [starting, setStarting] = useState(false);

  useEffect(() => {
    fetchIdentities().then((list) => {
      setIdentities(list);
      setSelectedId(list[0]?.id ?? '');
    });
    fetchInvestigations().then(setInvestigations);
  }, []);

  async function handleStart() {
    if (!selectedId) return;
    setStarting(true);
    // startInvestigation records a "running" entry synchronously, then
    // resolves once the (mock) analysis completes. Refresh right away so the
    // "running" state is visible, then again once it settles.
    const pending = startInvestigation(selectedId, REQUESTED_BY);
    setInvestigations(await fetchInvestigations());
    await pending;
    setInvestigations(await fetchInvestigations());
    setStarting(false);
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
          Uses a mock AI provider in this demo build. No NVIDIA API key is called from the browser.
        </p>
      </div>

      {investigations.length === 0 && <div className="empty-state">No investigations yet.</div>}

      {investigations.map((inv) => (
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

          {inv.status === 'completed' && (
            <>
              {inv.aiSummary && <p>{inv.aiSummary}</p>}
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
                        <td>{f.description}</td>
                        <td className="mono muted">{f.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </>
          )}
        </div>
      ))}
    </>
  );
}
