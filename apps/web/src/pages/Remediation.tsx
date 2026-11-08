import { useEffect, useState } from 'react';
import type { RemediationPlan } from '@credential-reaper/shared';
import { ApiRequestError, approveRemediation, fetchRemediationPlans, rejectRemediation, simulateRemediation } from '../api/client';
import { AutomationTag, StatusBadge } from '../components/Badges';
import { Panel } from '../components/Panel';
import { StateMessage } from '../components/StateMessage';

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

type PlanAction = 'approve' | 'reject' | 'simulate';

const ACTIONS: Record<PlanAction, (id: string) => Promise<RemediationPlan>> = {
  approve: approveRemediation,
  reject: rejectRemediation,
  simulate: simulateRemediation,
};

const PENDING_LABEL: Record<PlanAction, string> = { approve: 'Approving…', reject: 'Rejecting…', simulate: 'Simulating…' };

export function Remediation() {
  const [plans, setPlans] = useState<RemediationPlan[] | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: PlanAction } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);

  useEffect(() => {
    fetchRemediationPlans()
      .then(setPlans)
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  async function handleAction(id: string, action: PlanAction) {
    setBusy({ id, action });
    setActionError(null);
    try {
      const updated = await ACTIONS[action](id);
      setPlans((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev);
    } catch (e) {
      setActionError(String((e as Error).message ?? e));
      // A 409 means our copy of the plan is out of date; resync so the buttons match the stored status.
      if (e instanceof ApiRequestError && e.status === 409) {
        fetchRemediationPlans().then(setPlans).catch(() => {});
      }
    } finally {
      setBusy(null);
    }
  }

  return (
    <>
      <div className="page-header">
        <h1>Remediation</h1>
        <p>Proposed retirement and migration plans.</p>
      </div>
      <p className="safety-line" style={{ marginBottom: '1rem' }}>
        Dry run — no live credential is touched.
      </p>
      <p className="muted-sm" style={{ marginBottom: '1rem' }}>
        Approving a plan only allows it to be previewed. It does not execute anything, and real execution is not available.
      </p>

      {loadError && <StateMessage kind="error">{loadError}</StateMessage>}
      {!loadError && !plans && <StateMessage kind="loading">loading remediation plans…</StateMessage>}
      {!loadError && plans && plans.length === 0 && <StateMessage kind="empty">no remediation plans yet.</StateMessage>}
      {actionError && <StateMessage kind="error">{actionError}</StateMessage>}

      {plans?.map((plan) => (
        <Panel
          key={plan.id}
          title={
            <>
              {plan.identityName} — {plan.action}
            </>
          }
          actions={<StatusBadge status={plan.status} />}
        >
          <p style={{ margin: '0.5rem 0' }}>{plan.justification}</p>
          <ol className="steps">
            {plan.steps.map((step) => (
              <li key={step.id}>
                <span className="step-text">{step.description}</span>
                <AutomationTag automatable={step.automatable} />
              </li>
            ))}
          </ol>
          <div className="plan-foot">
            <span className="muted-sm">
              Created {formatDateTime(plan.createdAt)}
              {plan.simulatedAt ? ` · simulated ${formatDateTime(plan.simulatedAt)}` : ''}
            </span>
            <div className="plan-actions">
              {plan.status === 'proposed' && (
                <>
                  <button className="btn" disabled={busy !== null} onClick={() => handleAction(plan.id, 'approve')}>
                    {busy?.id === plan.id && busy.action === 'approve' ? PENDING_LABEL.approve : 'Approve plan'}
                  </button>
                  <button className="btn btn-secondary" disabled={busy !== null} onClick={() => handleAction(plan.id, 'reject')}>
                    {busy?.id === plan.id && busy.action === 'reject' ? PENDING_LABEL.reject : 'Reject'}
                  </button>
                </>
              )}
              {plan.status !== 'rejected' && (
                <button
                  className="btn btn-secondary"
                  disabled={plan.status !== 'approved' || busy !== null}
                  aria-describedby={plan.status === 'proposed' ? `${plan.id}-simulate-hint` : undefined}
                  onClick={() => handleAction(plan.id, 'simulate')}
                >
                  {busy?.id === plan.id && busy.action === 'simulate'
                    ? PENDING_LABEL.simulate
                    : plan.status === 'simulated'
                      ? 'Simulated'
                      : 'Simulate (dry run)'}
                </button>
              )}
              {plan.status === 'proposed' && (
                <span id={`${plan.id}-simulate-hint`} className="muted-sm">
                  Approve the plan to enable simulation.
                </span>
              )}
            </div>
          </div>
        </Panel>
      ))}
    </>
  );
}
