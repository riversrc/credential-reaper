import { useEffect, useState } from 'react';
import type { AuditEvent } from '@credential-reaper/shared';
import { fetchAuditEvents } from '../api/client';

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
  'remediation-proposed': 'Remediation plan proposed',
  'remediation-approved': 'Remediation plan approved',
  'remediation-simulated': 'Remediation simulated',
  'remediation-rejected': 'Remediation plan rejected',
  'identity-retired': 'Identity retired',
};

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
        <p>Investigation history and audit trail — every action taken against a machine identity.</p>
      </div>

      {error && <div className="error-state">{error}</div>}
      {!error && !events && <div className="empty-state">Loading audit history…</div>}
      {!error && events && events.length === 0 && <div className="empty-state">No audit events yet.</div>}

      {events && events.length > 0 && (
        <div className="card">
          <ul className="timeline">
            {events.map((event) => (
              <li key={event.id}>
                <div className="ts">{formatDateTime(event.timestamp)}</div>
                <div>
                  <strong>{actionLabels[event.action]}</strong>
                  {event.identityName && <> — {event.identityName}</>}
                </div>
                <div className="muted" style={{ fontSize: '0.85rem' }}>
                  {event.details}
                </div>
                <div className="muted" style={{ fontSize: '0.78rem' }}>
                  by {event.actor}
                </div>
              </li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
}
