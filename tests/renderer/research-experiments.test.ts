import { describe, expect, it, vi } from 'vitest';

import { createResearchExperimentProjection } from '../../src/renderer/views/research/research-experiments';
import { emptyExperimentDraft } from '../../src/renderer/views/research/ResearchExperimentPanel';
import type { ResearchExperimentExecution } from '../../src/shared/types';

describe('research experiment projection', () => {
  it('inspects the environment then starts an experiment from the typed source path', async () => {
    const execution: ResearchExperimentExecution = {
      id: 'exp_1', projectId: 'research_1',
      request: {
        projectId: 'research_1', requestId: 'req_exp', label: 'Measure signal', engine: 'python',
        runtime: { kind: 'bundled-python' }, sourcePath: 'run.py', inputPaths: ['data.csv'], arguments: [],
        parameters: {}, expectedEnvironmentHash: 'a'.repeat(64), timeoutMs: 60000, network: 'disabled'
      },
      ownerRunId: null, workspacePath: '/tmp/roc', workspaceRoot: '/tmp/roc', status: 'completed',
      environment: {
        runtime: { kind: 'bundled-python' }, executable: '/tmp/python', prefix: '/tmp/python', basePrefix: '/tmp/python',
        version: '3.12.14', platform: 'darwin', architecture: 'arm64', toolchainHash: 'b'.repeat(64), metadataHash: 'c'.repeat(64),
        packages: [], lockFiles: [], hash: 'd'.repeat(64)
      },
      files: [{ area: 'log', path: 'stdout.txt', sha256: 'e'.repeat(64), size: 12 }],
      inputHash: 'f'.repeat(64), exitCode: 0, error: null, artifactId: null,
      createdAt: '2026-09-14T01:00:00.000Z', startedAt: '2026-09-14T01:00:01.000Z', endedAt: '2026-09-14T01:00:02.000Z'
    };
    const adapter = {
      list: vi.fn(async () => [execution]),
      inspect: vi.fn(async () => execution.environment!),
      start: vi.fn(async () => execution),
      cancel: vi.fn(),
      publish: vi.fn(),
      get: vi.fn(),
      readFile: vi.fn()
    };
    const projection = createResearchExperimentProjection(adapter, { createId: () => 'req_fixed' });
    projection.setProject('research_1');
    projection.setDraft({
      ...emptyExperimentDraft,
      label: 'Measure signal',
      sourcePath: 'run.py',
      inputPaths: 'data.csv'
    });
    await projection.start();
    expect(adapter.inspect).toHaveBeenCalledWith({ projectId: 'research_1', runtime: { kind: 'bundled-python' } });
    expect(adapter.start).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'research_1', label: 'Measure signal', engine: 'python', sourcePath: 'run.py', inputPaths: ['data.csv'],
      expectedEnvironmentHash: 'd'.repeat(64), network: 'disabled'
    }));
    expect(projection.getSnapshot().experiments[0]?.request.label).toBe('Measure signal');
  });
});
