import { createHash, randomUUID } from 'node:crypto';

import type { Database as DatabaseConnection } from 'better-sqlite3';

export type ContextArtifactKind = 'tool_result' | 'transcript' | 'summary_index';

export type PersistContextArtifactInput = {
  content: string;
  kind: ContextArtifactKind;
  runId: string;
  threadId: string;
  toolCallId?: string | null;
  toolName?: string | null;
  workspaceHash: string | null;
};

export type PersistedContextArtifact = {
  artifactId: string;
  content: string;
  kind: ContextArtifactKind;
  originalChars: number;
  preview: string;
  runId: string;
  sha256: string;
  threadId: string;
  toolCallId: string | null;
  toolName: string | null;
  workspaceHash: string | null;
};

type ContextArtifactRow = {
  id: string;
  run_id: string;
  thread_id: string;
  kind: ContextArtifactKind;
  tool_call_id: string | null;
  tool_name: string | null;
  sha256: string;
  original_chars: number;
  preview: string;
  content: string;
  workspace_hash: string | null;
};

export class ContextArtifactStore {
  constructor(private readonly db: DatabaseConnection) {}

  persistArtifact(input: PersistContextArtifactInput): PersistedContextArtifact {
    const content = requireNonEmpty(input.content, 'context_artifact_content_empty');
    const artifactId = `ctx_artifact_${randomUUID()}`;
    const sha256 = hashContent(content);
    const preview = content.slice(0, 2000);
    const toolCallId = normalizeOptional(input.toolCallId);
    const toolName = normalizeOptional(input.toolName);
    this.db
      .prepare(
        `INSERT INTO context_artifacts
         (id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars, preview, content, workspace_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        artifactId,
        requireNonEmpty(input.runId, 'context_artifact_run_id_empty'),
        requireNonEmpty(input.threadId, 'context_artifact_thread_id_empty'),
        input.kind,
        toolCallId,
        toolName,
        sha256,
        content.length,
        preview,
        content,
        input.workspaceHash,
        new Date().toISOString()
      );
    return {
      artifactId,
      content,
      kind: input.kind,
      originalChars: content.length,
      preview,
      runId: input.runId,
      sha256,
      threadId: input.threadId,
      toolCallId,
      toolName,
      workspaceHash: input.workspaceHash
    };
  }

  readArtifact(input: { artifactId: string; expectedSha256?: string }): PersistedContextArtifact | null {
    const artifactId = requireNonEmpty(input.artifactId, 'context_artifact_id_empty');
    const row = this.db
      .prepare(
        `SELECT id, run_id, thread_id, kind, tool_call_id, tool_name, sha256, original_chars, preview, content, workspace_hash
         FROM context_artifacts
         WHERE id = ?`
      )
      .get(artifactId) as ContextArtifactRow | undefined;
    if (row === undefined) {
      return null;
    }
    if (input.expectedSha256 !== undefined && input.expectedSha256 !== row.sha256) {
      throw new Error('context_artifact_hash_mismatch');
    }
    return {
      artifactId: row.id,
      content: row.content,
      kind: row.kind,
      originalChars: row.original_chars,
      preview: row.preview,
      runId: row.run_id,
      sha256: row.sha256,
      threadId: row.thread_id,
      toolCallId: row.tool_call_id,
      toolName: row.tool_name,
      workspaceHash: row.workspace_hash
    };
  }

  recordPreCompactionFlush(input: {
    content: string;
    runId: string;
    threadId: string;
    tokenCount?: number | null;
    workspaceHash: string | null;
  }): void {
    const content = requireNonEmpty(input.content, 'context_flush_content_empty');
    this.db
      .prepare(
        `INSERT INTO session_messages (id, thread_id, role, content, token_count, phase, workspace_hash, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        `smsg_${randomUUID()}`,
        requireNonEmpty(input.threadId, 'context_flush_thread_id_empty'),
        'system',
        content,
        input.tokenCount === undefined ? null : input.tokenCount,
        'pre_compaction_flush',
        input.workspaceHash,
        new Date().toISOString()
      );
  }
}

export function formatContextArtifactReference(artifact: PersistedContextArtifact): string {
  return [
    '<roc_context_artifact>',
    `artifactId: ${artifact.artifactId}`,
    `sha256: ${artifact.sha256}`,
    `originalChars: ${artifact.originalChars}`,
    'preview:',
    artifact.preview,
    'retrievalHint: use session_search for the summary/index and artifactId for exact old output',
    '</roc_context_artifact>'
  ].join('\n');
}

function hashContent(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function normalizeOptional(value: string | null | undefined): string | null {
  if (value === undefined || value === null) {
    return null;
  }
  const normalized = value.trim();
  return normalized.length === 0 ? null : normalized;
}

function requireNonEmpty(value: string, code: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) {
    throw new Error(code);
  }
  return value;
}
