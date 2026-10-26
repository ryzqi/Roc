import { useState } from 'react';
import { useContentPreferences } from '../../app/use-content-preferences';
import type { ContentPreferences as Preferences } from '../../app/ui-state';

export function ContentPreferences(): React.JSX.Element {
  const { preferences, update } = useContentPreferences();
  const [note, setNote] = useState('');
  const change = (patch: Partial<Preferences>): void => { update(patch); setNote('显示偏好已更新'); };
  const control = 'h-[var(--control-height-compact)] rounded-control border-[0.5px] border-line px-3 text-[var(--font-meta-size)] text-muted hover:bg-[var(--overlay-hover)] aria-pressed:bg-[var(--overlay-active)] aria-pressed:text-ink';
  return (
    <fieldset className="flex flex-col gap-3 border-t-[0.5px] border-line pt-3" data-testid="settings-content-preferences">
      <legend className="text-[var(--font-ui-size)] font-medium">显示偏好</legend>
      <div role="group" aria-label="界面密度" className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-muted">界面密度</span>
        {([['compact', '紧凑'], ['comfortable', '舒适']] as const).map(([id, label]) => (
          <button key={id} type="button" aria-pressed={preferences.density === id} className={control}
            data-testid={`settings-density-${id}`} onClick={() => change({ density: id })}>{label}</button>
        ))}
      </div>
      <div role="group" aria-label="阅读字号" className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-muted">阅读字号</span>
        {([14, 15, 16] as const).map(size => (
          <button key={size} type="button" aria-pressed={preferences.readSize === size} className={control}
            data-testid={`settings-read-size-${size}`} onClick={() => change({ readSize: size })}>{size} px</button>
        ))}
      </div>
      <div role="group" aria-label="代码字号" className="flex flex-wrap items-center gap-2">
        <span className="w-20 text-muted">代码字号</span>
        {([12, 13, 14] as const).map(size => (
          <button key={size} type="button" aria-pressed={preferences.codeSize === size} className={control}
            data-testid={`settings-code-size-${size}`} onClick={() => change({ codeSize: size })}>{size} px</button>
        ))}
      </div>
      <p role="status" className="min-h-4 text-muted text-[var(--font-meta-size)]">{note}</p>
    </fieldset>
  );
}
