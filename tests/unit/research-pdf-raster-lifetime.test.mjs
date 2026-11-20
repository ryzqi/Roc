import assert from 'node:assert/strict';
import {mkdtemp, readFile, readdir, rm, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';
import {createPerformancePdf} from '../../scripts/lib/research-pdf-performance-fixture.mjs';

const {withResearchPdf, renderResearchPdfPage} = await importTypeScriptModule(
  'src/main/plugins/research/pdf-render.ts', {platform: 'node',
    external: ['@napi-rs/canvas', 'pdfjs-dist/legacy/build/pdf.mjs'], tempDir: '.runtime/test-bundles'});

async function fixture(operation) {
  const root = await mkdtemp(join(tmpdir(), 'roc-raster-lifetime-'));
  try {
    return await withResearchPdf(Uint8Array.from(createPerformancePdf()), async pdf => {
      const page = await pdf.getPage(1), render = page.render.bind(page);
      let canvas;
      page.render = options => {canvas = options.canvas; return render(options);};
      try {return await operation({root, page, pdf, canvas: () => canvas});}
      finally {page.cleanup();}
    });
  } finally {await rm(root, {recursive: true, force: true});}
}

test('PNG and OCR pixels survive releasing the real native canvas after a page', async () => {
  await fixture(async ({root, page, pdf, canvas}) => {
    const image = await renderResearchPdfPage(page, 1, pdf.numPages, root);
    assert.equal(canvas().width, 0);
    assert.equal(canvas().height, 0);
    assert.equal(image.image.data.byteLength, image.width * image.height * 4);
    assert.ok(image.image.data.some(value => value !== 0));
    const png = await readFile(image.path);
    assert.equal(png.byteLength, image.pngBytes);
    assert.deepEqual(png.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });
});

for (const failure of ['render', 'encode', 'write', 'asset-limit']) {
  test(`native canvas is released after ${failure} fails, preserving the original error`, async () => {
    await fixture(async ({root, page, pdf, canvas}) => {
      const render = page.render.bind(page), expected = new Error(`fixture_${failure}`);
      page.render = options => {
        const task = render(options);
        if (failure === 'encode') options.canvas.encode = async () => {throw expected;};
        if (failure === 'render') return {promise: task.promise.then(() => {throw expected;})};
        return task;
      };
      if (failure === 'write') await writeFile(join(root, 'page-1.png'), 'existing');
      await assert.rejects(renderResearchPdfPage(page, 1, pdf.numPages, root, 1.5, false,
        failure === 'asset-limit' ? 1 : undefined),
      error => failure === 'write' ? error.code === 'EEXIST'
        : failure === 'asset-limit' ? error.code === 'research_document_asset_too_large'
          : error === expected);
      assert.equal(canvas().width, 0);
      assert.equal(canvas().height, 0);
    });
  });
}

test('an explicit OCR-only output plan does no PNG encoding or filesystem writes', async () => {
  await fixture(async ({root, page, pdf, canvas}) => {
    const render = page.render.bind(page);
    page.render = options => {
      options.canvas.encode = async () => {throw new Error('unexpected_png_encoding');};
      return render(options);
    };
    const image = await renderResearchPdfPage(page, 1, pdf.numPages, root, 1.5, false, 1,
      {needPngArtifact: false, includeRgbaImage: true});
    assert.equal(image.path, null);
    assert.equal(image.pngBytes, 0);
    assert.equal(image.image.data.byteLength, image.width * image.height * 4);
    assert.deepEqual(await readdir(root), []);
    assert.equal(canvas().width, 0);
  });
});

test('a failed PDF initialization is followed by a usable document and operation failures still propagate', async () => {
  await assert.rejects(withResearchPdf(new Uint8Array([1, 2, 3]), async () => assert.fail('invalid PDF opened')));
  const expected = new Error('fixture_operation_failed');
  await assert.rejects(withResearchPdf(Uint8Array.from(createPerformancePdf()), async () => {throw expected;}),
    error => error === expected);
  await withResearchPdf(Uint8Array.from(createPerformancePdf()), async pdf => assert.equal(pdf.numPages, 400));
});
