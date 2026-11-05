import {dirname, join} from 'node:path';
import type {ResearchExportExecution, ResearchExportFile, ResearchExportSources} from '../../../shared/schemas/research-exports';
import {researchExportResourceKey, type ResearchExportResourceReview} from '../../../shared/schemas/research-export-publication';
import type {ResearchCrateInput} from '../../../shared/schemas/research-ro-crate';
import {researchExperimentSourcePath} from '../../../shared/schemas/research-experiments';
import {researchContentHash} from './research-files';
import {projectResearchPublicValue} from './export-public-projection';
import {exportScientificReviewPath} from './export-scientific-review';
import type {ResearchRepository} from './repository';
import {buildResearchCrate, type ResearchCrateDocument} from './export-ro-crate';

const resourceId = (resource: ResearchExportResourceReview) => `resource-${researchContentHash(researchExportResourceKey(resource.source))}`;
const referenceId = (id: string) => `reference-${researchContentHash(id)}`;

function properties(values: Record<string, string | null>): {name: string; value: string}[] {
  return Object.entries(values).map(([name, value]) => {
    const projection = projectResearchPublicValue({name, value});
    const projected = projection.value as {name: string | null; value: string | null};
    return {name: projected.name === null ? `omitted property ${researchContentHash(name)}` : projected.name,
      value: projected.value === null ? value === null ? 'Not recorded' : 'Omitted from public projection' : projected.value};
  });
}

/** Compile semantic entities from the actual registered inventory and the exact reviewed sources. */
export function buildExportCrate(repository: ResearchRepository, record: ResearchExportExecution,
  sources: ResearchExportSources, files: ResearchExportFile[]): ResearchCrateDocument {
  const review = record.request.publicationReview;
  const entryDirectory = dirname(sources.template?.entryPath ?? 'main.tex');
  const paths = new Set(files.map(file => file.path));
  const works: ResearchCrateInput['works'] = review.resources.map(resource => {
    const {source} = resource;
    const delivered: string[] = [];
    if (resource.delivery.kind === 'bundled') {
      if (source.kind === 'template') {
        delivered.push(...[`source/${source.path}`, `provenance/template/${source.path}`].filter(path => paths.has(path)));
      } else {
        delivered.push(`provenance/${source.kind === 'figure' ? 'figures' : 'experiments'}/${source.id}/${source.area}/${source.path}`);
        if (source.kind === 'figure' && source.area === 'output') {
          const figure = sources.figures.find(figure => figure.id === source.id);
          if (figure?.validation.files.some(file => file.path === source.path)) {
            delivered.push(join('source', entryDirectory, `figures/${source.id}.${source.path.split('.').at(-1)}`));
          }
        }
      }
      if (delivered.length === 0 || delivered.some(path => !paths.has(path))) throw new Error('research_crate_file_missing');
      for (const path of delivered) {
        const file = files.find(file => file.path === path)!;
        if (file.sha256 !== source.sha256 || file.size !== source.size) throw new Error('research_export_resource_changed');
      }
    }
    return {id: resourceId(resource), kind: resource.kind, name: resource.name, description: resource.description,
      version: resource.version, url: resource.url, license: resource.license, basedOn: [],
      delivery: resource.delivery.kind === 'bundled' ? {kind: 'bundled', paths: delivered} : resource.delivery};
  });
  for (const reference of review.references) works.push({
    id: referenceId(reference.id), kind: 'reference', basedOn: [],
    name: reference.name, description: reference.description, version: reference.version, url: reference.url, license: reference.license,
    delivery: {kind: 'metadata_only', url: reference.url, instructions: reference.instructions}
  });
  const manuscriptId = sources.manuscriptArtifact.id;
  works.push({
    id: manuscriptId, kind: 'manuscript', name: review.publication.name, description: review.publication.description,
    version: sources.manuscript.contentHash, url: null, license: review.publication.license,
    delivery: {kind: 'bundled', paths: ['paper.pdf', join('source', entryDirectory, 'roc-manuscript.tex'), 'provenance/approved-manuscript.tex']},
    basedOn: works.map(work => work.id)
  });
  const activities: ResearchCrateInput['activities'] = [];
  for (const run of sources.experiments) {
    if (run.environment === null || run.status !== 'completed') throw new Error('research_export_environment_required');
    const resources = review.resources.filter(resource => resource.source.kind === 'experiment' && resource.source.id === run.id);
    const program = resources.find(resource => resource.source.area === 'input' && resource.source.path === researchExperimentSourcePath(run.request));
    if (program === undefined || program.kind !== 'software') throw new Error('research_export_program_metadata_required');
    const inputs = resources.filter(resource => resource.source.area === 'input').map(resourceId);
    const outputs = resources.filter(resource => resource.source.area === 'output').map(resourceId);
    for (const id of outputs) works.find(work => work.id === id)!.basedOn = inputs;
    activities.push({
      id: run.id, name: `Experiment ${run.id}`, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
      inputs, outputs, software: resourceId(program),
      environment: {hash: run.environment.hash, version: run.environment.version,
        packages: properties(Object.fromEntries(run.environment.packages.map(item => [item.name, item.version])))},
      parameters: properties(run.request.parameters), seed: run.request.engine === 'python' ? run.request.seed : null,
      cost: {kind: 'unknown', reason: 'No monetary cost receipt recorded for this local execution.'}
    });
  }
  for (const figure of sources.figures) {
    const run = repository.figureRuns.get(record.projectId, figure.runId);
    if (run.environment === null || run.status !== 'completed') throw new Error('research_export_environment_required');
    const resources = review.resources.filter(resource => resource.source.kind === 'figure' && resource.source.id === figure.id);
    const program = resources.find(resource => resource.source.area === 'input' && resource.source.path === run.request.sourcePath);
    if (program === undefined || program.kind !== 'software') throw new Error('research_export_program_metadata_required');
    const inputs = resources.filter(resource => resource.source.area === 'input').map(resourceId);
    const outputs = resources.filter(resource => resource.source.area === 'output').map(resourceId);
    for (const id of outputs) works.find(work => work.id === id)!.basedOn = inputs;
    activities.push({
      id: run.id, name: `Figure execution ${run.id}`, status: run.status, startedAt: run.startedAt, endedAt: run.endedAt,
      inputs, outputs, software: resourceId(program),
      environment: {hash: run.environment.hash, version: run.environment.pipelineVersion,
        packages: properties({vega: run.environment.vegaVersion, 'vega-lite': run.environment.vegaLiteVersion,
          '@napi-rs/canvas': run.environment.rendererVersion, node: run.environment.nodeVersion})},
      parameters: properties(Object.fromEntries(Object.entries(run.request.figure).map(([name, value]) => [name, String(value)]))),
      seed: run.request.figure.seed,
      cost: {kind: 'unknown', reason: 'No monetary cost receipt recorded for this local execution.'}
    });
  }
  const approvals: ResearchCrateInput['approvals'] = [{
    artifactId: manuscriptId,
    artifactVersion: repository.inspectArtifact({projectId: record.projectId, artifactId: manuscriptId, expectedVersion: null}).snapshot.version,
    workId: manuscriptId, recordedAt: sources.review.updatedAt, reviewPath: exportScientificReviewPath
  }];
  for (const figure of sources.figures) {
    for (const resource of review.resources.filter(resource => resource.source.kind === 'figure' &&
      resource.source.id === figure.id && resource.kind === 'figure')) {
      approvals.push({artifactId: figure.artifactId,
        artifactVersion: repository.inspectArtifact({projectId: record.projectId, artifactId: figure.artifactId, expectedVersion: null}).snapshot.version,
        workId: resourceId(resource), recordedAt: repository.getArtifact(figure.artifactId).updatedAt, reviewPath: exportScientificReviewPath});
    }
  }
  return buildResearchCrate({publication: review.publication, files, works, activities, approvals});
}
