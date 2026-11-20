import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

const { validateQualityTaskOutput } = await importTypeScriptModule('evaluation/adapters/s01/validators.ts', { platform: 'node' });
const load = name => JSON.parse(readFileSync(new URL(`../fixtures/quality-evaluation/expected/long-memory-${name}.json`, import.meta.url)));
const studies = load('study-boundaries');
const release = load('release-constraints');
const grade = (validator, summary, citations = validator.citations) =>
  validateQualityTaskOutput(validator, JSON.stringify({ summary, citations }));
const studySummary = 'The fatigue study tested 60 endodontic files. The periodontal study enrolled 90 patients. Keep the studies separate.';
const releaseSummary = release.requiredPhrases.join('; ');

for (const [name, validator, summary] of [
  ['study numerals', studies, studySummary],
  ['study words', studies, 'The fatigue study tested sixty files. The periodontal study enrolled ninety patients. Keep the studies separate.'],
  ['release numerals and required negations', release, releaseSummary],
  ['release words', release, 'Twenty-one day total-protein window; fifteen-day FGF-2 window; do not make a clinical recommendation; preclinical, not human evidence'],
  ['same-sentence release constraints', release, release.requiredPhrases.join(', ')]
]) {
  test(`S01 memory accepts ${name}`, () => {
    assert.equal(grade(validator, summary).passed, true, JSON.stringify(grade(validator, summary)));
  });
}

for (const [name, summary] of [
  ['original falsehood exploit', 'It is false that there were 60 endodontic files. It is false that there were 90 patients. Do not keep the studies separate.'],
  ['leading negation', studySummary.replace('tested 60', 'did not test 60')],
  ['trailing negation', studySummary.replace('60 endodontic files.', '60 endodontic files is incorrect.')],
  ['contradiction after a correct answer', studySummary + ' It is false that there were 60 endodontic files.'],
  ['contraction', studySummary.replace('Keep the studies', "Don't keep the studies")],
  ['larger number substring', studySummary.replace('60 endodontic', '160 endodontic')],
  ['larger patient count', studySummary.replace('90 patients', '190 patients')],
  ['decimal count', studySummary.replace('60 endodontic', '60.5 endodontic')],
  ['word count mismatch', studySummary.replace('60 endodontic', 'ninety endodontic')],
  ['compound word count mismatch', studySummary.replace('60 endodontic', 'one hundred and sixty endodontic')],
  ['forbidden shared population', studySummary + ' They used the same population.']
]) {
  test(`S01 memory rejects ${name}`, () => assert.equal(grade(studies, summary).passed, false));
}

for (const [name, summary] of [
  ['negated release window', releaseSummary.replace('21-day', 'not a 21-day')],
  ['reversed clinical prohibition', releaseSummary.replace('do not make', 'make')],
  ['denied clinical prohibition', releaseSummary.replace('do not make', 'It is false that we should do not make')],
  ['denied preclinical qualification', releaseSummary.replace('preclinical,', 'It is incorrect that it is preclinical,')],
  ['wrong release duration', releaseSummary.replace('21-day', '121-day')],
  ['forbidden treatment claim', releaseSummary + '; proven treatment']
]) {
  test(`S01 memory rejects ${name}`, () => assert.equal(grade(release, summary).passed, false));
}

for (const [name, validator, summary] of [['studies', studies, studySummary], ['release', release, releaseSummary]]) {
  test(`S01 ${name} still requires the exact citation multiset`, () => {
    for (const citations of [[], ['unrelated-doi'], [...validator.citations, validator.citations[0]]]) {
      const result = grade(validator, summary, citations);
      assert.equal(result.passed, false);
      assert.ok(result.failures.includes('memory_citations'));
    }
    assert.equal(grade(validator, summary, [...validator.citations].reverse()).passed, true);
  });
}
