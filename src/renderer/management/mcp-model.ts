import type {
  AgentCapabilityPreview,
  AgentCapabilityCard,
  McpServerConfig,
  McpServersConfig
} from '../../shared/types';
import { mcpServerEditorFieldsSchema } from '../../shared/schemas/ipc-mcp-skills';

/**
 * MCP projections (P9/T9.3).
 *
 * Type-only imports. The phase text for this tab lists four things the contract does not have
 * (F24):
 *
 *  - **No `args` / `env` / `headers`.** `mcpServerConfigSchema` is
 *    `{id, name, enabled, transport, preset, riskLevel, url?, command?, allowedTools[]}` — a
 *    stdio server is a single `command` string and an http/sse server is a single `url`.
 *  - **No per-server approval mode.** `approvalMode` is one value for the whole MCP config
 *    (`mcp.setApprovalMode`), not a per-server field.
 *  - **No latency and no last-connected time.** `mcpServerTestResultSchema` is
 *    `{serverId, status, checked[], error}`; the snapshot's `status` is `not_connected` until a
 *    test runs, and `tools` is `allowedTools.length`, i.e. a *count of allowed names*, not
 *    discovered tools.
 *  - **No `mcp.tools.get` over IPC.** The plugin declares that capability but it is not in
 *    `ipc-registry.ts` (B25). Per-server tool *names* therefore come from
 *    `agent.getCapabilityPreview`'s manifest, whose `provenance` carries
 *    `{kind:'mcp', serverId}` — the same list the next run will actually use.
 */

export const mcpTransportLabels: Readonly<Record<McpServerConfig['transport'], string>> = {
  stdio: 'stdio（本地命令）',
  http: 'http',
  sse: 'sse'
};

export const mcpRiskLabels: Readonly<Record<McpServerConfig['riskLevel'], string>> = {
  low: '低',
  medium: '中',
  high: '高'
};

export const mcpApprovalModeLabels: Readonly<Record<McpServersConfig['approvalMode'], string>> = {
  default: '默认：MCP 工具调用需要审批',
  fully_automatic: '全自动：MCP 工具调用不拦截'
};

/**
 * The id pattern the panel enforces.
 *
 * The backend schema only requires a non-empty string, but a server id becomes part of the
 * model-visible tool name and of `canonicalIdentity` (`mcp:<serverId>:<tool>`), so a space or a
 * slash in it would produce a tool the model cannot name reliably. This is a UI-level rule and
 * is registered as such (F24) — it is stricter than the schema, never looser.
 */
export type McpDraft = {
  id: string;
  name: string;
  enabled: boolean;
  transport: McpServerConfig['transport'];
  riskLevel: McpServerConfig['riskLevel'];
  url: string;
  command: string;
  /** One tool name per line; the backend field is `allowedTools: string[]`. */
  allowedToolsText: string;
};

export function emptyMcpDraft(): McpDraft {
  return {
    id: '',
    name: '',
    enabled: false,
    transport: 'stdio',
    riskLevel: 'medium',
    url: '',
    command: '',
    allowedToolsText: ''
  };
}

export function draftFromServer(server: McpServerConfig): McpDraft {
  return {
    id: server.id,
    name: server.name,
    enabled: server.enabled,
    transport: server.transport,
    riskLevel: server.riskLevel,
    url: server.url ?? '',
    command: server.command ?? '',
    allowedToolsText: server.allowedTools.join('\n')
  };
}

export function linesToList(text: string): string[] {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export type McpDraftIssue = { field: keyof McpDraft | 'allowedToolsText'; message: string };

/**
 * Uses the shared editor schema so field errors and transport constraints stay aligned with Main.
 */
export function validateMcpDraft(draft: McpDraft): McpDraftIssue[] {
  const result = mcpServerEditorFieldsSchema.safeParse({
    id: draft.id,
    name: draft.name,
    enabled: draft.enabled,
    transport: draft.transport,
    riskLevel: draft.riskLevel,
    url: draft.url,
    command: draft.command,
    allowedTools: linesToList(draft.allowedToolsText)
  });
  if (result.success) return [];

  return result.error.issues.flatMap((issue): McpDraftIssue[] => {
    const field = issue.path[0];
    if (field === 'allowedTools') {
      return [{ field: 'allowedToolsText', message: issue.message }];
    }
    if (
      field === 'id' ||
      field === 'name' ||
      field === 'enabled' ||
      field === 'transport' ||
      field === 'riskLevel' ||
      field === 'url' ||
      field === 'command' ||
      field === 'allowedToolsText'
    ) {
      return [{ field, message: issue.message }];
    }
    return [];
  });
}

export function issueFor(issues: readonly McpDraftIssue[], field: McpDraftIssue['field']): string | null {
  return issues.find((issue) => issue.field === field)?.message ?? null;
}

/**
 * Draft → config.
 *
 * `preset` is not in the draft: it is a property of the built-in Exa server and is preserved
 * from the existing record (`upsertServer` replaces the whole server, so dropping it would
 * un-preset a preset). The field for the *other* transport is cleared, because leaving a stale
 * `url` on a stdio server is how a config ends up with two contradictory addresses.
 */
export function toServerConfig(draft: McpDraft, existing: McpServerConfig | null): McpServerConfig {
  const base = {
    id: draft.id.trim(),
    name: draft.name.trim(),
    enabled: draft.enabled,
    transport: draft.transport,
    preset: existing?.preset ?? false,
    riskLevel: draft.riskLevel,
    allowedTools: linesToList(draft.allowedToolsText)
  };
  if (draft.transport === 'stdio') {
    return { ...base, command: draft.command.trim() };
  }
  return { ...base, url: draft.url.trim() };
}

/* ------------------------------------------------------------------ */
/* Capability preview: the only real per-server tool list              */
/* ------------------------------------------------------------------ */

export type ServerToolLine = {
  name: string;
  riskLevel: string;
  approval: 'none' | 'required';
  executionScopes: string[];
  effectClass: string;
};

/** Tools the next run would expose for one MCP server (`manifest.tools[].provenance`). */
export function manifestToolsForServer(preview: AgentCapabilityPreview | null, serverId: string): ServerToolLine[] {
  if (preview === null) {
    return [];
  }
  return preview.manifest.tools
    .filter((tool) => tool.provenance.kind === 'mcp' && tool.provenance.serverId === serverId)
    .map((tool) => ({
      name: tool.modelVisibleName,
      riskLevel: tool.riskLevel,
      approval: tool.approvalPolicy.kind,
      executionScopes: tool.executionScopes,
      effectClass: tool.effectClass
    }));
}

/** Built-in (non-MCP) tool names, from the preview's own list. */
export function builtInTools(preview: AgentCapabilityPreview | null): string[] {
  return preview === null ? [] : [...preview.builtInTools];
}

export function skillCards(preview: AgentCapabilityPreview | null): AgentCapabilityCard[] {
  return preview === null ? [] : preview.skillCards;
}

export type SkippedCapabilityLine = { id: string; type: string; reason: string };

const skippedReasonLabels: Readonly<Record<string, string>> = {
  not_found: '找不到',
  disabled: '未启用',
  invalid: '无效'
};

export function skippedCapabilities(preview: AgentCapabilityPreview | null): SkippedCapabilityLine[] {
  if (preview === null) {
    return [];
  }
  return preview.manifest.skippedCapabilities.map((entry) => ({
    id: entry.id,
    type: entry.type === 'mcp_server' ? 'MCP 服务' : '技能',
    reason: skippedReasonLabels[entry.reason] ?? entry.reason
  }));
}

export function previewSummary(preview: AgentCapabilityPreview | null): string {
  if (preview === null) {
    return '装配预览尚未读取。';
  }
  return `本次装配：内置工具 ${preview.builtInTools.length} 个 · MCP 工具 ${preview.toolCards.length} 个 · 技能 ${preview.skillCards.length} 个 · 子代理 ${preview.subagents.length} 个`;
}
