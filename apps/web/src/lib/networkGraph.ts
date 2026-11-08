import type { IdentityDependency, IdentityStatus, MachineIdentity } from '@credential-reaper/shared';
import type { fetchIdentityDetail } from '../api/client';
import type { GlyphKind } from '../components/Glyph';

export type IdentityDetail = Awaited<ReturnType<typeof fetchIdentityDetail>>;
export type NodeKind = 'identity' | 'owner' | 'team' | 'dependency';
export type EffectiveState = IdentityStatus | 'hidden';

export interface GraphNode {
  id: string;
  kind: NodeKind;
  label: string;
  sub: string;
  glyph: GlyphKind;
  x: number;
  y: number;
  identity?: MachineIdentity;
  /** Ids of identity nodes this hub is linked to (empty for identity nodes). */
  linkedIdentityIds: string[];
}

export interface GraphLink {
  id: string;
  from: string;
  to: string;
  kind: 'owner' | 'team' | 'dependency';
  d: string;
  straight: string;
}

export interface Graph {
  nodes: GraphNode[];
  links: GraphLink[];
  dust: { x: number; y: number }[];
  dustLinks: string[];
  cx: number;
  cy: number;
  rings: { rx: number; ry: number }[];
}

const DAY = 86_400_000;
export const STALE_AFTER_DAYS = 90;

/** FNV-1a, mapped to [0, 1). Layout is seeded from identity ids so it is identical on every load. */
export function hash01(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0) / 4294967296;
}

const isUnowned = (i: MachineIdentity) => i.status === 'orphaned' || !i.owner.trim() || /^unassigned$/i.test(i.owner.trim());

function curve(ax: number, ay: number, bx: number, by: number, seed: string): string {
  const mx = (ax + bx) / 2;
  const my = (ay + by) / 2;
  const dx = bx - ax;
  const dy = by - ay;
  const bend = (hash01(seed) - 0.5) * 0.45;
  return `M${ax.toFixed(1)} ${ay.toFixed(1)} Q${(mx - dy * bend).toFixed(1)} ${(my + dx * bend).toFixed(1)} ${bx.toFixed(1)} ${by.toFixed(1)}`;
}

export function buildGraph(
  identities: MachineIdentity[],
  details: Record<string, IdentityDetail | undefined>,
  w: number,
  h: number,
): Graph {
  const cx = w / 2;
  const cy = h / 2;
  const narrow = w < 560;
  const rx = Math.max(60, cx - (narrow ? 82 : 110));
  const ry = Math.max(60, cy - (narrow ? 58 : 62));

  const sorted = [...identities].sort((a, b) => hash01(a.id) - hash01(b.id) || a.id.localeCompare(b.id));
  const n = sorted.length;
  const nodes: GraphNode[] = [];
  const byId = new Map<string, GraphNode>();

  sorted.forEach((identity, i) => {
    const angle = -Math.PI / 2 + 0.35 + ((i + (hash01(`${identity.id}a`) - 0.5) * 0.3) * 2 * Math.PI) / Math.max(n, 1);
    const scale = i % 2 === 0 ? 1 : 0.78;
    const node: GraphNode = {
      id: `i:${identity.id}`,
      kind: 'identity',
      label: identity.name,
      sub: `${identity.type} · ${identity.environment}`,
      glyph: identity.type,
      x: cx + rx * scale * Math.cos(angle),
      y: cy + ry * scale * Math.sin(angle),
      identity,
      linkedIdentityIds: [],
    };
    nodes.push(node);
    byId.set(node.id, node);
  });

  const links: { identity: GraphNode; hub: GraphNode; kind: GraphLink['kind'] }[] = [];
  const hubFor = (id: string, kind: NodeKind, label: string, sub: string, glyph: GlyphKind) => {
    let hub = byId.get(id);
    if (!hub) {
      hub = { id, kind, label, sub, glyph, x: cx, y: cy, linkedIdentityIds: [] };
      byId.set(id, hub);
      nodes.push(hub);
    }
    return hub;
  };

  for (const node of [...nodes]) {
    const identity = node.identity!;
    const attach = (hub: GraphNode, kind: GraphLink['kind']) => {
      if (!hub.linkedIdentityIds.includes(identity.id)) hub.linkedIdentityIds.push(identity.id);
      links.push({ identity: node, hub, kind });
    };
    if (!isUnowned(identity)) attach(hubFor(`o:${identity.owner}`, 'owner', identity.owner, 'owner', 'owner'), 'owner');
    attach(hubFor(`t:${identity.team}`, 'team', identity.team, 'team', 'team'), 'team');
    const deps: IdentityDependency[] = details[identity.id]?.dependencies ?? [];
    for (const dep of deps) {
      attach(hubFor(`d:${dep.name.toLowerCase()}`, 'dependency', dep.name, `${dep.kind} · ${dep.relationship}`, dep.kind), 'dependency');
    }
  }

  // Hubs settle between the identities they connect; a fixed number of passes keeps it deterministic.
  const hubs = nodes.filter((nd) => nd.kind !== 'identity');
  const pull = { owner: 0.5, team: 0.36, dependency: 0.62 } as const;
  const targets = hubs.map((hub) => {
    const pts = hub.linkedIdentityIds.map((id) => byId.get(`i:${id}`)!);
    const ax = pts.reduce((s, p) => s + p.x, 0) / pts.length;
    const ay = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    const k = pull[hub.kind as keyof typeof pull];
    const tangent = (hash01(hub.id) - 0.5) * 70;
    const ang = Math.atan2(ay - cy, ax - cx) + Math.PI / 2;
    return { x: cx + (ax - cx) * k + Math.cos(ang) * tangent, y: cy + (ay - cy) * k + Math.sin(ang) * tangent };
  });
  hubs.forEach((hub, i) => {
    hub.x = targets[i].x;
    hub.y = targets[i].y;
  });
  const minGap = narrow ? 44 : 58;
  const ids = nodes.filter((nd) => nd.kind === 'identity');
  for (let pass = 0; pass < 90; pass++) {
    hubs.forEach((hub, i) => {
      hub.x += (targets[i].x - hub.x) * 0.06;
      hub.y += (targets[i].y - hub.y) * 0.06;
    });
    for (let a = 0; a < hubs.length; a++) {
      for (let b = a + 1; b < hubs.length; b++) separate(hubs[a], hubs[b], minGap, 0.5);
      for (const fixed of ids) separate(hubs[a], fixed, minGap + 14, 1);
    }
  }
  for (const hub of hubs) {
    hub.x = Math.min(w - 40, Math.max(40, hub.x));
    hub.y = Math.min(h - 40, Math.max(40, hub.y));
  }

  const graphLinks: GraphLink[] = links.map(({ identity, hub, kind }) => ({
    id: `${identity.id}>${hub.id}`,
    from: identity.identity!.id,
    to: hub.id,
    kind,
    d: curve(identity.x, identity.y, hub.x, hub.y, `${identity.id}${hub.id}`),
    straight: `M${identity.x.toFixed(1)} ${identity.y.toFixed(1)} L${hub.x.toFixed(1)} ${hub.y.toFixed(1)}`,
  }));

  // Unlabelled ambient texture: never interactive, never counted anywhere.
  const dust: { x: number; y: number }[] = [];
  for (let i = 0; dust.length < (narrow ? 14 : 30) && i < 200; i++) {
    const x = 16 + hash01(`dx${i}`) * (w - 32);
    const y = 16 + hash01(`dy${i}`) * (h - 32);
    if (nodes.every((nd) => Math.hypot(nd.x - x, nd.y - y) > 64)) dust.push({ x, y });
  }
  const dustLinks: string[] = [];
  dust.forEach((p, i) => {
    let best = -1;
    let bestD = 150;
    dust.forEach((q, j) => {
      const d = Math.hypot(p.x - q.x, p.y - q.y);
      if (j !== i && d < bestD) {
        best = j;
        bestD = d;
      }
    });
    if (best >= 0 && i % 2 === 0) dustLinks.push(curve(p.x, p.y, dust[best].x, dust[best].y, `dl${i}`));
  });

  return { nodes, links: graphLinks, dust, dustLinks, cx, cy, rings: [0.4, 0.78, 1, 1.32].map((k) => ({ rx: rx * k, ry: ry * k })) };
}

function separate(a: GraphNode, b: GraphNode, min: number, shareA: number) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  const dist = Math.hypot(dx, dy) || 0.01;
  if (dist >= min) return;
  const push = (min - dist) / dist;
  a.x += dx * push * shareA;
  a.y += dy * push * shareA;
  if (shareA < 1) {
    b.x -= dx * push * (1 - shareA);
    b.y -= dy * push * (1 - shareA);
  }
}

export const DAY_MS = DAY;

export function totalDays(startMs: number, nowMs: number) {
  return Math.max(0, Math.ceil((nowMs - startMs) / DAY));
}

/**
 * What an identity looked like at time `t`. Only the present uses the backend status; earlier moments are derived
 * from createdAt, lastUsedAt, usage events and (for retired identities) the identity-retired audit event.
 */
export function stateAt(
  identity: MachineIdentity,
  detail: IdentityDetail | undefined,
  t: number,
  retiredAt: number | undefined,
  atPresent: boolean,
): EffectiveState {
  const created = Date.parse(identity.createdAt);
  if (t < created) return 'hidden';
  if (atPresent) return identity.status;
  if (identity.status === 'retired') {
    const at = retiredAt ?? (identity.lastUsedAt ? Date.parse(identity.lastUsedAt) : created);
    if (t >= at) return 'retired';
  }
  // Repository identities have no usage evidence, so absence of use says nothing about staleness.
  if (identity.dataSource === 'repository') return 'active';
  let lastUse = created;
  const candidates = [identity.lastUsedAt, ...(detail?.usageHistory.map((u) => u.timestamp) ?? [])];
  for (const c of candidates) {
    if (!c) continue;
    const ms = Date.parse(c);
    if (ms <= t && ms > lastUse) lastUse = ms;
  }
  return t - lastUse > STALE_AFTER_DAYS * DAY ? 'stale' : 'active';
}

export const RISK_RANK = { low: 1, medium: 2, high: 3, critical: 4 } as const;
