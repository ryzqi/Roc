import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { ContextArtifactStore } from '../../../../src/main/services/deep-agent/context/context-artifact-store';
import { createToolOutputProjector } from '../../../../src/main/services/deep-agent/tool-output-projection';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentDatabaseSchema(db);
});

afterEach(() => {
  db.close();
});

describe('createToolOutputProjector', () => {
  it('stores only redacted long output in an artifact and exposes a bounded preview', () => {
    const projectToolOutput = createToolOutputProjector({
      artifactStore: new ContextArtifactStore(db),
      runId: 'run_tool_projection',
      threadId: 'thread_tool_projection',
      workspaceHash: 'workspace_hash_projection'
    });

    const projected = projectToolOutput({
      callId: 'call_tool_projection',
      name: 'web_read',
      output: `Bearer secret-token ${'x'.repeat(8_192)}`
    });

    expect(projected).toMatchObject({
      kind: 'tool_result_artifact',
      originalChars: expect.any(Number),
      preview: expect.stringContaining('[REDACTED]'),
      truncated: true
    });
    expect(JSON.stringify(projected)).not.toContain('secret-token');
    const artifact = db.prepare('SELECT content, preview, workspace_hash FROM context_artifacts').get() as {
      content: string;
      preview: string;
      workspace_hash: string;
    };
    expect(artifact.content).not.toContain('secret-token');
    expect(artifact.preview).toContain('[REDACTED]');
    expect(artifact.workspace_hash).toBe('workspace_hash_projection');
  });
});
