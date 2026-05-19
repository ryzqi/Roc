import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEEP_AGENT_MEMORY_NAMESPACE,
  buildDeepAgentMemoryKey,
  buildDeepAgentMemoryNamespace,
  createDeepAgentStoreFileValue
} from '../../src/main/services/deep-agent/sqlite-store';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanupAppServicesTest, initializeAppServicesTest, normalizeLineEndings, startFakeProvider, type AppServicesTestContext } from './app-service-fixtures';


describe('Roc foundation services memory', () => {
  let context: AppServicesTestContext;

  beforeEach(() => {
    context = initializeAppServicesTest();
  });

  afterEach(() => {
    cleanupAppServicesTest(context);
  });

  it('keeps Markdown as memory truth source and records accepted candidate writes', () => {
    const entry = context.services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户偏好把关键配置缺失视为显式错误。',
      confidence: 1,
      priority: 'high',
      source: 'user_explicit',
      sourceRef: 'test'
    });
    const accepted = context.services.memoryService.acceptCandidate(entry.id);

    const status = context.services.memoryService.status();
    const search = context.services.memoryService.search({ query: '关键配置' });
    const content = context.services.memoryService.get(accepted.id);
    const operationLog = readFileSync(join(context.root, 'logs', 'memory_operations.log'), 'utf8');

    expect(status.truthSource).toBe('markdown');
    expect(status.indexSource).toBe('sqlite');
    expect(status.vectorIndex.status).toBe('not_configured');
    expect(status.fullTextIndex.status).toBe('ready');
    expect(search.degraded).toBe(true);
    expect(search.items[0]).toMatchObject({
      id: accepted.id,
      layer: 'hot',
      scope: 'global',
      sourceRef: 'test'
    });
    expect(content).toContain('关键配置缺失');
    expect(operationLog).toContain('candidate_write');
    expect(operationLog).toContain('candidate_accept');
  });

  it('tracks candidate state, detects conflicts, and keeps unresolved candidates out of normal recall', () => {
    const activeCandidate = context.services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户喜欢简短回复。',
      confidence: 1,
      priority: 'high',
      source: 'user_explicit',
      sourceRef: 'test:active'
    });
    const active = context.services.memoryService.acceptCandidate(activeCandidate.id);
    const conflicting = context.services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户不喜欢简短回复。',
      confidence: 0.7,
      priority: 'high',
      source: 'agent_extract:session-1',
      sourceRef: 'session-1'
    });

    const candidates = context.services.memoryService.listCandidates();
    const conflicts = context.services.memoryService.listConflicts();
    const search = context.services.memoryService.search({ query: '不喜欢简短' });

    expect(candidates).toContainEqual(
      expect.objectContaining({
        id: conflicting.id,
        state: 'conflict_detected',
        conflictCount: 1,
        suggestedAction: 'review_conflict'
      })
    );
    expect(conflicts).toContainEqual(
      expect.objectContaining({
        candidateId: conflicting.id,
        activeMemoryId: active.id,
        type: 'preference',
        scope: 'global',
        status: 'open'
      })
    );
    expect(search.items.some((item) => item.id === conflicting.id)).toBe(false);
  });

  it('writes and searches session recall without promoting it to curated memory', () => {
    const recall = context.services.memoryService.writeSessionRecall({
      sessionId: 'session-phase4',
      title: 'Phase 4 记忆设计讨论',
      summary: '讨论候选记忆中心、会话回忆和恢复链。',
      scope: 'project:roc',
      content: '本次会话明确删除单条记忆要走可恢复链，并且会话回忆不能自动晋升为策展记忆。',
      sourceRef: 'test-session'
    });

    const sessionSearch = context.services.memoryService.sessionSearch({ query: '恢复链', scope: 'project:roc' });
    const memorySearch = context.services.memoryService.search({ query: '恢复链', source: 'session', scope: 'project:roc' });
    const candidates = context.services.memoryService.listCandidates();
    const operationLog = readFileSync(join(context.root, 'logs', 'memory_operations.log'), 'utf8');

    expect(recall).toMatchObject({
      id: 'session-phase4',
      scope: 'project:roc',
      sourceRef: 'test-session'
    });
    expect(sessionSearch.items).toEqual([
      expect.objectContaining({
        id: 'session-phase4',
        title: 'Phase 4 记忆设计讨论',
        scope: 'project:roc',
        sourceRef: 'test-session'
      })
    ]);
    expect(memorySearch.items).toEqual([
      expect.objectContaining({
        id: 'session-phase4',
        layer: 'session',
        scope: 'project:roc',
        sourceRef: 'test-session'
      })
    ]);
    expect(candidates.some((candidate) => candidate.sourceRef === 'test-session')).toBe(false);
    expect(operationLog).toContain('session_recall_write');
  });

  it('deletes and restores active memory with audit records', () => {
    const candidate = context.services.memoryService.writeCandidate({
      type: 'project_context',
      scope: 'project:roc',
      content: 'Roc Phase 4 正在实现记忆系统核心闭环。',
      confidence: 0.9,
      priority: 'medium',
      source: 'user_explicit',
      sourceRef: 'test-delete-restore'
    });
    const active = context.services.memoryService.acceptCandidate(candidate.id);

    const deleted = context.services.memoryService.deleteMemory(active.id);
    const afterDelete = context.services.memoryService.search({ query: '核心闭环', scope: 'project:roc' });
    const restored = context.services.memoryService.restoreMemory(active.id);
    const afterRestore = context.services.memoryService.search({ query: '核心闭环', scope: 'project:roc' });
    const operationLog = readFileSync(join(context.root, 'logs', 'memory_operations.log'), 'utf8');

    expect(deleted).toMatchObject({
      id: active.id,
      status: 'archived',
      recoverable: true
    });
    expect(afterDelete.items.some((item) => item.id === active.id)).toBe(false);
    expect(restored).toMatchObject({
      id: active.id,
      status: 'active',
      recoverable: false
    });
    expect(afterRestore.items).toContainEqual(
      expect.objectContaining({
        id: active.id,
        layer: 'warm',
        scope: 'project:roc'
      })
    );
    expect(operationLog).toContain('memory_delete');
    expect(operationLog).toContain('memory_restore');
  });

  it('removes archived memories from the Deep Agents store projection on initialize', async () => {
    const candidate = context.services.memoryService.writeCandidate({
      type: 'project_context',
      scope: 'project:roc',
      content: '初始化时不应保留已归档记忆投影。',
      confidence: 0.9,
      priority: 'medium',
      source: 'test',
      sourceRef: 'test-store-projection'
    });
    const accepted = context.services.memoryService.acceptCandidate(candidate.id);
    context.services.memoryService.deleteMemory(accepted.id);

    context.services.memoryService.initialize();
    const runtimeStore = Reflect.get(context.services.deepAgentRuntimeService as object, 'store') as {
      get: (namespace: string[], key: string) => Promise<unknown>;
    };
    const projected = await runtimeStore.get([...buildDeepAgentMemoryNamespace(null)], `/${accepted.id}.md`);

    expect(projected).toBeNull();
  });

  it('initializes a default AGENTS.md memory file for deepagents startup memory', () => {
    const agentsPath = join(context.services.paths.memoryDir, 'AGENTS.md');
    const agentsContent = normalizeLineEndings(readFileSync(agentsPath, 'utf8'));

    expect(existsSync(agentsPath)).toBe(true);
    expect(agentsContent).toContain('# Roc Project Rules');
    expect(agentsContent).toContain('`/workspace/` 是当前工作区，`/memory/` 是只读策展记忆视图。');
  });

  it('migrates legacy filesystem namespace entries into the current deep agent memory namespace on initialize', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-memory-namespace-'));
    try {
      const candidate = context.services.memoryService.writeCandidate({
        type: 'project_context',
        scope: 'project:roc',
        content: '旧命名空间投影需要迁移到当前工作区命名空间。',
        confidence: 0.9,
        priority: 'medium',
        source: 'test',
        sourceRef: 'test-legacy-namespace-migration'
      });
      const accepted = context.services.memoryService.acceptCandidate(candidate.id);
      const key = buildDeepAgentMemoryKey(accepted.id);
      const runtimeStore = Reflect.get(context.services.deepAgentRuntimeService as object, 'store') as {
        get: (namespace: string[], key: string) => Promise<{ value?: { content?: string } } | null>;
        put: (namespace: string[], key: string, value: Record<string, unknown>) => Promise<void>;
        delete: (namespace: string[], key: string) => Promise<void>;
      };

      await runtimeStore.put(
        [...DEEP_AGENT_MEMORY_NAMESPACE],
        key,
        createDeepAgentStoreFileValue({
          content: accepted.content,
          createdAt: accepted.createdAt,
          updatedAt: accepted.updatedAt
        })
      );
      await runtimeStore.delete([...buildDeepAgentMemoryNamespace(null)], key);

      context.services.workspaceService.selectWorkspace(workspaceRoot);
      context.services.memoryService.initialize();

      const legacyProjection = await runtimeStore.get([...DEEP_AGENT_MEMORY_NAMESPACE], key);
      const currentProjection = await runtimeStore.get([...buildDeepAgentMemoryNamespace(workspaceRoot)], key);

      expect(legacyProjection).toBeNull();
      expect(currentProjection?.value).toMatchObject({
        content: accepted.content,
        mimeType: 'text/markdown'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });
});
