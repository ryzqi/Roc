import { describe, expect, it, vi } from 'vitest';
import { applyResearchWorkflowTransition, shutdownResearchPlugin } from '../../../../src/main/plugins/research/research-plugin-lifecycle';

describe('research plugin lifecycle', () => {
  it('routes review actions through the gate and every other action through the runtime', async () => {
    const gate = {
      complete: vi.fn(async () => 'gated'),
      approve: vi.fn(async () => 'approved'),
      reject: vi.fn(async () => 'rejected')
    };
    const runtime = { transition: vi.fn(() => 'moved') };
    const exports = { projectChanged: vi.fn() };
    const complete = { projectId: 'project_1', expectedStage: 'figure', action: 'complete' } as const;
    const move = { projectId: 'project_1', expectedStage: 'figure', action: 'move', targetStage: 'writing' } as const;
    await expect(applyResearchWorkflowTransition({ request: complete, gate, runtime, exports })).resolves.toBe('gated');
    await expect(applyResearchWorkflowTransition({ request: move, gate, runtime, exports })).resolves.toBe('moved');
    expect(gate.complete).toHaveBeenCalledWith(complete);
    expect(runtime.transition).toHaveBeenCalledWith(move);
    expect(exports.projectChanged).toHaveBeenCalledTimes(2);
  });

  it('shuts each service down once and keeps every failure', async () => {
    const experiments = { shutdown: vi.fn(async () => undefined) };
    const figures = { shutdown: vi.fn(async () => { throw new Error('research_figure_shutdown_failed'); }) };
    const idle = { productionInputs: null, exports: null, indexer: null, embeddings: null, stageRuntime: null, templates: null, documents: null, library: null };
    await expect(shutdownResearchPlugin({ ...idle, experiments, figures })).rejects.toThrow(AggregateError);
    expect(experiments.shutdown).toHaveBeenCalledTimes(1);
    expect(figures.shutdown).toHaveBeenCalledTimes(1);
  });
});
