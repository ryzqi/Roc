import {writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {PDFDocument, StandardFonts} from 'pdf-lib';
import {hash} from './scientific-search-fixture.mjs';
import {scientificWikiFixture} from './scientific-wiki-fixture.mjs';

/** Original PDF bytes plus controlled parser tables exercise source publication, not extraction accuracy. */
export async function scientificComparisonFixture(api, services, {aligned = true} = {}) {
  const f = await scientificWikiFixture(api, services);
  f.papers = [];
  try {
    for (let index = 0; index < 3; index++) {
      const method = `Method ${String.fromCharCode(65 + index)}`, value = String(89 + index),
        label = `${method} Dataset C v1 test Baseline A v1 4 epochs seed 1 CPU inference 2 ms repeats 3 uncertainty 0.1`;
      const pdf = await PDFDocument.create(), font = await pdf.embedFont(StandardFonts.Helvetica), page = pdf.addPage([600, 800]);
      for (const [row, text] of ['2 Method', `${method} uses Dataset C.`, 'Table 3: Dataset C results.',
        `${label} F1 (%) ${value}`, 'Figure 2: Original architecture.', 'x = y',
        'where x denotes the original input.'].entries()) page.drawText(text, {x: 30, y: 740 - row * 35, size: 9, font});
      const bytes = Buffer.from(await pdf.save()), sourcePath = join(f.root, `comparison-${index}.pdf`);
      await writeFile(sourcePath, bytes);
      const metadata = {...f.metadata, id: `comparison-paper-${index}`, externalId: `comparison-paper-${index}`,
        doi: `10.1234/comparison-${index}`, title: `Original comparison paper ${index}`};
      const bibliography = {citationKey: `comparison-${index}`, entryType: 'article', fields: {title: metadata.title},
        preambles: [], csl: null, title: metadata.title, authors: metadata.authors, doi: metadata.doi,
        publishedYear: 2026, abstract: null, url: null};
      const document = f.repository.documents.import({id: `comparison-document-${index}`, libraryItemId: null,
        projectId: f.project.id, filename: `comparison-${index}.pdf`, mediaType: 'application/pdf',
        sourcePath: `comparison-${index}.pdf`, sourceHash: hash(bytes), size: bytes.length, entry: {metadata, bibliography}}, false).document;
      const data = structuredClone(f.data); delete data.paperIR;
      data.content.sourceHash = hash(bytes);
      data.content.blocks.find(block => block.id === 'body').text = `${method} uses Dataset C.`;
      const table = data.content.blocks.find(block => block.id === 'table');
      table.text = `${label} ${value}`;
      table.table = api.extractPaperTable(table, {id: 'table',
        rawHtml: `<table><tr><th>Method</th><th>F1 (%)</th></tr><tr><td>${label}</td><td>${value}</td></tr></table>`});
      data.content.blocks = api.attachPaperVisuals(api.attachPaperEquations(
        data.content.blocks.map(({equation, visual, imageAssetId, ...block}) => block),
        [{regions: [{id: 'equation', formula: 'x = y \\tag{7}'}]}]
      )).map(block => {
        block.imageAssetId = data.content.blocks.find(item => item.id === block.id).imageAssetId;
        if (block.visual) block.visual.assetId = block.imageAssetId ?? null;
        if (block.equation) block.equation.assetId = block.imageAssetId ?? null;
        return block;
      });
      data.content.content = data.content.blocks.filter(block => block.text.trim()).map(block => block.text).join('\n\n');
      data.content.quality = api.assessPdfQuality({pages: [{page: 1, regions: [], coordinateFrame: {
        kind: 'image', page: 1, width: 600, height: 800, unit: 'raster-pixel', coordinateOrigin: 'TOPLEFT'
      }}], blocks: data.content.blocks});
      const canonical = api.storedDocumentContentSchema.parse(data);
      const parseId = `comparison-parse-${index}`;
      f.repository.documents.begin(document.id, parseId);
      const ir = f.repository.documents.buildPaperIR(document.id, parseId, canonical);
      canonical.paperIR = await new api.PaperIRRepository(f.root).publish(ir);
      const generation = f.repository.scientificIndex.begin({ir, paperIR: canonical.paperIR, projectId: null,
        source: {kind: 'library'}, embedding: null, policy: {tableTokens: 64}});
      f.repository.scientificIndex.publish(generation.id, () => ({paperIR: canonical.paperIR, embedding: null}),
        () => f.repository.documents.complete(document.id, parseId, canonical, null));
      f.papers.push({document, ir, data: canonical, sourcePath, bytes, method, value, label});
    }
    const candidates = paper => {
      const table = paper.ir.tables[0], cell = text => {
        const item = table.cells.find(cell => cell.text === text);
        return {kind: 'table_cell', tableId: table.id, cellId: item.id, raw: item.text};
      };
      const row = cell(paper.label), metric = cell('F1 (%)');
      const conditions = {datasetId: 'dataset', datasetVersion: 'v1', split: 'test', metricId: 'metric',
        baselineId: 'baseline', budget: '4 epochs', hardware: 'CPU', trainingBudget: '4 epochs',
        inferenceBudget: '2 ms', randomSeeds: '1', repeats: '3', uncertainty: '0.1', other: {seed: '1'}};
      return {
        entities: [
          {id: 'model', entityType: 'Model', canonicalName: paper.method, aliases: [],
            attributes: {architecture: 'Original architecture', version: 'v1', components: []}, evidence: [row]},
          {id: 'dataset', entityType: 'Dataset', canonicalName: 'Dataset C', aliases: [],
            attributes: {version: 'v1', task: null}, evidence: [row]},
          {id: 'metric', entityType: 'Metric', canonicalName: 'F1', aliases: [],
            attributes: {definition: 'F1', direction: 'higher', unit: '%'}, evidence: [metric]},
          {id: 'baseline', entityType: 'Baseline', canonicalName: 'Baseline A', aliases: [],
            attributes: {version: 'v1'}, evidence: [row]}
        ],
        facts: [{id: 'result', factType: 'experimental_result', subjectEntityId: 'model', predicate: 'Reported F1',
          objectEntityId: null, value: {raw: paper.value, unit: null, unitEvidence: []}, conditions,
          conditionEvidence: Object.keys(conditions).map(field => ({field, key: field === 'other' ? 'seed' : null,
            evidence: [field === 'metricId' ? metric : row]})), table: {tableId: table.id, row: 1, cellId: cell(paper.value).cellId},
          evidence: [cell(paper.value), row], confidence: .8}],
        relations: []
      };
    };
    f.publishPaper = async paper => {
      const job = await f.service.enqueue({projectId: f.project.id, documentId: paper.document.id});
      f.repository.scientificExtraction.claim(job.id, f.project.id);
      paper.job = f.repository.scientificExtraction.publish(job.id, f.project.id, candidates(paper), paper.ir, () => job.snapshot);
      return paper.job;
    };
    await f.publishPaper(f.papers[0]);
    if (aligned) {
      const targets = f.repository.scientificExtraction.bundle(f.papers[0].job.id, f.project.id).entities;
      for (const type of ['Dataset', 'Metric', 'Baseline']) {
        const target = targets.find(entity => entity.entityType === type);
        f.repository.scientificExtraction.putAlias({id: `comparison-alias-${type}`, projectId: f.project.id,
          entityType: type, alias: target.canonicalName, targetEntityId: target.id, canonicalName: target.canonicalName,
          revision: 1, createdBy: 'fixture-human'}, target);
      }
      await f.publishPaper(f.papers[0]);
    }
    for (const paper of f.papers.slice(1)) await f.publishPaper(paper);
    f.readAll = () => Promise.all(f.papers.map(paper => f.service.readPaperCard({
      projectId: f.project.id, documentId: paper.document.id, generationId: null
    })));
    f.sources = f.papers.map(paper => ({documentId: paper.document.id, generationId: paper.job.id}));
    const created = await f.wiki.createCurrent({projectId: f.project.id, title: 'Compare three methods', kind: 'comparison',
      evidenceIds: [], claimIds: [], paperKnowledgeSources: f.sources});
    await f.wiki.idle();
    f.page = await f.wiki.readCurrent(f.project.id, created.page.id);
    return f;
  } catch (error) {await f.finish(); throw error;}
}
