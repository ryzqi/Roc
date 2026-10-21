import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { latexCitationKeys, unknownCitationKeys } from '../../../src/main/plugins/research/citation-integrity';
import type { OptimizerScenario } from './dataset';
import {
  componentValue, contentHash, normalizeTrajectory, surfaceHash,
  type HarnessSurface, type HarnessTrajectory
} from './surface';

/**
 * Roc eval adapter for the offline optimizer.
 *
 * This is a deterministic fixture transport: a synthetic step reads the surface, writes one draft
 * inside the supplied candidate workspace, and scores the *artifact bytes* with four checks —
 * non-empty artifact, the repository's existing citation verifier, the user's section heading kept
 * verbatim, and the scenario's numeric result restated. The rubric never reads a surface string, so
 * a scored gain has to come from produced content. It calls no network and no real provider.
 * Scores are fixture rubric values, not evidence of real model quality.
 */
export type ScenarioOutcome = {
  scenarioId: string;
  clusterId: string;
  score: number | null;
  passed: boolean;
  tokens: number;
  artifactRefs: { path: string; sha256: string }[];
  verifier: { name: 'research-citation-integrity'; ok: boolean; missing: string[] };
  rubric: { artifact: boolean; citations: boolean; headingKept: boolean; numericRestated: boolean };
  failure?: 'missing_artifact' | 'verifier_failed' | 'rubric_incomplete';
  trajectory: HarnessTrajectory;
};

export type AdapterOptions = {
  workspace: string;
  /** Must stay false: the offline adapter refuses to run when external effects are enabled. */
  allowExternalEffects: boolean;
};

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function heading(draft: string): string {
  return draft.match(/\\section\*\{[^}]*\}/u)?.[0] ?? '';
}

export function executeScenario(surface: HarnessSurface, scenario: OptimizerScenario, options: AdapterOptions): ScenarioOutcome {
  if (options.allowExternalEffects) throw new Error('optimizer_adapter_egress_forbidden');
  const revision = surfaceHash(surface);
  mkdirSync(options.workspace, { recursive: true });
  const steps: HarnessTrajectory['steps'] = [];
  const modelInput = { revision, scenarioId: scenario.id, family: scenario.family };
  steps.push({ index: 0, kind: 'model', name: 'plan', inputHash: sha256(contentHash(modelInput)),
    outputHash: sha256(revision), tokens: 80, status: 'ok' });

  if (componentValue(surface, 'guidance.evidence') === 'skip-artifact') {
    return {
      scenarioId: scenario.id, clusterId: scenario.clusterId, score: null, passed: false, tokens: 80,
      artifactRefs: [], verifier: { name: 'research-citation-integrity', ok: false, missing: [] },
      rubric: { artifact: false, citations: false, headingKept: false, numericRestated: false },
      failure: 'missing_artifact',
      trajectory: normalizeTrajectory({ schemaVersion: 1, experimentId: 'probe', scenarioId: scenario.id,
        surfaceRevision: surface.revision, steps, final: { score: null, artifactRefs: [] } })
    };
  }

  const verifyCitations = componentValue(surface, 'guidance.citation-check') === 'verify-citations-strict';
  const keepUserText = componentValue(surface, 'prompt.constraint') === 'preserve-user-text';
  const restateNumbers = componentValue(surface, 'guidance.evidence') === 'assert-numbers';
  const allowedCites = [scenario.payload.citeKey];
  const missing = unknownCitationKeys(latexCitationKeys(scenario.payload.draft), allowedCites);
  let draft = scenario.payload.draft;
  if (verifyCitations && missing.length > 0) {
    draft = draft.replace(/\\cite\{[^}]*\}/gu, `\\cite{${scenario.payload.citeKey}}`);
  }
  if (!keepUserText) draft = draft.replace(/\\section\*\{[^}]*\}/u, '\\section*{Rewritten}');
  if (restateNumbers) draft += `\n% roc-checked result=${scenario.payload.values[3]}\n`;

  const artifactName = `draft-${scenario.id}.tex`;
  writeFileSync(join(options.workspace, artifactName), draft);
  steps.push({ index: 1, kind: 'tool', name: 'write_draft', inputHash: sha256(contentHash(draft.length)),
    outputHash: sha256(draft), tokens: 20 + Math.ceil(draft.length / 4), status: 'ok' });

  const remainingMissing = unknownCitationKeys(latexCitationKeys(draft), allowedCites);
  steps.push({ index: 2, kind: 'verifier', name: 'research-citation-integrity',
    inputHash: sha256(draft), outputHash: sha256(contentHash(remainingMissing)),
    tokens: 0, status: remainingMissing.length === 0 ? 'ok' : 'failed' });

  const rubric = {
    artifact: draft.length > 0,
    citations: remainingMissing.length === 0,
    headingKept: heading(draft) === heading(scenario.payload.draft),
    numericRestated: draft.includes(`% roc-checked result=${scenario.payload.values[3]}`)
  };
  const score = Object.values(rubric).filter(Boolean).length / Object.keys(rubric).length;
  const failure = rubric.citations ? (score === 1 ? undefined : 'rubric_incomplete') : 'verifier_failed';
  const tokens = steps.reduce((total, step) => total + step.tokens, 0);
  const artifactRefs = [{ path: artifactName, sha256: sha256(draft) }];
  return {
    scenarioId: scenario.id, clusterId: scenario.clusterId, score, passed: score === 1, tokens, artifactRefs,
    verifier: { name: 'research-citation-integrity', ok: rubric.citations, missing: remainingMissing },
    rubric, ...(failure === undefined ? {} : { failure }),
    trajectory: normalizeTrajectory({ schemaVersion: 1, experimentId: 'probe', scenarioId: scenario.id,
      surfaceRevision: surface.revision, steps, final: { score, artifactRefs: artifactRefs.map(ref => `${ref.path}#${ref.sha256}`) } })
  };
}
