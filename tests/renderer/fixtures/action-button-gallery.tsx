import {ActionButton, FormSection, TextField} from '../../../src/renderer/shared/form-ui';
import {StickySaveBar} from '../../../src/renderer/settings/StickySaveBar';

const variants = [
  {id: 'primary', label: '保存设置', loadingLabel: '保存中…'},
  {id: 'secondary', label: '测试连通', loadingLabel: '测试中…'},
  {id: 'compact', label: '重新读取', loadingLabel: '读取中…'}
] as const;
const states = [
  {id: 'default', label: '默认'},
  {id: 'hover', label: '悬停'},
  {id: 'active', label: '按下'},
  {id: 'disabled', label: '禁用'},
  {id: 'loading', label: '加载'},
  {id: 'focus', label: '键盘焦点'}
] as const;

/** Permanent renderer fixture: hover, press and focus are native interactions. */
export function ActionButtonGallery(): React.JSX.Element {
  return <main className="mx-auto flex max-w-[960px] flex-col gap-6 p-6" data-testid="action-gallery">
    <FormSection title="模型与服务" testId="action-gallery-section">
      <div className="form-action-row">
        <TextField label="接入地址" value="https://models.example/v1" onChange={() => {}}
          testId="action-gallery-endpoint" />
        <ActionButton>测试连通</ActionButton>
      </div>
      <div className="grid grid-cols-[minmax(72px,1fr)_repeat(3,minmax(0,1fr))] items-center gap-3">
        {states.map(state => <div key={state.id} className="contents">
          <span className="text-muted text-[length:var(--font-meta-size)]">{state.label}</span>
          {variants.map(variant => <div key={variant.id} className="min-w-0">
            <ActionButton variant={variant.id} disabled={state.id === 'disabled'} loading={state.id === 'loading'}
              loadingLabel={variant.loadingLabel} data-testid={`action-${variant.id}-${state.id}`}>
              {variant.label}
            </ActionButton>
          </div>)}
        </div>)}
      </div>
    </FormSection>
    <StickySaveBar dirtyCount={2} highImpactCount={0} savedAt={null} busy={false}
      saving={false} transientDirty={false} onDiscard={() => {}} onSave={() => {}} />
  </main>;
}
