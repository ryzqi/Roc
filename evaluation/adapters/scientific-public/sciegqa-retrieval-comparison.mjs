import {resolve} from 'node:path';
import {hash, readJson} from '../../lib/common.mjs';
import {publicPdfArtifactPath} from './pdf.mjs';
import {verifySciegqaRetrievalRun} from './sciegqa-retrieval-run.mjs';

export function compareSciegqaRetrievalObservations(first, second) {
  const identities = Object.fromEntries([
    ['sourceLock', first.report.sourceLockHash === second.report.sourceLockHash],
    ['cohort', first.report.cohortHash === second.report.cohortHash],
    ['pdfVerification', first.inputs.pdfVerificationHash === second.inputs.pdfVerificationHash],
    ['sourceIdentities', hash(first.inputs.sourceIdentities) === hash(second.inputs.sourceIdentities)],
    ['correspondenceManifest', first.inputs.correspondenceManifestHash === second.inputs.correspondenceManifestHash],
    ['correspondenceInventory', first.inputs.correspondenceInventoryHash === second.inputs.correspondenceInventoryHash],
    ['contract', hash(first.inputs.contract) === hash(second.inputs.contract)],
    ['configuration', hash(first.inputs.config) === hash(second.inputs.config)],
    ['executionCode', hash(first.inputs.codeHashes) === hash(second.inputs.codeHashes)],
    ['compiledBundle', hash(first.inputs.compiledBundleHashes) === hash(second.inputs.compiledBundleHashes)],
    ['nodeVersion', first.inputs.nodeVersion === second.inputs.nodeVersion],
  ]);
  const firstById = new Map(first.rows.map(row => [row.id, row]));
  const secondById = new Map(second.rows.map(row => [row.id, row]));
  if (firstById.size !== first.rows.length || secondById.size !== second.rows.length) {
    throw new Error('scientific_sciegqa_comparison_duplicate_question');
  }
  const changed = [...new Set([...firstById.keys(), ...secondById.keys()])].sort()
    .filter(id => hash(firstById.get(id) ?? null) !== hash(secondById.get(id) ?? null));
  const indexEqual = first.verified.indexHash === second.verified.indexHash;
  const fixedInputs = Object.values(identities).every(Boolean);
  const outputsEqual = changed.length === 0 && indexEqual;
  const repeatable = fixedInputs && outputsEqual;
  return {schemaVersion: 1, kind: 'scientific-sciegqa-retrieval-observation-repeatability',
    status: !fixedInputs ? 'different-execution-inputs'
      : repeatable ? 'fixed-input-observations-repeatable' : 'observation-outputs-changed',
    identities, indexEqual, completeCohortOutputsEqual: outputsEqual,
    fixedInputObservationsRepeatable: repeatable, changedQuestionIds: changed,
    attempts: [first, second].map(({report, verified}) => ({
      root: report.root, reportHash: verified.reportHash, queries: verified.queries,
      parsedPapers: report.parsedPapers, failedPapers: report.failedPapers,
      deterministicScoreHash: verified.deterministicScoreHash, indexHash: verified.indexHash,
      metrics: verified.metrics, performance: verified.performance})),
    scientificBaselineReady: false,
    limitations: ['All225 original questions, source-unqualified cases and parse/search failures remain visible.',
      'Repeatable mechanical region/block observations do not establish full scientific evidence or answer quality.',
      'Latency and resource differences are measurements, not optimization gains.']};
}

export async function compareSciegqaRetrievalRuns(firstRoot, secondRoot) {
  if (resolve(firstRoot) === resolve(secondRoot)) throw new Error('scientific_sciegqa_comparison_same_run');
  const attempts = [];
  for (const root of [firstRoot, secondRoot]) {
    const verified = await verifySciegqaRetrievalRun(root);
    attempts.push({verified, report: readJson(publicPdfArtifactPath(root, 'report.json')),
      inputs: readJson(publicPdfArtifactPath(root, 'inputs.json')),
      rows: readJson(publicPdfArtifactPath(root, 'scores.json'))});
  }
  return compareSciegqaRetrievalObservations(...attempts);
}
