import { useEffect, useMemo, useRef } from 'react';
import { Link } from 'react-router-dom';
import type { AuditEvent, Investigation, MachineIdentity, RiskLevel } from '@credential-reaper/shared';
import type { IdentityDetail } from '../../lib/networkGraph';
import { buildHistory, formatStamp } from '../../lib/history';
import { ArrowRight, Glyph, type GlyphKind } from '../Glyph';
import { TYPE_LABEL } from '../../lib/typeLabels';
import { BasisTag, RiskBadge, StatusBadge } from '../Badges';
import { StateMessage } from '../StateMessage';

interface MapOverlayProps {
  identity: MachineIdentity;
  detail: IdentityDetail | undefined;
  investigations: Investigation[] | null;
  audit: AuditEvent[] | null;
  onClose: () => void;
}

const RISK_PIPS: Record<RiskLevel, number> = { low: 1, medium: 2, high: 3, critical: 4 };
const FOCUSABLE = 'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input, select';

function RiskRing({ level, score }: { level: RiskLevel; score: number }) {
  const hot = level === 'critical' || level === 'high';
  return (
    <div className={`risk-ring risk-${level}`}>
      <svg viewBox="-60 -60 120 120" width="120" height="120" aria-hidden="true">
        <polygon className="ring-outer" points="-24,-54 24,-54 54,-24 54,24 24,54 -24,54 -54,24 -54,-24" />
        <polygon className="ring-inner" points="-18,-42 18,-42 42,-18 42,18 18,42 -18,42 -42,18 -42,-18" />
      </svg>
      <div className="risk-ring-body">
        <span className="lcd">{score}</span>
        <span className="muted-sm">/100</span>
      </div>
      <div className="risk-ring-caption">
        <span className="kv-label">RISK LEVEL</span>
        <strong className={hot ? 'hot' : undefined}>{level.toUpperCase()}</strong>
        <span className="pips" role="img" aria-label={`${RISK_PIPS[level]} of 4`}>
          {[1, 2, 3, 4].map((n) => (
            <i key={n} className={n <= RISK_PIPS[level] ? 'on' : undefined} />
          ))}
        </span>
        <span className="muted-sm">backend-computed</span>
      </div>
    </div>
  );
}

interface Bubble {
  key: string;
  kind: GlyphKind;
  label: string;
  ghost?: boolean;
  linked: boolean;
}

function EgoGraph({ identity, detail }: { identity: MachineIdentity; detail: IdentityDetail | undefined }) {
  const unowned = identity.status === 'orphaned' || !identity.owner.trim() || /^unassigned$/i.test(identity.owner.trim());
  const bubbles: Bubble[] = [
    unowned
      ? { key: 'owner', kind: 'owner', label: 'NO OWNER', ghost: true, linked: false }
      : { key: 'owner', kind: 'owner', label: identity.owner, linked: true },
    { key: 'team', kind: 'team', label: identity.team, linked: true },
    ...(detail?.dependencies ?? []).map((d) => ({ key: d.id, kind: d.kind as GlyphKind, label: d.name, linked: true })),
  ];
  const cx = 260;
  const cy = 170;
  const critical = identity.riskLevel === 'critical';
  const n = bubbles.length;
  return (
    <svg className={`ego risk-${identity.riskLevel}`} viewBox="0 0 520 340" role="img" aria-label={`Neighbours of ${identity.name}: ${bubbles.map((b) => b.label).join(', ')}`}>
      <circle className="map-ring" cx={cx} cy={cy} r={95} />
      <circle className="map-ring" cx={cx} cy={cy} r={150} />
      {bubbles.map((b, i) => {
        const angle = -Math.PI / 2 + (i * 2 * Math.PI) / n + 0.4;
        const r = i % 2 === 0 ? 125 : 105;
        const x = cx + r * 1.3 * Math.cos(angle);
        const y = cy + r * Math.sin(angle);
        return (
          <g key={b.key} className={`ego-bubble${b.ghost ? ' is-ghost' : ''}`}>
            {b.linked && <line className="ego-link" x1={cx} y1={cy} x2={x} y2={y} />}
            <circle cx={x} cy={y} r={20} />
            <Glyph kind={b.kind} size={16} x={x} y={y} />
            <text x={x} y={y + 35} textAnchor="middle" className="map-label-sm">
              {(b.label.length > 22 ? `${b.label.slice(0, 21)}…` : b.label).toUpperCase()}
            </text>
          </g>
        );
      })}
      <g className="ego-center">
        {critical && <circle className="node-crit-halo" cx={cx} cy={cy} r={40} />}
        <circle cx={cx} cy={cy} r={32} />
        <Glyph kind={identity.type} size={24} x={cx} y={cy} />
        <text x={cx} y={cy + 52} textAnchor="middle" className="map-label">
          {identity.name.toUpperCase()}
        </text>
      </g>
    </svg>
  );
}

export function MapOverlay({ identity, detail, investigations, audit, onClose }: MapOverlayProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    closeRef.current?.focus();
    return () => {
      document.body.style.overflow = prevOverflow;
      opener?.focus?.();
    };
  }, []);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
        return;
      }
      if (e.key !== 'Tab' || !panelRef.current) return;
      const items = Array.from(panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((el) => el.offsetParent !== null);
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onClose]);

  const latest = useMemo(
    () =>
      (investigations ?? [])
        .filter((i) => i.identityId === identity.id && i.status === 'completed')
        .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0],
    [investigations, identity.id],
  );

  const history = useMemo(() => buildHistory(identity, detail, audit), [identity, detail, audit]);

  const findings = latest?.findings ?? [];

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="overlay-panel bracketed" role="dialog" aria-modal="true" aria-labelledby="overlay-title" ref={panelRef}>
        <header className="overlay-head">
          <div>
            <h2 id="overlay-title">{identity.name}</h2>
            <div className="overlay-tags">
              <StatusBadge status={identity.status} />
              <RiskBadge level={identity.riskLevel} />
            </div>
          </div>
          <button type="button" className="btn btn-secondary btn-sm" ref={closeRef} onClick={onClose}>
            Close <span className="muted-sm">Esc</span>
          </button>
        </header>

        <div className="overlay-grid">
          <div className="overlay-col">
            <dl className="kv">
              <dt>Type</dt>
              <dd>{TYPE_LABEL[identity.type]}</dd>
              <dt>Owner</dt>
              <dd>{identity.owner}</dd>
              <dt>Team</dt>
              <dd>{identity.team}</dd>
              <dt>Environment</dt>
              <dd>{identity.environment}</dd>
            </dl>
            <RiskRing level={identity.riskLevel} score={identity.riskScore} />
            {!detail ? (
              <StateMessage kind="error">Detail request failed for this identity. Permissions, dependencies and credentials are unavailable.</StateMessage>
            ) : (
              <>
                <h3>Permissions</h3>
                <ul className="mini-list">
                  {detail.permissions.length === 0 && <li className="muted">none on record</li>}
                  {detail.permissions.map((p) => (
                    <li key={p.id}>
                      <span>{p.resource}</span>
                      <span className="muted-sm">{p.scope}</span>
                    </li>
                  ))}
                </ul>
                <h3>Dependencies</h3>
                <ul className="mini-list">
                  {detail.dependencies.length === 0 && <li className="muted">none known</li>}
                  {detail.dependencies.map((d) => (
                    <li key={d.id}>
                      <span>{d.name}</span>
                      <span className="muted-sm">
                        {d.kind} · {d.relationship}
                      </span>
                    </li>
                  ))}
                </ul>
                <h3>Credentials</h3>
                <ul className="mini-list">
                  {detail.credentials.length === 0 && <li className="muted">none on record</li>}
                  {detail.credentials.map((c) => (
                    <li key={c.id}>
                      <span className="mono">{c.maskedPreview}</span>
                      <span className="muted-sm">{c.kind}</span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="overlay-center">
            <EgoGraph identity={identity} detail={detail} />
          </div>

          <div className="overlay-col">
            <h3>History</h3>
            {audit === null && <p className="muted-sm">Audit history is unavailable right now.</p>}
            <ol className="history" tabIndex={0} aria-label={`History of ${identity.name}, newest first`}>
              {history.map((h, i) => (
                <li key={`${h.ts}-${i}`}>
                  <span className="ts">{formatStamp(h.ts)}</span>
                  <strong>{h.title}</strong>
                  <span className="muted-sm">{h.meta}</span>
                </li>
              ))}
            </ol>
          </div>
        </div>

        <div className="overlay-issues">
          <h3>Findings from the latest investigation</h3>
          {investigations === null && <StateMessage kind="error">Investigations could not be loaded.</StateMessage>}
          {investigations !== null && !latest && <StateMessage kind="empty">no completed investigation for this identity yet.</StateMessage>}
          {findings.length > 0 && (
            <ul className="issues">
              {findings.map((f) => (
                <li key={f.id}>
                  <RiskBadge level={f.severity === 'info' ? 'low' : f.severity} />
                  <span className="issue-cat">{f.category}</span>
                  <BasisTag basis={f.basis} />
                  <span className="issue-desc">{f.description}</span>
                </li>
              ))}
            </ul>
          )}
        </div>

        <footer className="overlay-actions">
          <Link className="btn btn-secondary btn-sm" to={`/identities/${identity.id}`}>
            Open details
          </Link>
          <Link className="btn btn-secondary btn-sm" to={`/investigations?identity=${encodeURIComponent(identity.id)}`}>
            Start investigation
          </Link>
          <Link className="btn btn-sm" to="/remediation">
            View remediation <ArrowRight />
          </Link>
        </footer>
      </div>
    </div>
  );
}
