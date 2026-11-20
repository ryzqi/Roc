import {hash} from '../../lib/common.mjs';

/** Compare independently verified full cohorts. Latency/resource differences are
 * retained measurements, never evidence of an optimization or deterministic output. */
export function comparePublicPdfReports(attempts) {
  if (!Array.isArray(attempts) || attempts.length !== 2) throw new Error('scientific_pdf_comparison_inputs_invalid');
  for (const {run, inputs, verified} of attempts) {
    if (run.kind !== 'scientific-public-full-pdf-parser-component-run' || !run.cohortComplete
      || verified.kind !== 'scientific-public-full-pdf-provenance-component-baseline'
      || verified.status !== 'verified-provenance-unscored-quality'
      || run.papers !== 45 || verified.papers !== 45 || run.rows.length !== 45 || verified.rows.length !== 45
      || hash(run) !== verified.runHash || hash(verified.rows) !== verified.deterministicOutputHash
      || run.sourceLockHash !== verified.sourceLockHash || run.sourceLockHash !== inputs.sourceLockHash
      || hash(run.codeHashes) !== hash(inputs.codeHashes) || hash(run.codeHashes) !== hash(verified.parserCodeHashes)
      || hash(run.modelHashes) !== hash(inputs.modelHashes) || hash(run.modelHashes) !== hash(verified.modelHashes)
      || run.modelManifest !== inputs.modelManifest || run.modelManifest !== verified.modelManifest
      || hash(run.parserOptions) !== hash(inputs.parserOptions)
      || !Array.isArray(inputs.compiledBundleHashes) || inputs.compiledBundleHashes.length === 0
      || verified.rows.some((row, i) => row.paperId !== run.rows[i].paperId || !row.sourceVerified)
      || new Set(verified.rows.map(row => row.paperId)).size !== 45
      || verified.parsedPapers !== verified.rows.filter(row => row.status === 'parsed').length
      || verified.failedPapers !== verified.rows.filter(row => row.status === 'failed').length
      || verified.rows.some(row => !['parsed', 'failed'].includes(row.status)
        || (row.status === 'parsed' && !row.geometryVerified))) {
      throw new Error('scientific_pdf_comparison_report_unqualified');
    }
  }
  const [first, second] = attempts;
  const identities = {
    sourceLock: first.run.sourceLockHash === second.run.sourceLockHash,
    sourcePins: hash(first.inputs.pins) === hash(second.inputs.pins),
    parserCode: hash(first.run.codeHashes) === hash(second.run.codeHashes),
    compiledBundles: hash(first.inputs.compiledBundleHashes) === hash(second.inputs.compiledBundleHashes),
    modelFiles: hash(first.run.modelHashes) === hash(second.run.modelHashes),
    modelManifest: first.run.modelManifest === second.run.modelManifest,
    parserOptions: hash(first.run.parserOptions) === hash(second.run.parserOptions),
    nodeVersion: first.run.nodeVersion === second.run.nodeVersion,
    verifierCode: hash(first.verified.verifierCodeHashes) === hash(second.verified.verifierCodeHashes),
    cohort: hash(first.verified.rows.map(row => row.paperId)) === hash(second.verified.rows.map(row => row.paperId))
  };
  if (Object.values(identities).some(equal => !equal)) throw new Error('scientific_pdf_comparison_identity_changed');
  const changed = first.verified.rows.flatMap((before, i) => {
    const after = second.verified.rows[i];
    return hash(before) === hash(after) ? [] : [{paperId: before.paperId, before, after}];
  });
  const commonParsed = first.verified.rows.filter((row, i) => row.status === 'parsed' && second.verified.rows[i].status === 'parsed');
  const commonParsedEqual = commonParsed.every(row => !changed.some(change => change.paperId === row.paperId));
  const allParsed = attempts.every(attempt => attempt.verified.parsedPapers === 45);
  return {
    schemaVersion: 1, kind: 'scientific-public-full-pdf-repeatability',
    status: changed.length === 0 && allParsed ? 'complete-cohort-repeatable' : 'complete-cohort-not-repeatable',
    identities, papers: 45, commonParsedPapers: commonParsed.length, commonParsedOutputsEqual: commonParsedEqual,
    completeCohortOutputsEqual: changed.length === 0,
    completeSuccessfulCohortRepeatable: changed.length === 0 && allParsed,
    attempts: attempts.map(({verified}) => ({
      root: verified.root, runHash: verified.runHash, deterministicOutputHash: verified.deterministicOutputHash,
      parsedPapers: verified.parsedPapers, failedPapers: verified.failedPapers,
      verifiedPages: verified.verifiedPages, performance: verified.performance
    })),
    changed, scientificBaselineReady: false,
    limitations: [
      'Independent source/artifact/geometry verification does not prove human evidence locator correctness.',
      'All45 attempts remain in each denominator; cancellation differences prevent full-cohort repeatability.',
      'Measured timing/resource changes are not an optimization result.',
      'Scientific quality, exact evidence and generated Wiki acceptance remain incomplete.'
    ]
  };
}
