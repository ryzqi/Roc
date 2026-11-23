import { TriangleAlert } from 'lucide-react';
import { ActionButton } from '../shared/form-ui';

export function StickySaveBar({dirtyCount, savedOnce, highImpactCount, busy, saving, transientDirty, onDiscard, onSave}: {
  dirtyCount: number;
  savedOnce: boolean;
  highImpactCount: number;
  busy: boolean;
  saving: boolean;
  transientDirty: boolean;
  onDiscard: () => void;
  onSave: () => void;
}): React.JSX.Element {
  const dirty = dirtyCount > 0 || transientDirty;
  return <footer className="sticky-save-bar flex shrink-0 flex-wrap items-center gap-2 border-t-[0.5px] border-line-default pt-3" data-testid="settings-sticky-save-bar">
    <span className="min-w-0 flex-1 text-ink-muted text-[length:var(--font-meta-size)] tabular-nums" role="status" data-testid="settings-dirty-bar">
      {dirtyCount > 0 ? `未保存 ${dirtyCount.toLocaleString('zh-CN')} 项` : transientDirty ? '编辑内容尚未保存' : savedOnce ? '所有修改已保存' : ''}{transientDirty && dirtyCount > 0 ? '，编辑内容尚未保存' : ''}
      {highImpactCount > 0 ? <span className="ms-2 inline-flex items-center gap-1 text-[var(--st-warn)]" data-testid="settings-high-impact"><TriangleAlert size={12} aria-hidden="true" />{highImpactCount.toLocaleString('zh-CN')} 项高影响修改</span> : null}
    </span>
    <ActionButton onClick={onDiscard} disabled={!dirty || busy} data-testid="settings-discard-draft">放弃修改</ActionButton>
    <ActionButton variant="primary" onClick={onSave} disabled={dirtyCount === 0 || busy}
      loading={saving} loadingLabel="保存中…" data-testid="settings-save">保存设置</ActionButton>
  </footer>;
}
