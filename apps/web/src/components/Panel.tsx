import type { ReactNode } from 'react';

interface PanelProps {
  title?: ReactNode;
  actions?: ReactNode;
  bracketed?: boolean;
  flush?: boolean;
  className?: string;
  children: ReactNode;
}

export function Panel({ title, actions, bracketed, flush, className = '', children }: PanelProps) {
  const cls = ['panel', bracketed && 'bracketed', flush && 'panel-flush', className].filter(Boolean).join(' ');
  return (
    <section className={cls}>
      {(title || actions) && (
        <div className="panel-head">
          {title ? <h3>{title}</h3> : <span />}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}
