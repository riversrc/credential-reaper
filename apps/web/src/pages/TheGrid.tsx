import { useEffect, useState } from 'react';
import type { IdentityType, MachineIdentity } from '@credential-reaper/shared';
import { fetchIdentities } from '../api/client';
import { DemoChip } from '../components/DemoChip';
import { FilterSelect } from '../components/FilterSelect';
import { TYPE_LABEL } from '../lib/typeLabels';
import { IdentityTable } from '../components/IdentityTable';
import { Panel } from '../components/Panel';
import { StateMessage } from '../components/StateMessage';

const STATUS_OPTIONS = [
  { value: 'all', label: 'All' },
  { value: 'active', label: 'Active' },
  { value: 'stale', label: 'Stale' },
  { value: 'orphaned', label: 'Orphaned' },
  { value: 'retired', label: 'Retired' },
];
const TYPE_OPTIONS = [{ value: 'all', label: 'All' }, ...(Object.keys(TYPE_LABEL) as IdentityType[]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))];

export function TheGrid() {
  const [identities, setIdentities] = useState<MachineIdentity[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [typeFilter, setTypeFilter] = useState('all');
  const [statusFilter, setStatusFilter] = useState('all');

  useEffect(() => {
    fetchIdentities()
      .then(setIdentities)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  const shown = identities?.filter((i) => (typeFilter === 'all' || i.type === typeFilter) && (statusFilter === 'all' || i.status === statusFilter));

  return (
    <>
      <div className="page-header">
        <div className="page-header-row">
          <h1>The Grid</h1>
          <DemoChip />
        </div>
        <p>Every machine identity on record.</p>
      </div>

      {error && <StateMessage kind="error">{error}</StateMessage>}
      {!error && !identities && <StateMessage kind="loading">loading identities…</StateMessage>}
      {!error && identities && identities.length === 0 && <StateMessage kind="empty">no machine identities on record.</StateMessage>}

      {identities && identities.length > 0 && (
        <>
          <div className="filter-bar" style={{ marginBottom: '1rem' }}>
            <FilterSelect label="Type" value={typeFilter} options={TYPE_OPTIONS} onChange={setTypeFilter} />
            <FilterSelect label="Status" value={statusFilter} options={STATUS_OPTIONS} onChange={setStatusFilter} />
            <span className="muted-sm" role="status">
              {shown?.length} of {identities.length} shown
            </span>
          </div>
          {shown && shown.length === 0 ? (
            <StateMessage kind="empty">no identities match these filters.</StateMessage>
          ) : (
            <Panel flush>{shown && <IdentityTable identities={shown} />}</Panel>
          )}
        </>
      )}
    </>
  );
}
