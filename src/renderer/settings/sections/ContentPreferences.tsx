import { useContentPreferences } from '../../app/use-content-preferences';
import { PreferenceRow } from '../PreferenceRow';

export function ContentPreferences(): React.JSX.Element {
  const { preferences, update } = useContentPreferences();
  return (
    <div className="flex flex-col gap-4" data-testid="settings-content-preferences">
      <PreferenceRow label="界面密度" description="立即调整列表行高、控件与面板间距。" value={preferences.density}
        options={[{ value: 'compact', label: '紧凑' }, { value: 'comfortable', label: '舒适' }]}
        onChange={(density) => update({ density })} testId="settings-density" />
      <PreferenceRow label="阅读字号" description="立即调整文献、文稿预览与对话正文。" value={preferences.readSize}
        options={([14, 15, 16] as const).map((value) => ({ value, label: `${value} px` }))}
        onChange={(readSize) => update({ readSize })} testId="settings-read-size" />
      <PreferenceRow label="代码字号" description="立即调整代码与命令输出文字。" value={preferences.codeSize}
        options={([12, 13, 14] as const).map((value) => ({ value, label: `${value} px` }))}
        onChange={(codeSize) => update({ codeSize })} testId="settings-code-size" />
    </div>
  );
}
