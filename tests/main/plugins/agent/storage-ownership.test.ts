import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';

import { describe, expect, it } from 'vitest';

const sourceRoot = join(process.cwd(), 'src', 'main');
const ownerFiles = new Set([
  'infrastructure/database-schemas.ts',
  'plugins/agent/run-event-log.ts',
  'services/deep-agent/sqlite-checkpointer.ts',
  'services/deep-agent/tool-effect-store.ts'
]);

const tablePatterns = [
  /\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+agent_run_events\b/iu,
  /\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+agent_run_event_cursors\b/iu,
  /\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+agent_tool_effects\b/iu,
  /\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+langgraph_checkpoints\b/iu,
  /\b(?:FROM|INTO|UPDATE|DELETE\s+FROM)\s+langgraph_checkpoint_writes\b/iu
];

describe('agent storage ownership', () => {
  it('keeps operational SQL inside the storage owners', () => {
    const violations: string[] = [];
    for (const filePath of listTypeScriptFiles(sourceRoot)) {
      const relativePath = relative(sourceRoot, filePath).replaceAll('\\', '/');
      if (ownerFiles.has(relativePath)) {
        continue;
      }
      const source = readFileSync(filePath, 'utf8');
      for (const pattern of tablePatterns) {
        if (pattern.test(source)) {
          violations.push(relativePath);
          break;
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

function listTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const filePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...listTypeScriptFiles(filePath));
    } else if (entry.isFile() && filePath.endsWith('.ts')) {
      files.push(filePath);
    }
  }
  return files;
}
