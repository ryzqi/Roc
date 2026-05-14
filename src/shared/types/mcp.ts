export type McpServerSnapshot = {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse';
  status: 'not_connected' | 'ready' | 'error';
  tools: number;
  preset?: boolean;
  riskLevel?: 'low' | 'medium' | 'high';
  url?: string;
  command?: string;
  allowedTools?: string[];
  lastError?: string | null;
};

export type McpServerConfig = {
  id: string;
  name: string;
  enabled: boolean;
  transport: 'stdio' | 'http' | 'sse';
  preset: boolean;
  riskLevel: 'low' | 'medium' | 'high';
  url?: string;
  command?: string;
  allowedTools: string[];
};

export type McpServerTestResult = {
  serverId: string;
  status: 'ready' | 'invalid';
  checked: string[];
  error: string | null;
};
