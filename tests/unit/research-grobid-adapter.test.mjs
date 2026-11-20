import {test, before, after} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {createServer} from 'node:http';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let grobid, scholarly;
before(async () => {
  [grobid, scholarly] = await Promise.all([
    importTypeScriptModule('src/main/plugins/research/grobid-adapter.ts', {platform: 'node'}),
    importTypeScriptModule('src/main/plugins/research/scholarly-parser-adapter.ts', {platform: 'node'})
  ]);
});
after(() => {});
const digest = value => createHash('sha256').update(value).digest('hex');
const pdf = Buffer.from('%PDF-1.7\ncontrolled transport fixture\n');
const xml = `<?xml version="1.0" encoding="UTF-8"?>
<TEI xmlns="http://www.tei-c.org/ns/1.0">
<teiHeader><fileDesc><titleStmt><title>Fallback title</title></titleStmt><sourceDesc><biblStruct>
<analytic><title level="a">Source &amp; Study</title><author><persName><forename>Alice</forename><surname>Chen</surname></persName></author></analytic>
<monogr><imprint><date when="2024"/></imprint></monogr><idno type="DOI">10.1/test</idno></biblStruct></sourceDesc></fileDesc></teiHeader>
<facsimile><surface n="1" ulx="0" uly="0" lrx="600" lry="800"/></facsimile>
<text><body><div><head xml:id="s1" n="1" coords="1,40,60,100,15">Introduction</head>
<p>  The original study <ref type="bibr" target="#b1" coords="1,160,100,15,10">[1]</ref> reports a result. </p>
<p>Another source <ref type="bibr" target="#b1 #missing https://example.test/ref">[1, 2]</ref> remains incomplete.</p>
<div><head xml:id="s2" n="1.1">Background</head></div></div></body><back><listBibl><biblStruct xml:id="b1" coords="1,40,700,300,20">
<analytic><title level="a">Earlier Source</title></analytic><note type="raw_reference">A. Chen. Earlier Source.</note></biblStruct></listBibl></back></text></TEI>`;
const block = (id, text) => ({id, text, kind: 'paragraph', page: 1, bbox: null, locator: `pdf:1:${id}`, assetId: null});
const blocks = [block('title', 'Source & Study'), block('body', 'Introduction\n\nThe original study  [1] reports a result.\nBackground'),
  block('second', 'Another source [1, 2] remains incomplete.'), block('refs', 'A. Chen. Earlier Source.')];

test('extracts source metadata, nested sections, raw references and citation targets without promoting missing fields', () => {
  const result = grobid.parseGrobidTei(xml);
  assert.deepEqual(result.fields.metadata, {title: 'Source & Study', authors: ['Alice Chen'], doi: '10.1/test', year: '2024'});
  assert.deepEqual(result.fields.sections.map(s => [s.id, s.parentId, s.number]), [['s1', null, '1'], ['s2', 's1', '1.1']]);
  assert.equal(result.fields.references[0].rawCitation, 'A. Chen. Earlier Source.');
  assert.deepEqual(result.fields.citationMarkers[1].referenceIds, ['b1']);
  assert.deepEqual(result.fields.citationMarkers[1].unresolvedTargets, ['#missing', 'https://example.test/ref']);
  assert.equal(result.fields.sections[0].location.coordinateSystem, 'grobid-pdf-point-top-left');
  assert.deepEqual(result.fields.sections[0].location.boxes[0], {page: 1, x: 40, y: 60, width: 100, height: 15, pageWidth: 600, pageHeight: 800});
  const resolved = scholarly.crossValidateGrobid(result.fields, blocks);
  assert.ok(resolved.every(r => r.status === 'matched'));
  for (const r of resolved) assert.equal(blocks.find(b => b.id === r.blockId).text.slice(r.start, r.end), r.originalText);
  assert.equal(resolved.find(r => r.kind === 'citation_marker').originalText, '[1]');
  assert.deepEqual(scholarly.crossValidateGrobid(result.fields, [...blocks, block('duplicate', 'Source & Study')])[0].status, 'ambiguous');
});

test('invalid/missing TEI coordinate frames remain explicit and cannot acquire Roc raster locators', () => {
  for (const bad of ['1,-1,60,100,15', '2,40,60,100,15', '1,40,60,900,15', '1,40,60,NaN,15', '1,40,60,100']) {
    const result = grobid.parseGrobidTei(xml.replace('1,40,60,100,15', bad));
    assert.equal(result.fields.sections[0].location.status, 'invalid');
    assert.deepEqual(result.fields.sections[0].location.boxes, []);
    assert.ok(result.warnings.includes('research_grobid_coordinates_invalid'));
  }
  assert.equal(grobid.parseGrobidTei(xml.replace(/<facsimile>.*?<\/facsimile>/su, '')).fields.sections[0].location.status, 'invalid');
  for (const bad of ['<TEI>', '<html/>', '<!DOCTYPE TEI [<!ENTITY ext SYSTEM "file:///etc/passwd">]><TEI/>',
    xml.replace('xml:id="s2"', 'xml:id="s1"')]) assert.throws(() => grobid.parseGrobidTei(bad));
  for (const unsupported of ['<tei><text/></tei>', '<teiCorpus><TEI/></teiCorpus>']) {
    assert.throws(() => grobid.parseGrobidTei(unsupported), /research_grobid_output_unsupported/);
  }
});

test('source binding and complete proposal validation reject altered TEI, source blocks, fields and intervals', async () => {
  const result = await scholarly.enrichScholarlyFields(pdf, digest(pdf), blocks, {identity: 'fixture', parse: async () => xml}, new AbortController().signal);
  assert.equal(result.status, 'parsed'); assert.deepEqual(result.missingFields, []);
  assert.equal(result.teiHash, digest(xml)); assert.equal(result.rawTei, xml);
  for (const mutate of [r => {r.teiHash = 'a'.repeat(64);}, r => {r.rawTei += ' ';},
    r => {r.fields.metadata.title = 'invented';}, r => {r.resolutions[0].start++;}, r => {r.missingFields = ['metadata'];}]) {
    const bad = structuredClone(result); mutate(bad);
    assert.throws(() => scholarly.assertScholarlyEnrichment(bad, digest(pdf), blocks));
  }
  assert.throws(() => scholarly.assertScholarlyEnrichment(result, 'a'.repeat(64), blocks));
  assert.throws(() => scholarly.assertScholarlyEnrichment(result, digest(pdf), [block('changed', 'Source & Study'), ...blocks.slice(1)]));
  await assert.rejects(scholarly.enrichScholarlyFields(pdf, 'b'.repeat(64), blocks, null, new AbortController().signal));
});

test('disabled, unavailable, invalid and empty service results retain original Roc sources', async () => {
  const original = structuredClone(blocks), signal = new AbortController().signal;
  const disabled = await scholarly.enrichScholarlyFields(pdf, digest(pdf), blocks, null, signal);
  assert.equal(disabled.status, 'disabled');
  assert.deepEqual(disabled.missingFields, ['metadata', 'sections', 'references', 'citation_markers', 'coordinates']);
  for (const [code, status] of [['research_grobid_unavailable', 'unavailable'], ['research_grobid_http_failed', 'failed'],
    ['research_grobid_empty', 'failed'], ['research_grobid_response_too_large', 'failed']]) {
    const result = await scholarly.enrichScholarlyFields(pdf, digest(pdf), blocks,
      {identity: 'fixture', parse: async () => {throw new Error(code);}}, signal);
    assert.equal(result.status, status); assert.equal(result.failureCode, code); assert.equal(result.fields, null);
  }
  const invalid = await scholarly.enrichScholarlyFields(pdf, digest(pdf), blocks, {identity: 'fixture', parse: async () => '<TEI>'}, signal);
  assert.equal(invalid.failureCode, 'research_grobid_output_invalid');
  const partial = await scholarly.enrichScholarlyFields(pdf, digest(pdf), blocks, {identity: 'fixture', parse: async () => '<TEI><text><body/></text></TEI>'}, signal);
  assert.equal(partial.status, 'parsed'); assert.equal(partial.missingFields.length, 5);
  assert.deepEqual(blocks, original);
});

test('parent cancellation and deadline prevent a noncooperative service from publishing late output', async t => {
  const parent = new AbortController(); let release, received;
  const adapter = {identity: 'fixture', parse: (_pdf, signal) => {received = signal; return new Promise(resolve => {release = resolve;});}};
  const pending = scholarly.enrichScholarlyFields(pdf, digest(pdf), blocks, adapter, parent.signal);
  parent.abort(new Error('parent-stop'));
  await assert.rejects(pending, /parent-stop/); assert.equal(received.aborted, true); release(xml);
  t.mock.timers.enable({apis: ['setTimeout']});
  const deadline = scholarly.enrichScholarlyFields(pdf, digest(pdf), blocks, adapter, new AbortController().signal);
  t.mock.timers.tick(30_001);
  const result = await deadline;
  assert.equal(result.status, 'timed_out'); assert.equal(result.rawTei, null);
  release(xml); await Promise.resolve(); assert.equal(result.rawTei, null);
});

test('optional service input cap preserves Roc PDFs accepted by the existing 512 MiB source contract', async () => {
  const large = Buffer.alloc(128 * 1024 * 1024 + 1); large.write('%PDF-');
  const sourceHash = digest(large), signal = new AbortController().signal;
  const disabled = await scholarly.enrichScholarlyFields(large, sourceHash, blocks, null, signal);
  assert.equal(disabled.status, 'disabled');
  let calls = 0;
  const limited = await scholarly.enrichScholarlyFields(large, sourceHash, blocks,
    {identity: 'fixture', parse: async () => {calls++; return xml;}}, signal);
  assert.equal(calls, 0);
  assert.equal(limited.status, 'failed');
  assert.equal(limited.failureCode, 'research_grobid_input_too_large');
  assert.equal(limited.fields, null);
});

test('real loopback HTTP request sends original bytes and repeated coordinate fields with no consolidation or redirects', async () => {
  let requestBody = '';
  const server = createServer(async (req, res) => {
    assert.equal(req.url, '/api/processFulltextDocument');
    for await (const part of req) requestBody += part.toString();
    res.writeHead(200, {'Content-Type': 'application/xml'}); res.end(xml);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const adapter = new grobid.GrobidAdapter(`http://127.0.0.1:${server.address().port}`);
    assert.equal(await adapter.parse(pdf, new AbortController().signal), xml);
    assert.ok(requestBody.includes(pdf.toString()));
    assert.equal((requestBody.match(/name="teiCoordinates"/gu) ?? []).length, 7);
    for (const field of ['consolidateHeader', 'consolidateCitations', 'consolidateFunders']) {
      assert.match(requestBody, new RegExp(`name="${field}"\\r\\n\\r\\n0\\r\\n`, 'u'));
    }
    for (const endpoint of ['https://service.example', 'http://10.1.1.1', 'http://user:secret@localhost', 'http://localhost?token=test']) {
      assert.throws(() => new grobid.GrobidAdapter(endpoint), /local_endpoint_required/);
    }
    const redirect = new grobid.GrobidAdapter('http://localhost', async (_url, options) => {
      assert.equal(options.redirect, 'error'); return new Response('', {status: 503});
    });
    await assert.rejects(redirect.parse(pdf, new AbortController().signal), /http_failed/);
    const oversized = new grobid.GrobidAdapter('http://localhost', async () => new Response('x'.repeat(8 * 1024 * 1024 + 1)));
    await assert.rejects(oversized.parse(pdf, new AbortController().signal), /response_too_large/);
  } finally {await new Promise(resolve => server.close(resolve));}
});
