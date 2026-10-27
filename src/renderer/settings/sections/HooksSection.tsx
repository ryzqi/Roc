import { useEffect, useMemo, useState } from 'react';
import { ShieldCheck, ShieldQuestion } from 'lucide-react';
import { rocHookConfigSchema } from '../../../shared/schemas/ipc-memory-settings';
import type { RocHookCommandHandler, RocHookConfigSnapshot } from '../../../shared/types';
import { useAsyncAction } from '../../app/use-async-resource';
import type { SettingsDraft } from '../settings-rules';
import type { SettingsStore } from '../settings-scope';
import { trustHook } from '../settings-store';
import {
  CheckboxField,
  KeyValueRow,
  FormNote,
  FormSection,
  formSecondaryButtonClass,
  formTextAreaClass
} from '../../shared/form-ui';

/**
 * Hooks (T8.3).
 *
 * The legacy surface had no hooks UI at all, so this section is new — and the backend's
 * trust model is the reason it cannot be "a JSON textarea and nothing else":
 *
 *  - every handler's `trustState` comes from `hookTrustService` and is keyed on a hash of
 *    (event, matcher, command, timeout, failure mode). **Editing a handler resets trust**,
 *    so a `review_required` row needs an explicit `trustHook({handlerId, hash})` before the
 *    hook is allowed to run;
 *  - handler ids are structured (`event:groupIndex:hookIndex`), which is what lets the
 *    enable toggle locate the exact handler inside the config object without guessing.
 *
 * The raw JSON editor exists because adding a hook has no form — the config is a nested
 * event → matcher group → command handler tree and the backend's schema is the authority.
 * It validates with the **real** schema before the draft accepts the text, so an invalid
 * config is caught here and not only at save time.
 */

/**
 * Locates the handler a snapshot row refers to inside the **draft**.
 *
 * The snapshot is read-only: `store.update` never refreshes it, so a control bound to
 * `snapshot.handlers[i].enabled` would not move when clicked (the P8 review's P1-1). The id is
 * structured (`event:groupIndex:hookIndex`, `createHookHandlerId` in the main process), which is
 * what makes this lookup exact rather than a guess.
 */
function draftHandlerFor(draft: SettingsDraft, handlerId: string): RocHookCommandHandler | null {
  const parsed = parseHandlerId(handlerId);
  if (parsed === null) {
    return null;
  }
  const groups = draft.hooks.hooks[parsed.event as keyof SettingsDraft['hooks']['hooks']];
  return groups?.[parsed.groupIndex]?.hooks[parsed.hookIndex] ?? null;
}

/** The enabled state to render: the draft's value when it knows this handler, else the snapshot's. */
function handlerEnabled(draft: SettingsDraft, handler: RocHookConfigSnapshot['handlers'][number]): boolean {
  return draftHandlerFor(draft, handler.id)?.enabled ?? handler.enabled;
}

function parseHandlerId(handlerId: string): { event: string; groupIndex: number; hookIndex: number } | null {
  const parts = handlerId.split(':');
  if (parts.length !== 3) {
    return null;
  }
  const [event, groupIndexText, hookIndexText] = parts as [string, string, string];
  const groupIndex = Number.parseInt(groupIndexText, 10);
  const hookIndex = Number.parseInt(hookIndexText, 10);
  if (!Number.isInteger(groupIndex) || !Number.isInteger(hookIndex)) {
    return null;
  }
  return { event, groupIndex, hookIndex };
}

export function HooksSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const draft = store.draft;
  const snapshot: RocHookConfigSnapshot | null = store.snapshot?.hooks ?? null;
  const [jsonText, setJsonText] = useState('');
  const [jsonError, setJsonError] = useState<string | null>(null);

  const trust = useAsyncAction(
    (input: { handlerId: string; hash: string }) => trustHook(store.client, input),
    { label: '信任 Hook' }
  );

  const draftJson = useMemo(() => JSON.stringify(draft?.hooks ?? null, null, 2), [draft?.hooks]);
  useEffect(() => {
    setJsonText(draftJson);
    setJsonError(null);
  }, [draftJson]);

  if (draft === null || snapshot === null) {
    return <FormNote testId="settings-hooks-unavailable">Hooks 配置尚未读取完成。</FormNote>;
  }

  const handlers = snapshot.handlers;

  const toggleHandler = (handlerId: string, enabled: boolean): void => {
    const parsed = parseHandlerId(handlerId);
    if (parsed === null) {
      return;
    }
    store.update((next) => {
      const groups = next.hooks.hooks[parsed.event as keyof typeof next.hooks.hooks];
      const group = groups?.[parsed.groupIndex];
      const handler = group?.hooks[parsed.hookIndex];
      if (handler !== undefined) {
        handler.enabled = enabled;
      }
    });
  };

  return (
    <FormSection
      title="Hooks"
      testId="settings-section-hooks-body"
    >
      <dl className="flex flex-col gap-0.5">
        <KeyValueRow label="配置文件" value={snapshot.configPath} testId="settings-hooks-path" />
        <KeyValueRow label="存在" value={snapshot.exists ? '是' : '否'} testId="settings-hooks-exists" />
      </dl>

      {snapshot.validationErrors.length === 0 ? null : (
        <FormNote tone="warn" testId="settings-hooks-validation-errors">
          配置校验错误：{snapshot.validationErrors.join('；')}
        </FormNote>
      )}

      <ul className="flex flex-col gap-2" data-testid="settings-hooks-list">
        {handlers.map((handler) => (
          <li
            key={handler.id}
            className="flex flex-col gap-1 rounded-card border border-line bg-surface px-3 py-2"
            data-testid={`settings-hook-${handler.id}`}
            data-trust={handler.trustState}
          >
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono text-ink text-[var(--font-meta-size)]">{handler.event}</span>
              <span className="text-subtle text-[var(--font-micro-size)]">
                matcher: {handler.matcher ?? '（无）'}
              </span>
              <span className="text-subtle text-[var(--font-micro-size)]" data-testid={`settings-hook-state-${handler.id}`}>
                {handlerEnabled(draft, handler) ? '启用' : '停用'} ·{' '}
                {handler.failureMode === 'block' ? '阻塞失败' : '继续失败'}
              </span>
              <span
                className="ml-auto flex items-center gap-1 rounded-control border border-line px-1.5 text-[var(--font-micro-size)]"
                data-testid={`settings-hook-trust-${handler.id}`}
              >
                {handler.trustState === 'trusted' ? (
                  <ShieldCheck size={11} aria-hidden="true" className="text-[var(--st-ok)]" />
                ) : (
                  <ShieldQuestion size={11} aria-hidden="true" className="text-[var(--st-warn)]" />
                )}
                {handler.trustState === 'trusted'
                  ? '已信任'
                  : handler.trustState === 'review_required'
                    ? '需要复核'
                    : handler.trustState === 'disabled'
                      ? '已停用'
                      : '配置无效'}
              </span>
            </div>
            <p className="break-all font-mono text-muted text-[var(--font-micro-size)]">{handler.command}</p>
            {handler.validationError === null ? null : (
              <FormNote tone="warn" testId={`settings-hook-error-${handler.id}`}>
                {handler.validationError}
              </FormNote>
            )}
            <div className="flex flex-wrap items-center gap-3">
              <CheckboxField
                label="启用"
                // Checked state comes from the draft, not from the read-only snapshot: the two
                // would otherwise disagree the moment the box is clicked (P8 review P1-1).
                checked={handlerEnabled(draft, handler)}
                onChange={(enabled) => toggleHandler(handler.id, enabled)}
                testId={`settings-hook-enabled-${handler.id}`}
              />
              {handler.trustState === 'review_required' ? (
                <button
                  type="button"
                  data-testid={`settings-hook-trust-button-${handler.id}`}
                  disabled={trust.pending}
                  onClick={() => {
                    void trust.run({ handlerId: handler.id, hash: handler.hash }).then((result) => {
                      if (result.ok) {
                        store.reload();
                      }
                    });
                  }}
                  className={formSecondaryButtonClass}
                >
                  信任这条 hook
                </button>
              ) : null}
              {handler.lastRun === null ? (
                <span className="text-subtle text-[var(--font-micro-size)]">还没有运行记录</span>
              ) : (
                <span className="text-subtle text-[var(--font-micro-size)]">
                  最近运行：{handler.lastRun.status}
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    

      {trust.error === null ? null : (
        <FormNote tone="warn" testId="settings-hooks-trust-error">
          {trust.error}
        </FormNote>
      )}

      <div className="flex flex-col gap-1 border-t border-line pt-2">
        <span className="text-subtle text-[var(--font-micro-size)]">配置 JSON</span>
        <textarea
          value={jsonText}
          rows={8}
          spellCheck={false}
          onChange={(event) => {
            setJsonText(event.target.value);
            setJsonError(null);
          }}
          data-testid="settings-hooks-json"
          className={formTextAreaClass}
        />
        <div className="flex items-center gap-2">
          <button
            type="button"
            data-testid="settings-hooks-apply"
            onClick={() => {
              let parsed: unknown;
              try {
                parsed = JSON.parse(jsonText) as unknown;
              } catch {
                setJsonError('不是合法的 JSON。');
                return;
              }
              const result = rocHookConfigSchema.safeParse(parsed);
              if (!result.success) {
                setJsonError(result.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('；'));
                return;
              }
              store.update((next) => void (next.hooks = result.data));
              setJsonError(null);
            }}
            className={formSecondaryButtonClass}
          >
            应用到草稿
          </button>
          <button
            type="button"
            data-testid="settings-hooks-reset"
            onClick={() => {
              setJsonText(draftJson);
              setJsonError(null);
            }}
            className={formSecondaryButtonClass}
          >
            还原为草稿值
          </button>
          <span className="text-subtle text-[var(--font-micro-size)]">改动由顶部「保存设置」写入。</span>
        </div>
        {jsonError === null ? null : (
          <FormNote tone="warn" testId="settings-hooks-json-error">
            {jsonError}
          </FormNote>
        )}
      </div>
    </FormSection>
  );
}
