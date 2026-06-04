import { existsSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

describe('mcp feature boundary', () => {
  it('routes MCP IPC through RocClient instead of window.roc', () => {
    expect(existsSync('src/renderer/features/mcp/index.tsx')).toBe(true);
    expect(readFileSync('src/renderer/features/mcp/index.tsx', 'utf8')).toContain('RocClient');
    expect(readFileSync('src/renderer/views/mcp/McpManagementPanel.tsx', 'utf8')).not.toContain('window.roc');
  });
});
