import { describe, expect, it, vi } from 'vitest';

import { createResearchProductionProjection } from '../../src/renderer/views/research/research-production';
import type { ResearchArtifact, ResearchExportExecution, ResearchFigurePublication } from '../../src/shared/types';

describe('research production projection', () => {
  it('prepares an export from approved manuscript and figures then writes the zip', async () => {
    const manuscript: ResearchArtifact = {
      id: 'artifact_1', projectId: 'research_1', stage: 'writing', kind: 'manuscript', title: 'Results',
      path: null, status: 'approved', createdAt: '2026-09-14T00:40:00.000Z', updatedAt: '2026-09-14T00:50:00.000Z'
    };
    const figure: ResearchFigurePublication = {
      id: 'figure_1', projectId: 'research_1', runId: 'exp_1', artifactId: 'figure_artifact', title: 'Comparison',
      sourcePath: 'plot.py', inputPaths: ['data.csv'], replacesFigureId: null,
      validation: { widthPixels: 600, heightPixels: 450, widthPoints: 288, heightPoints: 216, pageCount: 1,
        files: [
          { path: 'figure.png', sha256: 'c'.repeat(64), size: 10 },
          { path: 'figure.svg', sha256: 'd'.repeat(64), size: 11 },
          { path: 'figure.pdf', sha256: 'e'.repeat(64), size: 12 }
        ], rendererHash: 'f'.repeat(64), options: { widthInches: 4, heightInches: 3, dpi: 150, seed: 1 } },
      manifestHash: '1'.repeat(64), status: 'approved', createdAt: '2026-09-14T01:00:00.000Z'
    };
    const prepared: ResearchExportExecution = {
      id: 'export_1', projectId: 'research_1',
      request: { projectId: 'research_1', requestId: 'req_export', title: 'Verified study', manuscriptArtifactId: manuscript.id, figureIds: [figure.id], template: { kind: 'default', language: 'zh' } },
      ownerRunId: null, status: 'ready', sources: null, sourceHash: '2'.repeat(64), toolchainHash: '3'.repeat(64),
      files: [], archive: { path: 'paper.zip', sha256: '4'.repeat(64), size: 20 }, artifactId: 'export_artifact',
      approval: 'unpublished', replacesExportId: null, error: null, createdAt: '2026-09-14T02:00:00.000Z', endedAt: '2026-09-14T02:01:00.000Z'
    };
    const adapter = {
      listFigures: vi.fn(async () => [figure]),
      listExports: vi.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValue([{ ...prepared, approval: 'approved' }]),
      prepare: vi.fn(async () => prepared),
      publish: vi.fn(),
      write: vi.fn()
    };
    const projection = createResearchProductionProjection(adapter, {
      projectId: () => 'research_1',
      language: () => 'zh',
      approvedManuscript: () => manuscript
    }, { createId: () => 'req_export' });
    projection.setProject('research_1');
    await projection.load();
    projection.toggleFigure(figure.id);
    projection.setTitle('Verified study');
    await projection.prepare();
    expect(adapter.prepare).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'research_1', title: 'Verified study', manuscriptArtifactId: manuscript.id, figureIds: [figure.id]
    }));
    projection.setDestination('/tmp/study.zip');
    await projection.write('export_1');
    expect(adapter.write).toHaveBeenCalledWith({ projectId: 'research_1', exportId: 'export_1', destinationPath: '/tmp/study.zip' });
  });
});
