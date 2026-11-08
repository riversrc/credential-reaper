import type { ReactNode } from 'react';

interface StateMessageProps {
  kind: 'loading' | 'empty' | 'error';
  children: ReactNode;
  actions?: ReactNode;
}

export function StateMessage({ kind, children, actions }: StateMessageProps) {
  const prompt = kind === 'error' ? '!' : '>';
  return (
    <div className={`term-state term-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      <span className="prompt" aria-hidden="true">
        {prompt}
      </span>
      {kind === 'error' && <strong>ERROR: </strong>}
      {children}
      {kind === 'loading' && <span className="cursor" aria-hidden="true" />}
      {actions && <div className="term-actions">{actions}</div>}
    </div>
  );
}
