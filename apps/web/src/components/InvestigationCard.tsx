import { useEffect, useRef, useState } from 'react';
import type { FindingSeverity, Investigation, InvestigationFinding } from '@credential-reaper/shared';
import { BasisTag, RiskBadge, StatusBadge } from './Badges';
import { StateMessage } from './StateMessage';

const SEVERITY_ORDER: FindingSeverity[] = ['critical', 'high', 'medium', 'low', 'info'];
const TOP_FINDINGS = 3;

function sortFindings(findings: InvestigationFinding[]) {
  return [...findings].sort((a, b) => SEVERITY_ORDER.indexOf(a.severity) - SEVERITY_ORDER.indexOf(b.severity));
}

function formatDateTime(iso: string | null) {
  if (!iso) return '—';
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function relativeTime(iso: string) {
  const diff = Date.now() - Date.parse(iso);
  if (Number.isNaN(diff)) return '—';
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'just now';
  if (min < 60) return `${min}m ago`;
  const hours = Math.round(min / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  return new Date(iso).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
}

function actionLabel(action: Investigation['recommendedAction']) {
  return action === 'no-action' ? 'No action' : (action ?? '');
}

function FindingRow({ finding }: { finding: InvestigationFinding }) {
  const head = (
    <>
      <RiskBadge level={finding.severity === 'info' ? 'low' : finding.severity} />
      <span className="finding-cat">{finding.category}</span>
      <BasisTag basis={finding.basis} />
      <span className="finding-desc">{finding.description}</span>
    </>
  );
  if (!finding.evidence) {
    return <li className="finding finding-flat">{head}</li>;
  }
  return (
    <li className="finding">
      <details className="disc">
        <summary className="disc-sum finding-head" aria-label={`${finding.severity} finding: ${finding.description}`}>
          {head}
        </summary>
        <div className="finding-evidence">
          <span className="muted-sm">Evidence</span>
          <p className="mono">{finding.evidence}</p>
        </div>
      </details>
    </li>
  );
}

function Findings({ findings }: { findings: InvestigationFinding[] }) {
  const sorted = sortFindings(findings);
  const top = sorted.slice(0, TOP_FINDINGS);
  const rest = sorted.slice(TOP_FINDINGS);
  return (
    <section className="inv-section" aria-label="Findings">
      <h4 className="inv-h">{rest.length ? `Top findings · ${top.length} of ${sorted.length}` : `Findings · ${sorted.length}`}</h4>
      <ul className="findings">
        {top.map((f) => (
          <FindingRow key={f.id} finding={f} />
        ))}
      </ul>
      {rest.length > 0 && (
        <details className="disc inv-more">
          <summary className="disc-sum">All findings ({sorted.length})</summary>
          <ul className="findings">
            {rest.map((f) => (
              <FindingRow key={f.id} finding={f} />
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

function Summary({ text }: { text: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflowing, setOverflowing] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      if (!expanded) setOverflowing(el.scrollHeight > el.clientHeight + 1);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [text, expanded]);

  return (
    <div className="inv-summary">
      <p ref={ref} className={expanded ? undefined : 'is-clamped'}>
        {text}
      </p>
      {(overflowing || expanded) && (
        <button type="button" className="link-btn" aria-expanded={expanded} onClick={() => setExpanded((v) => !v)}>
          {expanded ? 'Show less' : 'Full summary'}
        </button>
      )}
    </div>
  );
}

function Evidence({ inv }: { inv: Investigation }) {
  const factors = inv.riskAssessment?.factors ?? [];
  const trace = inv.toolTrace ?? [];
  return (
    <details className="disc inv-evidence">
      <summary className="disc-sum">Supporting evidence</summary>
      <div className="inv-evidence-body">
        {factors.length > 0 && (
          <div>
            <h4 className="inv-h">Risk factors</h4>
            <p className="muted-sm">Score and factors are computed by the backend from retrieved data, not set by the AI.</p>
            <ul className="trace">
              {factors.map((factor) => (
                <li key={factor}>{factor}</li>
              ))}
            </ul>
          </div>
        )}
        {trace.length > 0 && (
          <div>
            <h4 className="inv-h">Tool calls · {trace.length}</h4>
            <ul className="trace">
              {trace.map((call) => (
                <li key={call.seq}>
                  {call.seq}. {call.tool} <span className={`st-${call.status}`}>[{call.status}]</span> {call.summary} ({call.durationMs}ms)
                </li>
              ))}
            </ul>
          </div>
        )}
        <dl className="kv inv-meta">
          <dt>Requested by</dt>
          <dd>{inv.requestedBy}</dd>
          <dt>Started</dt>
          <dd>{formatDateTime(inv.startedAt)}</dd>
          <dt>Completed</dt>
          <dd>{formatDateTime(inv.completedAt)}</dd>
          <dt>Source</dt>
          <dd className="muted">{inv.source}</dd>
        </dl>
      </div>
    </details>
  );
}

export function InvestigationCard({ inv, defaultOpen }: { inv: Investigation; defaultOpen: boolean }) {
  const [open, setOpen] = useState(defaultOpen);
  const findings = inv.findings ?? [];
  const risk = inv.riskAssessment;
  return (
    <details className="inv disc" open={open} onToggle={(e) => setOpen(e.currentTarget.open)}>
      <summary className="disc-sum inv-sum">
        <span className="inv-name">{inv.identityName}</span>
        <span className="inv-status">
          <StatusBadge status={inv.status} />
        </span>
        <span className="inv-risk">
          {risk ? (
            <>
              <span className="lcd inv-score" aria-label={`Risk score ${risk.score} of 100`}>
                {risk.score}
              </span>
              <RiskBadge level={risk.level} />
            </>
          ) : (
            <span className="muted" aria-label="No risk score">
              —
            </span>
          )}
        </span>
        <span className="inv-action">
          {inv.recommendedAction && (
            <>
              <span className="inv-k">Action</span>
              <strong>{actionLabel(inv.recommendedAction)}</strong>
            </>
          )}
        </span>
        <time className="inv-time muted-sm" dateTime={inv.startedAt} title={formatDateTime(inv.startedAt)}>
          {relativeTime(inv.startedAt)}
        </time>
      </summary>

      <div className="inv-body">
        {(inv.status === 'running' || inv.status === 'queued') && <StateMessage kind="loading">analysis in progress…</StateMessage>}
        {inv.status === 'failed' && <StateMessage kind="error">{inv.aiSummary || 'investigation failed.'}</StateMessage>}

        {inv.status === 'completed' && (
          <>
            {inv.aiSummary && <Summary text={inv.aiSummary} />}
            {risk && <p className="muted-sm inv-risk-label">Risk · backend-computed</p>}
            {findings.length > 0 ? <Findings findings={findings} /> : <p className="muted-sm">No findings recorded.</p>}
          </>
        )}

        <Evidence inv={inv} />
      </div>
    </details>
  );
}
