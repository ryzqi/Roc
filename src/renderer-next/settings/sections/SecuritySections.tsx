import { NumberField, CheckboxField, SettingsNote, SettingsSection, settingsInputClass } from '../settings-ui';
import type { SettingsStore } from '../settings-scope';

/**
 * 智能体安全 · 记忆策略 (T8.3).
 *
 * Both sections write into `appSettingsSchema` and therefore ride the same whole-save
 * document; they are split because they answer different questions ("what may the agent
 * do" vs "what should it remember") and because the memory *files* (USER.md / AGENTS.md /
 * MEMORY.md, search) belong to the P9 management panel — this surface owns the policy the
 * backend enforces.
 *
 * The legacy guardrail object had seven fields; only these four have a backend home
 * (F22). Shell security level, overwrite protection, session token budget, MCP timeout and
 * the external-network switch are **removed** — the approval mode plus the tool policies in
 * `permissions.grants` are what the backend actually enforces.
 */

export function GuardrailSection({ store }: { store: SettingsStore }): React.JSX.Element {
  const draft = store.draft;
  if (draft === null) {
    return <SettingsNote testId="settings-guardrail-unavailable">设置尚未读取完成。</SettingsNote>;
  }
  const memory = draft.settings.memory;

  return (
    <SettingsSection
      title="智能体安全"
      hint="settings.save 的 permissions.mode 与 memory.securityScan / charLimits"
      testId="settings-section-guardrail-body"
    >
      <label className="flex max-w-[420px] flex-col gap-0.5">
        <span className="text-subtle text-[var(--font-micro-size)]">工具审批模式（permissions.mode）</span>
        <select
          value={draft.permissions.mode}
          onChange={(event) =>
            store.update((next) => {
              next.permissions.mode = event.target.value === 'fully_automatic' ? 'fully_automatic' : 'default';
            })
          }
          data-testid="settings-approval-mode"
          className={settingsInputClass}
        >
          <option value="default">默认：需要审批的工具会停下来等确认</option>
          <option value="fully_automatic">全自动：不拦截工具调用</option>
        </select>
        <span className="text-subtle text-[var(--font-micro-size)]">
          这一项直接决定 P4/P6 里的审批卡会不会出现（`run-capability-manifest` 读它）。
        </span>
      </label>

      {draft.permissions.mode === 'fully_automatic' ? (
        <SettingsNote tone="warn" testId="settings-approval-mode-warning">
          全自动模式下删除文件、执行命令等工具不会请求确认 —— 仅在明确知道风险时使用。
        </SettingsNote>
      ) : null}

      <h4 className="text-ink text-[var(--font-meta-size)]">记忆安全扫描</h4>
      <div className="flex flex-wrap gap-4">
        <CheckboxField
          label="提示注入"
          checked={memory.securityScan.promptInjection}
          onChange={(checked) =>
            store.update((next) => void (next.settings.memory.securityScan.promptInjection = checked))
          }
          testId="settings-scan-prompt-injection"
        />
        <CheckboxField
          label="凭据泄漏"
          checked={memory.securityScan.credential}
          onChange={(checked) => store.update((next) => void (next.settings.memory.securityScan.credential = checked))}
          testId="settings-scan-credential"
        />
        <CheckboxField
          label="SSH 后门"
          checked={memory.securityScan.sshBackdoor}
          onChange={(checked) => store.update((next) => void (next.settings.memory.securityScan.sshBackdoor = checked))}
          testId="settings-scan-ssh"
        />
        <CheckboxField
          label="不可见 Unicode"
          checked={memory.securityScan.invisibleUnicode}
          onChange={(checked) =>
            store.update((next) => void (next.settings.memory.securityScan.invisibleUnicode = checked))
          }
          testId="settings-scan-invisible-unicode"
        />
      </div>

      <h4 className="text-ink text-[var(--font-meta-size)]">记忆容量与会话保留</h4>
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
        <NumberField
          label="USER.md 字符上限"
          value={memory.charLimits.user}
          min={1}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.memory.charLimits.user = value;
              }
            })
          }
          testId="settings-char-limit-user"
        />
        <NumberField
          label="AGENTS.md 字符上限"
          value={memory.charLimits.agents}
          min={1}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.memory.charLimits.agents = value;
              }
            })
          }
          testId="settings-char-limit-agents"
        />
        <NumberField
          label="MEMORY.md 字符上限"
          value={memory.charLimits.memory}
          min={1}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.memory.charLimits.memory = value;
              }
            })
          }
          testId="settings-char-limit-memory"
        />
        <NumberField
          label="会话保留天数"
          value={memory.sessionRetentionDays}
          min={1}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.memory.sessionRetentionDays = value;
              }
            })
          }
          testId="settings-session-retention"
        />
      </div>

      <SettingsNote testId="settings-guardrail-removed">
        旧前端的 shell 安全等级 / 覆盖保护 / 会话 token 预算 / MCP 超时 / 外网开关在后端契约里没有字段，已移除。
        文件写入与命令执行的边界由工具自己的能力清单与审批模式决定，不是一组可调阈值。
      </SettingsNote>
    </SettingsSection>
  );
}

export function MemorySection({ store }: { store: SettingsStore }): React.JSX.Element {
  const draft = store.draft;
  if (draft === null) {
    return <SettingsNote testId="settings-memory-unavailable">设置尚未读取完成。</SettingsNote>;
  }
  const autoMemory = draft.settings.memory.autoMemory;

  return (
    <SettingsSection
      title="记忆策略"
      hint="settings.save 的 memory.autoMemory（记忆文件本身在管理面板，P9）"
      testId="settings-section-memory-body"
    >
      <CheckboxField
        label="自动沉淀记忆"
        description="运行结束后由后端从会话里提取候选记忆；关闭后不再写入。"
        checked={autoMemory.enabled}
        onChange={(enabled) => store.update((next) => void (next.settings.memory.autoMemory.enabled = enabled))}
        testId="settings-auto-memory-enabled"
      />

      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        <NumberField
          label="低置信度记忆保留天数"
          value={autoMemory.lowConfidenceTtlDays}
          min={1}
          disabled={!autoMemory.enabled}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.memory.autoMemory.lowConfidenceTtlDays = value;
              }
            })
          }
          testId="settings-auto-memory-ttl"
        />
        <NumberField
          label="审计记录保留天数"
          value={autoMemory.auditRetentionDays}
          min={1}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.memory.autoMemory.auditRetentionDays = value;
              }
            })
          }
          testId="settings-auto-memory-audit"
        />
        <NumberField
          label="每轮最多候选数"
          value={autoMemory.maxCandidatesPerRun}
          min={1}
          disabled={!autoMemory.enabled}
          onChange={(value) =>
            store.update((next) => {
              if (typeof value === 'number') {
                next.settings.memory.autoMemory.maxCandidatesPerRun = value;
              }
            })
          }
          testId="settings-auto-memory-max-candidates"
        />
      </div>

      <SettingsNote testId="settings-memory-note">
        记忆文件的读写与检索（USER.md / AGENTS.md / MEMORY.md、安全扫描结果、审计流水）在管理面板的「记忆」分区（P9）；
        这里只设置后端用来决定「要不要沉淀、沉淀多少、留多久」的策略值。
      </SettingsNote>
    </SettingsSection>
  );
}
