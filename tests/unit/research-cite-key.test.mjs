import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * Citation keys are the seam between Roc and everything outside it: the template's `\cite{…}`,
 * the collaborator's Zotero library, the submission system's reference list.
 *
 * Before this the key was `roc_<sha256 prefix>` — stable, and unreadable. Importing a `.bib`
 * that used `smith2020stutop` produced a library whose keys no longer matched the template, so
 * every `\cite` became "unknown" at export time (`citation-integrity.ts`) and the user saw
 * "export fails" instead of "your key changed".
 *
 * What is pinned here:
 *   1. the shape is Better BibTeX's default `authYearShorttitle` — the format a Zotero user
 *      already has in their template;
 *   2. collisions disambiguate with a trailing letter (never by rewriting the prefix), and the
 *      comparison is case-insensitive because BibTeX treats `Smith2020` and `smith2020` as one key;
 *   3. degenerate input (no authors, no year, CJK title) still yields a usable, deterministic key.
 */

const { betterBibtexKey, citationKeySet, citeKeyAuthor, citeKeyTitle } = await importTypeScriptModule(
  new URL('../../src/main/plugins/research/cite-key.ts', import.meta.url).pathname
);

test('作者取姓氏：逗号式与展示名两种写法都落到同一个词', () => {
  assert.equal(citeKeyAuthor('Smith, John'), 'smith');
  assert.equal(citeKeyAuthor('John Smith'), 'smith');
  assert.equal(citeKeyAuthor('Ann van der Berg'), 'berg');
  assert.equal(citeKeyAuthor('Ångström, Anders'), 'angstrom');
});

test('标题取前三个有效词的前三个字母，跳过虚词', () => {
  assert.equal(citeKeyTitle('A Study of the Topic'), 'stutop');
  assert.equal(citeKeyTitle('On the Origin of Species'), 'orispe');
  assert.equal(citeKeyTitle('Deep Learning'), 'deelea');
});

test('默认公式：作者 + 年份 + 标题片段，全小写', () => {
  const taken = citationKeySet([]);
  assert.equal(betterBibtexKey({ authors: ['Smith, John'], publishedYear: 2020, title: 'A Study of Topic' }, taken), 'smith2020stutop');
});

test('冲突追加消歧后缀，且大小写不敏感', () => {
  const taken = citationKeySet(['Smith2020Stutop']);
  assert.equal(betterBibtexKey({ authors: ['Smith, John'], publishedYear: 2020, title: 'A Study of Topic' }, taken), 'smith2020stutopa');
  assert.equal(betterBibtexKey({ authors: ['Smith, John'], publishedYear: 2020, title: 'A Study of Topic' }, taken), 'smith2020stutopb');
});

test('同一批里连续生成不会互相踩', () => {
  const taken = citationKeySet([]);
  const first = betterBibtexKey({ authors: ['Wang'], publishedYear: 2019, title: 'Same Title' }, taken);
  const second = betterBibtexKey({ authors: ['Wang'], publishedYear: 2019, title: 'Same Title' }, taken);
  assert.equal(first, 'wang2019samtit');
  assert.equal(second, 'wang2019samtita');
});

test('退化输入仍然确定性可用', () => {
  const taken = citationKeySet([]);
  assert.equal(betterBibtexKey({ authors: [], publishedYear: null, title: '研究' }, taken), 'anonnd');
  assert.equal(betterBibtexKey({ authors: ['王'], publishedYear: 2021, title: '方法学' }, taken), 'anon2021');
});
