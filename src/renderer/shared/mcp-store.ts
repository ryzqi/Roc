import type { McpServerConfig, McpServerSnapshot, McpServersConfig, McpServerTestResult } from '../../shared/types';
import type { IpcLikeResult } from '../app/loaded-state';
import type { RocClient } from './roc-client';

/**
 * MCP data layer (extracted in P9 from P8's `settings/settings-store.ts`).
 *
 * It lives here rather than in either feature because **two** surfaces manage MCP: the
 * settings centre's 授权与安全 section (approval mode + enable/test, the two decisions that
 * belong to settings) and the management drawer's MCP tab (authoring: upsert / delete /
 * preset). A second copy of these eight wrappers would be the drift the legacy renderer
 * accumulated.
 *
 * Three contract facts shape the signatures:
 *
 *  1. **`mcp.setServerEnabled` returns one server**, while `mcp.setApprovalMode` returns the
 *     whole config (F22).
 *  2. **`mcp.deleteServer` and `mcp.testServer` take a bare id string** (`inputTransform:
 *     id('id')`), not an object — the same trap as `settings.clearProviderSecret`.
 *  3. **`mcp.listServers` is a runtime snapshot and `mcp.getConfig` is the authoring view.**
 *     They disagree by design (`status`/`tools`/`lastError` vs `url`/`command`/`allowedTools`),
 *     so a surface that wants the whole truth merges them by id.
 */

export function listMcpServers(client: RocClient): Promise<IpcLikeResult<McpServerSnapshot[]>> {
  return client.api.mcp.listServers();
}

export function getMcpConfig(client: RocClient): Promise<IpcLikeResult<McpServersConfig>> {
  return client.api.mcp.getConfig();
}

/** Upsert by id: the config schema is the whole server, `preset` and `allowedTools` included. */
export function upsertMcpServer(client: RocClient, server: McpServerConfig): Promise<IpcLikeResult<McpServerConfig>> {
  return client.api.mcp.upsertServer(server);
}

export function setMcpServerEnabled(
  client: RocClient,
  input: { id: string; enabled: boolean }
): Promise<IpcLikeResult<McpServerConfig>> {
  return client.api.mcp.setServerEnabled(input);
}

/** Bare id string in, `{deleted:true}` out. */
export function deleteMcpServer(client: RocClient, id: string): Promise<IpcLikeResult<{ deleted: true }>> {
  return client.api.mcp.deleteServer(id);
}

/**
 * Connectivity test. Returns `{serverId, status, checked[], error}` — **there is no latency
 * field**, unlike `settings.testProvider` (F24), so the UI must not claim to show one.
 */
export function testMcpServer(client: RocClient, id: string): Promise<IpcLikeResult<McpServerTestResult>> {
  return client.api.mcp.testServer(id);
}

export function setMcpApprovalMode(
  client: RocClient,
  approvalMode: McpServersConfig['approvalMode']
): Promise<IpcLikeResult<McpServersConfig>> {
  return client.api.mcp.setApprovalMode({ approvalMode });
}

/** Materialises the Exa preset server (safe to call repeatedly: it upserts by id). */
export function ensureExaPreset(client: RocClient): Promise<IpcLikeResult<McpServerConfig>> {
  return client.api.mcp.ensureExaPreset();
}
