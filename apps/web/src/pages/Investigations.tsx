import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { Investigation, MachineIdentity } from '@credential-reaper/shared';
import { fetchIdentities, fetchInvestigations, startInvestigation } from '../api/client';
import { BasisTag, RiskBadge, StatusBadge } from '../components/Badges';
import { Panel } from '../components/Panel';
import { StateMessage } from '../components/StateMessage';

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
  const [params] = useSearchParams();
  const preselect = params.get('identity');
  const [loadError, setLoadError] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

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

      <Panel title="Start a new investigation">
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
          {starting && (
            <span className="muted" role="status">
              analysis in progress<span className="cursor" aria-hidden="true" />
            </span>
          )}
        </div>
        <p className="muted-sm" style={{ marginTop: '0.6rem', marginBottom: 0 }}>
          The Netrunner agent runs on the Worker with Nemotron when NVIDIA_API_KEY is configured, otherwise with a scripted mock. The NVIDIA key is never sent to the browser.
        </p>
        {startError && <StateMessage kind="error">{startError}</StateMessage>}
      </Panel>

      {loadError && <StateMessage kind="error">{loadError}</StateMessage>}
      {!loadError && investigations === null && <StateMessage kind="loading">loading investigations…</StateMessage>}
      {!loadError && investigations && investigations.length === 0 && <StateMessage kind="empty">no investigations yet.</StateMessage>}

      {investigations?.map((inv) => {
        const findings = inv.findings ?? [];
        const toolTrace = inv.toolTrace ?? [];
        return (
        <Panel key={inv.id} title={inv.identityName} actions={<StatusBadge status={inv.status} />}>
          <p className="muted-sm" style={{ margin: '0 0 0.75rem' }}>
            Requested by {inv.requestedBy} · started {formatDateTime(inv.startedAt)}
            {inv.completedAt ? ` · completed ${formatDateTime(inv.completedAt)}` : ''} · source: {inv.source}
          </p>

          {inv.status === 'running' && (
            <StateMessage kind="loading">analysis in progress…</StateMessage>
          )}
          {inv.status === 'failed' && inv.aiSummary && <StateMessage kind="error">{inv.aiSummary}</StateMessage>}

          {inv.status === 'completed' && (
            <>
              {inv.aiSummary && <p style={{ whiteSpace: 'pre-line' }}>{inv.aiSummary}</p>}
              {inv.riskAssessment && (
                <details style={{ marginBottom: '0.75rem' }}>
                  <summary>
                    <span className="muted">Risk score (computed by the backend, not the AI):</span>{' '}
                    <strong>{inv.riskAssessment.score}/100</strong> <RiskBadge level={inv.riskAssessment.level} />
                  </summary>
                  <ul className="trace">
                    {(inv.riskAssessment.factors ?? []).map((factor) => (
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
              {findings.length > 0 && (
                <div className="table-wrap"><table>
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
                    {findings.map((f) => (
                      <tr key={f.id} className="row-static">
                        <td>
                          <RiskBadge level={f.severity === 'info' ? 'low' : f.severity} />
                        </td>
                        <td className="muted">{f.category}</td>
                        <td>
                          <BasisTag basis={f.basis} />
                        </td>
                        <td>{f.description}</td>
                        <td className="mono muted">{f.evidence}</td>
                      </tr>
                    ))}
                  </tbody>
                </table></div>
              )}
            </>
          )}

          {toolTrace.length > 0 && (
            <details style={{ marginTop: '0.75rem' }}>
              <summary className="muted">Agent tool calls ({toolTrace.length})</summary>
              <ul className="trace">
                {toolTrace.map((call) => (
                  <li key={call.seq}>
                    {call.seq}. {call.tool} <span className={`st-${call.status}`}>[{call.status}]</span> {call.summary} ({call.durationMs}ms)
                  </li>
                ))}
              </ul>
            </details>
          )}
        </Panel>
        );
      })}
    </>
  );
}
