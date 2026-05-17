import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAppServices, type AppServices } from '../../src/main/services/app-service';
import { RocDomainError, wrapIpc } from '../../src/main/services/errors';

let root: string;
let services: AppServices;

function normalizeLineEndings(value: string): string {
  return value.replaceAll('\r\n', '\n');
}

function readHeader(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) {
    return value.join(', ');
  }
  return value;
}

type CapturedProviderRequest = {
  method: string | undefined;
  url: string | undefined;
  authorization: string | undefined;
  xApiKey: string | undefined;
  anthropicVersion: string | undefined;
  contentType: string | undefined;
  rawBody: string;
  body: unknown;
};

type FakeProvider = {
  endpoint: string;
  requests: CapturedProviderRequest[];
  close: () => Promise<void>;
};

function readBody(request: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer | string) => {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    });
    request.on('error', rejectBody);
    request.on('end', () => {
      resolveBody(Buffer.concat(chunks).toString('utf8'));
    });
  });
}

async function startFakeProvider(responseBody: unknown, statusCode: number): Promise<FakeProvider> {
  const requests: CapturedProviderRequest[] = [];
  const server = createServer((request: IncomingMessage, response: ServerResponse) => {
    void (async () => {
      const rawBody = await readBody(request);
      const parsedBody = rawBody.length === 0 ? null : (JSON.parse(rawBody) as unknown);
      requests.push({
        method: request.method,
        url: request.url,
        authorization: readHeader(request.headers.authorization),
        xApiKey: readHeader(request.headers['x-api-key']),
        anthropicVersion: readHeader(request.headers['anthropic-version']),
        contentType: readHeader(request.headers['content-type']),
        rawBody,
        body: parsedBody
      });
      response.statusCode = statusCode;
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify(responseBody));
    })().catch((error: unknown) => {
      response.statusCode = 500;
      response.setHeader('content-type', 'application/json');
      response.end(
        JSON.stringify({
          error: error instanceof Error ? error.message : 'fake provider request failed'
        })
      );
    });
  });

  await new Promise<void>((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') {
    throw new Error('Fake provider did not expose a TCP address.');
  }
  const tcpAddress = address as AddressInfo;

  return {
    endpoint: `http://127.0.0.1:${tcpAddress.port}/v1`,
    requests,
    close: () =>
      new Promise<void>((resolveClose, rejectClose) => {
        server.close((error) => {
          if (error !== undefined) {
            rejectClose(error);
            return;
          }
          resolveClose();
        });
      })
  };
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'roc-test-'));
  services = createAppServices(root);
  services.appService.initialize();
  services.providerRuntimeService.setDeterministicResponse({
    content: 'Provider runtime 测试回复。',
    finishReason: 'stop',
    promptTokens: 8,
    completionTokens: 6
  });
});

afterEach(() => {
  services.databaseService.close();
  rmSync(root, { recursive: true, force: true });
});

describe('Roc foundation services', () => {
  it('creates the .roc directory tree and config files', () => {
    expect(existsSync(join(root, 'config', 'settings.json'))).toBe(true);
    expect(existsSync(join(root, 'config', 'providers.json'))).toBe(false);
    expect(existsSync(join(root, 'config', 'mcp.servers.json'))).toBe(false);
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"schemaVersion": 3');
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"providers"');
    expect(normalizeLineEndings(readFileSync(join(root, 'config', 'settings.json'), 'utf8'))).toContain('"mcp"');
    expect(existsSync(join(root, 'memory', 'hot', 'hot_memory.md'))).toBe(true);
    expect(existsSync(join(root, 'skills'))).toBe(true);
    expect(existsSync(join(root, 'tasks', 'recovery'))).toBe(true);
    expect(existsSync(join(root, 'rtk', 'tee'))).toBe(true);
  });

  it('initializes SQLite with WAL and required first-wave tables', () => {
    const journalMode = services.databaseService.db.pragma('journal_mode', { simple: true });
    expect(String(journalMode).toLocaleLowerCase()).toBe('wal');

    const rows = services.databaseService.db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>;
    const tableNames = rows.map((row) => row.name);

    expect(tableNames).toContain('task_threads');
    expect(tableNames).toContain('task_events');
    expect(tableNames).toContain('memory_entries_index');
    expect(tableNames).toContain('memory_candidates');
    expect(tableNames).toContain('memory_conflicts');
    expect(tableNames).toContain('memory_operations');
    expect(tableNames).toContain('mcp_servers');
    expect(tableNames).toContain('skills');
  });

  it('returns a real empty task snapshot from SQLite', () => {
    const snapshot = services.taskService.getSnapshot();

    expect(snapshot.counts.total).toBe(0);
    expect(snapshot.counts.running).toBe(0);
    expect(snapshot.counts.failed).toBe(0);
    expect(snapshot.counts.pendingConfirmation).toBe(0);
    expect(snapshot.threads).toEqual([]);
    expect(snapshot.recentEvents).toEqual([]);
  });

  it('reports workspace state separately from the Roc data root', () => {
    const status = services.appService.getStatus();

    expect(status.workspace).toEqual({
      selectedPath: null,
      label: '未选择工作区'
    });
    expect(status.paths.root).toBe(root);
  });

  it('keeps Markdown as memory truth source and records accepted candidate writes', () => {
    const entry = services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户偏好把关键配置缺失视为显式错误。',
      confidence: 1,
      priority: 'high',
      source: 'user_explicit',
      sourceRef: 'test'
    });
    const accepted = services.memoryService.acceptCandidate(entry.id);

    const status = services.memoryService.status();
    const search = services.memoryService.search({ query: '关键配置' });
    const content = services.memoryService.get(accepted.id);
    const operationLog = readFileSync(join(root, 'logs', 'memory_operations.log'), 'utf8');

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
    const activeCandidate = services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户喜欢简短回复。',
      confidence: 1,
      priority: 'high',
      source: 'user_explicit',
      sourceRef: 'test:active'
    });
    const active = services.memoryService.acceptCandidate(activeCandidate.id);
    const conflicting = services.memoryService.writeCandidate({
      type: 'preference',
      scope: 'global',
      content: '用户不喜欢简短回复。',
      confidence: 0.7,
      priority: 'high',
      source: 'agent_extract:session-1',
      sourceRef: 'session-1'
    });

    const candidates = services.memoryService.listCandidates();
    const conflicts = services.memoryService.listConflicts();
    const search = services.memoryService.search({ query: '不喜欢简短' });

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
    const recall = services.memoryService.writeSessionRecall({
      sessionId: 'session-phase4',
      title: 'Phase 4 记忆设计讨论',
      summary: '讨论候选记忆中心、会话回忆和恢复链。',
      scope: 'project:roc',
      content: '本次会话明确删除单条记忆要走可恢复链，并且会话回忆不能自动晋升为策展记忆。',
      sourceRef: 'test-session'
    });

    const sessionSearch = services.memoryService.sessionSearch({ query: '恢复链', scope: 'project:roc' });
    const memorySearch = services.memoryService.search({ query: '恢复链', source: 'session', scope: 'project:roc' });
    const candidates = services.memoryService.listCandidates();
    const operationLog = readFileSync(join(root, 'logs', 'memory_operations.log'), 'utf8');

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
    const candidate = services.memoryService.writeCandidate({
      type: 'project_context',
      scope: 'project:roc',
      content: 'Roc Phase 4 正在实现记忆系统核心闭环。',
      confidence: 0.9,
      priority: 'medium',
      source: 'user_explicit',
      sourceRef: 'test-delete-restore'
    });
    const active = services.memoryService.acceptCandidate(candidate.id);

    const deleted = services.memoryService.deleteMemory(active.id);
    const afterDelete = services.memoryService.search({ query: '核心闭环', scope: 'project:roc' });
    const restored = services.memoryService.restoreMemory(active.id);
    const afterRestore = services.memoryService.search({ query: '核心闭环', scope: 'project:roc' });
    const operationLog = readFileSync(join(root, 'logs', 'memory_operations.log'), 'utf8');

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

  it('reports blocked agent state until default model is configured', () => {
    const status = services.agentService.getStatus();

    expect(status.deepAgentsPackage).toBe('available');
    expect(status.defaultModelConfigured).toBe(false);
    expect(status.memoryAccess).toBe('store_backend');
    expect(status.execution).toBe('blocked_until_provider_configured');
  });

  it('validates explicit default model selection from enabled provider models', () => {
    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: '未配置默认模型。'
    });

    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-disabled',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'secret:provider-openai',
          enabled: true,
          models: [
            {
              id: 'model-disabled',
              displayName: 'Disabled model',
              enabled: false,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'invalid',
      modelId: 'model-disabled',
      providerId: 'provider-openai',
      reason: '默认模型未启用。'
    });

    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-ready',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'secret:provider-openai',
          enabled: true,
          models: [
            {
              id: 'model-ready',
              displayName: 'Ready model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'ready',
      modelId: 'model-ready',
      providerId: 'provider-openai',
      reason: '默认模型可用。'
    });
  });

  it('exposes Deep Agents config preview without running a model', () => {
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: 'model-ready',
      providers: [
        {
          id: 'provider-openai',
          name: 'OpenAI compatible',
          type: 'openai_compatible',
          endpoint: 'https://api.example.test/v1',
          credentialRef: 'secret:provider-openai',
          enabled: true,
          models: [
            {
              id: 'model-ready',
              displayName: 'Ready model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });

    const status = services.agentService.getStatus();
    const preview = services.agentService.getDeepAgentConfigPreview();

    expect(status.execution).toBe('ready');
    expect(status.deepAgentsApi.createDeepAgent).toBe(true);
    expect(preview).toEqual({
      runnable: false,
      model: 'model-ready',
      memoryAccess: 'store_backend',
      builtInTools: ['write_todos', 'task', 'ls', 'read_file', 'write_file', 'edit_file', 'glob', 'grep', 'execute'],
      rocTools: [],
      todoMapping: {
        sourceTool: 'write_todos',
        target: 'task_steps'
      },
      interruptOn: {},
      reason: 'W2 只装配配置预览，不执行 Deep Agents run。'
    });
  });

  it('removes archived memories from the Deep Agents store projection on initialize', async () => {
    const candidate = services.memoryService.writeCandidate({
      type: 'project_context',
      scope: 'project:roc',
      content: '初始化时不应保留已归档记忆投影。',
      confidence: 0.9,
      priority: 'medium',
      source: 'test',
      sourceRef: 'test-store-projection'
    });
    const accepted = services.memoryService.acceptCandidate(candidate.id);
    services.memoryService.deleteMemory(accepted.id);

    services.memoryService.initialize();
    const runtimeStore = Reflect.get(services.deepAgentRuntimeService as object, 'store') as {
      get: (namespace: string[], key: string) => Promise<unknown>;
    };
    const projected = await runtimeStore.get(['roc', 'memory', 'filesystem'], `/${accepted.id}.md`);

    expect(projected).toBeNull();
  });

  it('rejects providers saved with non-secret credential refs at the schema boundary', () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-'));
    const liveServices = createAppServices(liveRoot);

    try {
      liveServices.appService.initialize();
      expect(() =>
        liveServices.configService.saveProviders({
          schemaVersion: 1,
          defaultModelId: 'live-model',
          providers: [
            {
              id: 'provider-live-openai',
              name: 'Live OpenAI compatible',
              type: 'openai_compatible',
              endpoint: 'https://example.test/v1',
              credentialRef: 'env:LEGACY_KEY',
              enabled: true,
              models: [
                {
                  id: 'live-model',
                  displayName: 'Live model',
                  enabled: true,
                  supportsStreaming: true,
                  supportsToolCalls: true
                }
              ]
            }
          ]
        })
      ).toThrow();
    } finally {
      liveServices.databaseService.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('selects a real workspace and keeps the app status bound to the same path', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      const workspace = services.workspaceService.selectWorkspace(workspaceRoot);
      const current = services.workspaceService.getCurrentWorkspace();
      const status = services.appService.getStatus();

      expect(workspace.path).toBe(workspaceRoot);
      expect(workspace.displayName).toBe(workspaceRoot.split(/[\\/]/).pop());
      expect(workspace.trustState).toBe('trusted');
      expect(current?.path).toBe(workspaceRoot);
      expect(status.workspace).toEqual({
        selectedPath: workspaceRoot,
        label: workspaceRoot
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('lists, searches, previews, and writes workspace files with recovery points', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      mkdirSync(join(workspaceRoot, 'src'));
      mkdirSync(join(workspaceRoot, 'assets'));
      writeFileSync(join(workspaceRoot, 'src', 'notes.md'), 'alpha\nphase three boundary\n', 'utf8');
      writeFileSync(
        join(workspaceRoot, 'assets', 'pixel.png'),
        Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jG3sAAAAASUVORK5CYII=',
          'base64'
        )
      );
      services.workspaceService.selectWorkspace(workspaceRoot);

      const tree = services.fileService.listTree({ relativePath: '' });
      const search = services.fileService.search({ query: 'phase three' });
      const preview = services.fileService.readPreview({ relativePath: 'src/notes.md' });
      const imagePreview = services.fileService.readPreview({ relativePath: 'assets/pixel.png' });
      const writeResult = services.fileService.writeTextFile({
        relativePath: 'src/notes.md',
        content: 'updated phase three boundary\n',
        source: 'test'
      });
      const recoverySnapshot = readFileSync(writeResult.recoveryPoint.snapshotPath, 'utf8');
      const updatedContent = readFileSync(join(workspaceRoot, 'src', 'notes.md'), 'utf8');

      expect(tree.entries).toContainEqual(
        expect.objectContaining({
          name: 'src',
          relativePath: 'src',
          type: 'directory'
        })
      );
      expect(search.matches).toEqual([
        expect.objectContaining({
          relativePath: 'src/notes.md',
          line: 2,
          preview: 'phase three boundary'
        })
      ]);
      expect(preview).toMatchObject({
        relativePath: 'src/notes.md',
        kind: 'text',
        truncated: false,
        content: 'alpha\nphase three boundary\n'
      });
      expect(imagePreview.kind).toBe('image');
      expect(imagePreview.mediaType).toBe('image/png');
      expect(imagePreview.content.startsWith('data:image/png;base64,')).toBe(true);
      expect(imagePreview.sizeBytes).toBeGreaterThan(0);
      expect(writeResult.recoveryPoint.relativePath).toBe('src/notes.md');
      expect(recoverySnapshot).toBe('alpha\nphase three boundary\n');
      expect(updatedContent).toBe('updated phase three boundary\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns structured workspace and git errors instead of implicit fallbacks', async () => {
    const missingWorkspace = await wrapIpc(() => services.workspaceService.selectWorkspace(join(root, 'missing')));
    expect(missingWorkspace).toEqual({
      ok: false,
      error: {
        code: 'workspace_path_missing',
        message: '工作区路径不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请选择一个存在的目录作为工作区。'
      }
    });

    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);
      const gitStatus = await wrapIpc(() => services.gitService.getStatus());

      expect(gitStatus).toEqual({
        ok: false,
        error: {
          code: 'git_repository_missing',
          message: '当前工作区不是 Git 仓库。',
          category: 'not_found',
          retryable: false,
          userAction: '请选择一个 Git 仓库工作区，或在外部初始化仓库后重试。'
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('stages and unstages a changed workspace file through GitService', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const before = services.gitService.getStatus();
      const staged = services.gitService.stageFile('notes.txt');
      const unstaged = services.gitService.unstageFile('notes.txt');

      expect(before.porcelain).toContain(' M notes.txt');
      expect(staged.porcelain).toContain('M  notes.txt');
      expect(unstaged.porcelain).toContain(' M notes.txt');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('stages multiple changed workspace files through GitService', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-stage-files-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      writeFileSync(join(workspaceRoot, 'todo.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt', 'todo.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed notes\n', 'utf8');
      writeFileSync(join(workspaceRoot, 'todo.txt'), 'changed todo\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const staged = services.gitService.stageFiles(['notes.txt', 'todo.txt']);

      expect(staged.porcelain).toContain('M  notes.txt');
      expect(staged.porcelain).toContain('M  todo.txt');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns unified diff text for a selected changed Git file', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-diff-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const diff = services.gitService.getFileDiff('notes.txt');

      expect(diff).toMatchObject({
        workspacePath: workspaceRoot,
        relativePath: 'notes.txt'
      });
      expect(normalizeLineEndings(diff.patch)).toContain('diff --git a/notes.txt b/notes.txt');
      expect(normalizeLineEndings(diff.patch)).toContain('-initial');
      expect(normalizeLineEndings(diff.patch)).toContain('+changed');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports changed Git files with unquoted operation paths', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-space-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'space name.txt'), 'initial\n', 'utf8');
      runGit(['add', 'space name.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'space name.txt'), 'changed\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const before = services.gitService.getStatus();
      const changes = (before as { changes?: Array<{ relativePath: string }> }).changes;

      expect(before.porcelain).toContain(' M "space name.txt"');
      expect(changes).toEqual([
        expect.objectContaining({
          relativePath: 'space name.txt'
        })
      ]);
      const staged = services.gitService.stageFile(changes![0].relativePath);
      expect(staged.porcelain).toContain('M  "space name.txt"');
      const unstaged = services.gitService.unstageFile(changes![0].relativePath);
      expect(unstaged.porcelain).toContain(' M "space name.txt"');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports renamed Git files with the new operation path and original path', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-rename-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'old name.txt'), 'initial\n', 'utf8');
      runGit(['add', 'old name.txt']);
      runGit(['commit', '-m', 'initial']);
      runGit(['mv', 'old name.txt', 'new name.txt']);
      services.workspaceService.selectWorkspace(workspaceRoot);

      const before = services.gitService.getStatus();

      expect(before.porcelain).toContain('R  "old name.txt" -> "new name.txt"');
      expect(before.changes).toEqual([
        expect.objectContaining({
          index: 'R',
          worktree: ' ',
          originalPath: 'old name.txt',
          relativePath: 'new name.txt'
        })
      ]);
      const unstaged = services.gitService.unstageFile(before.changes[0].relativePath);
      expect(unstaged.porcelain).toContain('D  "old name.txt"');
      expect(unstaged.porcelain).toContain('?? "new name.txt"');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects Git file operations outside the selected workspace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-boundary-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => services.gitService.stageFile('../outside.txt')).toThrow(RocDomainError);
      expect(() => services.gitService.stageFile('nested/../outside.txt')).toThrow('Git 文件路径必须在当前工作区内。');
      expect(() => services.gitService.stageFiles([])).toThrow('批量暂存至少需要一个文件路径。');
      expect(() => services.gitService.stageFiles(['../outside.txt'])).toThrow('Git 文件路径必须在当前工作区内。');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('commits staged changes and returns clean status', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-commit-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      services.gitService.stageFile('notes.txt');
      const committed = services.gitService.commit('update notes');

      expect(committed.commitMessage).toBe('update notes');
      expect(committed.commitSha).toMatch(/^[0-9a-f]{40}$/);
      expect(committed.status.changedFiles).toBe(0);
      expect(committed.status.porcelain).toEqual([]);
      expect(runGit(['log', '-1', '--pretty=%s']).trim()).toBe('update notes');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('fails commit with empty message', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-commit-empty-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => services.gitService.commit('   ')).toThrow('提交说明不能为空。');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('discards worktree-only file changes', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-discard-worktree-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const discarded = services.gitService.discardFileChanges('notes.txt');

      expect(discarded.porcelain).toEqual([]);
      expect(normalizeLineEndings(readFileSync(join(workspaceRoot, 'notes.txt'), 'utf8'))).toBe('initial\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('discards staged and worktree file changes together', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-discard-staged-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed once\n', 'utf8');
      runGit(['add', 'notes.txt']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'changed twice\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const discarded = services.gitService.discardFileChanges('notes.txt');

      expect(discarded.porcelain).toEqual([]);
      expect(normalizeLineEndings(readFileSync(join(workspaceRoot, 'notes.txt'), 'utf8'))).toBe('initial\n');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('rejects Git discard outside the selected workspace', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-discard-boundary-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => services.gitService.discardFileChanges('../outside.txt')).toThrow(RocDomainError);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns structured git push errors when no remote is configured', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-push-missing-'));
    const runGit = (args: string[]): void => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      services.workspaceService.selectWorkspace(workspaceRoot);

      const pushResult = await wrapIpc(() => services.gitService.push());

      expect(pushResult).toEqual({
        ok: false,
        error: {
          code: 'git_push_remote_missing',
          message: '当前分支没有配置远端。',
          category: 'not_found',
          retryable: false,
          userAction: '请先为当前分支配置远端后再 push。'
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('lists local branches and marks the current branch', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-branches-list-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      runGit(['branch', 'feature/git-workbench']);
      services.workspaceService.selectWorkspace(workspaceRoot);

      const branchInfo = services.gitService.listBranches();

      expect(branchInfo.currentBranch.length).toBeGreaterThan(0);
      expect(branchInfo.branches).toContainEqual(
        expect.objectContaining({
          name: branchInfo.currentBranch,
          current: true
        })
      );
      expect(branchInfo.branches).toContainEqual(
        expect.objectContaining({
          name: 'feature/git-workbench',
          current: false
        })
      );
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('creates a local branch and optionally checks it out', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-branch-create-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      services.workspaceService.selectWorkspace(workspaceRoot);

      const created = services.gitService.createBranch('feature/batch-stage', true);

      expect(created.branchInfo.currentBranch).toBe('feature/batch-stage');
      expect(created.branchInfo.branches).toContainEqual(
        expect.objectContaining({
          name: 'feature/batch-stage',
          current: true
        })
      );
      expect(created.status.branch).toBe('feature/batch-stage');
      expect(runGit(['branch', '--show-current']).trim()).toBe('feature/batch-stage');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('checks out an existing local branch', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-branch-checkout-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      runGit(['branch', 'feature/switch-target']);
      services.workspaceService.selectWorkspace(workspaceRoot);

      const switched = services.gitService.checkoutBranch('feature/switch-target');

      expect(switched.branchInfo.currentBranch).toBe('feature/switch-target');
      expect(switched.status.branch).toBe('feature/switch-target');
      expect(runGit(['branch', '--show-current']).trim()).toBe('feature/switch-target');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('fails to create a branch when the local branch already exists', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-git-branch-duplicate-'));
    const runGit = (args: string[]): string => {
      const result = spawnSync('git', args, {
        cwd: workspaceRoot,
        encoding: 'utf8',
        windowsHide: true
      });
      if (result.status !== 0) {
        throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`);
      }
      return result.stdout;
    };

    try {
      runGit(['init']);
      runGit(['config', 'user.email', 'roc-test@example.test']);
      runGit(['config', 'user.name', 'Roc Test']);
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'initial\n', 'utf8');
      runGit(['add', 'notes.txt']);
      runGit(['commit', '-m', 'initial']);
      runGit(['branch', 'feature/existing']);
      services.workspaceService.selectWorkspace(workspaceRoot);

      expect(() => services.gitService.createBranch('feature/existing', false)).toThrow(RocDomainError);
      expect(() => services.gitService.createBranch('feature/existing', false)).toThrow(/already exists|已存在/u);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('runs only low-risk workspace commands and records agent command events', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      writeFileSync(join(workspaceRoot, 'notes.txt'), 'terminal output\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);
      const task = services.taskService.createTaskRun({
        userInput: '读取工作区文件',
        modelId: 'model-ready',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      services.taskService.markRunRunning(task.id);

      const commandResult = services.shellExecutionService.executeAgentCommand({
        command: 'dir',
        cwd: workspaceRoot,
        threadId: task.threadId,
        runId: task.id
      });
      const blockedResult = services.shellExecutionService.evaluate({
        command: 'Remove-Item notes.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });
      const snapshot = services.taskService.getSnapshot();

      expect(commandResult).toMatchObject({
        command: 'dir',
        cwd: workspaceRoot,
        exitCode: 0,
        truncated: false,
        usedRtk: false,
        bypassReason: 'rtk_binary_missing'
      });
      expect(commandResult.output).toContain('notes.txt');
      expect(blockedResult).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'remove-item notes.txt'
      });
      expect(snapshot.recentEvents.some((event) => event.type === 'agent_execute')).toBe(true);
      expect(snapshot.recentEvents.some((event) => event.type === 'agent_update')).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('uses rtk for allowed agent commands when roc-rtk.exe is available', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      writeFileSync(join(services.paths.toolsDir, 'roc-rtk.exe'), '', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);
      writeFileSync(join(workspaceRoot, '.git'), '', 'utf8');
      const task = services.taskService.createTaskRun({
        userInput: '检查 git 状态',
        modelId: 'model-ready',
        enabledCapabilities: {
          mcpServers: [],
          skills: []
        }
      });
      services.taskService.markRunRunning(task.id);
      const shellExecutionServiceForTest = services.shellExecutionService as unknown as {
        execFile: unknown;
      };
      const originalExecFile = shellExecutionServiceForTest.execFile;
      (services.shellExecutionService as unknown as {
        execFile: (
          file: string,
          args: string[],
          cwd: string,
          extraEnv?: Record<string, string>
        ) => { stdout: string; stderr: string; exitCode: number };
      }).execFile = (file, args, execCwd, extraEnv = {}) => {
        if (String(file).endsWith('roc-rtk.exe')) {
          expect(args).toEqual(['git', 'status']);
          expect(execCwd).toBe(workspaceRoot);
          expect(extraEnv.RTK_DB_PATH).toBe(join(root, 'rtk', 'history.db'));
          expect(extraEnv.RTK_TEE_DIR).toBe(join(root, 'rtk', 'tee'));
          return {
            stdout: 'On branch main',
            stderr: '',
            exitCode: 0
          };
        }
        throw new Error(`unexpected command: ${String(file)}`);
      };

      const result = services.shellExecutionService.executeAgentCommand({
        command: 'git status',
        cwd: workspaceRoot,
        threadId: task.threadId,
        runId: task.id
      });

      expect(result.usedRtk).toBe(true);
      expect(result.bypassReason).toBeUndefined();
      expect(result.output).toBe('On branch main');
      shellExecutionServiceForTest.execFile = originalExecFile;
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns UTF-8 shell output for Chinese workspace filenames', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      writeFileSync(join(workspaceRoot, '记忆系统.md'), '# 记忆系统\n', 'utf8');
      services.workspaceService.selectWorkspace(workspaceRoot);

      const result = services.shellExecutionService.execute({
        command: 'dir',
        cwd: workspaceRoot,
        source: 'terminal'
      });

      expect(result).toMatchObject({
        command: 'dir',
        cwd: workspaceRoot,
        exitCode: 0,
        usedRtk: false,
        bypassReason: 'user_terminal_raw_output'
      });
      expect(result.stdout).toContain('记忆系统.md');
      expect(result.stdout).not.toContain('�');
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks compound shell commands even when they start with a read-only command', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);

      const pipedRemoval = services.shellExecutionService.evaluate({
        command: 'dir | Remove-Item -Recurse',
        cwd: workspaceRoot,
        source: 'agent'
      });
      const chainedRemoval = services.shellExecutionService.evaluate({
        command: 'dir; Remove-Item notes.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });

      expect(pipedRemoval).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir | remove-item -recurse'
      });
      expect(chainedRemoval).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir; remove-item notes.txt'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('returns a permission error when executing a high-risk shell command through IPC boundary', async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);

      const result = await wrapIpc(() =>
        services.shellExecutionService.execute({
          command: 'Remove-Item notes.txt',
          cwd: workspaceRoot,
          source: 'agent'
        })
      );

      expect(result).toEqual({
        ok: false,
        error: {
          code: 'command_requires_confirmation',
          message: '命令需要确认，未执行。',
          category: 'permission',
          retryable: false,
          userAction: '请在任务确认卡片中查看命令、作用目录和风险原因后再决定是否执行。'
        }
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('blocks shell redirection because it can write workspace files', () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), 'roc-workspace-'));
    try {
      services.workspaceService.selectWorkspace(workspaceRoot);

      const redirectedListing = services.shellExecutionService.evaluate({
        command: 'dir > created-by-redirection.txt',
        cwd: workspaceRoot,
        source: 'agent'
      });

      expect(redirectedListing).toEqual({
        status: 'requires_confirmation',
        reason: 'high_risk_command',
        riskLevel: 'high',
        normalizedCommand: 'dir > created-by-redirection.txt'
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  it('reports RTK resources as degraded when the bundled binary is missing', () => {
    const status = services.rtkService.getStatus();

    expect(status).toEqual({
      enabledForAgentCommands: true,
      binaryPath: join(root, 'tools', 'roc-rtk.exe'),
      configPath: join(root, 'rtk', 'config.toml'),
      teeDir: join(root, 'rtk', 'tee'),
      resourceState: 'missing',
      bypassReason: 'rtk_binary_missing'
    });
  });

  it('keeps unexpected IPC errors sanitized while preserving domain errors', async () => {
    const domainResult = await wrapIpc(() => {
      throw new RocDomainError({
        code: 'memory_not_found',
        message: '记忆条目不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请重新搜索记忆。'
      });
    });

    const unexpectedResult = await wrapIpc(() => {
      throw new Error('SQLITE_CANTOPEN: C:\\Users\\任彦舟\\.roc\\roc.sqlite');
    });

    expect(domainResult).toEqual({
      ok: false,
      error: {
        code: 'memory_not_found',
        message: '记忆条目不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请重新搜索记忆。'
      }
    });
    expect(unexpectedResult).toEqual({
      ok: false,
      error: {
        code: 'internal_error',
        message: 'Roc 内部错误，已记录到本地日志。',
        category: 'internal',
        retryable: false,
        userAction: '请查看 Roc 日志后重试。'
      }
    });
  });

  it('manages providers and clears invalid default models', () => {
    const provider = services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: 'secret:provider-local',
      enabled: true,
      models: [
        {
          id: 'model-tools',
          displayName: 'Tool capable model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    services.configService.setDefaultModel('model-tools');

    expect(provider.credentialRef).toBe('secret:provider-local');
    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'ready',
      modelId: 'model-tools',
      providerId: 'provider-local',
      reason: '默认模型可用。'
    });

    services.configService.deleteProvider(provider.id);

    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'missing',
      modelId: null,
      providerId: null,
      reason: '未配置默认模型。'
    });
  });

  it('tests a saved provider through the live transport without relying on the default model', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'OK'
            },
            finish_reason: 'stop'
          }
        ],
        usage: {
          prompt_tokens: 11,
          completion_tokens: 1,
          total_tokens: 12
        }
      },
      200
    );

    try {
      liveServices.appService.initialize();
      liveServices.secretService.setProviderSecret('provider-live-openai', 'sk-live-test-secret');
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-live-openai',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await liveServices.providerRuntimeService.testProvider('provider-live-openai');

      expect(result).toMatchObject({
        providerId: 'provider-live-openai',
        status: 'ready',
        defaultModelReady: false,
        modelId: 'live-model',
        error: null
      });
      expect(fakeProvider.requests).toHaveLength(1);
      expect(fakeProvider.requests[0]).toMatchObject({
        method: 'POST',
        url: '/v1/chat/completions',
        authorization: 'Bearer sk-live-test-secret'
      });
      expect(fakeProvider.requests[0]?.body).toMatchObject({
        model: 'live-model',
        stream: false,
        messages: [
          expect.objectContaining({
            role: 'system'
          }),
          expect.objectContaining({
            role: 'user',
            content: 'Reply with OK only.'
          })
        ]
      });
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns local validation failures for provider tests without issuing live requests', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'This response should not be requested.'
            },
            finish_reason: 'stop'
          }
        ]
      },
      200
    );

    try {
      liveServices.appService.initialize();
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          {
            id: 'provider-disabled',
            name: 'Disabled provider',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-disabled',
            enabled: false,
            models: [
              {
                id: 'disabled-model',
                displayName: 'Disabled model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          },
          {
            id: 'provider-no-models',
            name: 'No ready models',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-no-models',
            enabled: true,
            models: [
              {
                id: 'disabled-model',
                displayName: 'Disabled model',
                enabled: false,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          },
          {
            id: 'provider-missing-secret',
            name: 'Missing secret',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-missing-secret',
            enabled: true,
            models: [
              {
                id: 'missing-secret-model',
                displayName: 'Missing secret model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const disabled = await liveServices.providerRuntimeService.testProvider('provider-disabled');
      const noModels = await liveServices.providerRuntimeService.testProvider('provider-no-models');
      const missingSecret = await liveServices.providerRuntimeService.testProvider('provider-missing-secret');

      expect(disabled).toMatchObject({
        providerId: 'provider-disabled',
        status: 'invalid',
        defaultModelReady: false,
        modelId: null,
        error: 'Provider 未启用。'
      });
      expect(noModels).toMatchObject({
        providerId: 'provider-no-models',
        status: 'invalid',
        defaultModelReady: false,
        modelId: null,
        error: 'Provider 没有已启用模型。'
      });
      expect(missingSecret).toMatchObject({
        providerId: 'provider-missing-secret',
        status: 'invalid',
        defaultModelReady: false,
        modelId: 'missing-secret-model',
        error: 'Provider 凭据未存储。'
      });
      expect(fakeProvider.requests).toHaveLength(0);
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns redacted HTTP failures in provider tests after issuing a live request', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        error: {
          message: 'bad Authorization: Bearer sk-live-test-secret'
        }
      },
      401
    );

    try {
      liveServices.appService.initialize();
      liveServices.secretService.setProviderSecret('provider-live-openai', 'sk-live-test-secret');
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-live-openai',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await liveServices.providerRuntimeService.testProvider('provider-live-openai');

      expect(result).toMatchObject({
        providerId: 'provider-live-openai',
        status: 'invalid',
        defaultModelReady: false,
        modelId: 'live-model'
      });
      expect(result.error).toContain('HTTP 401');
      expect(result.error).toContain('[REDACTED]');
      expect(result.error).not.toContain('sk-live-test-secret');
      expect(fakeProvider.requests).toHaveLength(1);
    } finally {
      liveServices.databaseService.close();
      await fakeProvider.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns retryable network failures as invalid provider test results', async () => {
    const liveRoot = mkdtempSync(join(tmpdir(), 'roc-live-provider-test-'));
    const liveServices = createAppServices(liveRoot);
    const fakeProvider = await startFakeProvider(
      {
        choices: [
          {
            message: {
              role: 'assistant',
              content: 'This response should not be requested.'
            },
            finish_reason: 'stop'
          }
        ]
      },
      200
    );
    await fakeProvider.close();

    try {
      liveServices.appService.initialize();
      liveServices.secretService.setProviderSecret('provider-live-openai', 'sk-live-test-secret');
      liveServices.configService.saveProviders({
        schemaVersion: 1,
        defaultModelId: null,
        providers: [
          {
            id: 'provider-live-openai',
            name: 'Live OpenAI compatible',
            type: 'openai_compatible',
            endpoint: fakeProvider.endpoint,
            credentialRef: 'secret:provider-live-openai',
            enabled: true,
            models: [
              {
                id: 'live-model',
                displayName: 'Live model',
                enabled: true,
                supportsStreaming: true,
                supportsToolCalls: true
              }
            ]
          }
        ]
      });

      const result = await liveServices.providerRuntimeService.testProvider('provider-live-openai');

      expect(result).toMatchObject({
        providerId: 'provider-live-openai',
        status: 'invalid',
        defaultModelReady: false,
        modelId: 'live-model'
      });
      expect(result.error).toContain('Provider 网络请求失败');
      expect(result.error).not.toContain('sk-live-test-secret');
    } finally {
      liveServices.databaseService.close();
      rmSync(liveRoot, { recursive: true, force: true });
    }
  });

  it('returns provider timeout failures as invalid test results', async () => {
    vi.useFakeTimers();
    services.secretService.setProviderSecret('provider-local', 'sk-local-test-secret');
    services.configService.saveProviders({
      schemaVersion: 1,
      defaultModelId: null,
      providers: [
        {
          id: 'provider-local',
          name: 'Local OpenAI-compatible',
          type: 'openai_compatible',
          endpoint: 'http://127.0.0.1:11434/v1',
          credentialRef: 'secret:provider-local',
          enabled: true,
          models: [
            {
              id: 'model-tools',
              displayName: 'Tool capable model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true
            }
          ]
        }
      ]
    });
    services.providerRuntimeService.setDeterministicFailure(
      new RocDomainError({
        code: 'provider_request_timeout',
        message: 'Provider 请求超时，请稍后重试或检查 Provider endpoint。',
        category: 'external',
        retryable: true,
        userAction: '请稍后重试，或检查 Provider endpoint 是否可访问。'
      })
    );

    const resultPromise = services.providerRuntimeService.testProvider('provider-local');
    await vi.runAllTimersAsync();
    const result = await resultPromise;

    expect(result).toMatchObject({
      providerId: 'provider-local',
      status: 'invalid',
      defaultModelReady: false,
      modelId: 'model-tools',
      error: 'Provider 请求超时，请稍后重试或检查 Provider endpoint。'
    });
  });

  it('keeps multiple OpenAI-compatible and Anthropic-compatible providers as independent default-model choices', () => {
    services.configService.upsertProvider({
      id: 'provider-openai-a',
      name: 'OpenAI A',
      type: 'openai_compatible',
      endpoint: 'https://openai-a.example.test/v1',
      credentialRef: 'secret:provider-openai-a',
      enabled: true,
      models: [
        {
          id: 'openai-a-model',
          displayName: 'OpenAI A model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    services.configService.upsertProvider({
      id: 'provider-openai-b',
      name: 'OpenAI B',
      type: 'openai_compatible',
      endpoint: 'https://openai-b.example.test/v1',
      credentialRef: 'secret:provider-openai-b',
      enabled: true,
      models: [
        {
          id: 'openai-b-model',
          displayName: 'OpenAI B model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: false
        }
      ]
    });
    services.configService.upsertProvider({
      id: 'provider-anthropic-a',
      name: 'Anthropic A',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic-a.example.test/v1',
      credentialRef: 'secret:provider-anthropic-a',
      enabled: true,
      models: [
        {
          id: 'anthropic-a-model',
          displayName: 'Anthropic A model',
          enabled: true,
          supportsStreaming: false,
          supportsToolCalls: false
        }
      ]
    });
    services.configService.upsertProvider({
      id: 'provider-anthropic-b',
      name: 'Anthropic B',
      type: 'anthropic_compatible',
      endpoint: 'https://anthropic-b.example.test/v1',
      credentialRef: 'secret:provider-anthropic-b',
      enabled: true,
      models: [
        {
          id: 'anthropic-b-model',
          displayName: 'Anthropic B model',
          enabled: true,
          supportsStreaming: false,
          supportsToolCalls: false
        }
      ]
    });

    const config = services.configService.getProviders();
    services.configService.setDefaultModel('anthropic-b-model');

    expect(config.providers.map((provider) => `${provider.type}:${provider.id}`)).toEqual([
      'nvidia:nvidia',
      'openai_compatible:provider-openai-a',
      'openai_compatible:provider-openai-b',
      'anthropic_compatible:provider-anthropic-a',
      'anthropic_compatible:provider-anthropic-b'
    ]);
    expect(services.configService.getDefaultModelState()).toEqual({
      status: 'ready',
      modelId: 'anthropic-b-model',
      providerId: 'provider-anthropic-b',
      reason: '默认模型可用。'
    });
  });

  it('manages MCP servers and validates local MCP test requirements', () => {
    const exaPreset = services.mcpService.ensureExaPreset();
    const server = services.mcpService.upsertServer({
      id: 'docs-http',
      name: 'Docs HTTP MCP',
      transport: 'http',
      enabled: true,
      url: 'https://docs.example.test/mcp',
      preset: false,
      riskLevel: 'medium',
      allowedTools: ['search_docs']
    });
    const disabled = services.mcpService.setServerEnabled('docs-http', false);
    const testResult = services.mcpService.testServer('docs-http');
    const servers = services.mcpService.listServers();

    expect(exaPreset).toMatchObject({
      id: 'exa-hosted',
      transport: 'http',
      preset: true
    });
    expect(server.enabled).toBe(true);
    expect(disabled.enabled).toBe(false);
    expect(testResult).toMatchObject({
      serverId: 'docs-http',
      status: 'ready',
      checked: ['id', 'name', 'transport', 'url']
    });
    expect(servers).toContainEqual(
      expect.objectContaining({
        id: 'docs-http',
        enabled: false,
        status: 'not_connected'
      })
    );

    services.mcpService.deleteServer('docs-http');
    expect(services.mcpService.listServers().some((item) => item.id === 'docs-http')).toBe(false);
  });

  it('ensures the Exa preset exists on startup', () => {
    const exaServer = services.mcpService.listServers().find((server) => server.id === 'exa-hosted');

    expect(exaServer).toMatchObject({
      id: 'exa-hosted',
      name: 'Exa Hosted MCP',
      transport: 'http',
      preset: true,
      enabled: false,
      url: 'https://mcp.exa.ai/mcp'
    });
  });

  it('imports, disables, enables, and deletes local skills without a marketplace', () => {
    const source = mkdtempSync(join(tmpdir(), 'roc-skill-source-'));
    try {
      writeFileSync(
        join(source, 'SKILL.md'),
        ['---', 'name: project-review', 'description: Review a local project', '---', '', '# Skill', ''].join('\n'),
        'utf8'
      );

      const imported = services.skillService.importSkill({ sourcePath: source, id: 'project-review' });
      const disabled = services.skillService.setEnabled('project-review', false);
      const enabled = services.skillService.setEnabled('project-review', true);
      const skills = services.skillService.list();

      expect(imported).toMatchObject({
        id: 'project-review',
        name: 'project-review',
        enabled: true,
        status: 'ready'
      });
      expect(resolve(imported.path).startsWith(resolve(services.paths.skillsDir))).toBe(true);
      expect(disabled.enabled).toBe(false);
      expect(enabled.enabled).toBe(true);
      expect(skills).toContainEqual(expect.objectContaining({ id: 'project-review', enabled: true }));

      services.skillService.deleteSkill('project-review');
      expect(services.skillService.list().some((item) => item.id === 'project-review')).toBe(false);
    } finally {
      rmSync(source, { recursive: true, force: true });
    }
  });

  it('builds an Agent capability preview from the current turn MCP and Skill selections', () => {
    services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: null,
      enabled: true,
      models: [
        {
          id: 'model-ready',
          displayName: 'Ready model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    services.configService.setDefaultModel('model-ready');
    services.mcpService.upsertServer({
      id: 'docs-http',
      name: 'Docs HTTP MCP',
      transport: 'http',
      enabled: true,
      url: 'https://docs.example.test/mcp',
      preset: false,
      riskLevel: 'medium',
      allowedTools: ['search_docs']
    });
    services.mcpService.upsertServer({
      id: 'disabled-mcp',
      name: 'Disabled MCP',
      transport: 'http',
      enabled: false,
      url: 'https://disabled.example.test/mcp',
      preset: false,
      riskLevel: 'low',
      allowedTools: ['disabled_tool']
    });
    mkdirSync(join(services.paths.skillsDir, 'project-review'), { recursive: true });
    writeFileSync(
      join(services.paths.skillsDir, 'project-review', 'SKILL.md'),
      ['---', 'name: project-review', 'description: Review a local project', '---', ''].join('\n'),
      'utf8'
    );

    const preview = services.agentService.getCapabilityPreview({
      mcpServers: ['docs-http', 'disabled-mcp', 'missing-mcp'],
      skills: ['project-review', 'missing-skill']
    });

    expect(preview).toMatchObject({
      runnable: false,
      modelId: 'model-ready',
      untrustedContextPolicy: 'external_content_reference_only',
      selectedCapabilities: {
        mcpServers: ['docs-http'],
        skills: ['project-review']
      }
    });
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'mcp:docs-http:search_docs',
        name: 'search_docs',
        capabilityType: 'mcp_tool',
        scope: 'external',
        riskLevel: 'medium',
        auditCategory: 'mcp_call',
        requiresApproval: false
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'builtin:execute',
        name: 'execute',
        capabilityType: 'terminal_tool',
        scope: 'workspace',
        auditCategory: 'agent_execute',
        requiresApproval: false
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'builtin:delete_file',
        name: 'delete_file',
        capabilityType: 'terminal_tool',
        auditCategory: 'workspace_delete',
        requiresApproval: false
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'web:web_read',
        name: 'web_read',
        capabilityType: 'web_read',
        scope: 'network',
        untrustedContext: true
      })
    );
    expect(preview.skillCards).toContainEqual(
      expect.objectContaining({
        id: 'skill:project-review',
        name: 'project-review',
        capabilityType: 'skill',
        sourcePath: join(services.paths.skillsDir, 'project-review')
      })
    );
    expect(preview.subagents).toContainEqual(
      expect.objectContaining({
        id: 'code-review',
        inheritsSkills: false
      })
    );
    expect(preview.skippedCapabilities).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: 'disabled-mcp', type: 'mcp_server', reason: 'disabled' }),
        expect.objectContaining({ id: 'missing-mcp', type: 'mcp_server', reason: 'not_found' }),
        expect.objectContaining({ id: 'missing-skill', type: 'skill', reason: 'not_found' })
      ])
    );
    expect(preview.interruptOn).toMatchObject({
      // fully_automatic 默认不挂 interrupt
    });
    expect(preview.interruptOn).toEqual({});
  });

  it('normalizes the Exa preset into a single web_search capability card', () => {
    services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: null,
      enabled: true,
      models: [
        {
          id: 'model-ready',
          displayName: 'Ready model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    services.configService.setDefaultModel('model-ready');
    services.mcpService.setServerEnabled(services.mcpService.ensureExaPreset().id, true);

    const preview = services.agentService.getCapabilityPreview({
      mcpServers: ['exa-hosted'],
      skills: []
    });

    expect(preview.selectedCapabilities.mcpServers).toEqual(['exa-hosted']);
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'mcp:exa-hosted:web_search',
        name: 'web_search',
        capabilityType: 'mcp_tool',
        auditCategory: 'mcp_call',
        requiresApproval: false
      })
    );
    expect(preview.toolCards).not.toContainEqual(
      expect.objectContaining({
        name: 'web_search_exa'
      })
    );
    expect(preview.interruptOn).toEqual({});
  });

  it('switches capability preview to default approval mode for MCP and delete_file only', () => {
    services.configService.upsertProvider({
      id: 'provider-local',
      name: 'Local OpenAI-compatible',
      type: 'openai_compatible',
      endpoint: 'http://127.0.0.1:11434/v1',
      credentialRef: null,
      enabled: true,
      models: [
        {
          id: 'model-ready',
          displayName: 'Ready model',
          enabled: true,
          supportsStreaming: true,
          supportsToolCalls: true
        }
      ]
    });
    services.configService.setDefaultModel('model-ready');
    services.configService.savePermissions({
      schemaVersion: 3,
      mode: 'default',
      grants: []
    });
    services.mcpService.setServerEnabled(services.mcpService.ensureExaPreset().id, true);

    const preview = services.agentService.getCapabilityPreview({
      mcpServers: ['exa-hosted'],
      skills: []
    });

    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'builtin:delete_file',
        name: 'delete_file',
        requiresApproval: true
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'mcp:exa-hosted:web_search',
        name: 'web_search',
        requiresApproval: true
      })
    );
    expect(preview.toolCards).toContainEqual(
      expect.objectContaining({
        id: 'builtin:execute',
        name: 'execute',
        requiresApproval: false
      })
    );
    expect(preview.interruptOn).toEqual({
      delete_file: true,
      web_search: true
    });
  });

  it('creates scheduled background tasks and keeps tray summary bound to task state', () => {
    const preview = services.taskService.createBackgroundTaskPreview({
      goal: '每天检查项目测试状态',
      trigger: {
        type: 'schedule',
        description: '每天 09:00',
        nextRunAt: '2026-04-29T01:00:00.000Z'
      },
      workspacePath: root,
      allowedActions: ['pnpm test'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = services.taskService.createBackgroundTask(preview);
    const paused = services.taskService.pauseBackgroundTask(task.id);
    const resumed = services.taskService.resumeBackgroundTask(task.id);
    const tray = services.lifecycleService.getTraySummary();
    const snapshot = services.taskService.getSnapshot();

    expect(preview).toMatchObject({
      goal: '每天检查项目测试状态',
      scheduled: true,
      nextRunAt: '2026-04-29T01:00:00.000Z',
      riskLevel: 'medium',
      requiresConfirmation: false
    });
    expect(task).toMatchObject({
      goal: '每天检查项目测试状态',
      status: 'running',
      triggerDescription: '每天 09:00',
      nextRunAt: '2026-04-29T01:00:00.000Z'
    });
    expect(paused.status).toBe('paused');
    expect(resumed.status).toBe('running');
    expect(tray).toMatchObject({
      residentEnabled: true,
      backgroundPaused: false,
      backgroundTasks: {
        total: 1,
        running: 1,
        failed: 0,
        pendingConfirmation: 0
      },
      nextRunAt: '2026-04-29T01:00:00.000Z'
    });
    expect(snapshot.counts.running).toBe(1);
    expect(snapshot.threads).toContainEqual(
      expect.objectContaining({
        id: task.threadId,
        status: 'running'
      })
    );
    expect(snapshot.recentEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: 'background_task_created' }),
        expect.objectContaining({ type: 'background_task_paused' }),
        expect.objectContaining({ type: 'background_task_resumed' })
      ])
    );
  });

  it('returns structured errors for illegal background task transitions', async () => {
    const missing = await wrapIpc(() => services.taskService.pauseBackgroundTask('missing-background-task'));

    expect(missing).toEqual({
      ok: false,
      error: {
        code: 'background_task_not_found',
        message: '后台任务不存在。',
        category: 'not_found',
        retryable: false,
        userAction: '请刷新任务工作台后重试。'
      }
    });

    const preview = services.taskService.createBackgroundTaskPreview({
      goal: '检查取消状态',
      trigger: {
        type: 'manual',
        description: '手动触发',
        nextRunAt: null
      },
      workspacePath: root,
      allowedActions: ['pnpm test'],
      forbiddenActions: [],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = services.taskService.createBackgroundTask(preview);
    services.taskService.cancelBackgroundTask(task.id);

    const resumeCancelled = await wrapIpc(() => services.taskService.resumeBackgroundTask(task.id));

    expect(resumeCancelled).toEqual({
      ok: false,
      error: {
        code: 'background_task_invalid_transition',
        message: '后台任务当前状态不能继续。',
        category: 'conflict',
        retryable: false,
        userAction: '请查看任务状态，必要时创建新的后台任务。'
      }
    });
  });

  it('generates redacted diagnostic packages with task, RTK and performance evidence', () => {
    const preview = services.taskService.createBackgroundTaskPreview({
      goal: '生成诊断包',
      trigger: {
        type: 'manual',
        description: '手动触发',
        nextRunAt: null
      },
      workspacePath: root,
      allowedActions: ['echo diagnostic'],
      forbiddenActions: ['git push'],
      failurePolicy: 'pause_and_report',
      notificationPolicy: 'failures_and_confirmations'
    });
    const task = services.taskService.createBackgroundTask(preview);
    const pack = services.diagnosticsService.createDiagnosticPackage({
      taskId: task.id,
      errorSummary: 'Authorization: Bearer sk-secret-value'
    });
    const content = readFileSync(pack.path, 'utf8');

    expect(pack).toMatchObject({
      taskId: task.id,
      redacted: true,
      includes: expect.arrayContaining(['task_snapshot', 'performance_sample', 'rtk_status'])
    });
    expect(content).toContain('[REDACTED]');
    expect(content).not.toContain('sk-secret-value');
    expect(content).not.toContain('Bearer sk-secret-value');
  });

  it('records performance samples and exposes the package directory script target', () => {
    const sample = services.diagnosticsService.samplePerformance({
      mode: 'test',
      memoryBudgetMb: 300
    });

    expect(sample).toMatchObject({
      mode: 'test',
      memoryBudgetMb: 300
    });
    expect(sample.rssMb).toBeGreaterThan(0);
    expect(sample.heapUsedMb).toBeGreaterThan(0);
    expect(typeof sample.exceedsBudget).toBe('boolean');
    expect(existsSync(resolve('scripts/package-dir.mjs'))).toBe(true);
  });
});
