import { describe, expect, it, vi } from 'vitest';

import { createResearchTemplateProjection } from '../../src/renderer/views/research/research-templates';
import type { ResearchTemplate } from '../../src/shared/types';

describe('research template projection', () => {
  it('imports a template, edits the entry, and compiles a preview', async () => {
    const template: ResearchTemplate = {
      id: 'template_1', projectId: 'research_1', rootPath: '/tmp/template', entryPath: 'main.tex', status: 'imported',
      pdfPath: null, errors: [], diagnostics: [], revision: 1, compiledRevision: null, sourceDigest: 'a'.repeat(64),
      compiledDigest: null, pdfHash: null, activeCompileId: null, lastCompiledAt: null, updatedAt: '2026-09-14T01:00:00.000Z'
    };
    const ready = { ...template, status: 'ready' as const, pdfPath: '/tmp/template.pdf', pdfHash: 'b'.repeat(64), compiledRevision: 2, compiledDigest: 'a'.repeat(64) };
    const adapter = {
      list: vi.fn(async () => [ready]),
      files: vi.fn(async () => [{ path: 'main.tex', size: 12, sha256: 'c'.repeat(64), editable: true }]),
      importTemplate: vi.fn(async () => template),
      readFile: vi.fn(async () => ({ path: 'main.tex', size: 12, sha256: 'c'.repeat(64), editable: true, content: '\\documentclass{article}' })),
      saveFile: vi.fn(async () => ({ path: 'main.tex', size: 13, sha256: 'd'.repeat(64), editable: true, content: '\\documentclass{article}\\nHello' })),
      compile: vi.fn(async () => ready),
      selectFile: vi.fn(async () => '/tmp/source')
    };
    const projection = createResearchTemplateProjection(adapter);
    projection.setProject('research_1');
    await projection.importTemplate();
    expect(adapter.importTemplate).toHaveBeenCalledWith({ projectId: 'research_1', sourcePath: '/tmp/source' });
    await projection.openFile('main.tex');
    projection.setOpenContent('\\documentclass{article}\\nHello');
    await projection.save();
    expect(adapter.saveFile).toHaveBeenCalled();
    await projection.compile();
    expect(adapter.compile).toHaveBeenCalledWith({ projectId: 'research_1', templateId: 'template_1' });
    expect(projection.getSnapshot().templates[0]?.status).toBe('ready');
  });
});
