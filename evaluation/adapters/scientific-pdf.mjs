import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { hash, readJson, ROOT, sha256 } from '../lib/common.mjs';
import { checkScientificRagCorpus, scientificManifestSchema } from '../lib/scientific-rag-corpus.mjs';
import { normalizeScientificPdfBox, scoreScientificPdfPaper, scientificPdfScoringContract,
  summarizeScientificPdfScores } from '../lib/scientific-pdf-scoring.mjs';
import { publicPdfArtifactPath, verifyPublicPdfReceipt } from './scientific-public/pdf.mjs';
import { verifyScientificNativeFusion } from '../lib/scientific-native-fusion.mjs';

const requireValue = (condition, code) => { if (!condition) throw new Error(`scientific_pdf_adapter_${code}`); };
// makeBlock applies this boundary to region text. Check that correspondence
// without normalizing human gold or the transcript supplied to CER.
const productionBlockText = value => value.replace(/\u0000/gu, '').replace(/[ \t]+/gu, ' ')
  .replace(/\n{3,}/gu, '\n\n').trim();
function directory(path) {
  const root = resolve(path);
  requireValue(lstatSync(root).isDirectory() && realpathSync(root) === root, 'directory_invalid');
  return root;
}
function kind(type, fallback) {
  if (['paragraph_title', 'doc_title', 'title', 'heading'].includes(type)) return 'heading';
  if (['image', 'chart', 'header_image', 'figure'].includes(type)) return 'figure';
  if (['figure_title', 'table_title', 'chart_title', 'caption'].includes(type)) return 'caption';
  if (['formula', 'equation'].includes(type)) return 'equation';
  if (['table', 'reference', 'algorithm'].includes(type)) return type;
  if (['paragraph', 'text', 'abstract', 'number', 'header', 'footer', 'aside_text', 'footnote',
    'formula_number', 'content'].includes(type)) return 'text';
  return type ? 'other' : kind(fallback, 'unknown');
}

/** Convert actual blocks and rich-only regions without consulting gold.
 * The host must first verify bytes/assets/real-PDF geometry with the receipt
 * verifier; pure fixture callers do not establish those production facts. */
export function observeScientificPdfStructure(row, structured) {
  if (row.status === 'failed') {
    requireValue(structured === null && typeof row.failure?.code === 'string' && row.failure.code.length > 0,
      'failure_invalid');
    return { sourceHash: row.sourceHash, parseRef: null, status: 'failed', failureCode: row.failure.code, pages: [] };
  }
  requireValue(row.status === 'parsed' && row.failure === null
    && structured?.coordinateFrameContractVersion === 1 && structured.parserFingerprint === row.parserFingerprint
    && structured.pages.length === row.pageCount && Array.isArray(structured.blocks), 'structure_invalid');
  const ids = new Set(), regions = new Map();
  for (const page of structured.pages) {
    requireValue(page.coordinateFrame?.page === page.page && Array.isArray(page.regions), 'page_invalid');
    if (page.fusion !== undefined || page.nativeTextItems !== undefined) {
      verifyScientificNativeFusion(page, structured.blocks.filter(block => block.locations[0]?.page === page.page));
    }
    for (const region of page.regions) {
      requireValue(typeof region.id === 'string' && region.id.length > 0 && !regions.has(region.id), 'region_duplicate');
      regions.set(region.id, { ...region, page: page.page });
    }
  }
  const frames = new Map(structured.pages.map(p => [p.page, p.coordinateFrame]));
  requireValue(frames.size === row.pageCount && structured.pages.every((p, i) => p.page === i + 1), 'pages_invalid');
  const pages = structured.pages.map(page => ({ page: page.page, frame: page.coordinateFrame,
    transcript: '', predictions: [], nativeTextHash: hash(page.text) }));
  const byPage = new Map(pages.map(p => [p.page, p])), transcriptParts = new Map(pages.map(p => [p.page, []]));
  const add = (id, page, bbox, text, region, blockKind, imagePath) => {
    requireValue(typeof text === 'string' && byPage.has(page), 'block_invalid');
    const target = byPage.get(page), conversion = normalizeScientificPdfBox(frames.get(page), bbox);
    target.predictions.push({ id, blockId: ids.has(id) ? id : null, kind: kind(region?.type, blockKind), text,
      order: ids.has(id) ? target.predictions.length : null, bbox: conversion.bbox, conversion,
      regionText: region?.text ?? null,
      latex: region?.formula ?? null, tableHtml: region?.tableMatches?.fullHtml || region?.tableMatches?.html
        || region?.table?.fullHtml || region?.table?.html || null,
      assetPath: imagePath ?? null, assetVerified: Boolean(imagePath && row.artifacts.some(a => a.path === imagePath)
        && structured.assets.some(a => a.path === imagePath && a.page === page)) });
  };
  for (const block of structured.blocks) {
    requireValue(typeof block.id === 'string' && !ids.has(block.id) && Array.isArray(block.locations)
      && block.locations.length === 1, 'block_identity_invalid');
    ids.add(block.id);
    const location = block.locations[0], region = regions.get(block.id);
    requireValue(location.coordinateOrigin === 'TOPLEFT' && (!region || region.page === location.page
      && hash(region.bbox) === hash(location.bbox) && typeof region.text === 'string'
      && (structured.pages.find(page => page.page === location.page)?.fusion
        || productionBlockText(region.text) === block.text)
      && region.imagePath === block.imagePath), 'region_block_mismatch');
    add(block.id, location.page, location.bbox, block.text, region, block.kind, block.imagePath);
    transcriptParts.get(location.page).push(block.text);
  }
  for (const [id, region] of regions) if (!ids.has(id)) {
    add(id, region.page, region.bbox, region.text, region, null, region.imagePath);
  }
  for (const page of pages) page.transcript = transcriptParts.get(page.page).join('\n\n');
  return { sourceHash: row.sourceHash, parseRef: null, parserFingerprint: row.parserFingerprint,
    status: 'parsed', failureCode: null, pages };
}

/** Fail closed before scoring if full gold is unavailable. Observation mode
 * instead exports verified predictions and deliberately has no quality score. */
export async function evaluateScientificPdfRun({ runRoot, sourceRoot, manifestPath = null }) {
  let readiness = null, manifest = null, goldRoot = null;
  if (manifestPath) {
    readiness = await checkScientificRagCorpus(manifestPath);
    if (!readiness.corpusReady) return { schemaVersion: 1, kind: 'scientific-full-pdf-scoring-readiness',
      status: 'blocked', corpusReadiness: readiness, qualityMetrics: null, scientificBaselineReady: false };
    goldRoot = directory(dirname(realpathSync(manifestPath)));
    manifest = scientificManifestSchema.parse(readJson(manifestPath));
  }
  const root = directory(runRoot), sources = directory(sourceRoot);
  const run = readJson(publicPdfArtifactPath(root, 'run.json')), inputs = readJson(publicPdfArtifactPath(root, 'inputs.json'));
  requireValue(run.status === 'processed-unscored' && run.cohortComplete && run.rows?.length === run.papers
    && inputs.pins?.length === run.papers && run.papers > 0 && run.sourceLockHash === inputs.sourceLockHash
    && hash(run.codeHashes) === hash(inputs.codeHashes) && hash(run.modelHashes) === hash(inputs.modelHashes)
    && run.modelManifest === inputs.modelManifest && hash(run.parserOptions) === hash(inputs.parserOptions)
    && run.failedPapers === run.rows.filter(r => r.status === 'failed').length
    && new Set(inputs.pins.map(p => p.sha256)).size === run.papers, 'run_invalid');
  if (manifest) requireValue(manifest.papers.length === run.papers && hash(manifest.papers.map(p => p.sourceHash).sort())
    === hash(inputs.pins.map(p => p.sha256).sort()), 'gold_cohort_mismatch');
  const papers = [], observations = [], verified = [];
  const goldByHash = new Map(manifest?.papers.map(p => [p.sourceHash, p]) ?? []);
  for (const [index, row] of run.rows.entries()) {
    const receipt = await verifyPublicPdfReceipt(root, sources, row, index, inputs.pins[index], run.modelManifest);
    const structured = row.status === 'parsed' ? readJson(publicPdfArtifactPath(root, row.structured)) : null;
    const observation = observeScientificPdfStructure(row, structured);
    observations.push({ paperId: row.paperId, datasetPaperId: row.datasetPaperId ?? null, ...observation });
    verified.push(receipt);
    if (manifest) {
      const paper = goldByHash.get(row.sourceHash);
      const bytes = readFileSync(publicPdfArtifactPath(goldRoot, paper.annotationPath));
      requireValue(sha256(bytes) === paper.annotationHash, 'gold_changed');
      papers.push({ category: paper.category, parseMode: row.parseMode,
        ...scoreScientificPdfPaper(JSON.parse(bytes), observation) });
    }
  }
  // Catch corpus modifications while verification was running.
  if (manifest) {
    const after = await checkScientificRagCorpus(manifestPath);
    requireValue(after.corpusReady && after.inputDigest === readiness.inputDigest, 'corpus_changed');
  }
  const group = (field, names) => Object.fromEntries(names.map(name => [name,
    summarizeScientificPdfScores(papers.filter(p => p[field] === name).flatMap(p => p.scores))]));
  return { schemaVersion: 1, kind: manifest ? 'scientific-full-pdf-draft-score' : 'scientific-full-pdf-observation',
    status: manifest ? 'scored-draft-contract' : 'verified-observations-unscored-quality',
    workingDirectory: ROOT, root, sourceRoot: sources, runHash: hash(run), inputsHash: hash(inputs),
    corpusInputDigest: readiness?.inputDigest ?? null, scoringContract: scientificPdfScoringContract,
    codeHashes: Object.fromEntries(['evaluation/adapters/scientific-pdf.mjs', 'evaluation/lib/scientific-pdf-scoring.mjs',
      'evaluation/lib/scientific-rag-corpus.mjs', 'evaluation/adapters/scientific-public/pdf.mjs',
      'evaluation/adapters/scientific-public/structure.mjs', 'scripts/score-scientific-pdf.mjs',
      'evaluation/lib/scientific-native-fusion.mjs',
      'pnpm-lock.yaml'].map(path => [path, sha256(readFileSync(join(ROOT, path)))])),
    parserCodeHashes: run.codeHashes, modelHashes: run.modelHashes, modelManifest: run.modelManifest,
    verified, observations, papers, deterministicObservationHash: hash(observations),
    qualityMetrics: manifest ? { all: summarizeScientificPdfScores(papers.flatMap(p => p.scores)),
      categories: group('category', [...new Set(manifest.papers.map(p => p.category))]),
      parseModes: group('parseMode', ['native-text', 'ocr', 'mixed', null]) } : null,
    scientificBaselineReady: false,
    limitations: ['Draft scoring contract and word segmentation require human review before baseline acceptance.',
      'Observation mode uses no gold and establishes no scientific quality or human-review authenticity.',
      'Captured-parse gold requires an exact parseRef; isolated PDF receipts do not supply a parseId.',
      'Caption provenance remains null until independent caption locators exist in gold.',
      'Figure asset metric checks declared path/page/hash linkage and matched source locator, not crop-image content correspondence.',
      'Custom TEDS is not the official leaderboard algorithm; table cell exact match preserves whitespace.',
      'One-locator production blocks supported; multiple locators fail explicitly rather than inventing split text.',
      'Rich-only regions retain objects but do not enter published-block CER or receive inferred reading order.',
      'No parser/model inference rerun, complete evidence/retrieval/Wiki score or embedding cost.'] };
}
