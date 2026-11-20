import { mkdtempSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

/**
 * Preserve the local indexer's line/UTF-16 locators and parser-block source metadata. A generic
 * splitter change also needs retrieval-quality evidence, beyond matching these chunk contracts.
 */
async function loadIndexFiles() {
  const dir = mkdtempSync(realpathSync(join(tmpdir())) + '/roc-index-text-');
  const outfile = join(dir, 'index-files.mjs');
  await build({
    entryPoints: ['src/main/plugins/research/index-files.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    packages: 'bundle'
  });
  return { dir, files: await import(outfile) };
}

test('indexText keeps short text grouped by source lines', async () => {
  const { dir, files } = await loadIndexFiles();
  try {
    const result = files.indexText(Buffer.from('title\n\nbody text', 'utf8'));

    assert.equal(result.parserVersion, 'roc-paper-cl100k-2');
    assert.equal(result.content, 'title\n\nbody text');
    assert.deepEqual(result.chunks, [{ content: 'title\n\nbody text', locator: 'text; UTF-16 1-16', section: null }]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('indexText splits an oversized line without breaking UTF-16 surrogate pairs', async () => {
  const { dir, files } = await loadIndexFiles();
  try {
    const text = `${'界'.repeat(1999)}😀tail`;
    const result = files.indexText(Buffer.from(text, 'utf8'));

    assert.ok(result.chunks.length > 2);
    assert.equal(result.chunks.map((chunk) => chunk.content).join(''), text);
    let offset = 0;
    for (const chunk of result.chunks) {
      assert.equal(chunk.locator, `text; UTF-16 ${offset + 1}-${offset + chunk.content.length}`);
      offset += chunk.content.length;
      assert.ok(chunk.content.length <= 2000);
      const decoded = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(chunk.content, 'utf8'));
      assert.equal(decoded, chunk.content);
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('indexLocatedText preserves parser locators while splitting long extracted blocks', async () => {
  const { dir, files } = await loadIndexFiles();
  try {
    const text = 'x'.repeat(2001);
    const chunks = files.indexLocatedText(text, 'PDF page 7, paragraph 2');

    assert.equal(chunks.map((chunk) => chunk.content).join(''), text);
    assert.deepEqual(chunks.map((chunk) => chunk.locator), [
      'PDF page 7, paragraph 2; UTF-16 1-2000',
      'PDF page 7, paragraph 2; UTF-16 2001-2001'
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('indexText rejects malformed UTF-8 rather than indexing replacement characters', async () => {
  const { dir, files } = await loadIndexFiles();
  try {
    assert.throws(() => files.indexText(Buffer.from([0xff])), TypeError);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('structured text preserves CRLF, headings, paragraphs, literal tokens and multilingual token budgets',async()=>{
  const {dir,files}=await loadIndexFiles();
  const {getEncoding}=await import('js-tiktoken');const enc=getEncoding('cl100k_base');
  try {
    const text='# 方法\r\n\r\n'+('注意力机制 handles long context.\r\n'.repeat(80))+'\r\n## 限定条件\r\n\r\n<|endoftext|> 不代表所有任务。😀';
    const result=files.indexText(Buffer.from(text));
    assert.equal(result.content,text);
    assert.equal(result.chunks.map(chunk=>chunk.content).join(''),text);
    assert.ok(result.chunks.some(chunk=>chunk.section==='方法 / 限定条件'));
    for(const chunk of result.chunks) assert.ok(enc.encode(chunk.content,[],[]).length<=512);
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('parsed headings apply to following paragraph and table parents without changing their original text',async()=>{
  const {dir,files}=await loadIndexFiles();
  try {
    const chunks=files.indexDocumentBlocks([{id:'h',kind:'heading',text:'Results',locator:'p1'},
      {id:'p',kind:'paragraph',text:'exact  original\nparagraph',locator:'p2'},{id:'t',kind:'table',text:'a,b\n1,2',locator:'p3'}], {paperId:'paper',parseId:'parse',sourceHash:'a'.repeat(64)});
    assert.deepEqual(chunks.map(c=>c.section),['Results','Results','Results']);
    assert.equal(chunks[1].content,'exact  original\nparagraph');
    assert.equal(chunks[2].locator,'p3');
    assert.equal(chunks[1].semantic.semanticRole,'results');
    assert.deepEqual(chunks[1].semantic.relatedBlockIds,['t']);
    assert.equal(chunks[2].semantic.blockId,'t');
    const page='2 Method\nExact method.\n2.1 Architecture\nOriginal formula.';
    const pages=files.indexDocumentBlocks([{id:'page1',kind:'paragraph',text:page,locator:'PDF page 1'},
      {id:'page2',kind:'paragraph',text:'The architecture continues.',locator:'PDF page 2'}],
      {paperId:'paper',parseId:'parse',sourceHash:'a'.repeat(64)});
    assert.equal(pages[0].content,page);
    assert.equal(pages[0].semantic.blockId,'page1');
    assert.equal(pages[0].locator,'PDF page 1');
    assert.deepEqual(pages[1].semantic.sectionPath,['2 Method','2.1 Architecture']);
    assert.equal(pages[1].semantic.semanticRole,'method');
  }finally{rmSync(dir,{recursive:true,force:true});}
});
