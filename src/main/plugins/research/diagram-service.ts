import {AsyncLocalStorage} from 'node:async_hooks';
import {randomUUID} from 'node:crypto';
import {rm} from 'node:fs/promises';
import {join} from 'node:path';
import {diagramRendererVersion, diagramSourceLimit, validateDiagramSource} from '../../../shared/research-diagram-policy';
import type {ResearchDiagramRequest} from '../../../shared/schemas/research-diagrams';
import {researchDiagramResultSchema} from '../../../shared/schemas/research-diagrams';
import type {ResearchRepository} from './repository';
import {createResearchDirectory, readResearchFile, researchContentHash, researchWorkspace} from './research-files';
import {ResearchExportFiles} from './export-files';
import {renderResearchDiagram} from './diagram-renderer';

const diagramSignal = new AsyncLocalStorage<AbortSignal>();
export const withResearchDiagramSignal = <T>(signal: AbortSignal, work: () => T): T => diagramSignal.run(signal, work);
export class ResearchDiagramService {
  private readonly controllers = new Set<AbortController>();
  private readonly pending = new Set<Promise<unknown>>();
  private closed = false;
  constructor(private readonly repository: Pick<ResearchRepository, 'getProject'>,
    private readonly renderer = renderResearchDiagram) {}
  async render(request: ResearchDiagramRequest) {
    if (this.closed) throw new Error('research_diagram_service_closed');
    const controller = new AbortController(); this.controllers.add(controller);
    const external = diagramSignal.getStore();
    const signal = external ? AbortSignal.any([external, controller.signal]) : controller.signal;
    const job = this.run(request, signal); this.pending.add(job);
    try { return await job; } finally { this.pending.delete(job); this.controllers.delete(controller); }
  }
  async shutdown(): Promise<void> {
    this.closed = true; for (const controller of this.controllers) controller.abort();
    await Promise.allSettled(this.pending);
  }
  private async run(request: ResearchDiagramRequest, signal: AbortSignal) {
    const project = this.repository.getProject(request.projectId);
    if (project.status === 'archived') throw new Error('research_project_archived');
    if (!request.path.endsWith('.mmd')) throw new Error('research_diagram_mmd_required');
    const root = await researchWorkspace(project.workspacePath);
    const bytes = await readResearchFile(root, request.path, diagramSourceLimit);
    const source = new TextDecoder('utf-8', {fatal: true}).decode(bytes);
    const sourceHash = researchContentHash(bytes);
    if (request.expectedHash && request.expectedHash !== sourceHash) throw new Error('research_diagram_source_changed');
    validateDiagramSource(source); signal.throwIfAborted();
    const rendering = await this.renderer(source, sourceHash, project.id, signal);
    if (researchContentHash(await readResearchFile(root, request.path, diagramSourceLimit)) !== sourceHash) throw new Error('research_diagram_source_changed');
    signal.throwIfAborted();
    const id = randomUUID(), directory = `diagrams/${id}`;
    const output = await createResearchDirectory(root, directory);
    try {
      const writer = new ResearchExportFiles(output);
      await writer.write('source.mmd', bytes); await writer.write('diagram.svg', rendering.svg);
      await writer.write('diagram.png', rendering.png); await writer.write('diagram.pdf', rendering.pdf);
      const limitations = ['Non-numeric diagram; no quantitative dataTrace or scientific validation is implied.', 'Layout depends on bundled Mermaid and Electron fonts; inspect the exported figure before publication.'];
      await writer.write('manifest.json', JSON.stringify({schemaVersion: 1, id, projectId: project.id, sourcePath: request.path,
        sourceHash, renderer: diagramRendererVersion, electron: process.versions.electron ?? null, chrome: process.versions.chrome ?? null,
        files: writer.list(), limitations}, null, 2));
      signal.throwIfAborted();
      return researchDiagramResultSchema.parse({id, directory, sourceHash, renderer: diagramRendererVersion, files: writer.list(), limitations});
    } catch (error) { await rm(join(root, directory), {recursive: true, force: true}); throw error; }
  }
}
