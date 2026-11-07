import { useEffect, useState } from 'react';
import type { RemediationPlan } from '@credential-reaper/shared';
import { fetchRemediationPlans, simulateRemediation } from '../api/client';
import { StatusBadge } from '../components/Badges';

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function Remediation() {
  const [plans, setPlans] = useState<RemediationPlan[] | null>(null);
  const [simulatingId, setSimulatingId] = useState<string | null>(null);

  useEffect(() => {
    fetchRemediationPlans().then(setPlans);
  }, []);

  async function handleSimulate(id: string) {
    setSimulatingId(id);
    const updated = await simulateRemediation(id);
    setPlans((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev);
    setSimulatingId(null);
  }

  return (
    <>
      <div className="page-header">
        <h1>Remediation</h1>
        <p>Proposed retirement and migration plans. Simulation is always a dry run — no live credential is ever touched.</p>
      </div>

      {!plans && <div className="empty-state">Loading remediation plans…</div>}
      {plans && plans.length === 0 && <div className="empty-state">No remediation plans yet.</div>}

      {plans?.map((plan) => (
        <div className="card" key={plan.id}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 style={{ margin: 0 }}>
              {plan.identityName} — <span style={{ textTransform: 'capitalize' }}>{plan.action}</span>
            </h3>
            <StatusBadge status={plan.status} />
          </div>
          <p style={{ margin: '0.5rem 0' }}>{plan.justification}</p>
          <ol style={{ margin: '0.5rem 0 0.75rem', paddingLeft: '1.25rem' }}>
            {plan.steps.map((step) => (
              <li key={step.id} style={{ marginBottom: '0.2rem' }}>
                {step.description}{' '}
                <span className="muted" style={{ fontSize: '0.78rem' }}>
                  {step.automatable ? '(automatable)' : '(manual)'}
                </span>
              </li>
            ))}
          </ol>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span className="muted" style={{ fontSize: '0.78rem' }}>
              Created {formatDateTime(plan.createdAt)}
              {plan.simulatedAt ? ` · simulated ${formatDateTime(plan.simulatedAt)}` : ''}
            </span>
            <button
              className="btn btn-secondary"
              disabled={plan.status === 'simulated' || simulatingId === plan.id}
              onClick={() => handleSimulate(plan.id)}
            >
              {simulatingId === plan.id ? 'Simulating…' : plan.status === 'simulated' ? 'Simulated ✓' : 'Simulate (dry run)'}
            </button>
          </div>
        </div>
      ))}
    </>
  );
}
