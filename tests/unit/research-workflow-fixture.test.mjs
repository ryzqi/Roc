import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { test } from 'node:test';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

const root = new URL('../fixtures/research-workflow/', import.meta.url);

test('frozen synthetic research fixture contains precisely the licensed files and byte hashes', async () => {
  const manifest = JSON.parse(await readFile(new URL('manifest.json', root), 'utf8'));
  assert.equal(manifest.license, 'CC0-1.0');
  assert.deepEqual(manifest.files.map((entry) => entry.path), (await readdir(root)).filter((path) => path !== 'manifest.json').sort());
  for (const entry of manifest.files) {
    const bytes = await readFile(new URL(entry.path, root));
    assert.equal(bytes.length, entry.size, entry.path);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, entry.path);
  }
});

test('original PDF fixture exposes the exact source text and page recorded in metadata', async () => {
  const literature = JSON.parse(await readFile(new URL('literature.json', root), 'utf8'));
  const loading = getDocument({
    data: new Uint8Array(await readFile(new URL(literature.source, root))),
    useSystemFonts: true
  });
  try {
    const document = await loading.promise;
    assert.equal(document.numPages, 1);
    const page = await document.getPage(literature.locator.page);
    const text = await page.getTextContent();
    assert.equal(text.items.map((entry) => entry.str).join(''), literature.excerpt);
  } finally {
    await loading.destroy();
  }
});
