import type { IdentityDependency, IdentityType } from '@credential-reaper/shared';

export type GlyphKind = IdentityType | IdentityDependency['kind'] | 'owner' | 'team';

const PATHS: Record<GlyphKind, string> = {
  'service-account': 'M8 7.5a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5ZM3 14c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5',
  'api-key': 'M5 11.5a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM8 8.5h6.5M12 8.5v2.5M14.5 8.5V10',
  'oauth-app': 'M2.5 3.5h11v9h-11ZM2.5 6.5h11M6 9.5l1.5 1.5L10.5 8',
  'ssh-key': 'M2.5 3h11v10h-11ZM5 6.5 7.5 8.5 5 10.5M8.5 11h3',
  certificate: 'M3 2.5h10v8H3ZM5.5 5.5h5M5.5 8h3M10.5 13.5l-1-2.5M11 11l1 2.5',
  'bot-account': 'M3 5.5h10v7H3ZM8 5.5v-3M6 8.5v1M10 8.5v1',
  webhook: 'M4 12.5a1.8 1.8 0 1 0 0-.01ZM12 12.5a1.8 1.8 0 1 0 0-.01ZM8 4.5a1.8 1.8 0 1 0 0-.01ZM5.3 11 7 6.2M10.7 11 9 6.2M5.8 12.5h4.4',
  owner: 'M8 7a2.3 2.3 0 1 0 0-4.6A2.3 2.3 0 0 0 8 7ZM3.5 13.5c0-2.4 2-3.8 4.5-3.8s4.5 1.4 4.5 3.8',
  team: 'M5.5 7a2 2 0 1 0 0-4 2 2 0 0 0 0 4ZM11 7.5a1.7 1.7 0 1 0 0-3.4 1.7 1.7 0 0 0 0 3.4ZM1.8 13c0-2 1.7-3.3 3.7-3.3S9.2 11 9.2 13M10 10.2c2.2-.3 4.2.7 4.2 2.6',
  service: 'M8 2 13.5 5v6L8 14 2.5 11V5ZM2.5 5 8 8l5.5-3M8 8v6',
  pipeline: 'M2.5 4.5 6 8l-3.5 3.5M7.5 4.5 11 8l-3.5 3.5M12.5 4v8',
  application: 'M2.5 3h11v10h-11ZM2.5 6h11M4.5 4.5h.01M6.5 4.5h.01',
  'data-store': 'M3 4c0-1 2.2-1.8 5-1.8S13 3 13 4s-2.2 1.8-5 1.8S3 5 3 4ZM3 4v8c0 1 2.2 1.8 5 1.8S13 13 13 12V4M3 8c0 1 2.2 1.8 5 1.8S13 9 13 8',
};

interface GlyphProps {
  kind: GlyphKind;
  size?: number;
  x?: number;
  y?: number;
}

/** 16x16 stroke glyph. Pass x/y to place inside an <svg>; omit for standalone HTML use. */
export function Glyph({ kind, size = 16, x, y }: GlyphProps) {
  const path = <path d={PATHS[kind]} fill="none" stroke="currentColor" strokeWidth={1.4} strokeLinecap="square" strokeLinejoin="miter" />;
  if (x !== undefined && y !== undefined) {
    const s = size / 16;
    return <g transform={`translate(${x - size / 2} ${y - size / 2}) scale(${s})`}>{path}</g>;
  }
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      {path}
    </svg>
  );
}

export function ArrowRight({ className = 'btn-arrow' }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <path d="M2 8h11M9 4l4 4-4 4" fill="none" stroke="currentColor" strokeWidth={1.6} strokeLinecap="square" />
    </svg>
  );
}
