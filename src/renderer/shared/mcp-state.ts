import type { AgentCapabilityPreview, McpServerConfig, McpServersConfig, McpServerSnapshot, McpServerTestResult } from '../../shared/types';
import { draftFromServer, manifestToolsForServer, skippedCapabilities, validateMcpDraft } from '../management/mcp-model';

export type McpRow = {
  server: McpServerConfig;
  snapshot: McpServerSnapshot | null;
  enabled: boolean;
  issue: string | null;
  toolSummary: string;
};

/** Authored configuration owns row identity, even when the runtime read fails. */
export function projectMcpRows(input: {
  config: McpServersConfig | null;
  servers: readonly McpServerSnapshot[];
  enabled: (server: McpServerConfig) => boolean;
  tests: Record<string, McpServerTestResult>;
  preview: AgentCapabilityPreview | null;
  previewStatus: 'idle' | 'loading' | 'ready' | 'error';
}): McpRow[] {
  const snapshots = new Map(input.servers.map((entry) => [entry.id, entry]));
  return (input.config?.servers ?? []).map((server) => {
    const snapshot = snapshots.get(server.id) ?? null;
    const enabled = input.enabled(server);
    const test = input.tests[server.id];
    const skipped = enabled && input.previewStatus === 'ready'
      ? skippedCapabilities(input.preview).find((entry) => entry.type === 'MCP 服务' && entry.id === server.id)
      : undefined;
    const issue = validateMcpDraft(draftFromServer(server))[0]?.message
      ?? (test?.status === 'invalid' ? test.error ?? '配置有问题' : null)
      ?? snapshot?.lastError
      ?? (snapshot?.status === 'error' ? '连接错误' : null)
      ?? (skipped ? `工具预览未包含此服务：${skipped.reason}` : null);
    const toolSummary = !enabled ? '已停用'
      : input.previewStatus === 'loading' ? '正在更新工具预览…'
      : input.previewStatus !== 'ready' || input.preview === null ? '工具预览不可用'
      : `下次对话提供 ${manifestToolsForServer(input.preview, server.id).length} 个工具`;
    return { server, snapshot, enabled, issue, toolSummary };
  });
}
