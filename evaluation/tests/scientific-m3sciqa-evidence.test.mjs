import assert from 'node:assert/strict';
import test from 'node:test';
import {degrees, PDFDocument, StandardFonts} from 'pdf-lib';
import {alignM3Evidence, extractM3PdfText, normalizedM3Text, verifyM3EvidenceArtifact} from '../adapters/scientific-public/m3sciqa-evidence.mjs';
import {sha256} from '../lib/common.mjs';

const passage = 'External natural questions improve word diversity and structural diversity.';
const label = (evidence = passage) => ({id: 'example:0', publishedRow: 0,
  original: {reference_arxiv_id: '2309.14362', evidence_reference: evidence}});

async function actualPdf({repeat = false, rotated = false, lines = null} = {}) {
  const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica);
  for (let i = 0; i < (repeat ? 2 : 1); i++) {
    const page = pdf.addPage([612, 792]);
    if (rotated) {page.setRotation(degrees(90));page.setCropBox(20, 40, 560, 720);}
    (lines ?? [`Context. ${passage} Following context.`]).forEach((text, line) => {
      page.drawText(text, {x: 60, y: 700 - line * 18, size: 10, font});
    });
  }
  const bytes = await pdf.save();
  return {bytes, document: await extractM3PdfText(bytes, sha256(bytes))};
}

test('full normalized passage binds original item intervals and font-metric geometry', async () => {
  const {document} = await actualPdf();
  const result = alignM3Evidence(label(), document);
  assert.equal(result.status, 'unique-normalized-text-match');
  assert.equal(result.matches.length, 1);
  const match = result.matches[0], item = match.items[0];
  assert.equal(match.normalizedPassageHash, result.normalizedEvidenceHash);
  assert.equal(item.selectedText, passage);
  assert.equal(item.utf16[0], 'Context. '.length);
  assert.equal(item.rawText, `Context. ${passage} Following context.`);
  assert.equal(item.geometry.granularity, 'whole-text-item');
  assert.equal(item.geometry.humanLocatorReview, false);
  assert.equal(match.sourceHash, document.sourceHash);
});
test('rotated non-default CropBox retains actual PDF and viewport quadrilaterals', async () => {
  const {document} = await actualPdf({rotated: true});
  const result = alignM3Evidence(label(), document);
  assert.equal(result.status, 'unique-normalized-text-match');
  const match = result.matches[0], geometry = match.items[0].geometry;
  assert.equal(match.frame.rotation, 90);
  assert.deepEqual(match.frame.viewBox, [20, 40, 580, 760]);
  for (let i = 0; i < 4; i++) {
    const [x, y] = geometry.pdfQuad[i], [a, b, c, d, e, f] = match.frame.transform;
    assert.deepEqual(geometry.viewportQuad[i], [a * x + c * y + e, b * x + d * y + f]);
  }
  assert.ok(geometry.bbox[0] >= 0 && geometry.bbox[2] <= match.frame.width);
  assert.ok(geometry.bbox[1] >= 0 && geometry.bbox[3] <= match.frame.height);
});
test('line-end dehyphenation preserves exact item provenance without arbitrary word changes', async () => {
  const {document} = await actualPdf({lines: ['External natu-', 'ral questions improve word diversity and structural diversity.']});
  const result = alignM3Evidence(label(), document);
  assert.equal(result.status, 'unique-normalized-text-match');
  assert.equal(result.matches[0].items.length, 2);
  assert.equal(result.matches[0].items[0].selectedText, 'External natu');
  assert.equal(result.matches[0].items[1].selectedText, 'ral questions improve word diversity and structural diversity.');
  assert.equal(normalizedM3Text([{str: 'natu-ral', hasEOL: false}]).text, 'natu-ral');
});
test('NFKC ligature expansion keeps original UTF-16 offsets and word boundaries', () => {
  const normalized = normalizedM3Text([{str: 'A ﬁgure 😀.', hasEOL: false}]);
  assert.equal(normalized.text, 'A figure 😀.');
  assert.deepEqual(normalized.units.slice(2, 4).map(unit => [unit.start, unit.end]), [[2, 3], [2, 3]]);
  assert.deepEqual(normalized.units.slice(-3, -1).map(unit => [unit.start, unit.end]), [[8, 10], [8, 10]]);
});
test('duplicate original passages remain ambiguous instead of choosing a convenient page', async () => {
  const {document} = await actualPdf({repeat: true});
  const result = alignM3Evidence(label(), document);
  assert.equal(result.status, 'ambiguous');
  assert.deepEqual(result.matches.map(match => match.page), [1, 2]);
});
test('unmatched math, missing source/evidence and incomplete evidence retain explicit failures', async () => {
  const {document} = await actualPdf();
  assert.equal(alignM3Evidence(label(''), document).status, 'missing-published-evidence');
  assert.equal(alignM3Evidence(label(), null).status, 'source-unavailable');
  assert.equal(alignM3Evidence(label('diversity'), document).status, 'insufficient-exact-text');
  assert.equal(alignM3Evidence(label(`${passage} Equation $x_{t+1}$.`), document).status, 'not-found');
  assert.equal(alignM3Evidence(label(passage.toLowerCase()), document).status, 'not-found');
});
test('a passage inside a longer word is not an exact evidence occurrence', async () => {
  const {document} = await actualPdf({lines: [`X${passage}`]});
  assert.equal(alignM3Evidence(label(), document).status, 'not-found');
});
test('unavailable item geometry cannot be reported as a located passage', async () => {
  const {document} = await actualPdf();
  document.pages[0].items[0].geometry = null;
  const result = alignM3Evidence(label(), document);
  assert.equal(result.status, 'geometry-unavailable');
  assert.equal(result.matches[0].geometryAvailable, false);
});
test('source and reconstructed interval/coordinate tampering fail even with recomputed hashes', async () => {
  const {bytes, document} = await actualPdf();
  await assert.rejects(extractM3PdfText(bytes, '0'.repeat(64)), /source_changed/);
  const expected = alignM3Evidence(label(), document);
  assert.equal(verifyM3EvidenceArtifact(expected, expected).verified, true);
  for (const tamper of [result => {result.matches[0].items[0].utf16[0] = 0;},
    result => {result.matches[0].items[0].geometry.bbox[0] = 0;},
    result => {result.status = 'not-found';result.matches = [];}]) {
    const changed = structuredClone(expected);
    tamper(changed);
    assert.throws(() => verifyM3EvidenceArtifact(changed, expected), /artifact_changed/);
  }
});
