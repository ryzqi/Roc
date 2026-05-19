import type React from 'react';
import { StatusPill as SharedStatusPill } from '../components/StatusPill';

export type PillTone = 'neutral' | 'ok' | 'warn' | 'bad' | 'info';

export const StatusPill = SharedStatusPill;

export function InfoRow({
  sub,
  tag,
  title,
  tone = 'neutral'
}: {
  sub?: string;
  tag: string;
  title: string;
  tone?: PillTone;
}): React.JSX.Element {
  return (
    <div className="row">
      <div>
        <div className="row-title">{title}</div>
        {sub === undefined ? null : <div className="row-sub">{sub}</div>}
      </div>
      <span className={`pill ${tone}`}>{tag}</span>
    </div>
  );
}

export function FieldRow({
  children,
  hint,
  label
}: {
  children: React.ReactNode;
  hint?: string;
  label: string;
}): React.JSX.Element {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
      {hint === undefined ? null : <small className="field-hint">{hint}</small>}
    </label>
  );
}
