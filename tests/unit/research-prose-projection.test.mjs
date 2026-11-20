import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * Prose findings must land on a claim, and the mapping must never be guessed.
 *
 * The inspected text is a *projection*: one Markdown unit per manuscript section, one line range
 * per paragraph. Vale reports line numbers, and a line number mapped to the wrong claim is worse
 * than no location at all — a reviewer would read an unrelated paragraph and conclude the tool is
 * lying. So every property pinned here is about the boundary between "we know" and "we don't":
 *
 *   * the line ranges are built while writing, never recovered by searching the text back up
 *     (repeated claim text and embedded newlines would make the search return the wrong line);
 *   * a line outside every range is a section-level finding (`claimId: null`), which is the honest
 *     answer for a heading or a blank line;
 *   * a non-positive or absurd line number stays unlocated instead of being clamped into range;
 *   * an unknown severity level becomes `other`, not `warning` — folding the unknown into a known
 *     tier would silently hide a contract change;
 *   * an alert for a path we never sent is reported as a dropped unit, not discarded.
 *
 * Vale itself is not run here. What is pinned is the projection and the mapping; whether Vale
 * answers at all is a toolchain property (pinned by `scripts/research/smoke.ts` and the rebuilt
 * toolchain), and a `node --test` run cannot reach a sandboxed binary.
 */

const { buildProseBundle, projectProseAlerts, summarizeProseFindings } = await importTypeScriptModule(
  'src/main/plugins/research/prose-projection.ts'
);

const sections = [
  { title: 'Introduction', claimIds: ['claim-a', 'claim-b'] },
  { title: 'Method', claimIds: ['claim-c'] }
];
const claims = [
  { id: 'claim-a', content: 'The dataset contains 100 samples.' },
  // Deliberately multi-line and deliberately repeating the first claim's opening words: both are
  // the cases where "search the text back up to find the offset" gives a wrong answer.
  { id: 'claim-b', content: 'The dataset contains 100 samples.\n\nAnd a second line that repeats nothing.' },
  { id: 'claim-c', content: 'We fit a linear model.' }
];

test('one unit per section, with line ranges built as the text is written', () => {
  const bundle = buildProseBundle({ sections, claims });
  assert.deepEqual(bundle.units.map((unit) => unit.path), ['sections/000.md', 'sections/001.md']);
  assert.deepEqual(bundle.claimIds, ['claim-a', 'claim-b', 'claim-c']);

  const [first, second] = bundle.units;
  //  1 `# Introduction`  2 blank  3 claim-a  4 blank  5-7 claim-b  8 blank
  // The blank line after each claim is part of the layout, so ranges are not adjacent. Pinning the
  // exact numbers is the point: they are what a reported line is matched against.
  assert.deepEqual(first.segments, [
    { claimId: 'claim-a', startLine: 3, endLine: 3 },
    { claimId: 'claim-b', startLine: 5, endLine: 7 }
  ]);
  assert.deepEqual(first.content.split('\n'), [
    '# Introduction', '', 'The dataset contains 100 samples.', '', 'The dataset contains 100 samples.',
    '', 'And a second line that repeats nothing.', '', ''
  ]);
  // 1 `# Method`  2 blank  3 claim-c  4 blank
  assert.deepEqual(second.segments, [{ claimId: 'claim-c', startLine: 3, endLine: 3 }]);
});

test('a line inside a range resolves to that claim, including the repeated second line', () => {
  const bundle = buildProseBundle({ sections, claims });
  const report = { 'sections/000.md': [
    alert({ Line: 3, Match: 'first' }),
    alert({ Line: 5, Match: 'repeated' }),
    alert({ Line: 7, Match: 'second line' })
  ] };
  const { findings } = projectProseAlerts(report, bundle);
  assert.deepEqual(findings.map((finding) => finding.claimId), ['claim-a', 'claim-b', 'claim-b']);
  assert.deepEqual(findings.map((finding) => finding.match), ['first', 'repeated', 'second line']);
  assert.deepEqual(findings.map((finding) => finding.sectionTitle), ['Introduction', 'Introduction', 'Introduction']);
  assert.equal(findings[0].style, 'RocAcademic');
  assert.equal(findings[0].rule, 'Hedging');
});

test('the heading and blank lines are section-level findings, not paragraph findings', () => {
  const bundle = buildProseBundle({ sections, claims });
  const report = { 'sections/000.md': [alert({ Line: 1 }), alert({ Line: 2 }), alert({ Line: 4 }), alert({ Line: 8 })] };
  const { findings } = projectProseAlerts(report, bundle);
  assert.deepEqual(findings.map((finding) => finding.claimId), [null, null, null, null]);
  assert.equal(summarizeProseFindings(findings).unlocated, 4);
});

test('a line number that cannot be trusted stays unlocated instead of being clamped', () => {
  const bundle = buildProseBundle({ sections, claims });
  const report = { 'sections/000.md': [
    alert({ Line: 0 }), alert({ Line: -3 }), alert({ Line: 4.5 }), alert({ Line: '5' }), alert({ Line: 9999 })
  ] };
  const { findings } = projectProseAlerts(report, bundle);
  assert.deepEqual(findings.map((finding) => finding.claimId), [null, null, null, null, null]);
});

test('an unknown severity is kept as `other` rather than folded into a known tier', () => {
  const bundle = buildProseBundle({ sections, claims });
  const report = { 'sections/000.md': [
    alert({ Line: 3, Severity: 'error' }), alert({ Line: 3, Severity: 'suggestion' }), alert({ Line: 3, Severity: 'critical' }),
    alert({ Line: 3, Severity: 3 })
  ] };
  const { findings } = projectProseAlerts(report, bundle);
  assert.deepEqual(findings.map((finding) => finding.severity), ['error', 'suggestion', 'other', 'other']);
  assert.deepEqual(summarizeProseFindings(findings), { error: 1, warning: 0, suggestion: 1, other: 2, located: 4, unlocated: 0 });
});

test('an alert for a path we never sent is reported as dropped, not discarded', () => {
  const bundle = buildProseBundle({ sections, claims });
  const report = { 'sections/000.md': [alert({ Line: 3 })], 'elsewhere/999.md': [alert({ Line: 1 })] };
  const { findings, droppedUnits } = projectProseAlerts(report, bundle);
  assert.deepEqual(droppedUnits, ['elsewhere/999.md']);
  assert.equal(findings.length, 1);
});

test('the report is sorted by document order so a rerun reads the same way', () => {
  const bundle = buildProseBundle({ sections, claims });
  const report = {
    'sections/001.md': [alert({ Line: 3, Check: 'RocAcademicZ.Rule' })],
    'sections/000.md': [alert({ Line: 5, Check: 'RocAcademic.B' }), alert({ Line: 3, Check: 'RocAcademic.A' })]
  };
  const { findings } = projectProseAlerts(report, bundle);
  assert.deepEqual(findings.map((finding) => [finding.sectionIndex, finding.line]), [[0, 3], [0, 5], [1, 3]]);
});

test('a missing claim is a broken structure, not a section to skip silently', () => {
  // Skipping would make the report look cleaner than the manuscript is — the exact failure this
  // check exists to prevent.
  assert.throws(() => buildProseBundle({ sections: [{ title: 'X', claimIds: ['nope'] }], claims }), /research_prose_claim_missing/u);
  assert.throws(() => buildProseBundle({ sections: [], claims }), /research_prose_no_sections/u);
});

test('a malformed report is rejected rather than read as "nothing found"', () => {
  const bundle = buildProseBundle({ sections, claims });
  for (const report of [null, 'ok', 7, { 'sections/000.md': {} }]) {
    assert.throws(() => projectProseAlerts(report, bundle), /research_prose_report_invalid/u, JSON.stringify(report));
  }
});

test('missing fields degrade to a locatable-but-empty finding instead of throwing', () => {
  const bundle = buildProseBundle({ sections, claims });
  const { findings } = projectProseAlerts({ 'sections/000.md': [{ Line: 3, Check: 'Vale.Spelling' }] }, bundle);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].claimId, 'claim-a');
  assert.equal(findings[0].message, '');
  assert.deepEqual(findings[0].span, [0, 0]);
  // A check without a style prefix still yields a usable style label.
  assert.equal(findings[0].style, 'Vale');
  assert.equal(findings[0].rule, 'Spelling');
});

function alert(overrides) {
  return { Action: { Name: '', Params: null }, Suggestions: [], Span: [1, 5], Check: 'RocAcademic.Hedging',
    Description: '', Link: '', Message: 'hit', Severity: 'warning', Match: 'arguably', Line: 3, ...overrides };
}
