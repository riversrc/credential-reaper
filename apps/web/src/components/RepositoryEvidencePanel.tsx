import { useState } from 'react';
import type { MachineIdentity, RepositoryEvidence } from '@credential-reaper/shared';
import { updateOwnership } from '../api/client';
import { Panel } from './Panel';

const day = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—');
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '—');

function OwnershipControl({ identity, evidence, onChanged }: { identity: MachineIdentity; evidence: RepositoryEvidence; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [owner, setOwner] = useState(identity.owner);
  const [team, setTeam] = useState(identity.team);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const curated = identity.ownerSource === 'curated';

  const submit = async (body: Parameters<typeof updateOwnership>[1]) => {
    setBusy(true);
    setError(null);
    try {
      await updateOwnership(identity.id, body);
      setEditing(false);
      onChanged();
    } catch (e) {
      setError(String((e as Error).message ?? e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: '0.5rem' }}>
      {!editing && (
        <div className="row-gap" style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          <button type="button" className="btn btn-secondary btn-sm" onClick={() => setEditing(true)}>
            Set owner manually
          </button>
          {curated && (
            <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => submit({ revert: true, actor: 'operator' })}>
              Use repository owner{evidence.declaredOwnership?.owner ? ` (${evidence.declaredOwnership.owner})` : ''}
            </button>
          )}
        </div>
      )}
      {editing && (
        <form
          style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap', alignItems: 'center' }}
          onSubmit={(e) => {
            e.preventDefault();
            if (owner.trim()) void submit({ owner: owner.trim(), team: team.trim(), actor: 'operator' });
          }}
        >
          <input aria-label="Owner" value={owner} maxLength={100} onChange={(e) => setOwner(e.target.value)} />
          <input aria-label="Team" value={team} maxLength={100} onChange={(e) => setTeam(e.target.value)} />
          <button type="submit" className="btn btn-sm" disabled={busy || !owner.trim()}>
            Save
          </button>
          <button type="button" className="btn btn-secondary btn-sm" disabled={busy} onClick={() => setEditing(false)}>
            Cancel
          </button>
        </form>
      )}
      {error && <p className="muted-sm" role="alert">{error}</p>}
    </div>
  );
}

export function RepositoryEvidencePanel({ identity, evidence, onChanged }: { identity: MachineIdentity; evidence: RepositoryEvidence; onChanged: () => void }) {
  const declared = evidence.declaredOwnership;
  const curated = identity.ownerSource === 'curated';
  return (
    <Panel title="Repository evidence" actions={<span className="muted-sm mono">{evidence.repo}</span>}>
      {evidence.state === 'removed' && (
        <p role="status">
          <strong>No longer declared in the repository.</strong> The credential has not been retired or revoked; confirm before taking action.
        </p>
      )}
      <dl className="kv">
        <dt>Commit</dt>
        <dd className="mono">{evidence.commitSha ? evidence.commitSha.slice(0, 12) : 'unknown'}</dd>
        <dt>First / last seen</dt>
        <dd>
          {when(evidence.firstSeenAt)} / {when(evidence.lastSeenAt)}
        </dd>
        <dt>Declared status</dt>
        <dd>{evidence.declaredStatus ?? '—'}</dd>
        <dt>Purpose</dt>
        <dd>{evidence.purpose ?? '—'}</dd>
        <dt>Introduced</dt>
        <dd>
          {day(evidence.introducedOn)}
          {evidence.introducedBy ? ` by ${evidence.introducedBy}` : ''}
        </dd>
        <dt>Owner source</dt>
        <dd>{curated ? 'Set manually (scans will not overwrite it)' : 'Declared in repository'}</dd>
        {declared && (
          <>
            <dt>Declared owner</dt>
            <dd>
              {declared.owner ?? '—'}
              {declared.team ? ` · ${declared.team}` : ''}
              {declared.ownershipStatus ? ` · ${declared.ownershipStatus}` : ''}
              {declared.lastReviewedOn ? ` · reviewed ${day(declared.lastReviewedOn)}` : ''}
              {evidence.ownershipDiffers && (
                <>
                  {' '}
                  <span className="src-tag src-demo">differs from current owner</span>
                </>
              )}
              {declared.note && <div className="muted-sm">{declared.note}</div>}
            </dd>
          </>
        )}
        <dt>Runtime evidence</dt>
        <dd className="muted">None. Repository scans do not observe usage, deployment state or telemetry, so last use is unknown.</dd>
      </dl>
      <OwnershipControl identity={identity} evidence={evidence} onChanged={onChanged} />

      {evidence.services.length > 0 && (
        <>
          <h4 className="muted-sm" style={{ marginTop: '1rem' }}>Services declared to use it</h4>
          <ul className="prov-list">
            {evidence.services.map((s) => (
              <li key={s.serviceId}>
                {s.name} <span className="muted-sm">{[s.mode, s.usage].filter(Boolean).join(' · ')}</span>
              </li>
            ))}
          </ul>
        </>
      )}

      {evidence.endpoints.length > 0 && (
        <>
          <h4 className="muted-sm" style={{ marginTop: '1rem' }}>Endpoints ({evidence.endpoints.length})</h4>
          <ul className="prov-list mono">
            {evidence.endpoints.slice(0, 12).map((e) => (
              <li key={e.key}>
                {e.method} {e.path} <span className="muted-sm">{e.authenticated ? 'authenticated' : 'no auth declared'}</span>
              </li>
            ))}
            {evidence.endpoints.length > 12 && <li className="muted-sm">…and {evidence.endpoints.length - 12} more</li>}
          </ul>
        </>
      )}

      {evidence.permissionHistory.length > 0 && (
        <>
          <h4 className="muted-sm" style={{ marginTop: '1rem' }}>Permission history</h4>
          <ul className="prov-list">
            {evidence.permissionHistory.map((h, i) => (
              <li key={i}>
                <span className="muted-sm">{day(h.date)}</span> {h.change ?? ''} {h.permissionId && <span className="mono">{h.permissionId}</span>}
                {h.ticket && <span className="muted-sm"> · {h.ticket}</span>}
                {h.note && <div className="muted-sm">{h.note}</div>}
              </li>
            ))}
          </ul>
        </>
      )}

      <h4 className="muted-sm" style={{ marginTop: '1rem' }}>Sources ({evidence.provenance.length})</h4>
      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Source path</th>
              <th>Evidence</th>
              <th>Confidence</th>
              <th>Commit</th>
            </tr>
          </thead>
          <tbody>
            {evidence.provenance.map((p, i) => (
              <tr key={`${p.sourcePath}-${i}`} className="row-static">
                <td className="mono">{p.sourcePath}</td>
                <td className="muted">{p.evidenceType}</td>
                <td>
                  <span className={`badge badge-${p.confidence === 'high' ? 'low' : p.confidence === 'medium' ? 'medium' : 'neutral'}`}>{p.confidence}</span>
                </td>
                <td className="mono muted">{p.commitSha ? p.commitSha.slice(0, 8) : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Panel>
  );
}
