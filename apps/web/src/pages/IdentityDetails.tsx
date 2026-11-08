import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CredentialMetadata, IdentityDependency, MachineIdentity, PermissionGrant, UsageEvent } from '@credential-reaper/shared';
import { fetchIdentityDetail } from '../api/client';
import { RiskBadge, StatusBadge } from '../components/Badges';
import { Panel } from '../components/Panel';
import { StateMessage } from '../components/StateMessage';

interface DetailState {
  identity: MachineIdentity;
  permissions: PermissionGrant[];
  dependencies: IdentityDependency[];
  credentials: CredentialMetadata[];
  usageHistory: UsageEvent[];
}

function formatDateTime(iso: string | null) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleString(undefined, { year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function IdentityDetails() {
  const { id } = useParams<{ id: string }>();
  const [data, setData] = useState<DetailState | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setData(null);
    setError(null);
    fetchIdentityDetail(id).then(setData).catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  if (error) return <StateMessage kind="error">{error}</StateMessage>;
  if (!data) return <StateMessage kind="loading">loading identity…</StateMessage>;

  const { identity, permissions, dependencies, credentials, usageHistory } = data;

  return (
    <>
      <Link to="/grid" className="back-link">
        Back to The Grid
      </Link>
      <div className="page-header">
        <h1>{identity.name}</h1>
        <p>{identity.description}</p>
      </div>

      <div className="grid-2">
        <Panel title="Overview">
          <dl className="kv">
            <dt>Type</dt>
            <dd>{identity.type}</dd>
            <dt>Owner</dt>
            <dd>{identity.owner}</dd>
            <dt>Team</dt>
            <dd>{identity.team}</dd>
            <dt>Environment</dt>
            <dd>{identity.environment}</dd>
            <dt>Created</dt>
            <dd>{formatDateTime(identity.createdAt)}</dd>
            <dt>Last used</dt>
            <dd>{formatDateTime(identity.lastUsedAt)}</dd>
            <dt>Status</dt>
            <dd>
              <StatusBadge status={identity.status} />
            </dd>
            <dt>Risk</dt>
            <dd>
              <span className="lcd-risk">
                <span className="lcd">{identity.riskScore}</span>
                <span className="muted-sm">/100</span>
                <RiskBadge level={identity.riskLevel} />
              </span>
            </dd>
            <dt>Tags</dt>
            <dd>{identity.tags.join(', ') || '—'}</dd>
          </dl>
        </Panel>

        <Panel title="Credentials (metadata only)">
          {credentials.length === 0 && <p className="muted">No credentials on record.</p>}
          {credentials.map((c) => (
            <div key={c.id} style={{ marginBottom: '0.75rem' }}>
              <div>
                <strong>{c.kind}</strong> <span className="mono muted">{c.maskedPreview}</span>
              </div>
              <div className="muted-sm">
                Stored in {c.storageLocation} · created {formatDateTime(c.createdAt)} · rotated {formatDateTime(c.lastRotatedAt)} · expires{' '}
                {formatDateTime(c.expiresAt)}
              </div>
            </div>
          ))}
        </Panel>
      </div>

      <div className="grid-2">
        <Panel title="Permissions">
          {permissions.length === 0 && <p className="muted">No permission grants on record.</p>}
          {permissions.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Resource</th>
                    <th>Scope</th>
                    <th>Granted by</th>
                  </tr>
                </thead>
                <tbody>
                  {permissions.map((p) => (
                    <tr key={p.id} className="row-static">
                      <td className="mono">{p.resource}</td>
                      <td>{p.scope}</td>
                      <td className="muted">{p.grantedBy}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>

        <Panel title="Dependencies">
          {dependencies.length === 0 && <p className="muted">No known dependencies.</p>}
          {dependencies.length > 0 && (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Kind</th>
                    <th>Relationship</th>
                  </tr>
                </thead>
                <tbody>
                  {dependencies.map((d) => (
                    <tr key={d.id} className="row-static">
                      <td>{d.name}</td>
                      <td className="muted">{d.kind}</td>
                      <td className="muted">{d.relationship}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
      </div>

      <Panel title="Usage history">
        {usageHistory.length === 0 && <p className="muted">No usage events on record.</p>}
        {usageHistory.length > 0 && (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Timestamp</th>
                  <th>Action</th>
                  <th>Source</th>
                  <th>Result</th>
                </tr>
              </thead>
              <tbody>
                {usageHistory.map((u) => (
                  <tr key={u.id} className="row-static">
                    <td className="muted">{formatDateTime(u.timestamp)}</td>
                    <td className="mono">{u.action}</td>
                    <td>{u.source}</td>
                    <td>
                      <span className={`badge badge-${u.result === 'success' ? 'low' : u.result === 'denied' ? 'medium' : 'critical'}`}>{u.result}</span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>
    </>
  );
}
