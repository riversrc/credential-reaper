import { useEffect, useState } from 'react';
import type { RemediationPlan, RemediationPrPreview } from '@credential-reaper/shared';
import { ApiRequestError, approveRemediation, fetchIdentities, fetchRemediationPlans, openRemediationPr, previewRemediationPr, rejectRemediation, simulateRemediation } from '../api/client';
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
  const [repoIdentityIds, setRepoIdentityIds] = useState<Set<string>>(new Set());
  const [previews, setPreviews] = useState<Record<string, RemediationPrPreview>>({});
  const [prBusy, setPrBusy] = useState<{ id: string; step: 'preview' | 'open' } | null>(null);

  useEffect(() => {
    fetchRemediationPlans()
      .then(setPlans)
      .catch((e) => setLoadError(String(e.message ?? e)));
  }, []);

  useEffect(() => {
    fetchIdentities()
      .then((all) => setRepoIdentityIds(new Set(all.filter((i) => i.dataSource === 'repository' && i.repoState === 'present').map((i) => i.id))))
      .catch(() => {});
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

  async function handlePreview(plan: RemediationPlan) {
    if (busy || prBusy) return;
    setPrBusy({ id: plan.id, step: 'preview' });
    setActionError(null);
    try {
      const preview = await previewRemediationPr(plan.id);
      setPreviews((prev) => ({ ...prev, [plan.id]: preview }));
    } catch (e) {
      setActionError(String((e as Error).message ?? e));
    } finally {
      setPrBusy(null);
    }
  }

  async function handleOpenPr(plan: RemediationPlan) {
    if (busy || prBusy) return;
    setPrBusy({ id: plan.id, step: 'open' });
    setActionError(null);
    try {
      const updated = await openRemediationPr(plan.id);
      setPlans((prev) => prev?.map((p) => (p.id === updated.id ? updated : p)) ?? prev);
      setPreviews((prev) => {
        const { [plan.id]: _done, ...rest } = prev;
        return rest;
      });
      setAnnouncement(`Pull request opened for ${plan.identityName}.`);
    } catch (e) {
      setActionError(String((e as Error).message ?? e));
      if (e instanceof ApiRequestError && e.status === 409) fetchRemediationPlans().then(setPlans).catch(() => {});
    } finally {
      setPrBusy(null);
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
        The agent proposes, you approve, and Credential Reaper opens the pull request with the fix. A person merges it. No credential is revoked from here.
      </p>
      <p className="muted-sm" style={{ marginBottom: '1rem' }}>
        Approving a plan lets you preview and open a pull request that removes the identity's declarations from the repository (retire plans on repository identities). Merging it re-syncs the inventory; revoking the real credential stays a separate, human step.
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
            {plan.prUrl && (
              <p className="pr-link">
                Pull request opened {formatDateTime(plan.prOpenedAt || null)}:{' '}
                <a href={plan.prUrl} target="_blank" rel="noreferrer">
                  {plan.prUrl}
                </a>
                <span className="muted-sm"> Changes repository configuration only. A person must merge it, and the credential itself is not touched.</span>
              </p>
            )}
            {previews[plan.id] && (
              <div className="pr-preview">
                <p>
                  <strong>{previews[plan.id]!.title}</strong>
                </p>
                <p className="muted-sm">
                  {previews[plan.id]!.repo}: branch {previews[plan.id]!.branch} into {previews[plan.id]!.baseBranch} (at {previews[plan.id]!.baseSha.slice(0, 7)})
                </p>
                <ul className="pr-files">
                  {previews[plan.id]!.files.map((file) => (
                    <li key={file.path}>
                      <code>{file.path}</code> <span className="muted-sm">{file.change === 'deleted' ? 'deleted' : `${file.removedLines.length} line(s) removed`}</span>
                    </li>
                  ))}
                </ul>
                <ul className="pr-checks">
                  {previews[plan.id]!.verification.map((v) => (
                    <li key={v.check}>
                      {v.ok ? 'Pass' : 'Fail'}: {v.check}
                    </li>
                  ))}
                </ul>
                {previews[plan.id]!.leftUntouched.length > 0 && (
                  <p className="muted-sm">Still mentions the identity, left unchanged: {previews[plan.id]!.leftUntouched.join(', ')}</p>
                )}
                <p className="muted-sm">Opening the pull request changes no credential. It only proposes this configuration change for a person to review and merge.</p>
                <button className="btn" aria-disabled={prBusy !== null} onClick={() => handleOpenPr(plan)}>
                  {prBusy?.id === plan.id && prBusy.step === 'open' ? 'Opening…' : 'Open pull request'}
                </button>
              </div>
            )}
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
                {plan.action === 'retire' && repoIdentityIds.has(plan.identityId) && (plan.status === 'approved' || plan.status === 'simulated') && !plan.prUrl && !previews[plan.id] && (
                  <button className="btn" aria-disabled={busy !== null || prBusy !== null} onClick={() => handlePreview(plan)}>
                    {prBusy?.id === plan.id && prBusy.step === 'preview' ? 'Building preview…' : 'Preview pull request'}
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
