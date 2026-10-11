import type { ButtonHTMLAttributes, ReactNode } from 'react';
import { errorMessage } from '../lib/format';

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <div className="state" role="status" aria-live="polite">
      <span className="spinner" aria-hidden="true" />
      <span>{label}…</span>
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  return (
    <div className="state state-error" role="alert">
      <p>{errorMessage(error)}</p>
      {onRetry && (
        <button type="button" className="btn" onClick={onRetry}>
          Try again
        </button>
      )}
    </div>
  );
}

export function EmptyState({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="state state-empty">
      <p className="state-title">{title}</p>
      {children && <p className="muted">{children}</p>}
    </div>
  );
}

interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  busy?: boolean;
  variant?: 'primary' | 'default' | 'ghost';
}

export function Button({ busy = false, variant = 'default', className, children, disabled, ...rest }: ButtonProps) {
  const classes = ['btn', variant !== 'default' ? `btn-${variant}` : '', className ?? ''].filter(Boolean).join(' ');
  return (
    <button type="button" {...rest} className={classes} disabled={disabled || busy} aria-busy={busy || undefined}>
      {busy && <span className="spinner spinner-sm" aria-hidden="true" />}
      {children}
    </button>
  );
}

/** Inline form feedback. Errors interrupt (alert); confirmations are polite. */
export function Notice({ kind, children }: { kind: 'error' | 'success' | 'info'; children: ReactNode }) {
  return (
    <p className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>
      {children}
    </p>
  );
}
