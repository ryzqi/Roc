import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../../src/main/infrastructure/database-schemas';
import {
  ContextArtifactStore,
  formatContextArtifactReference
} from '../../../../../src/main/services/deep-agent/context/context-artifact-store';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentDatabaseSchema(db);
});

afterEach(() => {
  db.close();
});

describe('ContextArtifactStore', () => {
  it('does not create context artifact tables during construction', () => {
    const isolatedDb = new Database(':memory:');
    try {
      new ContextArtifactStore(isolatedDb);

      expect(tableExists(isolatedDb, 'context_artifacts')).toBe(false);
    } finally {
      isolatedDb.close();
    }
  });

  it('persists a large tool result with hash, preview, and full readback', () => {
    const store = new ContextArtifactStore(db);
    const content = `${'alpha '.repeat(100)}final evidence`;

    const artifact = store.persistArtifact({
      content,
      kind: 'tool_result',
      runId: 'run_ctx_1',
      threadId: 'thread_ctx_1',
      toolCallId: 'call_read_1',
      toolName: 'read_file',
      workspaceHash: 'workspace_hash_a'
    });

    expect(artifact.artifactId).toMatch(/^ctx_artifact_/u);
    expect(artifact.kind).toBe('tool_result');
    expect(artifact.originalChars).toBe(content.length);
    expect(artifact.preview).toBe(content.slice(0, 2000));
    expect(artifact.sha256).toHaveLength(64);

    const loaded = store.readArtifact({
      artifactId: artifact.artifactId,
      expectedSha256: artifact.sha256,
      threadId: 'thread_ctx_1',
      workspaceHash: 'workspace_hash_a'
    });

    expect(loaded?.content).toBe(content);
    expect(loaded?.toolCallId).toBe('call_read_1');
    expect(loaded?.toolName).toBe('read_file');
  });

  it('rejects artifact readback when the expected hash does not match', () => {
    const store = new ContextArtifactStore(db);
    const artifact = store.persistArtifact({
      content: 'stored evidence',
      kind: 'tool_result',
      runId: 'run_ctx_2',
      threadId: 'thread_ctx_2',
      toolCallId: 'call_shell_1',
      toolName: 'run_shell_command',
      workspaceHash: null
    });

    expect(() =>
      store.readArtifact({
        artifactId: artifact.artifactId,
        expectedSha256: '0'.repeat(64),
        threadId: 'thread_ctx_2',
        workspaceHash: null
      })
    ).toThrow('context_artifact_hash_mismatch');
  });

  it('formats a compact artifact reference for runtime ToolMessage content', () => {
    const store = new ContextArtifactStore(db);
    const artifact = store.persistArtifact({
      content: 'large tool output',
      kind: 'tool_result',
      runId: 'run_ctx_3',
      threadId: 'thread_ctx_3',
      toolCallId: 'call_read_2',
      toolName: 'read_file',
      workspaceHash: 'workspace_hash_b'
    });

    const reference = formatContextArtifactReference(artifact);

    expect(reference).toContain('<roc_context_artifact>');
    expect(reference).toContain(`artifactId: ${artifact.artifactId}`);
    expect(reference).toContain(`sha256: ${artifact.sha256}`);
    expect(reference).toContain('retrievalHint: use read_context_artifact with artifactId, sha256, offset, and limit');
  });

  it('does not read an artifact outside the current thread and workspace scope', () => {
    const store = new ContextArtifactStore(db);
    const artifact = store.persistArtifact({
      content: 'scoped evidence',
      kind: 'tool_result',
      runId: 'run_ctx_scope',
      threadId: 'thread_ctx_scope',
      workspaceHash: 'workspace_hash_scope'
    });

    expect(store.readArtifact({
      artifactId: artifact.artifactId,
      expectedSha256: artifact.sha256,
      threadId: 'other_thread',
      workspaceHash: 'workspace_hash_scope'
    })).toBeNull();
    expect(store.readArtifact({
      artifactId: artifact.artifactId,
      expectedSha256: artifact.sha256,
      threadId: 'thread_ctx_scope',
      workspaceHash: 'other_workspace'
    })).toBeNull();
  });

});

function tableExists(connection: Database.Database, tableName: string): boolean {
  const row = connection.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as
    | { name: string }
    | undefined;
  return row !== undefined;
}
