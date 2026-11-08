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

const ANNOUNCE: Record<PlanAction, string> = { approve: 'approved', reject: 'rejected', simulate: 'simulated (dry run)' };

/** Where keyboard focus goes after an action: the next available button, else the plan's status line. */
type FocusTarget = { id: string; to: 'simulate' | 'state' };

export function Remediation() {
  const [plans, setPlans] = useState<RemediationPlan[] | null>(null);
  const [busy, setBusy] = useState<{ id: string; action: PlanAction } | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [announcement, setAnnouncement] = useState('');
  const [focusTarget, setFocusTarget] = useState<FocusTarget | null>(null);

  useEffect(() => {
    fetchRemediationPlans()
      .then(setPlans)
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    if (!focusTarget) return;
    document.getElementById(`${focusTarget.id}-${focusTarget.to}`)?.focus();
    setFocusTarget(null);
  }, [focusTarget, plans]);

  async function handleAction(plan: RemediationPlan, action: PlanAction) {
    if (busy) return;
    const { id } = plan;
    setBusy({ id, action });
    setActionError(null);
    try {
      const updated = await ACTIONS[action](id);
      setPlans((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev);
      setAnnouncement(`${plan.action} plan for ${plan.identityName} ${ANNOUNCE[action]}.`);
      setFocusTarget({ id, to: action === 'approve' ? 'simulate' : 'state' });
    } catch (e) {
      setActionError(String((e as Error).message ?? e));
      setFocusTarget({ id, to: 'state' });
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
      <div className="sr-only" role="status" aria-live="polite">
        {announcement}
      </div>
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

      {plans?.map((plan) => {
        const label = `${plan.action} ${plan.identityName}, created ${formatDateTime(plan.createdAt)}`;
        return (
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
              <span id={`${plan.id}-state`} tabIndex={-1} className="muted-sm plan-state">
                Status {plan.status} · Created {formatDateTime(plan.createdAt)}
                {plan.simulatedAt ? ` · simulated ${formatDateTime(plan.simulatedAt)}` : ''}
              </span>
              <div className="plan-actions">
                {plan.status === 'proposed' && (
                  <>
                    <button
                      className="btn"
                      aria-disabled={busy !== null}
                      aria-label={`Approve plan: ${label}`}
                      onClick={() => handleAction(plan, 'approve')}
                    >
                      {busy?.id === plan.id && busy.action === 'approve' ? PENDING_LABEL.approve : 'Approve plan'}
                    </button>
                    <button
                      className="btn btn-secondary"
                      aria-disabled={busy !== null}
                      aria-label={`Reject plan: ${label}`}
                      onClick={() => handleAction(plan, 'reject')}
                    >
                      {busy?.id === plan.id && busy.action === 'reject' ? PENDING_LABEL.reject : 'Reject'}
                    </button>
                  </>
                )}
                {plan.status !== 'rejected' && (
                  <button
                    id={`${plan.id}-simulate`}
                    className="btn btn-secondary"
                    disabled={plan.status !== 'approved'}
                    aria-disabled={busy !== null}
                    aria-label={`Simulate dry run: ${label}`}
                    aria-describedby={plan.status === 'proposed' ? `${plan.id}-simulate-hint` : undefined}
                    onClick={() => handleAction(plan, 'simulate')}
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
        );
      })}
    </>
  );
}
