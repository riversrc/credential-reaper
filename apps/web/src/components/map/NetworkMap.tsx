import { useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { buildGraph, type EffectiveState, type GraphNode, type IdentityDetail } from '../../lib/networkGraph';
import type { MachineIdentity } from '@credential-reaper/shared';
import { useElementWidth } from '../../hooks/useElementWidth';
import { useReducedMotion } from '../../hooks/useReducedMotion';
import { Glyph } from '../Glyph';
import { TYPE_LABEL } from '../../lib/typeLabels';

interface NetworkMapProps {
  identities: MachineIdentity[];
  details: Record<string, IdentityDetail | undefined>;
  states: Record<string, EffectiveState>;
  dimmedIds: Set<string>;
  selectedId: string | null;
  onSelect: (id: string) => void;
  onFocusChange: (id: string | null) => void;
}

const truncate = (s: string, max: number) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

function accessibleName(identity: MachineIdentity, state: EffectiveState) {
  return `${identity.name}, ${TYPE_LABEL[identity.type]}, ${state === 'hidden' ? identity.status : state}, ${identity.riskLevel} risk`;
}

export function NetworkMap({ identities, details, states, dimmedIds, selectedId, onSelect, onFocusChange }: NetworkMapProps) {
  const [wrapRef, width] = useElementWidth<HTMLDivElement>();
  const reduced = useReducedMotion();
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const nodeRefs = useRef<Record<string, SVGGElement | null>>({});

  const w = Math.max(width, 280);
  const h = w < 560 ? Math.round(w * 1.15) : Math.min(620, Math.max(440, Math.round(w * 0.6)));
  const graph = useMemo(() => buildGraph(identities, details, w, h), [identities, details, w, h]);
  const labelMax = w < 560 ? 16 : 24;

  const active = hoverId ?? focusId;
  const isVisible = (id: string) => (states[id] ?? 'active') !== 'hidden';
  const identityNodes = graph.nodes.filter((n) => n.kind === 'identity');

  const visibleHub = (node: GraphNode) => node.linkedIdentityIds.some(isVisible);
  const hubMatches = (node: GraphNode) => node.linkedIdentityIds.some((id) => isVisible(id) && !dimmedIds.has(id));
  const relatedToActive = (node: GraphNode) => active !== null && node.linkedIdentityIds.includes(active);
  const neighbors = new Set<string>();
  if (active) for (const n of graph.nodes) if (n.linkedIdentityIds.includes(active)) n.linkedIdentityIds.forEach((id) => neighbors.add(id));
  const identityById = new Map(identities.map((i) => [i.id, i]));

  function setHover(id: string | null) {
    setHoverId(id);
    onFocusChange(id ?? focusId);
  }
  function setFocus(id: string | null) {
    setFocusId(id);
    onFocusChange(id ?? hoverId);
  }

  function onKeyDown(e: KeyboardEvent<HTMLDivElement>) {
    if (e.key === 'Escape') {
      setHoverId(null);
      setFocusId(null);
      onFocusChange(null);
      (document.activeElement as HTMLElement | null)?.blur();
      return;
    }
    const dir = e.key === 'ArrowRight' || e.key === 'ArrowDown' ? 1 : e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 0;
    if (!dir) return;
    const order = identityNodes.map((n) => n.identity!.id).filter(isVisible);
    if (order.length === 0) return;
    e.preventDefault();
    const at = focusId ? order.indexOf(focusId) : -1;
    const next = order[(at + dir + order.length) % order.length];
    nodeRefs.current[next]?.focus();
  }

  const activeNode = active ? identityNodes.find((n) => n.identity!.id === active) : undefined;

  return (
    <div className="map-canvas scanlines" ref={wrapRef} style={{ height: h }} onKeyDown={onKeyDown}>
      {width > 0 && (
        <svg
          width={w}
          height={h}
          viewBox={`0 0 ${w} ${h}`}
          role="group"
          aria-label={`Network map of ${identities.length} machine identities. Use arrow keys to move between identities and Enter to open one.`}
        >
          <g aria-hidden="true">
            {graph.rings.map((r, i) => (
              <ellipse key={i} className="map-ring" cx={graph.cx} cy={graph.cy} rx={r.rx} ry={r.ry} />
            ))}
            {graph.dustLinks.map((d, i) => (
              <path key={i} d={d} className="dust-link" />
            ))}
            {graph.dust.map((p, i) => (
              <rect key={i} x={p.x - 1.5} y={p.y - 1.5} width={3} height={3} className="dust" />
            ))}
          </g>

          <g aria-hidden="true">
            {graph.links.map((link) => {
              const identity = identityById.get(link.from)!;
              const state = states[identity.id] ?? 'active';
              const lit = active === link.from;
              const threat = identity.riskLevel === 'critical' || identity.status === 'orphaned';
              const cls = [
                'map-link',
                threat && 'is-threat',
                state === 'hidden' && 'is-hidden',
                active !== null && !lit && 'is-faded',
                lit && 'is-lit',
                dimmedIds.has(identity.id) && 'is-dim',
              ]
                .filter(Boolean)
                .join(' ');
              return (
                <g key={link.id}>
                  <path className={cls} d={lit ? link.straight : link.d} pathLength={1} />
                  {!reduced && state === 'active' && !dimmedIds.has(identity.id) && !threat && (
                    <circle className="map-pulse" r={2} aria-hidden="true">
                      <animateMotion dur={`${3 + hashDur(link.id)}s`} repeatCount="indefinite" path={link.d} />
                    </circle>
                  )}
                </g>
              );
            })}
          </g>

          {graph.nodes
            .filter((n) => n.kind !== 'identity')
            .map((node) => {
              const dim = !hubMatches(node) || (active !== null && !relatedToActive(node));
              const size = node.kind === 'dependency' ? 14 : 18;
              return (
                <g
                  key={node.id}
                  className={`map-hub hub-${node.kind}${visibleHub(node) ? '' : ' is-hidden'}${dim ? ' is-dim' : ''}`}
                  transform={`translate(${node.x} ${node.y})`}
                  role="img"
                  aria-label={`${node.kind}: ${node.label}`}
                >
                  <rect x={-size / 2} y={-size / 2} width={size} height={size} />
                  <Glyph kind={node.glyph} size={size - 5} x={0} y={0} />
                  <text y={size / 2 + 11} textAnchor="middle" className="map-label-sm">
                    {truncate(node.label, labelMax).toUpperCase()}
                  </text>
                </g>
              );
            })}

          {identityNodes.map((node) => {
            const identity = node.identity!;
            const state = states[identity.id] ?? 'active';
            const hidden = state === 'hidden';
            const dim = dimmedIds.has(identity.id) || (active !== null && active !== identity.id && !neighbors.has(identity.id));
            const critical = identity.riskLevel === 'critical';
            const cls = [
              'map-node',
              `risk-${identity.riskLevel}`,
              `state-${state}`,
              hidden && 'is-hidden',
              dim && 'is-dim',
              selectedId === identity.id && 'is-selected',
              active === identity.id && 'is-active',
            ]
              .filter(Boolean)
              .join(' ');
            return (
              <g
                key={node.id}
                ref={(el) => {
                  nodeRefs.current[identity.id] = el;
                }}
                className={cls}
                transform={`translate(${node.x} ${node.y})`}
                role="button"
                tabIndex={hidden ? -1 : 0}
                aria-hidden={hidden || undefined}
                aria-label={accessibleName(identity, state)}
                onPointerEnter={() => setHover(identity.id)}
                onPointerLeave={() => setHover(null)}
                onFocus={() => setFocus(identity.id)}
                onBlur={() => setFocus(null)}
                onClick={() => onSelect(identity.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(identity.id);
                  }
                }}
              >
                <circle className="node-halo" r={32} />
                {critical && !reduced && <circle className="node-crit-halo" r={24} />}
                {critical && reduced && <circle className="node-crit-halo-static" r={26} />}
                {state === 'orphaned' && <circle className="node-orphan-ring" r={25} strokeDasharray="62 13.4" />}
                <rect className="node-chip" x={-14} y={-14} width={28} height={28} />
                <g className="node-glyph">
                  <Glyph kind={node.glyph} size={18} x={0} y={0} />
                </g>
                {critical && (
                  <g aria-hidden="true">
                    <rect className="node-bang-box" x={8} y={-21} width={12} height={12} />
                    <text className="node-bang" x={14} y={-11.5} textAnchor="middle">
                      !
                    </text>
                  </g>
                )}
                <text className="map-label" y={31} textAnchor="middle">
                  {truncate(identity.name, labelMax).toUpperCase()}
                </text>
                <text className="map-label-sub" y={43} textAnchor="middle">
                  {truncate(node.sub, labelMax + 8)}
                </text>
              </g>
            );
          })}
        </svg>
      )}

      {activeNode && (
        <div
          className="map-tip"
          role="presentation"
          style={{ left: Math.min(w - 110, Math.max(110, activeNode.x)), top: Math.max(8, activeNode.y - 74) }}
        >
          <strong>{activeNode.identity!.name}</strong>
          <span>
            {TYPE_LABEL[activeNode.identity!.type]} · {states[activeNode.identity!.id] === 'hidden' ? activeNode.identity!.status : states[activeNode.identity!.id]} ·{' '}
            {activeNode.identity!.riskLevel} risk
          </span>
        </div>
      )}
    </div>
  );

}

function hashDur(id: string) {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 997;
  return (h % 30) / 10;
}

export function MapLegend() {
  const swatch = (cls: string, ring?: boolean) => (
    <svg width="20" height="20" viewBox="-12 -12 24 24" aria-hidden="true" className={`legend-swatch map-node ${cls}`}>
      {ring && <circle className="node-orphan-ring" r={10} strokeDasharray="25 5.4" />}
      <rect className="node-chip" x={-6} y={-6} width={12} height={12} />
    </svg>
  );
  return (
    <ul className="map-legend" aria-label="Map legend">
      <li>{swatch('risk-low state-active')}Active</li>
      <li>{swatch('risk-medium state-stale')}Stale</li>
      <li>{swatch('risk-critical state-orphaned', true)}Orphaned, no owner link</li>
      <li>{swatch('risk-low state-retired')}Retired</li>
      <li className="legend-note">Border colour = backend risk level, never colour alone: label, glyph and ring style repeat it</li>
    </ul>
  );
}
