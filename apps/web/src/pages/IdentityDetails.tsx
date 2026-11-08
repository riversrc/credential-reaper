import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { CredentialMetadata, IdentityDependency, MachineIdentity, PermissionGrant, UsageEvent } from '@credential-reaper/shared';
import { fetchIdentityDetail } from '../api/client';
import { RiskBadge, StatusBadge } from '../components/Badges';

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

  if (error) return <div className="error-state">{error}</div>;
  if (!data) return <div className="empty-state">Loading identity…</div>;

  const { identity, permissions, dependencies, credentials, usageHistory } = data;

  return (
    <>
      <Link to="/" className="back-link">
        ← Back to The Grid
      </Link>
      <div className="page-header">
        <h1>{identity.name}</h1>
        <p>{identity.description}</p>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Overview</h3>
          <p>
            <span className="muted">Type:</span> {identity.type}
          </p>
          <p>
            <span className="muted">Owner:</span> {identity.owner}
          </p>
          <p>
            <span className="muted">Team:</span> {identity.team}
          </p>
          <p>
            <span className="muted">Environment:</span> {identity.environment}
          </p>
          <p>
            <span className="muted">Created:</span> {formatDateTime(identity.createdAt)}
          </p>
          <p>
            <span className="muted">Last used:</span> {formatDateTime(identity.lastUsedAt)}
          </p>
          <p>
            <span className="muted">Status:</span> <StatusBadge status={identity.status} />
          </p>
          <p>
            <span className="muted">Risk:</span> <RiskBadge level={identity.riskLevel} /> ({identity.riskScore}/100)
          </p>
          <p>
            <span className="muted">Tags:</span> {identity.tags.join(', ') || '—'}
          </p>
        </div>

        <div className="card">
          <h3>Credentials (metadata only)</h3>
          {credentials.length === 0 && <p className="muted">No credentials on record.</p>}
          {credentials.map((c) => (
            <div key={c.id} style={{ marginBottom: '0.75rem' }}>
              <div>
                <strong>{c.kind}</strong> <span className="mono muted">{c.maskedPreview}</span>
              </div>
              <div className="muted" style={{ fontSize: '0.8rem' }}>
                Stored in {c.storageLocation} · created {formatDateTime(c.createdAt)} · rotated {formatDateTime(c.lastRotatedAt)} · expires{' '}
                {formatDateTime(c.expiresAt)}
              </div>
            </div>
          ))}
        </div>
      </div>

      <div className="grid-2">
        <div className="card">
          <h3>Permissions</h3>
          {permissions.length === 0 && <p className="muted">No permission grants on record.</p>}
          {permissions.length > 0 && (
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
                  <tr key={p.id} style={{ cursor: 'default' }}>
                    <td className="mono">{p.resource}</td>
                    <td>{p.scope}</td>
                    <td className="muted">{p.grantedBy}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>

        <div className="card">
          <h3>Dependencies</h3>
          {dependencies.length === 0 && <p className="muted">No known dependencies.</p>}
          {dependencies.length > 0 && (
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
                  <tr key={d.id} style={{ cursor: 'default' }}>
                    <td>{d.name}</td>
                    <td className="muted">{d.kind}</td>
                    <td className="muted">{d.relationship}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <div className="card">
        <h3>Usage history</h3>
        {usageHistory.length === 0 && <p className="muted">No usage events on record.</p>}
        {usageHistory.length > 0 && (
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
                <tr key={u.id} style={{ cursor: 'default' }}>
                  <td className="muted">{formatDateTime(u.timestamp)}</td>
                  <td className="mono">{u.action}</td>
                  <td>{u.source}</td>
                  <td>
                    <StatusBadge status={u.result === 'success' ? 'active' : u.result === 'denied' ? 'stale' : 'orphaned'} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </>
  );
}
