import { EmptyState } from '../shell/EmptyState';

/**
 * Assistant panel placeholder (P1). P4 replaces the body with the real
 * transcript + composer.
 *
 * The header row is already the final shape from MASTER v2 §6.3 —
 * `当前项目 · 当前阶段 · 模型` then the thinking toggle — because P4 has to fit
 * its model selector and context line into exactly this space. The composer
 * placeholder exists so the panel's vertical rhythm (header / transcript flex /
 * composer) is real rather than approximated.
 *
 * P4 owns: `chat.startRun` + `chat.onRunEvent`, the reused `chat-run-state`
 * reducer, the migrated rich blocks, transcript virtualisation, HITL cards,
 * session list, attachments, and the model list from `settings.get`.
 */

export type AssistantPanelProps = {
  projectName: string | null;
  /** Current workflow stage label, when a project is open (P6 supplies it). */
  stageLabel?: string | null;
  onOpenSettings: () => void;
};

export function AssistantPanel({
  projectName,
  stageLabel = null,
  onOpenSettings
}: AssistantPanelProps): React.JSX.Element {
  return (
    <div className="flex h-full min-h-0 flex-col bg-bg-soft" data-testid="assistant-panel">
      <div className="flex shrink-0 flex-col gap-1 border-b border-line px-3 py-2">
        <div className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-muted text-[var(--font-meta-size)]" data-testid="assistant-context">
            {projectName === null ? '未进入项目' : projectName}
            {stageLabel === null ? '' : ` · ${stageLabel}`}
          </span>
          <button
            type="button"
            onClick={onOpenSettings}
            title="模型与思考开关在设置中心（唯一可写位置）"
            data-testid="assistant-model-settings"
            className="h-[var(--control-height-compact)] shrink-0 rounded-control border border-line px-2 font-mono text-muted text-[var(--font-micro-size)] hover:text-ink"
          >
            模型未配置
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto" data-testid="assistant-transcript">
        <EmptyState
          title="助手尚未接入"
          description="消息流、推理、工具调用、子代理与审批卡片将在这一栏渲染。"
          testId="assistant-placeholder"
        />
        <p className="px-6 text-center text-subtle text-[var(--font-micro-size)]">P4 实现</p>
      </div>

      <div className="shrink-0 border-t border-line p-2.5" data-testid="assistant-composer">
        <div className="flex items-end gap-2 rounded-card border border-line bg-surface px-2.5 py-2">
          <textarea
            rows={3}
            disabled
            aria-label="给助手的指令"
            placeholder="P4 接入 chat.startRun 后可用"
            className="min-h-[3rem] min-w-0 flex-1 resize-none bg-transparent text-ink outline-none placeholder:text-subtle disabled:opacity-60"
          />
          <button
            type="button"
            disabled
            className="h-[var(--control-height)] shrink-0 rounded-control border border-line px-3 text-muted disabled:opacity-50"
          >
            发送
          </button>
        </div>
        <p className="mt-1 text-subtle text-[var(--font-micro-size)]">Enter 发送 · Shift+Enter 换行 · ⌘Enter 也发送</p>
      </div>
    </div>
  );
}
