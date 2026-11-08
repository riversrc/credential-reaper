import { useEffect, useState } from 'react';
import type { AuditEvent } from '@credential-reaper/shared';
import { fetchAuditEvents } from '../api/client';
import { Panel } from '../components/Panel';
import { StateMessage } from '../components/StateMessage';

function formatDateTime(iso: string) {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

const actionLabels: Record<AuditEvent['action'], string> = {
  'investigation-started': 'Investigation started',
  'investigation-completed': 'Investigation completed',
  'investigation-failed': 'Investigation failed',
  'remediation-proposed': 'Remediation plan proposed',
  'remediation-approved': 'Remediation plan approved',
  'remediation-simulated': 'Remediation simulated',
  'remediation-rejected': 'Remediation plan rejected',
  'identity-retired': 'Identity retired',
  'ownership-curated': 'Ownership updated',
};

const markerClass = (action: AuditEvent['action']) =>
  action === 'investigation-failed' || action === 'remediation-rejected' ? 'tl-bad' : action === 'identity-retired' || action === 'remediation-proposed' ? 'tl-warn' : '';

export function TheAfterlife() {
  const [events, setEvents] = useState<AuditEvent[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetchAuditEvents()
      .then(setEvents)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <>
      <div className="page-header">
        <h1>The Afterlife</h1>
        <p>Audit trail of every action taken.</p>
      </div>

      {error && <StateMessage kind="error">{error}</StateMessage>}
      {!error && !events && <StateMessage kind="loading">loading audit history…</StateMessage>}
      {!error && events && events.length === 0 && <StateMessage kind="empty">no audit events yet.</StateMessage>}

      {events && events.length > 0 && (
        <Panel title={`Audit trail · ${events.length} events`}>
          <ul className="timeline">
            {events.map((event) => (
              <li key={event.id} className={markerClass(event.action)}>
                <div className="ts">{formatDateTime(event.timestamp)}</div>
                <div className="tl-title">
                  {actionLabels[event.action]}
                  {event.identityName && <span className="muted"> — {event.identityName}</span>}
                </div>
                <div style={{ fontSize: '0.82rem' }}>{event.details}</div>
                <div className="muted-sm">by {event.actor}</div>
              </li>
            ))}
          </ul>
        </Panel>
      )}
    </>
  );
}
