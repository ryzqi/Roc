import { test } from 'node:test';
import assert from 'node:assert/strict';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';

/**
 * The arXiv preflight answers two questions the compile gate cannot:
 *
 *   * which template files actually take part in the build (so the rest can be dropped from
 *     `source/` instead of shipped), and
 *   * what would still be wrong with the ZIP if a human uploaded it to arXiv, where `pdflatex`
 *     runs once and BibTeX does not run at all.
 *
 * The properties pinned here are the conservative ones: a `.tex` that is merely *mentioned*
 * anywhere in the reachable tree is kept, comments and `verbatim` content never create
 * "missing file" noise, and findings are warnings — the preflight must never be the reason a
 * legitimate export fails.
 */

const { latexReachability, prunableTexFiles, runArxivPreflight, isPortableFileName, stripLatexComments } =
  await importTypeScriptModule(new URL('../../src/main/plugins/research/arxiv-preflight.ts', import.meta.url).pathname);

function tree(entries) {
  return new Map(Object.entries(entries));
}

test('引用闭包沿 \\input / \\include 走到叶子，并解析相对路径', () => {
  const files = tree({
    'main.tex': '\\input{sec/intro}\n\\include{sections/method}',
    'sec/intro.tex': 'intro',
    'sections/method.tex': '\\subfile{sections/deep}',
    'sections/deep.tex': 'deep',
    'unused.tex': 'unused'
  });
  const result = latexReachability({ entryPath: 'main.tex', files });
  assert.deepEqual(result.texFiles, ['main.tex', 'sec/intro.tex', 'sections/deep.tex', 'sections/method.tex']);
  assert.deepEqual(result.missing, []);
});

test('注释里的 \\input 不算引用（否则剪枝永远看不到真正到不了的文件）', () => {
  const files = tree({
    'main.tex': '% \\input{old.tex}\n\\input{live}',
    'live.tex': 'live',
    'old.tex': 'old'
  });
  assert.deepEqual(latexReachability({ entryPath: 'main.tex', files }).texFiles, ['live.tex', 'main.tex']);
});

test('到不了、也没被提到的 .tex 才会被剪；被提到的保留', () => {
  const files = tree({
    'main.tex': '\\input{body}\n% 备用入口在 main-alt.tex',
    'body.tex': 'body',
    'orphan.tex': 'orphan',
    'main-alt.tex': 'alt'
  });
  const reachable = latexReachability({ entryPath: 'main.tex', files }).texFiles;
  assert.deepEqual(prunableTexFiles({ entryPath: 'main.tex', files, reachable }), ['orphan.tex']);
});

test('缺图与缺 \\input 目标都会报出来，但不抛错', () => {
  const files = tree({ 'main.tex': '\\input{gone}\n\\includegraphics[width=1in]{figures/plot}' });
  const result = latexReachability({ entryPath: 'main.tex', files });
  assert.deepEqual(result.missing.map((entry) => entry.name).sort(), ['figures/plot', 'gone']);
});

test('用 BibTeX 却没有 .bbl 是警告（arXiv 不跑 BibTeX）', () => {
  const files = tree({ 'main.tex': '\\bibliographystyle{plain}\n\\bibliography{refs}\n\\input{body}', 'body.tex': 'body' });
  const withoutBbl = runArxivPreflight({ entryPath: 'main.tex', texFiles: files, files: [{ path: 'main.tex', size: 10 }], bbl: null });
  assert.deepEqual(withoutBbl.findings.map((finding) => finding.code), ['missing_bbl']);
  const withBbl = runArxivPreflight({ entryPath: 'main.tex', texFiles: files, files: [{ path: 'main.tex', size: 10 }], bbl: 'main.bbl' });
  assert.deepEqual(withBbl.findings, []);
});

test('草稿标记、绝对路径、文件名、图稿体积各自成为一条带定位的警告', () => {
  const files = tree({
    'main.tex': [
      '\\todo{finish this}',
      '% TODO rewrite the intro',
      '\\iffalse hidden \\fi',
      '\\includegraphics{/Users/somebody/plot.pdf}'
    ].join('\n'),
    'figures/big plot.pdf': ''
  });
  const result = runArxivPreflight({
    entryPath: 'main.tex',
    texFiles: files,
    files: [{ path: 'main.tex', size: 100 }, { path: 'figures/big plot.pdf', size: 6 * 1024 * 1024 }],
    bbl: null
  });
  const codes = result.findings.map((finding) => finding.code);
  for (const expected of ['todo_markup', 'draft_markup', 'conditional_block', 'absolute_path', 'filename_not_portable', 'figure_size']) {
    assert.ok(codes.includes(expected), `期望有 ${expected}，实际 ${codes.join(',')}`);
  }
  const todo = result.findings.find((finding) => finding.code === 'todo_markup');
  assert.equal(todo.line, 1);
  assert.equal(todo.severity, 'warning');
});

test('图稿扩展名只认 arXiv 接受的四种', () => {
  const files = tree({ 'main.tex': '\\includegraphics{figures/a.tiff}' });
  const result = runArxivPreflight({ entryPath: 'main.tex', texFiles: files, files: [{ path: 'figures/a.tiff', size: 10 }], bbl: null });
  assert.ok(result.findings.some((finding) => finding.code === 'figure_extension'));
});

test('文件名可移植性只看 ASCII 与空格', () => {
  assert.equal(isPortableFileName('source/main.tex'), true);
  assert.equal(isPortableFileName('source/图表.tex'), false);
  assert.equal(isPortableFileName('source/my plot.pdf'), false);
});

test('注释剥离不碰 \\%', () => {
  assert.equal(stripLatexComments('50\\% of it % trailing'), '50\\% of it ');
});
