import './StatusBadge.css';

export type StatusBadgeTone = 'neutral' | 'processing' | 'ready' | 'warning' | 'danger';

export type StatusBadgeProps = {
  tone: StatusBadgeTone;
  label: string;
  compact?: boolean;
  title?: string;
  testId?: string;
  progress?: 0 | 1 | 2 | 3;
};

const PROGRESS_STAGES = [0, 1, 2] as const;

/** Presentation only: callers supply the observed state and completed stage count. */
export function StatusBadge({
  tone,
  label,
  compact = false,
  title,
  testId,
  progress
}: StatusBadgeProps): React.JSX.Element {
  const reduced = useEffectiveReducedMotion();
  const ready = tone === 'ready' && (progress === undefined || progress === 3);
  return <span className="status-badge" data-tone={tone} data-compact={compact}
    data-progress={progress} data-ready={ready} data-motion-reduced={reduced || undefined} data-testid={testId} title={title ?? label}>
    <span className="status-badge__mark" aria-hidden="true">
      <span className="status-badge__track">
      {progress === undefined ? <span className="status-badge__dot" /> : <svg
        className="status-badge__progress" viewBox="0 0 12 12" focusable="false">
        {PROGRESS_STAGES.map(stage => {
          const state = stage < progress ? 'completed' : tone === 'processing' && stage === progress ? 'current' : 'pending';
          return <rect key={stage} className="status-badge__segment" data-state={state}
            x={0.5 + stage * 4} y={state === 'current' ? 3 : 4}
            width="3" height={state === 'current' ? 6 : 4} rx="1" />;
        })}
      </svg>}
      </span>
      <Check size={12} className="status-badge__confirmation"/>
    </span>
    <span className={`status-badge__label${compact ? ' status-badge__hidden' : ''}`}>{label}</span>
    {progress === undefined ? null : <span className="status-badge__hidden">，阶段进度 {progress}/3</span>}
  </span>;
}
import {Check} from 'lucide-react';
import {useEffectiveReducedMotion} from './motion-preference';
