import {researchExportInputsSchema, researchExportPublicationReviewSchema, researchExportResourceKey,
  type ResearchExportInputs, type ResearchExportPublicationReview} from '../../../shared/schemas/research-export-publication';
import type {ResearchExportSources} from '../../../shared/schemas/research-exports';
import {researchExperimentSourcePath} from '../../../shared/schemas/research-experiments';
import {researchContentHash} from './research-files';
import type {ResearchRepository} from './repository';

/** Candidates identify original bytes. Logs are separate automatic public projections. */
export function collectExportInputs(repository: ResearchRepository, sources: ResearchExportSources): ResearchExportInputs {
  const resources: ResearchExportInputs['resources'] = [];
  for (const run of sources.experiments) {
    for (const file of run.files) {
      if (file.area === 'log') continue;
      const program = file.area === 'input' && file.path === researchExperimentSourcePath(run.request);
      resources.push({source: {...file, area: file.area, kind: 'experiment', id: run.id},
        role: program ? 'program' : file.area, mandatory: false, reason: null});
    }
  }
  for (const figure of sources.figures) {
    const run = repository.figureRuns.get(sources.project.id, figure.runId);
    for (const file of run.files) {
      if (file.area === 'log') continue;
      const image = file.area === 'output' && figure.validation.files.some(selected => selected.path === file.path);
      const program = file.area === 'input' && file.path === run.request.sourcePath;
      resources.push({source: {...file, area: file.area, kind: 'figure', id: figure.id},
        role: image ? 'figure' : program ? 'program' : file.area, mandatory: image,
        reason: image ? 'Required by the selected figure and manuscript compilation.' : null});
    }
  }
  if (sources.template !== null) {
    for (const file of sources.template.files) resources.push({
      source: {...file, kind: 'template', id: sources.template.id, area: null},
      role: 'template', mandatory: true, reason: 'Imported template files require explicit redistribution permission.'
    });
  }
  return researchExportInputsSchema.parse({
    sourceHash: researchContentHash(JSON.stringify(sources)), resources,
    references: sources.bibliography.map(entry => ({id: entry.citationKey, name: entry.title, url: entry.url}))
  });
}

export function validateExportPublication(input: unknown, candidates: ResearchExportInputs): ResearchExportPublicationReview {
  const review = researchExportPublicationReviewSchema.parse(input);
  if (review.sourceHash !== candidates.sourceHash) throw new Error('research_export_sources_changed');
  const selected = new Map(review.resources.map(resource => [researchExportResourceKey(resource.source), resource]));
  if (selected.size !== candidates.resources.length) throw new Error('research_export_resource_selection_required');
  for (const candidate of candidates.resources) {
    const resource = selected.get(researchExportResourceKey(candidate.source));
    if (resource === undefined) throw new Error('research_export_resource_selection_required');
    if (resource.source.sha256 !== candidate.source.sha256 || resource.source.size !== candidate.source.size) {
      throw new Error('research_export_resource_changed');
    }
    if (candidate.mandatory && resource.delivery.kind !== 'bundled') throw new Error('research_export_resource_bundled_required');
    if (candidate.role === 'program' && resource.kind !== 'software') throw new Error('research_export_program_metadata_required');
    if (candidate.role === 'figure' && resource.kind !== 'figure') throw new Error('research_export_figure_metadata_required');
  }
  const references = new Set(review.references.map(reference => reference.id));
  if (references.size !== candidates.references.length || candidates.references.some(reference => !references.has(reference.id))) {
    throw new Error('research_export_reference_selection_required');
  }
  return review;
}
