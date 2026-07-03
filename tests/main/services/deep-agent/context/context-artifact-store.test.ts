import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentPluginSchema } from '../../../../../src/main/plugins/agent/schema';
import {
  ContextArtifactStore,
  formatContextArtifactReference
} from '../../../../../src/main/services/deep-agent/context/context-artifact-store';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentPluginSchema(db);
});

afterEach(() => {
  db.close();
});

describe('ContextArtifactStore', () => {
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
      expectedSha256: artifact.sha256
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
        expectedSha256: '0'.repeat(64)
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
    expect(reference).toContain('retrievalHint: use session_search for the summary/index and artifactId for exact old output');
  });

  it('records a searchable pre-compaction flush row scoped to the workspace', () => {
    const store = new ContextArtifactStore(db);

    store.recordPreCompactionFlush({
      content: 'Context summary mentions deterministic compaction and payment service evidence.',
      runId: 'run_ctx_4',
      threadId: 'thread_ctx_4',
      tokenCount: 42,
      workspaceHash: 'workspace_hash_c'
    });

    const row = db
      .prepare('SELECT thread_id, role, content, phase, token_count, workspace_hash FROM session_messages WHERE thread_id = ?')
      .get('thread_ctx_4') as Record<string, unknown>;

    expect(row).toEqual({
      thread_id: 'thread_ctx_4',
      role: 'system',
      content: 'Context summary mentions deterministic compaction and payment service evidence.',
      phase: 'pre_compaction_flush',
      token_count: 42,
      workspace_hash: 'workspace_hash_c'
    });

    const found = db
      .prepare(
        `SELECT sm.content
         FROM session_messages_fts
         JOIN session_messages sm ON sm.rowid = session_messages_fts.rowid
         WHERE session_messages_fts MATCH ?`
      )
      .all('payment') as Array<{ content: string }>;

    expect(found.map((item) => item.content)).toEqual([
      'Context summary mentions deterministic compaction and payment service evidence.'
    ]);
  });
});
