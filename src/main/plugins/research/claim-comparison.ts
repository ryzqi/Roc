import type {ResearchClaim} from '../../../shared/types';
import type {ClaimComparison} from '../../../shared/schemas/research-claim-comparison';
import {relationClaimHash} from './evidence-relation-repository';

const normalize = (value: string): string => value.normalize('NFKC').trim().toLowerCase().replace(/\s+/gu, ' ');
/** Conservative comparison. Numeric differences alone never prove a scientific contradiction. */
export function compareClaims(left: ResearchClaim, right: ResearchClaim): ClaimComparison {
  const fields = ['method', 'dataset', 'metric', 'unit', 'baseline', 'conditions'] as const;
  const missing: string[] = [];
  for (const [side, claim] of [['left', left], ['right', right]] as const) {
    for (const [key, value] of Object.entries(claim.experiment)) if (typeof value === 'string' && normalize(value) === 'unknown') missing.push(`${side}.${key}`);
    if (claim.evidenceIds.length === 0) missing.push(`${side}.evidence`);
  }
  const differences = fields.filter(key => normalize(left.experiment[key]) !== 'unknown' &&
    normalize(right.experiment[key]) !== 'unknown' && normalize(left.experiment[key]) !== normalize(right.experiment[key]));
  const conflict = left.experiment.finding !== right.experiment.finding;
  const outcome = differences.length ? 'condition_difference' : missing.length ? 'undetermined' :
    conflict ? 'conflict_candidate' : 'comparable';
  const bind = (claim: ResearchClaim): ClaimComparison['left'] => ({
    claimId: claim.id, version: claim.version, claimHash: relationClaimHash(claim),
    evidenceIds: claim.evidenceIds, experiment: claim.experiment
  });
  return {left: bind(left), right: bind(right), outcome, differences, missing,
    suggestedRelation: outcome === 'conflict_candidate' ? 'contradicts' : null, reviewStatus: 'unreviewed'};
}
