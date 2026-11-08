import { Link, useNavigate } from 'react-router-dom';
import type { MachineIdentity } from '@credential-reaper/shared';
import { RiskBadge, StatusBadge } from './Badges';

function formatDate(iso: string | null) {
  if (!iso) return 'never';
  return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
}

export function IdentityTable({ identities, dimIds }: { identities: MachineIdentity[]; dimIds?: Set<string> }) {
  const navigate = useNavigate();
  return (
    <div className="table-wrap">
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
          {identities.map((identity) => {
            const open = () => navigate(`/identities/${identity.id}`);
            return (
              <tr
                key={identity.id}
                className={dimIds?.has(identity.id) ? 'row-dim' : undefined}
                tabIndex={0}
                onClick={open}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && e.target === e.currentTarget) open();
                }}
              >
                <td>
                  <Link to={`/identities/${identity.id}`} onClick={(e) => e.stopPropagation()}>
                    <strong>{identity.name}</strong>
                  </Link>
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
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
