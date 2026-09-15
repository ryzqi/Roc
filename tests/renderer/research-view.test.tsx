// @vitest-environment jsdom
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ResearchView } from '../../src/renderer/views/research/ResearchView';
import { createLoadedState } from './view-test-helpers';
import type { ResearchArtifact, ResearchClaim, ResearchDocument, ResearchDocumentParse, ResearchEvidence, ResearchExperimentExecution, ResearchExportExecution, ResearchFigurePublication, ResearchIdeaCanvas, ResearchIndexStatus, ResearchLibraryItem, ResearchLiterature, ResearchManuscript, ResearchProject, ResearchStageRun, ResearchTemplate, ResearchWorkflowEvent, ResearchWorkflowSnapshot } from '../../src/shared/types';

let container: HTMLDivElement;
let root: ReturnType<typeof createRoot>;

describe('ResearchView project dashboard', () => {
  beforeEach(() => {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => { root.unmount(); });
    container.remove();
  });

  it('shows the pipeline, next action, timeline and review decision', async () => {
    const api = createResearchApi();
    await renderView(api);
    expect(text('research-current-stage')).toBe('写作');
    expect(text('research-next-action')).toContain('审核当前产物');
    expect(text('research-timeline')).toContain('阶段产物等待用户审核。');
    expect(text('research-artifacts')).toContain('Results');
    expect(text('research-index-phase')).toBe('空闲');
    expect(text('research-index-counts')).toContain('已就绪 2');
    await click('research-approve');
    expect(api.transitionWorkflow).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve' }));
  });

  it('pauses and rebuilds the project index from the dashboard', async () => {
    const api = createResearchApi();
    api.controlIndex.mockResolvedValueOnce({ ok: true, data: indexStatus({ phase: 'queued' }) });
    api.controlIndex.mockResolvedValueOnce({ ok: true, data: indexStatus({ phase: 'paused', paused: true }) });
    await renderView(api);
    await click('research-index-rebuild');
    expect(api.controlIndex).toHaveBeenCalledWith({ projectId: 'research_1', action: 'rebuild', expectedRevision: 1 });
    await click('research-index-pause');
    expect(api.controlIndex).toHaveBeenCalledWith({ projectId: 'research_1', action: 'pause', expectedRevision: 1 });
    expect(text('research-index-phase')).toBe('已暂停');
  });

  it('captures a knowledge hit as project evidence', async () => {
    const captured: ResearchEvidence = {
      id: 'evidence_1', projectId: 'research_1', documentId: 'doc_1', chunkId: 'chunk_1',
      sourceType: 'file', sourceId: 'note.md', sourceVersion: 'a'.repeat(64), title: 'Measured note',
      locator: 'lines 1-1', excerpt: 'Measured result: 42 units.', contentHash: 'b'.repeat(64),
      createdAt: '2026-09-14T01:00:00.000Z'
    };
    const api = createResearchApi();
    api.searchKnowledge.mockResolvedValue({
      ok: true,
      data: {
        query: 'Measured', hits: [{
          chunkId: captured.chunkId, documentId: captured.documentId, title: captured.title, content: captured.excerpt,
          locator: captured.locator, sourceType: captured.sourceType, sourceId: captured.sourceId, keywordRank: 1, vectorRank: null, rrfScore: 0.5
        }], keywordCount: 1, vectorCount: 0, embeddingModel: null, generatedAt: captured.createdAt
      }
    });
    api.captureEvidence.mockResolvedValue({ ok: true, data: captured });
    api.listEvidence.mockResolvedValueOnce({ ok: true, data: [] }).mockResolvedValue({ ok: true, data: [captured] });
    await renderView(api);
    await clickTab('知识库');
    setInput('research-knowledge-query', 'Measured');
    await click('research-knowledge-search');
    await click(`research-evidence-capture-${captured.chunkId}`);
    expect(api.captureEvidence).toHaveBeenCalledWith({ projectId: 'research_1', chunkId: captured.chunkId });
    expect(text('research-evidence-list')).toContain('Measured result: 42 units.');
  });

  it('creates a supported claim and saves the manuscript latex', async () => {
    const evidenceItem: ResearchEvidence = {
      id: 'evidence_1', projectId: 'research_1', documentId: 'doc_1', chunkId: 'chunk_1',
      sourceType: 'file', sourceId: 'note.md', sourceVersion: 'a'.repeat(64), title: 'Measured note',
      locator: 'lines 1-1', excerpt: 'Measured result: 42 units.', contentHash: 'b'.repeat(64),
      createdAt: '2026-09-14T01:00:00.000Z'
    };
    const manuscriptArtifact = { ...artifact(), title: 'Manuscript' };
    const claim: ResearchClaim = {
      id: 'claim_1', projectId: 'research_1', artifactId: manuscriptArtifact.id, subjectType: 'paragraph',
      content: 'The measured result is 42 units.', status: 'supported', evidenceIds: [evidenceItem.id],
      version: 1, createdAt: evidenceItem.createdAt, updatedAt: evidenceItem.createdAt
    };
    const saved: ResearchManuscript = {
      artifactId: manuscriptArtifact.id, projectId: 'research_1',
      sections: [{ title: 'Results', claimIds: [claim.id] }],
      latex: '\\section{Results}\nThe measured result is 42 units.',
      contentHash: 'c'.repeat(64), claimsHash: 'd'.repeat(64), updatedAt: evidenceItem.createdAt
    };
    const api = createResearchApi({
      workflow: workflow({ stage: 'writing', status: 'running', gateRequired: true, artifactIds: [] }),
      artifacts: [],
      events: [event('stage_started', '阶段已开始。')]
    });
    api.listEvidence.mockResolvedValue({ ok: true, data: [evidenceItem] });
    api.createArtifact.mockResolvedValue({ ok: true, data: manuscriptArtifact });
    api.listArtifacts.mockResolvedValue({ ok: true, data: [manuscriptArtifact] });
    api.createClaim.mockResolvedValue({ ok: true, data: claim });
    api.listClaims.mockResolvedValue({ ok: true, data: [claim] });
    api.getManuscript.mockResolvedValue({ ok: true, data: null });
    api.saveManuscript.mockResolvedValue({ ok: true, data: saved });
    await renderView(api);
    await clickTab('正文');
    await click('research-manuscript-create');
    expect(api.createArtifact).toHaveBeenCalledWith(expect.objectContaining({ stage: 'writing', kind: 'manuscript' }));
    setArea('research-claim-content', claim.content);
    const status = document.querySelector<HTMLSelectElement>('[data-testid="research-claim-status"]');
    expect(status).not.toBeNull();
    await act(async () => {
      status!.value = 'supported';
      status!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    const evidenceSelect = document.querySelector<HTMLSelectElement>('[data-testid="research-claim-evidence"]');
    expect(evidenceSelect).not.toBeNull();
    await act(async () => {
      Array.from(evidenceSelect!.options).forEach((option) => { option.selected = option.value === evidenceItem.id; });
      evidenceSelect!.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await click('research-claim-create');
    expect(api.createClaim).toHaveBeenCalledWith(expect.objectContaining({
      artifactId: manuscriptArtifact.id, content: claim.content, status: 'supported', evidenceIds: [evidenceItem.id]
    }));
    await act(async () => {
      document.querySelector<HTMLInputElement>(`[data-testid="research-claim-toggle-${claim.id}"]`)?.click();
    });
    await click('research-manuscript-save');
    expect(api.saveManuscript).toHaveBeenCalledWith({
      artifactId: manuscriptArtifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }]
    });
    expect(text('research-manuscript-latex')).toContain('The measured result is 42 units.');
  });

  it('requires an explicit review accept or revise decision', async () => {
    const snapshot = workflow({ stage: 'review', status: 'waiting_approval', gateRequired: true, artifactIds: ['artifact_1'] });
    const api = createResearchApi({ workflow: snapshot });
    await renderView(api);
    expect(text('research-current-stage')).toBe('审稿');
    await click('research-review-accept');
    expect(api.transitionWorkflow).toHaveBeenCalledWith(expect.objectContaining({ action: 'approve', reviewDecision: 'accept', expectedStage: 'review' }));
  });

  it('imports a search hit into the library and opens parsed reader text', async () => {
    const record: ResearchLiterature = {
      id: 'openalex:1', source: 'openalex', externalId: '1', doi: '10.1234/paper', title: 'Measured study',
      authors: ['Jane Doe'], abstract: 'Measured improvement.', publishedYear: 2026, citationCount: 1,
      url: null, openAccessUrl: null, importedAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z'
    };
    const item: ResearchLibraryItem = {
      id: 'lib_1', metadata: record, bibliography: { citationKey: 'doe2026', entryType: 'article', fields: { title: record.title }, preambles: [], csl: null,
        title: record.title, authors: record.authors, doi: record.doi, publishedYear: 2026, abstract: record.abstract, url: null },
      sources: [], projectIds: ['research_1'], revision: 1, archived: false, createdAt: record.importedAt, updatedAt: record.updatedAt
    };
    const document: ResearchDocument = {
      id: 'doc_1', libraryItemId: item.id, filename: 'paper.pdf', mediaType: 'application/pdf', sourceHash: 'a'.repeat(64),
      size: 12, status: 'ready', currentParseId: 'parse_1', activeParseId: null, error: null, createdAt: record.importedAt, updatedAt: record.updatedAt
    };
    const parse: ResearchDocumentParse = {
      run: { id: 'parse_1', documentId: 'doc_1', status: 'ready', error: null, createdAt: record.importedAt, finishedAt: record.updatedAt },
      content: { sourceHash: document.sourceHash, parserVersion: 'roc-pdf-1', pageCount: 1, content: 'Measured improvement.', warnings: [],
        assets: [], blocks: [{ id: 'b1', kind: 'paragraph', label: 'Body', text: 'Measured improvement.', locator: 'page 1', imageAssetId: null, locations: [] }] }
    };
    const api = createResearchApi();
    api.searchLiterature.mockResolvedValue({ ok: true, data: [record] });
    api.listLibrary.mockResolvedValue({ ok: true, data: [item] });
    api.importLibraryRecord.mockResolvedValue({ ok: true, data: { items: [item], createdCount: 1, duplicateCount: 0 } });
    api.listDocuments.mockResolvedValue({ ok: true, data: [document] });
    api.getDocumentContent.mockResolvedValue({ ok: true, data: parse });
    await renderView(api);
    await clickTab('文献库');
    setInput('research-library-query', 'evidence graph');
    await clickSubmit('research-library-panel');
    expect(api.searchLiterature).toHaveBeenCalled();
    const importButton = Array.from(documentButtons()).find((button) => button.textContent?.includes('导入文献库'));
    expect(importButton).not.toBeUndefined();
    await act(async () => { importButton?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
    await act(async () => { await Promise.resolve(); });
    expect(api.importLibraryRecord).toHaveBeenCalled();
    await click(`research-library-open-${item.id}`);
    expect(text('research-reader-content')).toContain('Measured improvement.');
  });

  it('imports a PDF attachment into the open library item and shows parsed text', async () => {
    const record: ResearchLiterature = {
      id: 'openalex:1', source: 'openalex', externalId: '1', doi: '10.1234/paper', title: 'Measured study',
      authors: ['Jane Doe'], abstract: 'Measured improvement.', publishedYear: 2026, citationCount: 1,
      url: null, openAccessUrl: null, importedAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z'
    };
    const item: ResearchLibraryItem = {
      id: 'lib_1', metadata: record, bibliography: { citationKey: 'doe2026', entryType: 'article', fields: { title: record.title }, preambles: [], csl: null,
        title: record.title, authors: record.authors, doi: record.doi, publishedYear: 2026, abstract: record.abstract, url: null },
      sources: [], projectIds: ['research_1'], revision: 1, archived: false, createdAt: record.importedAt, updatedAt: record.updatedAt
    };
    const imported: ResearchDocument = {
      id: 'doc_1', libraryItemId: item.id, filename: 'paper.pdf', mediaType: 'application/pdf', sourceHash: 'a'.repeat(64),
      size: 12, status: 'imported', currentParseId: null, activeParseId: null, error: null, createdAt: record.importedAt, updatedAt: record.updatedAt
    };
    const ready: ResearchDocument = { ...imported, status: 'ready', currentParseId: 'parse_1' };
    const parse: ResearchDocumentParse = {
      run: { id: 'parse_1', documentId: 'doc_1', status: 'ready', error: null, createdAt: record.importedAt, finishedAt: record.updatedAt },
      content: { sourceHash: imported.sourceHash, parserVersion: 'roc-pdf-1', pageCount: 1, content: 'Measured improvement.', warnings: [],
        assets: [], blocks: [{ id: 'b1', kind: 'paragraph', label: 'Body', text: 'Measured improvement.', locator: 'page 1', imageAssetId: null, locations: [] }] }
    };
    const api = createResearchApi();
    api.listLibrary.mockResolvedValue({ ok: true, data: [item] });
    api.listDocuments.mockResolvedValueOnce({ ok: true, data: [] }).mockResolvedValue({ ok: true, data: [ready] });
    api.importDocument.mockResolvedValue({ ok: true, data: imported });
    api.parseDocument.mockResolvedValue({ ok: true, data: ready });
    api.getDocumentContent.mockResolvedValue({ ok: true, data: parse });
    const files = { selectFromDialog: vi.fn().mockResolvedValue({ ok: true, data: { filePaths: ['/tmp/paper.pdf'] } }) };
    await renderView(api, files);
    await clickTab('文献库');
    await click(`research-library-open-${item.id}`);
    await click('research-document-import');
    expect(api.importDocument).toHaveBeenCalledWith({ target: 'library-item', sourcePath: '/tmp/paper.pdf', libraryItemId: item.id, projectId: 'research_1' });
    expect(api.parseDocument).toHaveBeenCalledWith({ documentId: imported.id });
    expect(text('research-reader-content')).toContain('Measured improvement.');
  });

  it('imports a bibliography file and exports the selected records', async () => {
    const record: ResearchLiterature = {
      id: 'local:1', source: 'local', externalId: '1', doi: '10.1234/paper', title: 'Measured study',
      authors: ['Jane Doe'], abstract: 'Measured improvement.', publishedYear: 2026, citationCount: 1,
      url: null, openAccessUrl: null, importedAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z'
    };
    const item: ResearchLibraryItem = {
      id: 'lib_1', metadata: record, bibliography: { citationKey: 'doe2026', entryType: 'article', fields: { title: record.title }, preambles: [], csl: null,
        title: record.title, authors: record.authors, doi: record.doi, publishedYear: 2026, abstract: record.abstract, url: null },
      sources: [], projectIds: ['research_1'], revision: 1, archived: false, createdAt: record.importedAt, updatedAt: record.updatedAt
    };
    const api = createResearchApi();
    api.importBibliography.mockResolvedValue({ ok: true, data: { items: [item], createdCount: 1, duplicateCount: 0 } });
    api.listLibrary.mockResolvedValue({ ok: true, data: [item] });
    api.exportBibliography.mockResolvedValue({ ok: true, data: { format: 'bibtex', filename: 'library.bib', content: '@article{doe2026,title={Measured study}}' } });
    const files = { selectFromDialog: vi.fn().mockResolvedValue({ ok: true, data: { filePaths: ['/tmp/library.bib'] } }) };
    await renderView(api, files);
    await clickTab('文献库');
    await click('research-library-import-file');
    expect(api.importBibliography).toHaveBeenCalledWith({ sourcePath: '/tmp/library.bib', format: 'bibtex', projectId: 'research_1' });
    const checkbox = document.querySelector<HTMLInputElement>('[data-testid="research-library-select-lib_1"]');
    expect(checkbox).not.toBeNull();
    await act(async () => { checkbox?.click(); });
    await click('research-library-export');
    expect(api.exportBibliography).toHaveBeenCalledWith({ ids: ['lib_1'], format: 'bibtex' });
    expect(text('research-library-export-preview')).toContain('@article{doe2026,title={Measured study}}');
  });

  it('saves an idea canvas and promotes the approved version', async () => {
    const ideaArtifact = { ...artifact(), kind: 'idea_canvas' as const, title: 'Canvas', stage: 'ideation' as const, status: 'approved' as const };
    const canvas: ResearchIdeaCanvas = {
      artifactId: ideaArtifact.id, projectId: 'research_1', version: 1, problem: 'How to keep graphs inspectable?', hypothesis: 'Structured canvases help.',
      novelty: 'Promotion keeps versions.', supportingEvidence: 'Prior work lacks records.', counterevidence: '', experiment: 'Promote and inspect origin.',
      risks: 'Stale duplicates.', priority: 'high', rationale: 'Testable path.', contentHash: 'b'.repeat(64),
      createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T00:00:00.000Z',
      fields: [
        { key: 'problem', content: 'How to keep graphs inspectable?', status: 'pending', evidenceIds: [] },
        { key: 'hypothesis', content: 'Structured canvases help.', status: 'hypothesis', evidenceIds: [] },
        { key: 'novelty', content: 'Promotion keeps versions.', status: 'pending', evidenceIds: [] },
        { key: 'supportingEvidence', content: 'Prior work lacks records.', status: 'pending', evidenceIds: [] },
        { key: 'counterevidence', content: '', status: 'pending', evidenceIds: [] },
        { key: 'experiment', content: 'Promote and inspect origin.', status: 'hypothesis', evidenceIds: [] },
        { key: 'risks', content: 'Stale duplicates.', status: 'pending', evidenceIds: [] }
      ]
    };
    const api = createResearchApi({ artifacts: [ideaArtifact] });
    api.getIdeaCanvas.mockResolvedValue({ ok: true, data: canvas });
    api.saveIdeaCanvas.mockResolvedValue({ ok: true, data: { ...canvas, version: 2, rationale: 'Updated ranking.' } });
    api.promoteIdeaCanvas.mockResolvedValue({ ok: true, data: { canvas, project: { id: 'research_2', title: 'Promoted', description: canvas.problem, workspacePath: null, status: 'active', language: 'zh', origin: { projectId: 'research_1', artifactId: ideaArtifact.id, version: 1 }, currentStage: 'discovery', createdAt: canvas.createdAt, updatedAt: canvas.updatedAt } } });
    await renderView(api);
    await clickTab('构思');
    await clickSelectIdea();
    setArea('research-idea-rationale', 'Updated ranking.');
    await click('research-idea-save');
    expect(api.saveIdeaCanvas).toHaveBeenCalled();
    await click('research-idea-promote');
    expect(api.promoteIdeaCanvas).toHaveBeenCalledWith({ artifactId: ideaArtifact.id, expectedVersion: 2 });
  });

  it('prepares an export from approved manuscript and figures then saves the zip', async () => {
    const manuscript = { ...artifact(), status: 'approved' as const };
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
    const api = createResearchApi({ artifacts: [manuscript] });
    api.listFigures.mockResolvedValue({ ok: true, data: [figure] });
    api.listExports.mockResolvedValueOnce({ ok: true, data: [] }).mockResolvedValue({ ok: true, data: [{ ...prepared, approval: 'approved' }] });
    api.prepareExport.mockResolvedValue({ ok: true, data: prepared });
    api.publishExport.mockResolvedValue({ ok: true, data: { ...prepared, approval: 'draft' } });
    api.writeExport.mockResolvedValue({ ok: true, data: { exportId: prepared.id, projectId: 'research_1', destinationPath: '/tmp/study.zip', sha256: '4'.repeat(64), size: 20, createdAt: prepared.createdAt } });
    await renderView(api);
    await clickTab('图稿导出');
    await act(async () => { await Promise.resolve(); });
    const checkbox = document.querySelector<HTMLInputElement>('[data-testid="research-figure-toggle-figure_1"]');
    expect(checkbox).not.toBeNull();
    await act(async () => { checkbox?.click(); });
    setInput('research-export-title', 'Verified study');
    await click('research-export-prepare');
    expect(api.prepareExport).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'research_1', title: 'Verified study', manuscriptArtifactId: manuscript.id, figureIds: [figure.id]
    }));
    await act(async () => { await Promise.resolve(); });
    setInput('research-export-destination-export_1', '/tmp/study.zip');
    await click('research-export-write-export_1');
    expect(api.writeExport).toHaveBeenCalledWith({ projectId: 'research_1', exportId: 'export_1', destinationPath: '/tmp/study.zip' });
  });

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
    const api = createResearchApi();
    api.inspectExperimentEnvironment.mockResolvedValue({ ok: true, data: execution.environment });
    api.startExperiment.mockResolvedValue({ ok: true, data: execution });
    api.listExperiments.mockResolvedValue({ ok: true, data: [execution] });
    await renderView(api);
    await clickTab('实验');
    setInput('research-experiment-label', 'Measure signal');
    setInput('research-experiment-source', 'run.py');
    setInput('research-experiment-inputs', 'data.csv');
    await click('research-experiment-start');
    expect(api.inspectExperimentEnvironment).toHaveBeenCalledWith({ projectId: 'research_1', runtime: { kind: 'bundled-python' } });
    expect(api.startExperiment).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'research_1', label: 'Measure signal', engine: 'python', sourcePath: 'run.py', inputPaths: ['data.csv'],
      expectedEnvironmentHash: 'd'.repeat(64), network: 'disabled'
    }));
    expect(text('research-experiment-list')).toContain('Measure signal');
  });

  it('imports a template, edits the entry, and compiles a preview', async () => {
    const template: ResearchTemplate = {
      id: 'template_1', projectId: 'research_1', rootPath: '/tmp/template', entryPath: 'main.tex', status: 'imported',
      pdfPath: null, errors: [], diagnostics: [], revision: 1, compiledRevision: null, sourceDigest: 'a'.repeat(64),
      compiledDigest: null, pdfHash: null, activeCompileId: null, lastCompiledAt: null, updatedAt: '2026-09-14T01:00:00.000Z'
    };
    const ready = { ...template, status: 'ready' as const, pdfPath: '/tmp/template.pdf', pdfHash: 'b'.repeat(64), compiledRevision: 2, compiledDigest: 'a'.repeat(64) };
    const api = createResearchApi();
    api.listTemplates.mockResolvedValueOnce({ ok: true, data: [] }).mockResolvedValue({ ok: true, data: [ready] });
    api.getTemplateFiles.mockResolvedValue({ ok: true, data: [{ path: 'main.tex', size: 12, sha256: 'c'.repeat(64), editable: true }] });
    api.importTemplate.mockResolvedValue({ ok: true, data: template });
    api.readTemplateFile.mockResolvedValue({ ok: true, data: { path: 'main.tex', size: 12, sha256: 'c'.repeat(64), editable: true, content: '\\documentclass{article}' } });
    api.saveTemplateFile.mockResolvedValue({ ok: true, data: { path: 'main.tex', size: 13, sha256: 'd'.repeat(64), editable: true, content: '\\documentclass{article}\nHello' } });
    api.compileTemplate.mockResolvedValue({ ok: true, data: ready });
    const files = { selectFromDialog: vi.fn().mockResolvedValue({ ok: true, data: { filePaths: ['/tmp/source'] } }) };
    await renderView(api, files);
    await clickTab('文稿');
    await click('research-template-import');
    expect(api.importTemplate).toHaveBeenCalledWith({ projectId: 'research_1', sourcePath: '/tmp/source' });
    await clickFile('main.tex');
    setArea('research-template-editor', '\\documentclass{article}\nHello');
    await click('research-template-save');
    expect(api.saveTemplateFile).toHaveBeenCalled();
    await click('research-template-compile');
    expect(api.compileTemplate).toHaveBeenCalledWith({ projectId: 'research_1', templateId: 'template_1' });
    expect(document.querySelector('[data-testid="research-template-preview"]')).not.toBeNull();
  });

  it('starts a stage role with the typed instruction', async () => {
    const api = createResearchApi({
      workflow: workflow({ status: 'running', gateRequired: false, artifactIds: [] }),
      events: [event('stage_started', '阶段已开始。')],
      artifacts: []
    });
    await renderView(api);
    setValue('research-run-input', '写出可追溯的检索策略。');
    await click('research-start-run');
    expect(api.startStageRun).toHaveBeenCalledWith(expect.objectContaining({
      projectId: 'research_1', expectedStage: 'writing', instruction: '写出可追溯的检索策略。'
    }));
  });
});

function createResearchApi(overrides: {
  workflow?: ResearchWorkflowSnapshot;
  events?: ResearchWorkflowEvent[];
  runs?: ResearchStageRun[];
  artifacts?: ResearchArtifact[];
} = {}) {
  const project: ResearchProject = {
    id: 'research_1', title: '证据图', description: '把想法变成可追溯项目。', workspacePath: null,
    status: 'active', language: 'zh', origin: null, currentStage: 'writing',
    createdAt: '2026-09-14T00:00:00.000Z', updatedAt: '2026-09-14T01:00:00.000Z'
  };
  return {
    listProjects: vi.fn().mockResolvedValue({ ok: true, data: [project] }),
    getWorkflow: vi.fn().mockResolvedValue({ ok: true, data: overrides.workflow ?? workflow() }),
    listWorkflowEvents: vi.fn().mockResolvedValue({ ok: true, data: overrides.events ?? [event('approval_requested', '阶段产物等待用户审核。')] }),
    listStageRuns: vi.fn().mockResolvedValue({ ok: true, data: overrides.runs ?? [] }),
    listArtifacts: vi.fn().mockResolvedValue({ ok: true, data: overrides.artifacts ?? [artifact()] }),
    transitionWorkflow: vi.fn().mockResolvedValue({ ok: true, data: workflow({ status: 'completed', gateApproved: true }) }),
    startStageRun: vi.fn().mockResolvedValue({ ok: true, data: run() }),
    cancelStageRun: vi.fn(),
    retryStageRun: vi.fn(),
    createProject: vi.fn(),
    searchLiterature: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    searchKnowledge: vi.fn(),
    captureEvidence: vi.fn(),
    createClaim: vi.fn(),
    listClaims: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    getManuscript: vi.fn().mockResolvedValue({ ok: true, data: null }),
    saveManuscript: vi.fn(),
    listEmbeddingConfigs: vi.fn(),
    saveEmbeddingConfig: vi.fn(),
    listLibrary: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    importLibraryDoi: vi.fn(),
    importLibraryRecord: vi.fn(),
    importBibliography: vi.fn(),
    exportBibliography: vi.fn(),
    linkLibraryItem: vi.fn(),
    listDocuments: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    importDocument: vi.fn(),
    parseDocument: vi.fn(),
    getDocumentContent: vi.fn(),
    listEvidence: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    getIndexStatus: vi.fn().mockResolvedValue({ ok: true, data: indexStatus() }),
    controlIndex: vi.fn(),
    getIdeaCanvas: vi.fn().mockResolvedValue({ ok: true, data: null }),
    saveIdeaCanvas: vi.fn(),
    promoteIdeaCanvas: vi.fn(),
    createArtifact: vi.fn(),
    listFigures: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listExports: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    listExperiments: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    inspectExperimentEnvironment: vi.fn(),
    startExperiment: vi.fn(),
    getExperiment: vi.fn(),
    cancelExperiment: vi.fn(),
    publishExperiment: vi.fn(),
    publishFigure: vi.fn(),
    readExperimentFile: vi.fn(),
    prepareExport: vi.fn(),
    publishExport: vi.fn(),
    writeExport: vi.fn(),
    listTemplates: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    getTemplateFiles: vi.fn().mockResolvedValue({ ok: true, data: [] }),
    importTemplate: vi.fn(),
    readTemplateFile: vi.fn(),
    saveTemplateFile: vi.fn(),
    compileTemplate: vi.fn()
  };
}

function workflow(stage: Partial<ResearchWorkflowSnapshot['stages'][number]> = {}): ResearchWorkflowSnapshot {
  const names = ['discovery', 'retrieval', 'reading', 'ideation', 'planning', 'experiment', 'figure', 'writing', 'review', 'revision', 'export'] as const;
  const current = {
    stage: 'writing' as const, status: 'waiting_approval' as const, activeRunId: null, artifactIds: ['artifact_1'],
    enteredAt: '2026-09-14T00:30:00.000Z', completedAt: null, gateRequired: true, gateApproved: false, lastError: null, ...stage
  };
  return {
    projectId: 'research_1', currentStage: current.stage, projectStatus: 'active',
    stages: names.map((name, index) => name === current.stage ? current : {
      stage: name, status: index < names.indexOf(current.stage) ? 'completed' as const : 'locked' as const,
      activeRunId: null, artifactIds: [], enteredAt: index < names.indexOf(current.stage) ? '2026-09-14T00:00:00.000Z' : null,
      completedAt: index < names.indexOf(current.stage) ? '2026-09-14T00:10:00.000Z' : null,
      gateRequired: name !== 'discovery', gateApproved: false, lastError: null
    }),
    lastEvent: { type: 'approval_requested', stage: current.stage, message: '阶段产物等待用户审核。', createdAt: '2026-09-14T01:00:00.000Z' }
  };
}

function event(type: string, message: string): ResearchWorkflowEvent {
  return { id: `event_${type}`, projectId: 'research_1', stage: 'writing', type, message, payload: {}, createdAt: '2026-09-14T01:00:00.000Z' };
}

function artifact(): ResearchArtifact {
  return { id: 'artifact_1', projectId: 'research_1', stage: 'writing', kind: 'manuscript', title: 'Results', path: null, status: 'draft', createdAt: '2026-09-14T00:40:00.000Z', updatedAt: '2026-09-14T00:50:00.000Z' };
}

function run(): ResearchStageRun {
  return {
    id: 'run_1', projectId: 'research_1', stage: 'writing', requestId: 'req_1', parentRunId: null, retryOfRunId: null,
    reviewCycleId: null, revisionRound: 0, role: 'academic-writing-agent', outputKind: 'manuscript', status: 'queued',
    instruction: '写出可追溯的检索策略。', skillIds: ['roc-academic-writing'], skillHash: 'a'.repeat(64), toolNames: [],
    inputArtifactIds: [], outputArtifactIds: [], policy: { projectId: 'research_1', stage: 'writing', tier: 'deep', model: { kind: 'app_default' }, maxSteps: 30, timeoutMs: 180000 },
    providerId: null, modelId: null, modelVersion: null, error: null, createdAt: '2026-09-14T01:10:00.000Z', startedAt: null, endedAt: null
  };
}

async function renderView(research: ReturnType<typeof createResearchApi>, files?: { selectFromDialog: ReturnType<typeof vi.fn> }): Promise<void> {
  await act(async () => {
    root.render(React.createElement(ResearchView, {
      client: { api: { research, files: files ?? { selectFromDialog: vi.fn() } } as never },
      state: createLoadedState({ workspace: { id: 'ws', path: '/tmp/roc', label: 'Roc' } as never })
    }));
  });
  await act(async () => { await Promise.resolve(); });
}

function text(testId: string): string {
  const node = document.querySelector(`[data-testid="${testId}"]`);
  expect(node).not.toBeNull();
  return node?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
}

async function click(testId: string): Promise<void> {
  const button = document.querySelector<HTMLButtonElement>(`[data-testid="${testId}"]`);
  expect(button).not.toBeNull();
  await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}

function setValue(testId: string, value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  expect(textarea).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea?.dispatchEvent(new Event('input', { bubbles: true }));
}

async function clickTab(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('button')).find((node) => node.textContent?.trim() === label);
  expect(button).not.toBeUndefined();
  await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}

async function clickSubmit(testId: string): Promise<void> {
  const form = document.querySelector(`[data-testid="${testId}"] form`);
  expect(form).not.toBeNull();
  await act(async () => { form?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })); });
  await act(async () => { await Promise.resolve(); });
}

function setInput(testId: string, value: string): void {
  const input = document.querySelector<HTMLInputElement>(`[data-testid="${testId}"]`);
  expect(input).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value')?.set;
  setter?.call(input, value);
  input?.dispatchEvent(new Event('input', { bubbles: true }));
}

function documentButtons(): HTMLButtonElement[] {
  return Array.from(document.querySelectorAll('button'));
}

async function clickSelectIdea(): Promise<void> {
  const button = document.querySelector('[data-testid="research-idea-list"] button');
  expect(button).not.toBeNull();
  await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}

function setArea(testId: string, value: string): void {
  const textarea = document.querySelector<HTMLTextAreaElement>(`[data-testid="${testId}"]`);
  expect(textarea).not.toBeNull();
  const setter = Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value')?.set;
  setter?.call(textarea, value);
  textarea?.dispatchEvent(new Event('input', { bubbles: true }));
}

async function clickFile(label: string): Promise<void> {
  const button = Array.from(document.querySelectorAll('[data-testid="research-template-files"] button')).find((node) => node.textContent?.includes(label));
  expect(button).not.toBeUndefined();
  await act(async () => { button?.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
  await act(async () => { await Promise.resolve(); });
}

function indexStatus(overrides: Partial<ResearchIndexStatus> & { paused?: boolean; phase?: ResearchIndexStatus['phase'] } = {}): ResearchIndexStatus {
  const phase = overrides.phase ?? 'idle';
  const paused = overrides.paused ?? false;
  return {
    settings: {
      projectId: 'research_1', revision: paused ? 2 : 1, kinds: ['markdown', 'latex', 'bibliography', 'csv', 'pdf', 'image'],
      include: ['**/*'], exclude: ['**/node_modules/**'], watch: true, paused, embeddingConfigId: null
    },
    generation: 1, workspacePath: '/tmp/roc', phase, error: null, lastScanAt: '2026-09-14T01:00:00.000Z',
    counts: { total: 2, queued: 0, running: 0, ready: 2, failed: 0 },
    ...overrides
  };
}
