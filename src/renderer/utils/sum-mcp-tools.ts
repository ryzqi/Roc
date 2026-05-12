import type { McpServerSnapshot } from '../../shared/types';

export function sumMcpTools(servers: McpServerSnapshot[]): number {
  return servers.reduce((total, server) => total + server.tools, 0);
}
