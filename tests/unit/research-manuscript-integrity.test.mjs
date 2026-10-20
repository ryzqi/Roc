import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * One rule, and it is the one nothing else covers.
 *
 * A claim tagged `subjectType: 'figure'` can sit in a body section: `assertSupported()` checks status
 * and evidence but not the label, and `renderSections()` renders every claim in `section.claimIds`
 * without looking at it either. The claim is then rendered as ordinary prose while
 * `recordClaimProvenance()` files its audit edge as a `figure_claim` — so the provenance says the
 * sentence belongs to a figure that does not exist.
 *
 * It is deliberately *not* the "rendered twice as body and caption" story: the caption filter also
 * requires `claim.artifactId === figure.artifactId`, and a claim in `sections` must belong to the
 * manuscript artifact, so the two sets are disjoint.
 *
 * Why the neighbouring invariants are *not* tested here: "unsupported claims never reach the body"
 * and "every cited evidence resolves" are enforced earlier and stronger, by
 * `manuscript-repository.ts:118 resolveManuscriptClaims()` at write time and again at read time, and
 * by `createClaim -> validateSupport`. Where that enforcement lives is pinned by
 * `research-export-body-gate.test.mjs`, which drives the real repositories.
 */

const { checkManuscriptBody } = await importTypeScriptModule('src/main/plugins/research/manuscript-integrity.ts');

const body = {
  sections: [{ title: 'Introduction', claimIds: ['c1'] }, { title: 'Method', claimIds: ['c2'] }],
  claims: [{ id: 'c1', subjectType: 'claim' }, { id: 'c2', subjectType: 'claim' }]
};

test('a body made of ordinary claims passes', () => {
  assert.deepEqual(checkManuscriptBody(body), []);
  assert.deepEqual(checkManuscriptBody({ sections: [], claims: [] }), []);
});

test('a figure claim in a body section is refused, and the refusal names its section', () => {
  const violations = checkManuscriptBody({
    ...body,
    claims: [{ id: 'c1', subjectType: 'figure' }, { id: 'c2', subjectType: 'claim' }]
  });
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, 'research_export_figure_claim_in_body');
  assert.equal(violations[0].subject, 'c1');
  assert.equal(violations[0].sectionIndex, 0);
  assert.match(violations[0].detail, /Introduction/u);
});

test('the refusal says what the user can actually do about it', () => {
  // `subjectType` is immutable (`researchClaimUpdateRequestSchema` picks only content/status/evidenceIds)
  // and claims cannot be deleted, so "tag it as a figure instead" would be advice the user cannot
  // follow. The only workable remedy is a new claim plus re-saving the manuscript.
  const [violation] = checkManuscriptBody({ ...body, claims: [{ id: 'c1', subjectType: 'figure' }, { id: 'c2', subjectType: 'claim' }] });
  assert.match(violation.detail, /新建/u);
  assert.match(violation.detail, /重新保存正文/u);
  // And it must not claim the sentence would also appear as a caption — that is false.
  assert.doesNotMatch(violation.detail, /图注里/u);
});

test('a paragraph claim is not a figure claim', () => {
  // `subjectType` has three members; only one of them is the mislabel.
  assert.deepEqual(checkManuscriptBody({ ...body, claims: [{ id: 'c1', subjectType: 'paragraph' }, { id: 'c2', subjectType: 'claim' }] }), []);
});

test('every offending section is reported, in document order', () => {
  const violations = checkManuscriptBody({
    sections: [{ title: 'One', claimIds: ['a', 'b'] }, { title: 'Two', claimIds: ['c'] }],
    claims: [
      { id: 'a', subjectType: 'figure' },
      { id: 'b', subjectType: 'claim' },
      { id: 'c', subjectType: 'figure' }
    ]
  });
  assert.deepEqual(violations.map((violation) => [violation.sectionIndex, violation.subject]), [[0, 'a'], [1, 'c']]);
});

test('a claim id the caller did not supply is skipped, not invented into a violation', () => {
  // A dangling id already throws `research_claim_not_found` further up, and a claim belonging to
  // another artifact throws `research_claim_artifact_mismatch`; minting a third code for the same
  // problem would give one defect three names.
  assert.deepEqual(checkManuscriptBody({ ...body, claims: [{ id: 'c1', subjectType: 'claim' }] }), []);
});

test('the violation carries the code and subject the caller turns into an error', () => {
  // `<code>:<subject>` is the whole user-visible signal: research codes have no message layer.
  const [violation] = checkManuscriptBody({ ...body, claims: [{ id: 'c1', subjectType: 'figure' }, { id: 'c2', subjectType: 'claim' }] });
  assert.equal(`${violation.code}:${violation.subject}`, 'research_export_figure_claim_in_body:c1');
});
