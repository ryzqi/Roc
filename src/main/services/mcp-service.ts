import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import type { McpServerConfig, McpServerSnapshot, McpServerTestResult } from '../../shared/types';
import { RocDomainError } from './errors';
import type { RocPaths } from './paths';

const McpServerSchema: z.ZodType<McpServerConfig> = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  enabled: z.boolean(),
  transport: z.enum(['stdio', 'http', 'sse']),
  preset: z.boolean(),
  riskLevel: z.enum(['low', 'medium', 'high']),
  url: z.string().min(1).optional(),
  command: z.string().min(1).optional(),
  allowedTools: z.array(z.string().min(1))
});

const McpConfigSchema = z.object({
  schemaVersion: z.literal(1),
  servers: z.array(McpServerSchema)
});

type McpConfig = z.infer<typeof McpConfigSchema>;

export class McpService {
  constructor(private readonly paths: RocPaths) {}

  listServers(): McpServerSnapshot[] {
    const config = this.readConfig();

    return config.servers.map((server) => ({
      id: server.id,
      name: server.name,
      enabled: server.enabled,
      transport: server.transport,
      status: 'not_connected',
      tools: server.allowedTools.length,
      preset: server.preset,
      riskLevel: server.riskLevel,
      url: server.url,
      command: server.command,
      allowedTools: server.allowedTools,
      lastError: null
    }));
  }

  ensureExaPreset(): McpServerConfig {
    const existing = this.readConfig().servers.find((server) => server.id === 'exa-hosted');
    if (existing !== undefined) {
      return existing;
    }

    return this.upsertServer({
      id: 'exa-hosted',
      name: 'Exa Hosted MCP',
      transport: 'http',
      enabled: false,
      url: 'https://mcp.exa.ai/mcp',
      preset: true,
      riskLevel: 'medium',
      allowedTools: ['web_search_exa', 'web_search_advanced_exa']
    });
  }

  upsertServer(server: McpServerConfig): McpServerConfig {
    const parsed = McpServerSchema.parse(server);
    this.validateTransportFields(parsed);
    const config = this.readConfig();
    const existingIndex = config.servers.findIndex((item) => item.id === parsed.id);
    const nextServers =
      existingIndex === -1 ? [...config.servers, parsed] : config.servers.map((item) => (item.id === parsed.id ? parsed : item));
    this.writeConfig({
      schemaVersion: 1,
      servers: nextServers
    });
    return parsed;
  }

  setServerEnabled(id: string, enabled: boolean): McpServerConfig {
    const serverId = this.requireText(id, 'mcp_server_id_empty', 'MCP server ID 不能为空。', '请选择要修改的 MCP server。');
    const config = this.readConfig();
    const found = config.servers.find((server) => server.id === serverId);
    if (found === undefined) {
      throw this.notFound(serverId);
    }
    const nextServer: McpServerConfig = {
      ...found,
      enabled
    };
    this.writeConfig({
      schemaVersion: 1,
      servers: config.servers.map((server) => (server.id === serverId ? nextServer : server))
    });
    return nextServer;
  }

  deleteServer(id: string): void {
    const serverId = this.requireText(id, 'mcp_server_id_empty', 'MCP server ID 不能为空。', '请选择要删除的 MCP server。');
    const config = this.readConfig();
    const found = config.servers.find((server) => server.id === serverId);
    if (found === undefined) {
      throw this.notFound(serverId);
    }
    this.writeConfig({
      schemaVersion: 1,
      servers: config.servers.filter((server) => server.id !== serverId)
    });
  }

  testServer(id: string): McpServerTestResult {
    const serverId = this.requireText(id, 'mcp_server_id_empty', 'MCP server ID 不能为空。', '请选择要测试的 MCP server。');
    const server = this.readConfig().servers.find((item) => item.id === serverId);
    if (server === undefined) {
      throw this.notFound(serverId);
    }

    const checked = server.transport === 'stdio' ? ['id', 'name', 'transport', 'command'] : ['id', 'name', 'transport', 'url'];
    const missingTransportField =
      (server.transport === 'stdio' && server.command === undefined) ||
      ((server.transport === 'http' || server.transport === 'sse') && server.url === undefined);
    if (missingTransportField) {
      return {
        serverId,
        status: 'invalid',
        checked,
        error: server.transport === 'stdio' ? 'stdio MCP server 缺少 command。' : 'HTTP/SSE MCP server 缺少 url。'
      };
    }

    return {
      serverId,
      status: 'ready',
      checked,
      error: null
    };
  }

  private readConfig(): McpConfig {
    const parsed = JSON.parse(readFileSync(this.filePath(), 'utf8')) as unknown;
    return McpConfigSchema.parse(parsed);
  }

  private writeConfig(config: McpConfig): void {
    const parsed = McpConfigSchema.parse(config);
    writeFileSync(this.filePath(), `${JSON.stringify(parsed, null, 2)}\n`, 'utf8');
  }

  private validateTransportFields(server: McpServerConfig): void {
    if (server.transport === 'stdio' && server.command === undefined) {
      throw new RocDomainError({
        code: 'mcp_stdio_command_missing',
        message: 'stdio MCP server 必须配置 command。',
        category: 'validation',
        retryable: false,
        userAction: '请填写本地 MCP server 启动命令。'
      });
    }
    if ((server.transport === 'http' || server.transport === 'sse') && server.url === undefined) {
      throw new RocDomainError({
        code: 'mcp_url_missing',
        message: 'HTTP/SSE MCP server 必须配置 url。',
        category: 'validation',
        retryable: false,
        userAction: '请填写 MCP server URL。'
      });
    }
  }

  private notFound(id: string): RocDomainError {
    return new RocDomainError({
      code: 'mcp_server_not_found',
      message: `找不到 MCP server ${id}。`,
      category: 'not_found',
      retryable: false,
      userAction: '请刷新能力管理页后重试。'
    });
  }

  private requireText(value: string, code: string, message: string, userAction: string): string {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      throw new RocDomainError({
        code,
        message,
        category: 'validation',
        retryable: false,
        userAction
      });
    }
    return trimmed;
  }

  private filePath(): string {
    return join(this.paths.configDir, 'mcp.servers.json');
  }
}
