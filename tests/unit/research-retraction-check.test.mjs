import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * A retracted paper has perfectly valid metadata: right key, right pages, right DOI. So the
 * citation-key gate (`citation-integrity.ts`) cannot see it — this check answers the other half
 * of the question ("does this paper still exist as evidence?").
 *
 * The property that matters most is the failure mode: an upstream contract change or a missing
 * flag must read as `unknown`, never as `clear`. Reporting "fine" on unknown input is worse than
 * reporting nothing, because the user acts on it.
 */

const { openAlexWorkUrl, readOpenAlexRetraction, unknownRetraction } =
  await importTypeScriptModule(new URL('../../src/main/plugins/research/retraction-check.ts', import.meta.url).pathname);

test('DOI 直接交给 OpenAlex 解析，不做本地 URL 猜测', () => {
  assert.equal(openAlexWorkUrl('10.1000/xyz'), 'https://api.openalex.org/works/https://doi.org/10.1000%2Fxyz');
});

test('is_retracted 为真 → retracted，并带上标题作为 detail', () => {
  assert.deepEqual(readOpenAlexRetraction({ is_retracted: true, title: 'A Study' }), {
    status: 'retracted', detail: 'openalex_is_retracted:A Study'
  });
});

test('查到了且没有撤稿标记 → clear', () => {
  assert.deepEqual(readOpenAlexRetraction({ is_retracted: false }), { status: 'clear', detail: null });
});

test('标记缺失或形状不对 → unknown，绝不读成 false', () => {
  assert.equal(readOpenAlexRetraction({}).status, 'unknown');
  assert.equal(readOpenAlexRetraction({ is_retracted: 'true' }).status, 'unknown');
  assert.equal(readOpenAlexRetraction(null).status, 'unknown');
  assert.equal(readOpenAlexRetraction([]).status, 'unknown');
});

test('unknown 结论自己带核查时点', () => {
  const result = unknownRetraction({ id: 'paper_1', citationKey: 'smith2020', doi: '10.1/x', detail: 'doi_missing', checkedAt: '2026-10-21T00:00:00.000Z' });
  assert.equal(result.status, 'unknown');
  assert.equal(result.checkedSource, 'openalex');
  assert.equal(result.checkedAt, '2026-10-21T00:00:00.000Z');
});
