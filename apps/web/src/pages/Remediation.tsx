import { useEffect, useState } from 'react';
import type { RemediationPlan } from '@credential-reaper/shared';
import { fetchRemediationPlans, simulateRemediation } from '../api/client';
import { AutomationTag, StatusBadge } from '../components/Badges';
import { Panel } from '../components/Panel';
import { StateMessage } from '../components/StateMessage';

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function Remediation() {
  const [plans, setPlans] = useState<RemediationPlan[] | null>(null);
  const [simulatingId, setSimulatingId] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [simulateError, setSimulateError] = useState<string | null>(null);

  useEffect(() => {
    fetchRemediationPlans()
      .then(setPlans)
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  async function handleSimulate(id: string) {
    setSimulatingId(id);
    setSimulateError(null);
    try {
      const updated = await simulateRemediation(id);
      setPlans((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev);
    } catch (e) {
      setSimulateError(String((e as Error).message ?? e));
    } finally {
      setSimulatingId(null);
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

      {loadError && <StateMessage kind="error">{loadError}</StateMessage>}
      {!loadError && !plans && <StateMessage kind="loading">loading remediation plans…</StateMessage>}
      {!loadError && plans && plans.length === 0 && <StateMessage kind="empty">no remediation plans yet.</StateMessage>}
      {simulateError && <StateMessage kind="error">{simulateError}</StateMessage>}

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
            <button
              className="btn btn-secondary"
              disabled={plan.status === 'simulated' || simulatingId === plan.id}
              onClick={() => handleSimulate(plan.id)}
            >
              {simulatingId === plan.id ? 'Simulating…' : plan.status === 'simulated' ? 'Simulated' : 'Simulate (dry run)'}
            </button>
          </div>
        </Panel>
      ))}
    </>
  );
}
