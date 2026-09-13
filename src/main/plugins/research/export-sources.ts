import type { z } from 'zod';
import { researchExportSourcesSchema, type ResearchExportPrepare, type ResearchExportSources } from '../../../shared/schemas/research-exports';
import { researchBibliographyEntrySchema } from '../../../shared/schemas/research-library';
import type { ResearchExperimentService } from './experiment-service';
import type { ResearchFigureService } from './figure-service';
import type { LibraryItem } from './library-repository';
import { escapeLatex, renderCitations, renderSections } from './latex-source';
import { researchContentHash } from './research-files';
import type { ResearchRepository } from './repository';
import type { ResearchTemplateService } from './template-service';

export class ResearchExportSourceService {
  constructor(private readonly repository: ResearchRepository, private readonly figures: ResearchFigureService,
    private readonly experiments: ResearchExperimentService, private readonly templates: Pick<ResearchTemplateService, 'files'>) {}

  async capture(request: ResearchExportPrepare, signal: AbortSignal): Promise<ResearchExportSources> {
    signal.throwIfAborted();
    let template: ResearchExportSources['template'] = null;
    if (request.template.kind === 'imported') {
      const selection = request.template;
      const files = await this.templates.files({ projectId: request.projectId, templateId: selection.templateId });
      const current = this.repository.getTemplate({ projectId: request.projectId, templateId: selection.templateId });
      template = { id: current.id, revision: current.revision, entryPath: current.entryPath, sourceDigest: selection.expectedSourceDigest,
        files: files.map(({ path, size, sha256 }) => ({ path, size, sha256 })) };
    }
    const sources = this.collect(request, template);
    for (const figure of sources.figures) { signal.throwIfAborted(); await this.figures.verify(request.projectId, figure.id); }
    for (const run of sources.experiments) {
      signal.throwIfAborted();
      if (!sources.figures.some((figure) => figure.runId === run.id)) await this.experiments.snapshot(request.projectId, run.id);
    }
    signal.throwIfAborted();
    this.assertCurrent(request, sources);
    return sources;
  }

  assertCurrent(request: ResearchExportPrepare, sources: ResearchExportSources): void {
    if (exportSourceHash(this.collect(request, sources.template)) !== exportSourceHash(sources)) throw new Error('research_export_sources_changed');
  }

  private collect(request: ResearchExportPrepare, template: ResearchExportSources['template']): ResearchExportSources {
    const project = this.repository.getProject(request.projectId);
    if (project.status === 'archived') throw new Error('research_project_archived');
    const review = this.repository.reviews.requireForStage(project.id, 'export');
    if (review === null || review.manuscriptArtifactId !== request.manuscriptArtifactId) throw new Error('research_export_manuscript_changed');
    const bundle = this.repository.evidence.exportBundle({ projectId: project.id, artifactId: request.manuscriptArtifactId });
    const figures = [];
    const claims = [...bundle.claims];
    for (const id of request.figureIds) {
      const figure = this.repository.figures.get(project.id, id);
      if (figure.status !== 'approved') throw new Error('research_export_figure_approval_required');
      const artifact = this.repository.getArtifact(figure.artifactId);
      this.repository.evidence.assertPublishable(artifact);
      figures.push(figure);
      claims.push(...this.repository.evidence.listClaims({ projectId: project.id, artifactId: artifact.id }));
    }
    const evidenceIds = [...new Set(claims.flatMap((claim) => claim.evidenceIds))];
    const evidence = evidenceIds.map((id) => this.repository.evidence.getEvidence(id, project.id));
    const citationKeys: Record<string, string> = {};
    const bibliography = new Map<string, z.infer<typeof researchBibliographyEntrySchema>>();
    const libraryRevisions = new Map<string, number>();
    const pending: LibraryItem[] = [];
    const dependencies = new Map<string, string>();
    const include = (item: LibraryItem): void => {
      if (item.archived) throw new Error('research_export_reference_archived');
      if (libraryRevisions.has(item.id)) return;
      if (bibliography.size >= 5000) throw new Error('research_export_reference_limit');
      libraryRevisions.set(item.id, item.revision);
      bibliography.set(item.id, item.bibliography);
      pending.push(item);
    };
    for (const source of evidence) {
      if (source.sourceType === 'literature') {
        const item = this.repository.library.get(source.sourceId);
        citationKeys[source.id] = item.bibliography.citationKey;
        include(item);
      } else {
        citationKeys[source.id] = source.id;
        bibliography.set(source.id, researchBibliographyEntrySchema.parse({ citationKey: source.id, entryType: 'misc',
          fields: { title: escapeLatex(source.title), note: escapeLatex(`${source.sourceType}: ${source.sourceId}; ${source.locator}`) },
          preambles: [], csl: null, title: source.title, authors: [], doi: null, publishedYear: null, abstract: null, url: null }));
      }
    }
    for (let index = 0; index < pending.length; index += 1) {
      const item = pending[index];
      const key = item.bibliography.fields.crossref;
      if (key === undefined) continue;
      const parent = this.repository.library.resolveCitationKey(project.id, key.trim());
      dependencies.set(item.id, parent.id);
      include(parent);
    }
    if (bibliography.size > 5000) throw new Error('research_export_reference_limit');
    const entries = orderBibliography(bibliography, dependencies);
    if (new Set(entries.map((entry) => entry.citationKey)).size !== entries.length) throw new Error('research_export_citation_key_conflict');
    const artifactIds = new Set([request.manuscriptArtifactId, ...figures.map((figure) => figure.artifactId), ...review.reportArtifactIds]);
    const provenance = this.repository.listProvenance({ projectId: project.id }).filter((entry) => entry.artifactId !== null && artifactIds.has(entry.artifactId));
    const modelRuns = [...new Set(provenance.filter((entry) => entry.sourceType === 'model_run').map((entry) => entry.sourceId))]
      .map((id) => this.repository.runs.get(id, project.id));
    const experimentIds = [...new Set([...figures.map((figure) => figure.runId), ...evidence.filter((source) => source.sourceType === 'experiment').map((source) => source.sourceId)])];
    const experiments = experimentIds.map((id) => this.repository.experiments.get(project.id, id));
    if (experiments.some((run) => run.status !== 'completed')) throw new Error('research_export_experiment_incomplete');
    if (request.template.kind === 'imported') {
      const selection = request.template;
      const current = this.repository.getTemplate({ projectId: project.id, templateId: selection.templateId });
      if (current.revision !== selection.expectedRevision || current.sourceDigest !== selection.expectedSourceDigest || template === null
        || template.id !== current.id || template.revision !== current.revision || template.sourceDigest !== current.sourceDigest) throw new Error('research_export_template_changed');
    }
    return researchExportSourcesSchema.parse({ project: { id: project.id, title: project.title, description: project.description, workspacePath: project.workspacePath },
      manuscriptArtifact: this.repository.getArtifact(request.manuscriptArtifactId), manuscript: bundle.manuscript, claims, evidence, figures,
      bibliography: entries, citationKeys, libraryRevisions: [...libraryRevisions].map(([id, revision]) => ({ id, revision })), provenance, modelRuns, experiments, review, template,
      evidenceMetadata: Object.fromEntries(evidenceIds.map((id) => [id, this.repository.evidence.sourceMetadata(project.id, id)])) });
  }
}

function orderBibliography(entries: ReadonlyMap<string, z.infer<typeof researchBibliographyEntrySchema>>, dependencies: ReadonlyMap<string, string>) {
  const incoming = new Map([...entries.keys()].map((id) => [id, 0]));
  for (const parent of dependencies.values()) {
    const count = incoming.get(parent);
    if (count === undefined) throw new Error('research_export_reference_missing');
    incoming.set(parent, count + 1);
  }
  const queue = [...entries.keys()].filter((id) => incoming.get(id) === 0);
  const ordered = [];
  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index];
    const entry = entries.get(id);
    if (entry === undefined) throw new Error('research_export_reference_missing');
    ordered.push(entry);
    const parent = dependencies.get(id);
    if (parent !== undefined) {
      const count = incoming.get(parent);
      if (count === undefined) throw new Error('research_export_reference_missing');
      incoming.set(parent, count - 1);
      if (count === 1) queue.push(parent);
    }
  }
  if (ordered.length !== entries.size) throw new Error('research_export_reference_cycle');
  return ordered;
}

export function exportSourceHash(sources: ResearchExportSources): string { return researchContentHash(JSON.stringify(sources)); }

export function renderExportBody(sources: ResearchExportSources): string {
  const citedClaims = sources.claims.map((claim) => ({ ...claim,
    evidenceIds: [...new Map(claim.evidenceIds.map((id) => [sources.citationKeys[id], id])).values()] }));
  const body = renderSections(sources.manuscript.sections, citedClaims, sources.citationKeys);
  const figures = sources.figures.map((figure) => {
    const claims = citedClaims.filter((claim) => claim.artifactId === figure.artifactId && claim.subjectType === 'figure');
    if (claims.length === 0) throw new Error('research_figure_evidence_required');
    const caption = claims.map((claim) => `${escapeLatex(claim.content)}${renderCitations(claim.evidenceIds, sources.citationKeys)}`).join(' ');
    return `% figure: ${figure.id}; manifest: ${figure.manifestHash}\n\\begin{figure}[htbp]\n\\centering\n` +
      `\\includegraphics[width=0.9\\linewidth]{figures/${figure.id}.pdf}\n\\caption{${caption}}\n\\label{${figure.id}}\n\\end{figure}`;
  });
  return [body, ...figures].join('\n\n') + '\n';
}

export function defaultExportEntry(title: string, language: 'zh' | 'en'): string {
  const documentClass = language === 'zh' ? '\\documentclass[fontset=fandol]{ctexart}' : '\\documentclass{article}';
  return `${documentClass}\n\\usepackage{amsmath,booktabs,graphicx}\n\\title{${escapeLatex(title)}}\n\\date{}\n` +
    '\\begin{document}\n\\maketitle\n\\input{roc-manuscript.tex}\n\\bibliographystyle{plain}\n\\bibliography{roc-references}\n\\end{document}\n';
}
