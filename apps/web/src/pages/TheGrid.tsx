import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import type { MachineIdentity } from '@credential-reaper/shared';
import { fetchIdentities } from '../api/client';
import { RiskBadge, StatusBadge } from '../components/Badges';

function formatDate(iso: string | null) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function TheGrid() {
  const [identities, setIdentities] = useState<MachineIdentity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const navigate = useNavigate();

  useEffect(() => {
    fetchIdentities()
      .then(setIdentities)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <>
      <div className="page-header">
        <h1>The Grid</h1>
        <p>Machine identity inventory — every service account, key, cert, and bot we know about.</p>
      </div>

      {error && <div className="error-state">{error}</div>}
      {!error && !identities && <div className="empty-state">Loading identities…</div>}
      {!error && identities && identities.length === 0 && <div className="empty-state">No machine identities on record.</div>}

      {identities && identities.length > 0 && (
        <div className="card" style={{ padding: 0 }}>
          <table>
            <thead>
              <tr>
                <th>Name</th>
                <th>Type</th>
                <th>Owner</th>
                <th>Team</th>
                <th>Last used</th>
                <th>Status</th>
                <th>Risk</th>
              </tr>
            </thead>
            <tbody>
              {identities.map((identity) => (
                <tr key={identity.id} onClick={() => navigate(`/identities/${identity.id}`)}>
                  <td>
                    <strong>{identity.name}</strong>
                  </td>
                  <td className="muted">{identity.type}</td>
                  <td>{identity.owner}</td>
                  <td className="muted">{identity.team}</td>
                  <td className="muted">{formatDate(identity.lastUsedAt)}</td>
                  <td>
                    <StatusBadge status={identity.status} />
                  </td>
                  <td>
                    <RiskBadge level={identity.riskLevel} />
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
