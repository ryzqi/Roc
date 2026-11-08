import {test} from 'node:test';
import assert from 'node:assert/strict';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

const {createPdfTextCache} = await importTypeScriptModule('src/renderer/literature/pdf-text-cache.ts');
function documentFixture(text = number => `Page ${number}`) {
  const calls = [];
  return {calls, pdf: {async getPage(number) {
    calls.push(number);
    return {async getTextContent() {return {items: [{str: text(number), hasEOL: true}]};}};
  }}};
}

test('searching a 400-page document retains only the last 32 pages and preserves all text', async () => {
  const {pdf, calls} = documentFixture();
  const read = createPdfTextCache(pdf);
  for (let number = 1; number <= 400; number++) assert.equal(await read(number), `Page ${number}\n`);
  for (let number = 369; number <= 400; number++) await read(number);
  assert.equal(calls.length, 400);
  assert.equal(await read(368), 'Page 368\n');
  assert.equal(calls.length, 401);
});

test('character budget and LRU bound text independently of page count; oversized text remains readable', async () => {
  const {pdf, calls} = documentFixture(number => number === 4 ? '123456789' : 'abc');
  const read = createPdfTextCache(pdf, {maxPages: 32, maxCharacters: 8});
  await read(1); await read(2); await read(1); await read(3);
  await read(1); assert.equal(calls.length, 3);
  await read(2); assert.equal(calls.length, 4);
  assert.equal(await read(4), '123456789\n');
  assert.equal(await read(4), '123456789\n');
  assert.equal(calls.length, 6);
});

test('parallel readers share extraction, failed reads are retryable, documents never share text', async () => {
  let calls = 0, finish;
  const read = createPdfTextCache({getPage() {
    calls++;
    return new Promise((resolve, reject) => {finish = {resolve, reject};});
  }});
  const first = read(1), second = read(1);
  assert.equal(first, second); assert.equal(calls, 1);
  finish.reject(new Error('extraction failed'));
  await assert.rejects(first, /extraction failed/);
  const retry = read(1);
  finish.resolve({async getTextContent() {return {items: [{str: 'recovered', hasEOL: false}]};}});
  assert.equal(await retry, 'recovered '); assert.equal(calls, 2);
  const other = createPdfTextCache(documentFixture(() => 'other document').pdf);
  assert.equal(await other(1), 'other document\n');
  assert.equal(await read(1), 'recovered ');
});
