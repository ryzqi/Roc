import type { z } from 'zod';

import {
  mcpServerConfigSchema,
  mcpServerSnapshotSchema,
  mcpServerTestResultSchema
} from '../schemas/ipc-mcp-skills';

export type McpServerSnapshot = z.infer<typeof mcpServerSnapshotSchema>;
export type McpServerConfig = z.infer<typeof mcpServerConfigSchema>;
export type McpServerTestResult = z.infer<typeof mcpServerTestResultSchema>;
