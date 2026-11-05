import type {ResearchFigureConsistencyReceipt, ResearchFigureConsistencyBinding} from '../../../shared/schemas/research-figure-consistency';
import type {ResearchFigureDataTrace} from '../../../shared/schemas/research-figure-data';
import {relationClaimHash} from './evidence-relation-repository';
import {assertExperimentMetricEvidence, experimentMetricSource} from './experiment-result-evidence';
import {calculateConsistencyValue} from './consistency-calculation';
import {researchContentHash} from './research-files';
import {assertFigureRun, figureManifest} from './figure-repository';

export function figureDataLocation(binding: ResearchFigureConsistencyBinding): string {
  return JSON.stringify([binding.markName, binding.channel, binding.scenePath]);
}
export function selectFigureData(trace: ResearchFigureDataTrace, binding: ResearchFigureConsistencyBinding): {
  mark: ResearchFigureDataTrace['marks'][number]; item: ResearchFigureDataTrace['marks'][number]['items'][number]; value: number
} {
  const mark = trace.marks.find(item => item.name === binding.markName);
  if (mark === undefined || !Object.hasOwn(mark.directFields, binding.channel) || mark.directFields[binding.channel] !== binding.field ||
    mark.unsupportedChannels.includes(binding.channel) || mark.constantChannels.includes(binding.channel)) {
    throw new Error('research_figure_consistency_encoding_unsupported');
  }
  const item = mark.items.find(item => JSON.stringify(item.scenePath) === JSON.stringify(binding.scenePath));
  if (item === undefined || !Object.hasOwn(item.numericFields, binding.field)) {
    throw new Error('research_figure_consistency_value_required');
  }
  return {mark, item, value: item.numericFields[binding.field]};
}
/** Stored receipts validate selected scene data and calculations without claiming current source validity. */
export function assertFigureConsistencyMaterial(receipt: ResearchFigureConsistencyReceipt): void {
  const {request, material} = receipt.snapshot;
  assertFigureRun(material.run, material.figure.validation);
  if (material.figure.projectId !== request.projectId || material.figure.artifactId !== request.artifactId ||
    material.run.projectId !== request.projectId || material.run.artifactId !== request.artifactId ||
    material.run.id !== material.figure.runId || material.run.request.sourcePath !== material.figure.sourcePath ||
    JSON.stringify(material.run.request.inputPaths) !== JSON.stringify(material.figure.inputPaths) ||
    researchContentHash(figureManifest(material.run, material.figure.validation)) !== request.figure.manifestHash ||
    !material.run.files.some(file => file.area === 'input' && file.path === material.figure.sourcePath &&
      file.sha256 === material.trace.sourceHash) ||
    !material.run.files.some(file => file.area === 'output' && file.path === material.trace.file.path &&
      file.sha256 === material.trace.file.sha256 && file.size === material.trace.file.size) ||
    material.figure.id !== request.figure.id || material.figure.manifestHash !== request.figure.manifestHash ||
    material.trace.file.sha256 !== request.figure.traceHash ||
    material.trace.rendererHash !== material.figure.validation.rendererHash || material.mappings.length !== request.bindings.length) {
    throw new Error('research_figure_consistency_snapshot_invalid');
  }
  request.bindings.forEach((binding, index) => {
    const entry = material.mappings[index];
    const selected = selectFigureData({schemaVersion: 1, sourceHash: material.trace.sourceHash,
      rendererHash: material.trace.rendererHash, compiledSpecHash: material.trace.compiledSpecHash,
      marks: [{...entry.mark, items: [entry.item]}]}, binding);
    if (entry.claim.id !== binding.claimId || entry.claim.projectId !== request.projectId ||
      entry.claim.artifactId !== request.artifactId || entry.claim.subjectType !== 'figure' ||
      relationClaimHash(entry.claim) !== binding.expectedClaimHash || !entry.claim.evidenceIds.includes(binding.evidenceId) ||
      entry.evidence.id !== binding.evidenceId || entry.result.snapshot.request.projectId !== request.projectId ||
      entry.result.snapshot.id !== binding.resultId || entry.result.snapshotHash !== binding.resultHash ||
      researchContentHash(JSON.stringify(entry.result.snapshot)) !== binding.resultHash) {
      throw new Error('research_figure_consistency_snapshot_invalid');
    }
    assertExperimentMetricEvidence(entry.evidence, experimentMetricSource(entry.result, binding.metricId).metadata, entry.result);
    if (JSON.stringify(calculateConsistencyValue(binding, String(selected.value), entry.result)) !== JSON.stringify(entry.calculation)) {
      throw new Error('research_figure_consistency_snapshot_invalid');
    }
  });
}
