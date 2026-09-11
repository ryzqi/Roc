import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { z } from 'zod';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { applyResearchDatabaseSchema } from '../../../../src/main/infrastructure/database-schemas';
import { createPluginCapabilityAdapter } from '../../../../src/main/ipc/plugin-capability-adapter';
import { CapabilityRegistry } from '../../../../src/main/kernel/capability-registry';
import { createResearchPlugin } from '../../../../src/main/plugins/research';
import { researchArtifactSchema, researchProjectSchema, researchTemplateSchema, researchWorkflowSnapshotSchema } from '../../../../src/shared/schemas/research';
import { researchTemplateFileContentSchema, researchTemplateFileSchema } from '../../../../src/shared/schemas/research-production';
import { researchClaimSchema, researchEvidenceSchema, researchExportBundleSchema, researchManuscriptSchema } from '../../../../src/shared/schemas/research-evidence';

let db: Database.Database;
let plugin: ReturnType<typeof createResearchPlugin>;
let adapter: ReturnType<typeof createPluginCapabilityAdapter>;

beforeEach(async () => {
  db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  applyResearchDatabaseSchema(db);
  plugin = createResearchPlugin();
  const capabilities = new CapabilityRegistry();
  for (const capability of plugin.manifest.capabilities) capabilities.declare(plugin.manifest.id, capability);
  await plugin.initialize({
    pluginId: plugin.manifest.id, capabilities, database: { getConnection: () => db },
    eventBus: { publish: async () => {}, subscribe: () => () => {} },
    config: { get: () => null, set: () => {} },
    secrets: { get: () => null, set: () => {}, clear: () => {} },
    logger: { info: () => {}, warn: () => {}, error: () => {} }
  });
  adapter = createPluginCapabilityAdapter({
    invokeCapability: <TInput, TOutput>(name: string, input: TInput) => capabilities.invoke<TInput, TOutput>(name, input)
  });
});

afterEach(async () => {
  await plugin.shutdown();
  db.close();
});

async function call<T>(method: string, input: unknown, schema: z.ZodType<T>): Promise<T> {
  const result = await adapter.invoke(`research.${method}`, [input]);
  if (!result.ok) throw new Error(result.error.message);
  return schema.parse(result.data);
}

describe('research plugin IPC integration', () => {
  it('routes template import, versioned editing and unavailable compiler state through IPC', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-template-ipc-')));
    try {
      const source = join(root, 'source');
      await mkdir(source);
      await writeFile(join(source, 'main.tex'), '\\documentclass{article}\nOriginal');
      const project = await call('createProject', { title: 'Templates', description: 'IPC template editing', workspacePath: root }, researchProjectSchema);
      const template = await call('importTemplate', { projectId: project.id, sourcePath: source }, researchTemplateSchema);
      const request = { projectId: project.id, templateId: template.id };
      expect(await call('listTemplates', { projectId: project.id }, researchTemplateSchema.array())).toHaveLength(1);
      expect(await call('getTemplateFiles', request, researchTemplateFileSchema.array())).toHaveLength(1);
      const file = await call('readTemplateFile', { ...request, path: 'main.tex' }, researchTemplateFileContentSchema);
      await call('saveTemplateFile', { ...request, path: file.path, content: '\\documentclass{article}\nChanged', expectedHash: file.sha256 }, researchTemplateFileContentSchema);
      expect((await call('getTemplate', request, researchTemplateSchema)).revision).toBe(2);
      expect((await adapter.invoke('research.saveTemplateFile', [{ ...request, path: file.path, content: 'stale', expectedHash: file.sha256 }])).ok).toBe(false);
      const compiled = await call('compileTemplate', request, researchTemplateSchema);
      expect(compiled).toMatchObject({ status: 'failed', activeCompileId: null, pdfPath: null, errors: ['research_toolchain_unavailable'] });
      const status = await adapter.invoke('research.getToolchainStatus', []);
      expect(status).toMatchObject({ ok: true, data: { available: false, error: 'research_toolchain_unavailable' } });
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('carries evidence through a gated manuscript to a validated export bundle', async () => {
    const project = await call('createProject', { title: 'IPC study', description: 'End-to-end provenance.', workspacePath: null }, researchProjectSchema);
    await call('transitionWorkflow', { projectId: project.id, expectedStage: 'discovery', action: 'move', targetStage: 'writing' }, researchWorkflowSnapshotSchema);
    await call('transitionWorkflow', { projectId: project.id, expectedStage: 'writing', action: 'start' }, researchWorkflowSnapshotSchema);
    const artifact = await call('createArtifact', { projectId: project.id, stage: 'writing', kind: 'manuscript', title: 'Results', path: null }, researchArtifactSchema);
    const indexed = await adapter.invoke('research.upsertKnowledgeDocument', [{
      id: 'source', projectId: project.id, sourceType: 'file', sourceId: 'data.csv', title: 'Measured data',
      content: 'Control: 2; treatment: 4.', chunks: [{ content: 'Control: 2; treatment: 4.', locator: 'rows 2-3' }], embeddingConfigId: null
    }]);
    expect(indexed.ok).toBe(true);
    const evidence = await call('captureEvidence', { projectId: project.id, chunkId: 'source:chunk:0' }, researchEvidenceSchema);
    const claim = await call('createClaim', { projectId: project.id, artifactId: artifact.id, subjectType: 'paragraph',
      content: 'Treatment exceeds control.', status: 'supported', evidenceIds: [evidence.id] }, researchClaimSchema);
    const manuscript = await call('saveManuscript', { artifactId: artifact.id, sections: [{ title: 'Results', claimIds: [claim.id] }] }, researchManuscriptSchema);
    await call('transitionWorkflow', { projectId: project.id, expectedStage: 'writing', action: 'complete' }, researchWorkflowSnapshotSchema);
    expect((await adapter.invoke('research.getExportBundle', [{ projectId: project.id, artifactId: artifact.id }])).ok).toBe(false);
    await call('transitionWorkflow', { projectId: project.id, expectedStage: 'writing', action: 'approve' }, researchWorkflowSnapshotSchema);
    const bundle = await call('getExportBundle', { projectId: project.id, artifactId: artifact.id }, researchExportBundleSchema);
    expect(bundle.manuscript).toEqual(manuscript);
    expect(bundle.evidence).toEqual([evidence]);
    expect(bundle.claims).toEqual([claim]);
  });

  it('rejects forged snapshot fields and direct artifact self-approval at the capability boundary', async () => {
    const project = await call('createProject', { title: 'Boundary', description: 'Reject forged input.', workspacePath: null }, researchProjectSchema);
    const artifact = await call('createArtifact', { projectId: project.id, stage: 'discovery', kind: 'search_strategy', title: 'Strategy', path: null }, researchArtifactSchema);
    expect((await adapter.invoke('research.updateArtifact', [{ id: artifact.id, status: 'approved' }])).ok).toBe(false);
    expect((await adapter.invoke('research.captureEvidence', [{ projectId: project.id, chunkId: 'forged', excerpt: 'Invented evidence.' }])).ok).toBe(false);
    expect((await call('getArtifact', { id: artifact.id }, researchArtifactSchema)).status).toBe('draft');
    expect(await call('listEvidence', { projectId: project.id }, researchEvidenceSchema.array())).toEqual([]);
  });
});
