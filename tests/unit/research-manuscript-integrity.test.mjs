import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * One rule, and it is the one nothing else covers.
 *
 * A figure claim placed in a body section is rendered twice: `renderSections()` draws every claim
 * in `section.claimIds` as prose without looking at `subjectType`, and `renderExportBody()` also
 * picks `subjectType === 'figure'` claims out as captions. The same sentence then appears as body
 * text with no figure under it, and again under the figure.
 *
 * Why the neighbouring invariants are *not* tested here: "unsupported claims never reach the body"
 * and "every cited evidence resolves" are enforced earlier and stronger, by
 * `manuscript-repository.ts:118 resolveManuscriptClaims()` — at write time (`saveManuscript`) and
 * again at read time (`requireCurrentManuscript`, which every export path goes through). Asserting
 * them here would pin a rule this module does not own. Where that enforcement lives is pinned by
 * `research-export-body-gate.test.mjs`, which drives the real repositories.
 */

const { checkManuscriptBody, firstBlockingViolation } = await importTypeScriptModule(
  'src/main/plugins/research/manuscript-integrity.ts'
);

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
  assert.equal(violations[0].severity, 'block');
  assert.equal(violations[0].subject, 'c1');
  assert.equal(violations[0].sectionIndex, 0);
  assert.match(violations[0].detail, /Introduction/u);
});

test('a paragraph claim is not a figure claim', () => {
  // `subjectType` has three members; only one of them is the caption.
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
  // `resolveManuscriptClaims()` already refuses a dangling id with `research_claim_artifact_mismatch`;
  // minting a second code for the same problem would give one defect two names.
  assert.deepEqual(checkManuscriptBody({ ...body, claims: [{ id: 'c1', subjectType: 'claim' }] }), []);
});

test('the thrown code is the first blocking violation, located', () => {
  // This string is the whole signal: research codes have no message layer, so it has to point at a
  // specific claim rather than say "the body is not ready".
  const violations = checkManuscriptBody({ ...body, claims: [{ id: 'c1', subjectType: 'figure' }, { id: 'c2', subjectType: 'claim' }] });
  const blocking = firstBlockingViolation(violations);
  assert.notEqual(blocking, null);
  assert.equal(`${blocking.code}:${blocking.subject}`, 'research_export_figure_claim_in_body:c1');
});

test('firstBlockingViolation returns null when there is nothing to block', () => {
  assert.equal(firstBlockingViolation([]), null);
  assert.equal(firstBlockingViolation([{ code: 'x', severity: 'warn', subject: 's', sectionIndex: null, detail: '' }]), null);
});
