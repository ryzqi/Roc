import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { applyAgentDatabaseSchema } from '../../../../../src/main/infrastructure/database-schemas';
import { ContextArtifactStore } from '../../../../../src/main/services/deep-agent/context/context-artifact-store';
import { createContextArtifactReadTool } from '../../../../../src/main/services/deep-agent/context/context-artifact-tool';

let db: Database.Database;

beforeEach(() => {
  db = new Database(':memory:');
  applyAgentDatabaseSchema(db);
});

afterEach(() => {
  db.close();
});

describe('createContextArtifactReadTool', () => {
  it('returns bounded slices with continuation metadata', async () => {
    const store = new ContextArtifactStore(db);
    const artifact = store.persistArtifact({
      content: '0123456789',
      kind: 'tool_result',
      runId: 'run_artifact_tool',
      threadId: 'thread_artifact_tool',
      workspaceHash: 'workspace_artifact_tool'
    });
    const tool = createContextArtifactReadTool({
      artifactStore: store,
      threadId: 'thread_artifact_tool',
      workspaceHash: 'workspace_artifact_tool'
    });

    const first = JSON.parse(await tool.invoke({
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      limit: 4
    }));
    const second = JSON.parse(await tool.invoke({
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      offset: first.nextOffset,
      limit: 20
    }));

    expect(first).toMatchObject({
      artifactId: artifact.artifactId,
      content: '0123',
      offset: 0,
      nextOffset: 4,
      complete: false
    });
    expect(second).toMatchObject({
      content: '456789',
      offset: 4,
      nextOffset: null,
      complete: true
    });
  });

  it('rejects scope mismatch and unbounded offsets', async () => {
    const store = new ContextArtifactStore(db);
    const artifact = store.persistArtifact({
      content: 'scoped',
      kind: 'tool_result',
      runId: 'run_artifact_scope',
      threadId: 'thread_artifact_scope',
      workspaceHash: 'workspace_artifact_scope'
    });
    const tool = createContextArtifactReadTool({
      artifactStore: store,
      threadId: 'other_thread',
      workspaceHash: 'workspace_artifact_scope'
    });

    await expect(tool.invoke({
      artifactId: artifact.artifactId,
      sha256: artifact.sha256
    })).rejects.toThrow('context_artifact_not_found_or_scope_mismatch');
    const scopedTool = createContextArtifactReadTool({
      artifactStore: store,
      threadId: 'thread_artifact_scope',
      workspaceHash: 'workspace_artifact_scope'
    });
    await expect(scopedTool.invoke({
      artifactId: artifact.artifactId,
      sha256: artifact.sha256,
      offset: 99
    })).rejects.toThrow('context_artifact_offset_out_of_range');
  });
});
