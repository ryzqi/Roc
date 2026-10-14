import { useEffect, useState } from 'react';
import type { RtkBypassReason, RtkStatus } from '../../shared/types';
import type { RocClient } from '../shared/roc-client';

/**
 * `rtk.status` in one line (P3/T3.7).
 *
 * RTK wraps the commands the agent and the terminal run (tee-ing output, adding
 * resource metadata). The UI needs to say whether it is active, because when it
 * is not, command output is plain — that is a behaviour change a user should be
 * able to see without opening settings. The full detail (paths, config) belongs
 * to the settings centre (P8); this is deliberately a summary.
 *
 * Pure text mapping so it can be unit-tested without a DOM.
 */

export type RtkTone = 'ok' | 'warn' | 'muted';

export type RtkSummary = {
  tone: RtkTone;
  label: string;
  /** Paths/config, shown on hover (`title`), never as primary text. */
  detail: string;
};

const BYPASS_LABELS: Record<RtkBypassReason, string> = {
  rtk_binary_missing: '未找到 rtk 可执行文件',
  user_terminal_raw_output: '用户在终端直接输入命令',
  command_not_supported: '该命令不受 rtk 支持',
  virtual_workspace_path: '虚拟工作区路径',
  shell_file_operation_forbidden: '文件操作被拒绝',
  shell_run_not_authorized: 'shell 运行未授权',
  background_shell_command_not_pre_authorized: '后台命令未预授权'
};

export function describeRtkStatus(status: RtkStatus): RtkSummary {
  const detailParts = [`binary: ${status.binaryPath}`, `config: ${status.configPath}`];
  if (status.teeDir.length > 0) {
    detailParts.push(`tee: ${status.teeDir}`);
  }
  const detail = detailParts.join(' · ');

  if (status.resourceState === 'missing') {
    return { tone: 'warn', label: 'RTK 未启用（资源缺失）', detail };
  }
  if (!status.enabledForAgentCommands) {
    const reason = status.bypassReason === undefined ? null : BYPASS_LABELS[status.bypassReason];
    return {
      tone: 'muted',
      label: reason === null ? 'RTK 未对 Agent 命令启用' : `RTK 未启用：${reason}`,
      detail
    };
  }
  return { tone: 'ok', label: 'RTK 已启用', detail };
}

/**
 * `idle` means "not asked" — used when there is no bound workspace, so the caller
 * renders nothing instead of a spinner that can never resolve. An earlier version
 * left the state at `loading` forever in that case, and the Git drawer showed
 * 「RTK 状态读取中…」 in the very state where RTK cannot be queried.
 */
export type RtkStatusState = {
  status: 'idle' | 'loading' | 'ready' | 'error';
  summary: RtkSummary | null;
  error: string | null;
};

export function useRtkStatus(client: RocClient, enabled: boolean): RtkStatusState {
  const [state, setState] = useState<{
    status: 'idle' | 'loading' | 'ready' | 'error';
    summary: RtkSummary | null;
    error: string | null;
  }>({ status: enabled ? 'loading' : 'idle', summary: null, error: null });

  useEffect(() => {
    if (!enabled) {
      setState({ status: 'idle', summary: null, error: null });
      return;
    }
    let cancelled = false;
    setState((current) => ({ ...current, status: 'loading' }));
    void (async () => {
      const result = await client.api.rtk.status();
      if (cancelled) {
        return;
      }
      if (!result.ok) {
        setState({ status: 'error', summary: null, error: result.error.message });
        return;
      }
      setState({ status: 'ready', summary: describeRtkStatus(result.data), error: null });
    })();
    return () => {
      cancelled = true;
    };
  }, [client, enabled]);

  return state;
}
