import { describe, expect, it, vi } from 'vitest';

import type { MemoryFileWriteOutcome, MemoryKind, MemoryScope } from '../../../../src/shared/types';
import { AutoMemoryWriter, type AgentRunCompletedPayload } from '../../../../src/main/services/memory/auto-memory-writer';
import type { MemoryStoreRepository, MemoryWorkspaceContext } from '../../../../src/main/plugins/memory/memory-store-repository';

describe('AutoMemoryWriter', () => {
  it('rejects generic completed run summaries', async () => {
    const repository = createRepository({ workspace: null });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(createPayload({ summary: 'Completed the task successfully.' }), '2026-07-03T00:00:00.000Z');

    await expect(repository.readFile({ scope: 'global', kind: 'memory' })).resolves.toBeNull();
  });

  it('writes typed workspace facts only when evidence is present', async () => {
    const repository = createRepository({
      workspace: {
        label: 'Roc',
        path: 'F:\\Code\\Roc'
      }
    });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        workspacePath: 'F:\\Code\\Roc',
        summary: [
          'workspace_fact: roc.memory.auto_candidate | high | src/main/services/memory/auto-memory-writer.ts | Auto memory writes use typed candidates.'
        ].join('\n')
      }),
      '2026-07-03T00:00:00.000Z'
    );

    await expect(repository.readFile({ scope: 'workspace', kind: 'memory' }, { label: 'F:\\Code\\Roc', path: 'F:\\Code\\Roc' })).resolves.toContain(
      'type: workspace_fact'
    );
    await expect(repository.readFile({ scope: 'workspace', kind: 'memory' }, { label: 'F:\\Code\\Roc', path: 'F:\\Code\\Roc' })).resolves.toContain(
      'key: roc.memory.auto_candidate'
    );
  });

  it('rejects workspace facts without evidence', async () => {
    const repository = createRepository({ workspace: { label: 'Roc', path: 'F:\\Code\\Roc' } });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        workspacePath: 'F:\\Code\\Roc',
        summary: 'workspace_fact: roc.memory.no_evidence | high |  | Missing evidence should not write.'
      }),
      '2026-07-03T00:00:00.000Z'
    );

    await expect(repository.readFile({ scope: 'workspace', kind: 'memory' }, { label: 'F:\\Code\\Roc', path: 'F:\\Code\\Roc' })).resolves.toBeNull();
  });

  it('writes low-confidence pitfalls when they include a revalidation rule', async () => {
    const repository = createRepository({ workspace: { label: 'Roc', path: 'F:\\Code\\Roc' } });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        workspacePath: 'F:\\Code\\Roc',
        summary: [
          'pitfall: roc.memory.capacity_retry | low | tests/main/services/memory/auto-memory-writer.test.ts | Capacity overflow should retry after exact duplicate cleanup. | revalidate=when memory capacity policy changes'
        ].join('\n')
      }),
      '2026-07-03T00:00:00.000Z'
    );

    const content = await repository.readFile({ scope: 'workspace', kind: 'memory' }, { label: 'F:\\Code\\Roc', path: 'F:\\Code\\Roc' });
    expect(content).toContain('type: pitfall');
    expect(content).toContain('confidence: low');
    expect(content).toContain('revalidate: when memory capacity policy changes');
  });

  it('rejects transient task results from long-term memory', async () => {
    const repository = createRepository({ workspace: null });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        summary: 'transient_task_result: one.off | high | tests/manual/run.log | Finished this single run.'
      }),
      '2026-07-03T00:00:00.000Z'
    );

    await expect(repository.readFile({ scope: 'global', kind: 'memory' })).resolves.toBeNull();
  });

  it('rejects user preferences without evidence', async () => {
    const repository = createRepository({ workspace: null });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        summary: 'user_preference: user.cli.shell | high |  | User prefers PowerShell.'
      }),
      '2026-07-03T00:00:00.000Z'
    );

    await expect(repository.readFile({ scope: 'global', kind: 'memory' })).resolves.toBeNull();
  });

  it('writes directly evidenced user preferences to global memory', async () => {
    const repository = createRepository({ workspace: null });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        summary: 'user_preference: user.cli.shell | high | user stated: prefer PowerShell | User prefers PowerShell.'
      }),
      '2026-07-03T00:00:00.000Z'
    );

    const content = await repository.readFile({ scope: 'global', kind: 'memory' });
    expect(content).toContain('type: user_preference');
    expect(content).toContain('key: user.cli.shell');
    expect(content).toContain('summary: User prefers PowerShell.');
  });

  it('rejects model-inferred user preferences even when evidence text exists', async () => {
    const repository = createRepository({ workspace: null });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        summary: 'user_preference: user.editor | high | model inferred from one edit | User prefers Vim.'
      }),
      '2026-07-03T00:00:00.000Z'
    );

    await expect(repository.readFile({ scope: 'global', kind: 'memory' })).resolves.toBeNull();
  });

  it('keeps user-stated preferences when a later model-inferred candidate uses the same key', async () => {
    const repository = createRepository({ workspace: null });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        summary: 'user_preference: user.cli.shell | high | user stated: prefer PowerShell | User prefers PowerShell.'
      }),
      '2026-07-03T00:00:00.000Z'
    );
    await writer.handleAgentRunCompleted(
      createPayload({
        summary: 'user_preference: user.cli.shell | high | model inferred from command output | User prefers Bash.'
      }),
      '2026-07-03T00:00:00.000Z'
    );

    const content = await repository.readFile({ scope: 'global', kind: 'memory' });
    expect(content).toContain('summary: User prefers PowerShell.');
    expect(content).not.toContain('summary: User prefers Bash.');
  });

  it('skips duplicate candidate keys and summaries', async () => {
    const repository = createRepository({ workspace: null });
    const writer = createWriter(repository);
    const payload = createPayload({
      summary: 'decision: roc.memory.pipeline | high | user confirmed option C | Use automatic candidate pipeline.'
    });

    await writer.handleAgentRunCompleted(payload, '2026-07-03T00:00:00.000Z');
    await writer.handleAgentRunCompleted({ ...payload, runId: 'run_2' }, '2026-07-03T00:00:00.000Z');

    const content = await repository.readFile({ scope: 'global', kind: 'memory' });
    expect(content?.match(/key: roc\.memory\.pipeline/gu)).toHaveLength(1);
  });

  it('does not throw when repository writes fail', async () => {
    const repository = createRepository({ workspace: null, writeThrows: true });
    const writer = createWriter(repository);

    await expect(
      writer.handleAgentRunCompleted(
        createPayload({
          summary: 'decision: roc.memory.pipeline | high | user confirmed option C | Use automatic candidate pipeline.'
        }),
        '2026-07-03T00:00:00.000Z'
      )
    ).resolves.toBeUndefined();
  });

  it('retries capacity overflow once after duplicate cleanup', async () => {
    let writeCount = 0;
    const repository = createRepository({
      workspace: null,
      failFirstCapacity: true,
      onWrite: () => {
        writeCount += 1;
      }
    });
    const writer = createWriter(repository);

    await writer.handleAgentRunCompleted(
      createPayload({
        summary: 'decision: roc.memory.pipeline | high | user confirmed option C | Use automatic candidate pipeline.'
      }),
      '2026-07-03T00:00:00.000Z'
    );

    expect(writeCount).toBe(2);
    await expect(repository.readFile({ scope: 'global', kind: 'memory' })).resolves.toContain('key: roc.memory.pipeline');
  });
});

function createPayload(input: {
  summary: string;
  workspacePath?: string | null;
}): AgentRunCompletedPayload {
  return {
    runId: 'run_1',
    threadId: 'thread_1',
    workspacePath: input.workspacePath,
    summary: input.summary,
    assistantMessage: 'done'
  };
}

function createWriter(repository: MemoryStoreRepository): AutoMemoryWriter {
  return new AutoMemoryWriter({
    repository,
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn()
    }
  });
}

function createRepository(input: {
  workspace: MemoryWorkspaceContext | null;
  writeThrows?: boolean;
  failFirstCapacity?: boolean;
  onWrite?: () => void;
}): MemoryStoreRepository {
  const files = new Map<string, string>();
  let writeAttempts = 0;

  function key(scope: MemoryScope, kind: MemoryKind, workspaceOverride?: MemoryWorkspaceContext | null): string {
    const workspace = workspaceOverride === undefined ? input.workspace : workspaceOverride;
    const workspaceKey = workspace === null ? 'global' : workspace.path;
    return `${scope}:${kind}:${workspaceKey}`;
  }

  return {
    hasWorkspace: (workspaceOverride?: MemoryWorkspaceContext | null) => {
      if (workspaceOverride !== undefined) {
        return workspaceOverride !== null;
      }
      return input.workspace !== null;
    },
    readFile: async (request, workspaceOverride) => files.get(key(request.scope, request.kind, workspaceOverride)) ?? null,
    writeFile: async (request, workspaceOverride): Promise<MemoryFileWriteOutcome> => {
      writeAttempts += 1;
      input.onWrite?.();
      if (input.writeThrows === true) {
        throw new Error('write_failed');
      }
      if (input.failFirstCapacity === true && writeAttempts === 1) {
        return {
          ok: false,
          reason: 'capacity_exceeded',
          detail: 'Write blocked: capacity exceeded.',
          chars: request.content.length,
          limit: 1
        };
      }
      files.set(key(request.scope, request.kind, workspaceOverride), request.content);
      return {
        ok: true,
        meta: {
          scope: request.scope,
          kind: request.kind,
          exists: true,
          charCount: request.content.length,
          charLimit: 2200,
          absolutePath: '/memory/test/MEMORY.md',
          effective: true,
          updatedAt: '2026-07-03T00:00:00.000Z'
        }
      };
    }
  } as MemoryStoreRepository;
}
