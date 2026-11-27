import {before, after, test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, realpath, readFile, readdir, symlink, writeFile, rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {PDFDocument, PDFName, PDFString, StandardFonts} from 'pdf-lib';
import {createResearchFixture, loadResearchTestApi} from './fixtures/research-test-kit.mjs';
import {importTypeScriptModule} from '../../scripts/lib/bundle-ts.mjs';

let api, bibliographyTools, inspectPdfImportMetadata, ScientificLibraryIndexService, moduleRoot;
before(async () => {
  moduleRoot = await mkdtemp(join(tmpdir(), 'roc-auto-import-modules-'));
  await symlink(join(process.cwd(), 'node_modules'), join(moduleRoot, 'node_modules'), 'dir');
  [api, bibliographyTools, {inspectPdfImportMetadata}, {ScientificLibraryIndexService}] = await Promise.all([
    loadResearchTestApi(),
    ...['bibliography', 'document-import-metadata', 'scientific-library-index'].map(name =>
      importTypeScriptModule(`src/main/plugins/research/${name}.ts`, {platform: 'node',
        external: ['@napi-rs/canvas', 'pdfjs-dist', 'pdfjs-dist/*'], tempDir: moduleRoot}))
  ]);
});
after(async () => {api?.dispose(); if (moduleRoot) await rm(moduleRoot, {recursive: true, force: true});});

const hash = value => createHash('sha256').update(value).digest('hex');
const config = {id: 'auto-import', name: 'Fixture', baseUrl: 'https://fixture.invalid', model: 'fixture', dimensions: 3, enabled: true};
const xmlEscape = value => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;');

async function pdfBytes({title = 'Embedded local title', author = 'Local Writer', doi = null, subject = null,
  custom = {}, xmp = null, text = null} = {}) {
  const pdf = await PDFDocument.create();
  if (title !== null) pdf.setTitle(title);
  if (author !== null) pdf.setAuthor(author);
  if (subject !== null) pdf.setSubject(subject);
  pdf.setCreationDate(new Date('2001-01-02T00:00:00Z'));
  pdf.setModificationDate(new Date('2026-11-27T00:00:00Z'));
  const info = pdf.context.lookup(pdf.context.trailerInfo.Info);
  for (const [name, value] of Object.entries({...custom, ...(doi === null ? {} : {DOI: doi})})) {
    info.set(PDFName.of(name), PDFString.of(value));
  }
  if (xmp !== null) {
    const stream = pdf.context.stream(Buffer.from(xmp), {Type: 'Metadata', Subtype: 'XML'});
    pdf.catalog.set(PDFName.of('Metadata'), pdf.context.register(stream));
  }
  const font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([600, 800]);
  const lines = text ?? [title ?? 'Original article', '2 Method',
    'Autopdfretrievalsentinel proves that the original PDF body is searchable.',
    'The experiment preserves immutable source bytes and stable citations.'];
  lines.forEach((line, index) => page.drawText(line, {x: 30, y: 760 - index * 35, size: index === 0 ? 16 : 11, font}));
  return Buffer.from(await pdf.save());
}

async function fixture({fetcher = null, afterNormalize = null, metadataPreparation = true} = {}) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'roc-document-auto-import-')));
  const f = createResearchFixture(api, 'reading', root);
  const requests = [];
  const tools = {
    readBibliography: async input => (await bibliographyTools.readResearchBibliography(input)).entries,
    normalizeBibliography: async input => {
      const entries = (await bibliographyTools.normalizeResearchBibliography(input)).entries;
      await afterNormalize?.(input);
      return entries;
    },
    defaultParseOptions: () => ({tier: 'compact', device: 'cpu', pageRange: ''}),
    parseDocument: input => api.parseResearchDocument({...input, modelFiles: null, modelManifest: ''})
  };
  const fetch = async (url, init) => {
    requests.push({url, signal: init.signal});
    if (fetcher !== null) return await fetcher(url, init);
    const doi = decodeURIComponent(new URL(url).pathname.slice(1));
    return Response.json({type: 'journal-article', DOI: doi, title: 'Verified import metadata',
      author: [{family: 'Lovelace', given: 'Ada'}], issued: {'date-parts': [[2024, 2, 3]]},
      abstract: 'Provider abstract', URL: `https://doi.org/${doi}`});
  };
  const library = new api.ResearchLibraryService(f.repository.library, tools, root, fetch);
  f.repository.knowledge.saveEmbeddingConfig(config, 'test-secret');
  const embeddings = new api.ResearchEmbeddingService(f.repository.knowledge,
    {embed: async ({texts}) => texts.map(() => [3, 4, 0])},
    {secrets: {get: async () => 'test-key'}, logger: {info() {}, warn() {}, error() {}}});
  const scientific = new ScientificLibraryIndexService(f.repository, embeddings, root);
  const documents = new api.ResearchDocumentService(f.repository, tools, root, null, null, scientific,
    metadataPreparation ? (doi, projectId, signal) => library.prepareDoi(doi, projectId, signal) : null);
  const handlers = new Map();
  api.registerResearchDocumentCapabilities({pluginId: 'research', capabilities: {
    register(_pluginId, capability, handler) {handlers.set(capability.name, {capability, handler});}
  }}, f.repository.documents, documents);
  const importRequest = async input => {
    const {capability, handler} = handlers.get('research.document.import');
    return await handler(capability.inputSchema.parse(input));
  };
  const importPdf = async (bytes, {filename = 'selected.pdf', metadataMode = 'automatic', ...fields} = {}) => {
    const sourcePath = join(root, filename);
    await writeFile(sourcePath, bytes);
    return await importRequest({target: 'new-item', sourcePath, title: 'Filename fallback', citationKey: 'fallback',
      projectId: f.project.id, ...(metadataMode === null ? {} : {metadataMode}), ...fields});
  };
  return {...f, root, requests, documents, scientific, importRequest, importPdf,
    close: async () => {
      await documents.shutdown(); await library.shutdown(); await embeddings.shutdown();
      await f.close(); await rm(root, {recursive: true, force: true});
    }};
}

test('automatic real PDF metadata and exact DOI CSL precede creation, then original text reaches both indexes', async () => {
  const f = await fixture();
  try {
    const bytes = await pdfBytes({doi: 'https://doi.org/10.5555/Automatic-PDF'});
    const document = await f.importPdf(bytes), item = f.repository.library.get(document.libraryItemId);
    assert.equal(document.status, 'imported');
    assert.equal(document.sourceHash, hash(bytes));
    assert.deepEqual(await readFile(join(f.root, f.repository.documents.sourcePath(document.id))), bytes);
    assert.equal(f.requests.length, 1);
    assert.equal(decodeURIComponent(new URL(f.requests[0].url).pathname.slice(1)), '10.5555/automatic-pdf');
    assert.equal(item.metadata.title, 'Verified import metadata');
    assert.deepEqual(item.metadata.authors, ['Ada Lovelace']);
    assert.equal(item.metadata.publishedYear, 2024);
    assert.equal(item.metadata.doi, '10.5555/automatic-pdf');
    assert.match(item.bibliography.citationKey, /^lovelace2024/u);
    assert.notEqual(item.bibliography.citationKey, 'fallback');
    assert.ok(item.sources.some(source => source.metadata.source === 'doi' && source.metadata.title === 'Verified import metadata'));
    assert.ok(item.sources.some(source => source.metadata.source === 'local' &&
      source.metadata.externalId === `document:${hash(bytes)}` && source.metadata.title === 'Embedded local title' &&
      source.metadata.publishedYear === null));
    assert.ok(f.db.prepare('SELECT 1 FROM research_library_aliases WHERE item_id=? AND identity=?')
      .get(item.id, `local:document:${hash(bytes)}`));

    const parsed = await f.documents.parse(document.id, null);
    assert.equal(parsed.status, 'ready');
    const ir = await f.documents.paperIR(parsed.id, parsed.currentParseId);
    assert.equal(ir.metadata.title, item.metadata.title);
    assert.equal(ir.metadata.doi, item.metadata.doi);
    assert.equal(ir.metadata.year, 2024);
    assert.ok(f.repository.knowledge.hasDocumentEmbeddings(`document:${parsed.currentParseId}`, config.id, 1));
    const generation = f.repository.scientificIndex.active(null, parsed.id);
    assert.ok(generation);
    f.repository.scientificIndex.verify(generation.id);
    assert.ok(f.db.prepare("SELECT COUNT(*) FROM research_knowledge_keywords WHERE research_knowledge_keywords MATCH 'Autopdfretrievalsentinel'")
      .pluck().get() > 0);
    assert.ok(f.db.prepare(`SELECT COUNT(*) FROM research_scientific_fts f JOIN research_scientific_index_generations g ON g.id=f.generation_id
      WHERE research_scientific_fts MATCH 'Autopdfretrievalsentinel' AND g.status='active'`).pluck().get() > 0);
    assert.equal(f.repository.library.get(item.id).bibliography.citationKey, item.bibliography.citationKey);

    const repeated = await f.importPdf(bytes, {filename: 'renamed.pdf', title: 'Different fallback', citationKey: 'different'});
    assert.equal(repeated.id, parsed.id);
    assert.equal(repeated.currentParseId, parsed.currentParseId);
    assert.equal(repeated.status, 'ready');
    assert.equal(f.repository.documents.list(item.id).length, 1);
    assert.equal(f.repository.library.get(item.id).bibliography.citationKey, item.bibliography.citationKey);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('provided and omitted modes preserve explicit title/key and make no PDF metadata network request', async () => {
  const f = await fixture();
  try {
    for (const [index, mode] of ['provided', null].entries()) {
      const bytes = await pdfBytes({title: `Embedded ${index}`, doi: `10.5555/manual-${index}`,
        custom: {ArxivID: `2601.0123${index + 1}v2`}});
      const document = await f.importPdf(bytes, {metadataMode: mode, filename: `manual-${index}.pdf`,
        title: `User title ${index}`, citationKey: `User_Key_${index}`});
      const item = f.repository.library.get(document.libraryItemId);
      assert.equal(item.metadata.title, `User title ${index}`);
      assert.equal(item.bibliography.citationKey, `User_Key_${index}`);
      assert.equal(item.metadata.doi, null);
      assert.deepEqual(item.metadata.authors, []);
      assert.equal(item.metadata.url, null);
      assert.equal(item.bibliography.fields.eprint, undefined);
    }
    assert.equal(f.requests.length, 0);
    const directBytes = await pdfBytes({doi: '10.5555/direct'});
    const sourcePath = join(f.root, 'direct.pdf'); await writeFile(sourcePath, directBytes);
    const direct = await f.documents.import({target: 'new-item', sourcePath, title: 'Direct caller title',
      citationKey: 'Direct_Key', projectId: f.project.id, metadataMode: 'automatic'});
    assert.equal(f.repository.library.get(direct.libraryItemId).metadata.title, 'Direct caller title');
    assert.equal(f.repository.library.get(direct.libraryItemId).bibliography.citationKey, 'Direct_Key');
    assert.equal(f.requests.length, 0, 'direct service callers must explicitly opt into automatic metadata');
  } finally {await f.close();}
});

test('real XMP fields override generic Info metadata while dates and identifiers retain their meaning', async () => {
  const doi = '10.5555/xmp-source';
  const xmp = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:prism="http://prismstandard.org/namespaces/basic/2.0/">
      <dc:title><rdf:Alt><rdf:li xml:lang="x-default">Verified XMP Title</rdf:li></rdf:Alt></dc:title>
      <dc:creator><rdf:Seq><rdf:li>Ada Lovelace</rdf:li><rdf:li>Grace Hopper</rdf:li></rdf:Seq></dc:creator>
      <dc:identifier>${xmlEscape(doi)}</dc:identifier><prism:publicationDate>2023-05-06</prism:publicationDate>
    </rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const bytes = await pdfBytes({title: 'Untitled', author: 'Generic Writer', xmp});
  const before = Buffer.from(bytes), actual = await inspectPdfImportMetadata(bytes, new AbortController().signal);
  assert.deepEqual(actual, {title: 'Verified XMP Title', authors: ['Ada Lovelace', 'Grace Hopper'], doi, arxivId: null, publishedYear: 2023});
  assert.deepEqual(bytes, before, 'metadata reading must not detach or alter the source buffer');
  const plain = await inspectPdfImportMetadata(await pdfBytes(), new AbortController().signal);
  assert.equal(plain.publishedYear, null, 'CreationDate does not establish a publication year');
});

test('invalid/conflicting identifiers and reference or filename DOI guesses retain local hash identity', async () => {
  const f = await fixture();
  try {
    const cases = [
      {doi: 'invalid-doi', title: 'Invalid identifier'},
      {doi: '10.5555/one', subject: 'DOI: 10.5555/two', title: 'Conflicting identifiers'},
      {doi: '10.5555/one', subject: 'DOI: 10.5555/two', custom: {ArxivID: '2601.01234v2'}},
      {doi: '10.48550/arxiv.2601.01234', custom: {ArxivID: '2601.01235v2'}},
      {custom: {ArxivID: '2601.01234v2'}, subject: 'arXiv:2601.01235v2'},
      {custom: {ArxivID: '2601.00000v2'}, title: 'Invalid arXiv sequence'},
      {title: null, author: null, text: ['Unidentified article', 'References', 'DOI: 10.5555/reference', 'arXiv:2601.01234v2']},
      {title: null, author: null, text: ['Unidentified article', 'Abstract', 'arXiv:2601.01234v2']},
      {title: null, author: null, text: ['A prior article arXiv:2601.01234v2', 'Abstract', 'Original body']}
    ];
    for (const [index, input] of cases.entries()) {
      const bytes = await pdfBytes(input);
      const document = await f.importPdf(bytes, {filename: `10.5555-filename-arxiv-2601.01234-${index}.pdf`});
      const item = f.repository.library.get(document.libraryItemId);
      assert.equal(item.metadata.doi, null);
      assert.equal(item.metadata.externalId, `document:${hash(bytes)}`);
      assert.equal(item.bibliography.fields.eprint, undefined);
      assert.ok(f.db.prepare('SELECT 1 FROM research_library_aliases WHERE item_id=? AND identity=?')
        .get(item.id, `local:document:${hash(bytes)}`));
    }
    assert.equal(f.requests.length, 0);
  } finally {await f.close();}
});

test('a labelled real-PDF arXiv ID uses only an exact registered DOI receipt and keeps versioned source provenance', async () => {
  const f = await fixture();
  try {
    const bytes = await pdfBytes({title: null, text: ['Original preprint title',
      'arXiv:2601.01234v2 [cs.CL] 10 Jan 2026', 'Abstract', 'Autopdfretrievalsentinel original preprint body.']});
    const document = await f.importPdf(bytes), item = f.repository.library.get(document.libraryItemId);
    assert.equal(f.requests.length, 1);
    assert.equal(decodeURIComponent(new URL(f.requests[0].url).pathname.slice(1)), '10.48550/arxiv.2601.01234');
    assert.equal(item.metadata.doi, '10.48550/arxiv.2601.01234');
    assert.equal(item.metadata.title, 'Verified import metadata');
    assert.equal(item.metadata.publishedYear, 2024);
    assert.equal(item.bibliography.fields.eprint, '2601.01234v2');
    assert.equal(item.bibliography.fields.archiveprefix, 'arXiv');
    assert.ok(item.sources.some(source => source.metadata.source === 'local' &&
      source.metadata.externalId === `document:${hash(bytes)}` && source.metadata.url === 'https://arxiv.org/abs/2601.01234v2' &&
      source.bibliography.fields.eprint === '2601.01234v2' && source.providerRecord === null));
    assert.ok(item.sources.some(source => source.metadata.source === 'doi' && source.metadata.doi === '10.48550/arxiv.2601.01234'));
    assert.ok(item.sources.every(source => source.metadata.source !== 'arxiv'), 'a DOI receipt must not be represented as an arXiv provider response');
    assert.ok(f.db.prepare('SELECT 1 FROM research_library_aliases WHERE item_id=? AND identity=?')
      .get(item.id, 'arxiv:2601.01234'));
    assert.ok(f.db.prepare('SELECT 1 FROM research_library_aliases WHERE item_id=? AND identity=?')
      .get(item.id, `local:document:${hash(bytes)}`));
    assert.equal(document.sourceHash, hash(bytes));
    assert.deepEqual(await readFile(join(f.root, f.repository.documents.sourcePath(document.id))), bytes);

    const nextBytes = await pdfBytes({custom: {ArxivID: 'https://arxiv.org/abs/2601.01234v3'},
      text: ['Another original version', 'Abstract', 'Distinct version body.']});
    const next = await f.importPdf(nextBytes, {filename: 'preprint-v3.pdf'});
    assert.equal(next.libraryItemId, document.libraryItemId);
    assert.notEqual(next.id, document.id);
    assert.equal(f.repository.documents.list(item.id).length, 2);
    assert.equal(f.repository.library.get(item.id).bibliography.citationKey, item.bibliography.citationKey);
    assert.equal(f.repository.documents.get(document.id).sourceHash, hash(bytes));
    assert.deepEqual(await readFile(join(f.root, f.repository.documents.sourcePath(next.id))), nextBytes);

    const parsed = await f.documents.parse(document.id);
    assert.equal(parsed.status, 'ready');
    const generation = f.repository.scientificIndex.active(null, document.id);
    assert.ok(generation);
    f.repository.scientificIndex.verify(generation.id);
    assert.equal((await f.documents.paperIR(document.id, parsed.currentParseId)).metadata.doi, item.metadata.doi);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('arXiv metadata and standalone URL headers use the existing identifier validator, including legacy case and versions', async () => {
  const xmp = `<?xpacket begin=""?><x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">
    <rdf:Description xmlns:dc="http://purl.org/dc/elements/1.1/">
      <dc:identifier>arXiv:MATH.ag/0309136v2</dc:identifier>
    </rdf:Description></rdf:RDF></x:xmpmeta><?xpacket end="w"?>`;
  const bytes = await pdfBytes({xmp}), original = Buffer.from(bytes);
  const metadata = await inspectPdfImportMetadata(bytes, new AbortController().signal);
  assert.equal(metadata.arxivId, 'math.AG/0309136v2');
  assert.equal(metadata.doi, null);
  assert.deepEqual(bytes, original);
  const header = await inspectPdfImportMetadata(await pdfBytes({text: ['Article',
    'https://arxiv.org/abs/2601.01234v2', 'Abstract', 'Original article']}), new AbortController().signal);
  assert.equal(header.arxivId, '2601.01234v2');
});

test('an explicit DOI takes precedence over arXiv lookup without forging an arXiv provider record', async () => {
  const f = await fixture();
  try {
    const document = await f.importPdf(await pdfBytes({doi: '10.5555/published-paper', custom: {ArxivID: '2601.01234v2'}}));
    const item = f.repository.library.get(document.libraryItemId);
    assert.equal(f.requests.length, 1);
    assert.equal(decodeURIComponent(new URL(f.requests[0].url).pathname.slice(1)), '10.5555/published-paper');
    assert.equal(item.metadata.doi, '10.5555/published-paper');
    assert.equal(item.bibliography.fields.eprint, '2601.01234v2');
    assert.ok(item.sources.every(source => source.metadata.source !== 'arxiv'));
    assert.equal(f.db.prepare('SELECT 1 FROM research_library_aliases WHERE item_id=? AND identity=?')
      .get(item.id, 'doi:10.48550/arxiv.2601.01234'), undefined, 'a preprint field cannot establish a second DOI identity');
  } finally {await f.close();}
});

test('offline, missing preparation and mismatched arXiv DOI responses preserve the observed ID without inventing a DOI', async () => {
  for (const options of [
    {fetcher: async () => new Response('', {status: 503})},
    {fetcher: async () => Response.json({DOI: '10.48550/arxiv.2601.09999', title: 'Wrong preprint', type: 'journal-article'})},
    {metadataPreparation: false}
  ]) {
    const f = await fixture(options);
    try {
      const bytes = await pdfBytes({custom: {ArxivID: 'hep-TH/9901001v2'}});
      const document = await f.importPdf(bytes), item = f.repository.library.get(document.libraryItemId);
      assert.equal(f.requests.length, options.metadataPreparation === false ? 0 : 1);
      if (f.requests.length) {
        assert.equal(decodeURIComponent(new URL(f.requests[0].url).pathname.slice(1)), '10.48550/arxiv.hep-th/9901001');
      }
      assert.equal(item.metadata.title, 'Embedded local title');
      assert.deepEqual(item.metadata.authors, ['Local Writer']);
      assert.equal(item.metadata.doi, null);
      assert.equal(item.bibliography.doi, null);
      assert.equal(item.bibliography.fields.doi, undefined);
      assert.equal(item.bibliography.fields.eprint, 'hep-th/9901001v2');
      assert.equal(item.bibliography.fields.archiveprefix, 'arXiv');
      assert.equal(item.metadata.url, 'https://arxiv.org/abs/hep-th/9901001v2');
      assert.ok(item.sources.every(source => source.metadata.source === 'local' && source.providerRecord === null));
      assert.ok(f.db.prepare('SELECT 1 FROM research_library_aliases WHERE item_id=? AND identity=?')
        .get(item.id, `local:document:${hash(bytes)}`));
      assert.equal(f.db.prepare("SELECT 1 FROM research_library_aliases WHERE item_id=? AND identity LIKE 'doi:%'").get(item.id), undefined);
      assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library_provider_identifiers WHERE item_id=?').pluck().get(item.id), 0);
      assert.equal(document.sourceHash, hash(bytes));
      assert.deepEqual(await readFile(join(f.root, f.repository.documents.sourcePath(document.id))), bytes);
    } finally {await f.close();}
  }
});

test('a standalone DOI header can resolve metadata but a DOI in the article body cannot', async () => {
  const own = await inspectPdfImportMetadata(await pdfBytes({title: null, text: [
    'Article title', 'DOI: 10.5555/header', 'Abstract', 'A reference DOI: 10.5555/body'
  ]}), new AbortController().signal);
  assert.equal(own.doi, '10.5555/header');
  const body = await inspectPdfImportMetadata(await pdfBytes({title: null, text: [
    'Article title', 'Abstract', 'DOI: 10.5555/body'
  ]}), new AbortController().signal);
  assert.equal(body.doi, null);
});

test('unavailable or mismatched DOI CSL falls back to confirmed PDF fields before creation', async () => {
  for (const fetcher of [
    async () => new Response('', {status: 503}),
    async () => Response.json({DOI: '10.5555/other', title: 'Wrong article', type: 'journal-article'})
  ]) {
    const f = await fixture({fetcher});
    try {
      const document = await f.importPdf(await pdfBytes({doi: '10.5555/confirmed'}));
      const item = f.repository.library.get(document.libraryItemId);
      assert.equal(item.metadata.title, 'Embedded local title');
      assert.deepEqual(item.metadata.authors, ['Local Writer']);
      assert.equal(item.metadata.doi, '10.5555/confirmed');
      assert.equal(item.metadata.publishedYear, null);
      assert.ok(item.sources.every(source => source.metadata.source === 'local'));
      assert.notEqual(item.bibliography.citationKey, 'fallback');
    } finally {await f.close();}
  }
});

test('concurrent imports allocate distinct stable keys after all asynchronous normalization', async () => {
  let arrivals = 0, release;
  const pending = new Promise(resolve => {release = resolve;});
  const f = await fixture({afterNormalize: async () => {
    if (++arrivals === 2) release();
    await pending;
  }});
  try {
    const first = await pdfBytes({author: 'Ada Lovelace', custom: {PublicationYear: '2024'}, text: ['Shared title', 'First original source']});
    const second = await pdfBytes({author: 'Ada Lovelace', custom: {PublicationYear: '2024'}, text: ['Shared title', 'Second original source']});
    const [a, b] = await Promise.all([
      f.importPdf(first, {filename: 'first.pdf'}), f.importPdf(second, {filename: 'second.pdf'})
    ]);
    const aKey = f.repository.library.get(a.libraryItemId).bibliography.citationKey;
    const bKey = f.repository.library.get(b.libraryItemId).bibliography.citationKey;
    assert.notEqual(a.libraryItemId, b.libraryItemId);
    assert.notEqual(aKey, bKey);
    assert.match(aKey, /^lovelace2024/u); assert.match(bKey, /^lovelace2024/u);
    assert.equal(f.repository.library.usedCitationKeys().size, 2);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('a shared existing item keeps its curated title and a citation-key edit made while DOI lookup waits', async () => {
  let entered, release;
  const lookupEntered = new Promise(resolve => {entered = resolve;});
  const lookupPending = new Promise(resolve => {release = resolve;});
  const f = await fixture({fetcher: async () => {
    entered(); await lookupPending;
    return Response.json({type: 'journal-article', DOI: '10.5555/shared', title: 'Provider replacement',
      author: [{family: 'Provider'}], issued: {'date-parts': [[2024]]}});
  }});
  try {
    const otherProject = f.repository.createProject({title: 'Other project', description: '', workspacePath: join(f.root, 'other-project')});
    const sourcePath = join(f.root, 'shared.pdf');
    const original = await f.importPdf(await pdfBytes({doi: '10.5555/shared'}), {metadataMode: 'provided',
      filename: 'shared.pdf', title: 'Curated title', citationKey: 'Curated_Key'});
    const existing = f.repository.library.get(original.libraryItemId);
    // A DOI observation for the same local alias safely upgrades this existing identity.
    f.repository.library.import([{metadata: {...existing.metadata, doi: '10.5555/shared'},
      bibliography: {...existing.bibliography, doi: '10.5555/shared', fields: {...existing.bibliography.fields, doi: '10.5555/shared'}}}],
    otherProject.id, {notify: false});
    const importing = f.importRequest({target: 'new-item', sourcePath, title: 'Fallback replacement',
      citationKey: 'replacement', metadataMode: 'automatic', projectId: f.project.id});
    await lookupEntered;
    const current = f.repository.library.get(existing.id);
    f.repository.library.setCitationKey(existing.id, current.revision, 'Edited_While_Waiting');
    release();
    const attached = await importing, after = f.repository.library.get(existing.id);
    assert.equal(attached.id, original.id);
    assert.equal(after.metadata.title, 'Curated title');
    assert.equal(after.bibliography.citationKey, 'Edited_While_Waiting');
    assert.deepEqual(after.projectIds, [f.project.id, otherProject.id].sort());
    assert.equal(f.repository.documents.list(existing.id).length, 1);
  } finally {release?.(); await f.close();}
});

test('automatic reimport cannot restore an archived match or reassign a local PDF to a competing DOI item', async () => {
  const f = await fixture();
  try {
    const bytes = await pdfBytes({doi: '10.5555/archived'});
    const original = await f.importPdf(bytes), item = f.repository.library.get(original.libraryItemId);
    f.repository.library.archive(item.id, item.revision, true);
    const directories = await readdir(join(f.root, 'documents'));
    await assert.rejects(f.importPdf(bytes, {filename: 'again.pdf'}), /research_library_item_archived/u);
    assert.equal(f.repository.library.get(item.id).archived, true);
    assert.equal(f.repository.documents.get(original.id).sourceHash, hash(bytes));
    assert.deepEqual(await readdir(join(f.root, 'documents')), directories);

    const competingBytes = await pdfBytes({doi: '10.5555/competing', title: 'Local manual record'});
    const local = await f.importPdf(competingBytes, {metadataMode: 'provided', filename: 'local.pdf', citationKey: 'localManual'});
    const localItem = f.repository.library.get(local.libraryItemId);
    const doiItem = f.repository.library.import([{metadata: {...localItem.metadata, id: 'doi:10.5555/competing',
      source: 'doi', externalId: '10.5555/competing', doi: '10.5555/competing'},
    bibliography: {...localItem.bibliography, citationKey: 'separateDoi', doi: '10.5555/competing',
      fields: {...localItem.bibliography.fields, doi: '10.5555/competing'}}}], null, {notify: false}).items[0];
    await assert.rejects(f.importPdf(competingBytes, {filename: 'ambiguous.pdf'}), /research_literature_identity_ambiguous/u);
    assert.equal(f.repository.documents.get(local.id).libraryItemId, localItem.id);
    assert.equal(f.repository.documents.list(doiItem.id).length, 0);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('registered arXiv DOI lookup cannot reassign a manual PDF or restore its archived literature identity', async () => {
  const f = await fixture();
  try {
    const bytes = await pdfBytes({custom: {ArxivID: '2601.01234v2'}});
    const local = await f.importPdf(bytes, {metadataMode: 'provided', filename: 'local-preprint.pdf', citationKey: 'manualPreprint'});
    const localItem = f.repository.library.get(local.libraryItemId);
    const doi = '10.48550/arxiv.2601.01234';
    const competitor = f.repository.library.import([{metadata: {...localItem.metadata,
      id: `doi:${doi}`, source: 'doi', externalId: doi, doi},
    bibliography: {...localItem.bibliography, citationKey: 'separatePreprint', doi,
      fields: {...localItem.bibliography.fields, doi}}}], null, {notify: false}).items[0];
    const directories = await readdir(join(f.root, 'documents'));
    await assert.rejects(f.importPdf(bytes, {filename: 'ambiguous-preprint.pdf'}), /research_literature_identity_ambiguous/u);
    assert.equal(f.repository.documents.get(local.id).libraryItemId, localItem.id);
    assert.equal(f.repository.library.get(localItem.id).bibliography.citationKey, 'manualPreprint');
    assert.equal(f.repository.library.get(localItem.id).metadata.doi, null);
    assert.equal(f.repository.documents.list(competitor.id).length, 0);
    assert.deepEqual(await readdir(join(f.root, 'documents')), directories);
    assert.deepEqual(await readFile(join(f.root, f.repository.documents.sourcePath(local.id))), bytes);

    const archiveBytes = await pdfBytes({custom: {ArxivID: '2601.01235v1'}});
    const archivedDocument = await f.importPdf(archiveBytes, {filename: 'archived-preprint.pdf'});
    const archivedItem = f.repository.library.get(archivedDocument.libraryItemId);
    f.repository.library.archive(archivedItem.id, archivedItem.revision, true);
    const archivedDirectories = await readdir(join(f.root, 'documents'));
    await assert.rejects(f.importPdf(archiveBytes, {filename: 'archived-again.pdf'}), /research_library_item_archived/u);
    assert.equal(f.repository.library.get(archivedItem.id).archived, true);
    assert.equal(f.repository.documents.list(archivedItem.id).length, 1);
    assert.equal(f.repository.documents.get(archivedDocument.id).sourceHash, hash(archiveBytes));
    assert.deepEqual(await readdir(join(f.root, 'documents')), archivedDirectories);
    assert.deepEqual(f.db.pragma('foreign_key_check'), []);
  } finally {await f.close();}
});

test('a real parser failure retains the imported original and never reports ready parse or index', async () => {
  const f = await fixture();
  try {
    const bytes = Buffer.from('%PDF-1.7\ninvalid source without document objects');
    const imported = await f.importPdf(bytes);
    const parsed = await f.documents.parse(imported.id, null);
    assert.equal(parsed.status, 'failed');
    assert.equal(parsed.currentParseId, null);
    assert.equal(parsed.activeParseId, null);
    assert.ok(parsed.error);
    assert.equal(f.repository.scientificIndex.active(null, imported.id), null);
    assert.equal(f.db.prepare("SELECT COUNT(*) FROM research_knowledge_documents WHERE id LIKE 'document:%'").pluck().get(), 0);
    assert.deepEqual(await readFile(join(f.root, f.repository.documents.sourcePath(imported.id))), bytes);
  } finally {await f.close();}
});

test('shutdown during DOI or arXiv metadata preparation aborts instead of falling back to a new item', async () => {
  for (const metadata of [{doi: '10.5555/cancelled'}, {custom: {ArxivID: '2601.01234v2'}}]) {
    let entered;
    const lookupEntered = new Promise(resolve => {entered = resolve;});
    const f = await fixture({fetcher: async (_url, {signal}) => {
      entered();
      return await new Promise((_resolve, reject) => {
        if (signal.aborted) reject(signal.reason);
        else signal.addEventListener('abort', () => reject(signal.reason), {once: true});
      });
    }});
    try {
      const importing = f.importPdf(await pdfBytes(metadata));
      const rejected = assert.rejects(importing, /research_document_parse_cancelled/u);
      await lookupEntered;
      await f.documents.shutdown(); await rejected;
      assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_library').pluck().get(), 0);
      assert.equal(f.db.prepare('SELECT COUNT(*) FROM research_documents').pluck().get(), 0);
      assert.deepEqual(await readdir(join(f.root, 'documents')), []);
    } finally {await f.close();}
  }
});
