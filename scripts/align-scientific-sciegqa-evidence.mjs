import {execFileSync} from 'node:child_process';
import {lstatSync, mkdirSync, readFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {observeSciegqaPaper, sciegqaEvidenceContract, verifySciegqaObservation} from '../evaluation/adapters/scientific-public/sciegqa-evidence.mjs';
import {publicPdfArtifactPath} from '../evaluation/adapters/scientific-public/pdf.mjs';
import {fileInventory, hash, readJson, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';

const {values} = parseArgs({options: {root: {type: 'string'}, 'output-root': {type: 'string'},
  verify: {type: 'boolean'}}, strict: true, allowPositionals: false});
try {
  if (!values['output-root']) throw new Error('scientific_sciegqa_correspondence_output_required');
  const root = resolve(values.root ?? join(ROOT, 'evaluation/local/corpora/sciegqa-bench-v1'));
  const outputRoot = resolve(values['output-root']);
  const contains = (parent, child) => {
    const rel = relative(parent, child);
    return !rel || rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
  };
  if (contains(root, outputRoot) || contains(outputRoot, root)) {
    throw new Error('scientific_sciegqa_correspondence_overlaps_input');
  }
  for (let current = outputRoot;; current = resolve(current, '..')) {
    try {if (lstatSync(current).isSymbolicLink()) throw new Error('scientific_sciegqa_correspondence_link');}
    catch (error) {if (error.code !== 'ENOENT') throw error;}
    if (resolve(current, '..') === current) break;
  }
  // Rebuild export from exact locked originals before observing its assets.
  execFileSync('python3', [join(ROOT, 'scripts/prepare-scientific-sciegqa.py'),
    '--output-root', root, '--verify'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const original = readJson(publicPdfArtifactPath(root, 'manifest.json'));
  const labelsBytes = readFileSync(publicPdfArtifactPath(root, original.labelsPath));
  if (sha256(labelsBytes) !== original.labelsHash) throw new Error('scientific_sciegqa_correspondence_labels_changed');
  const labels = JSON.parse(labelsBytes);
  if (!values.verify) mkdirSync(outputRoot, {recursive: false, mode: 0o700});
  const emitted = new Set(), save = (name, value) => {
    emitted.add(name);
    if (values.verify) verifySciegqaObservation(readJson(publicPdfArtifactPath(outputRoot, name)), value);
    else writeJson(join(outputRoot, name), value);
  };
  const papers = [], regionResults = new Map();
  for (const [index, paper] of original.papers.entries()) {
    const selected = labels.filter(label => label.paperId === paper.id);
    const regions = [...new Map(selected.flatMap(label => label.evidence).map(region => {
      const key = hash([paper.id, region.page, region.normalizedBbox]);
      return [key, {...region, id: key}];
    })).values()];
    const observed = await observeSciegqaPaper(root, paper, regions, publicPdfArtifactPath);
    const name = `paper-${index}.json`; save(name, observed);
    for (const page of observed.pages) for (const region of page.regions) regionResults.set(region.id, region);
    papers.push({id: paper.id, artifact: name, artifactHash: hash(observed),
      pages: observed.pdfPages ?? 0, imagePages: observed.imagePages ?? 0, extraImages: observed.extraImages ?? [],
      candidatePages: observed.pages.filter(p => p.status === 'visual-correspondence-candidate').length,
      candidateRegions: observed.pages.flatMap(p => p.regions)
        .filter(r => r.status === 'visual-correspondence-candidate').length});
    console.error(`Observed SciEGQA ${index + 1}/${original.papers.length} ${paper.id}: ${papers.at(-1).candidatePages}/${papers.at(-1).pages} page candidates`);
    globalThis.gc?.();
  }
  const alignment = labels.map(label => {
    const evidence = label.evidence.map(region => {
      const id = hash([label.paperId, region.page, region.normalizedBbox]), result = regionResults.get(id);
      return {publishedRegionId: region.id, observationId: id,
        status: result?.status ?? 'source-region-unavailable'};
    });
    return {id: label.id, publishedRow: label.publishedRow, paperId: label.paperId, evidence,
      status: label.status === 'published-image-regions-verified'
        && evidence.length > 0 && evidence.every(e => e.status === 'visual-correspondence-candidate')
        ? 'all-published-regions-visual-candidates' : 'unqualified-source-correspondence',
      humanLocatorReview: false};
  });
  save('alignment.json', alignment);
  const counts = {};
  for (const row of alignment) counts[row.status] = (counts[row.status] ?? 0) + 1;
  const manifest = {schemaVersion: 1, kind: 'scientific-sciegqa-original-pdf-image-correspondence',
    contract: sciegqaEvidenceContract, sourceLockHash: original.sourceLockHash,
    labelsHash: original.labelsHash, exporterHash: original.exporterHash,
    runnerHash: sha256(readFileSync(new URL(import.meta.url))), publishedRows: labels.length,
    alignmentHash: hash(alignment), counts, papers, uniqueRegions: regionResults.size,
    candidateRegions: [...regionResults.values()].filter(r => r.status === 'visual-correspondence-candidate').length,
    scientificBaselineReady: false,
    limitations: ['Independent fixed-frame raster comparison, not human review or exact pixel identity.',
      '72dpi comparison permits one comparison pixel of ink tolerance; no page/shift/crop search.',
      'PDF coordinates remain candidates bound to actual rotation, CropBox and viewport.',
      'Every original row retained; failed/insufficient comparisons never become negatives.',
      'No full document text, cell structure, LaTeX, reading-order or Wiki fact gold.']};
  save('manifest.json', manifest);
  if (hash(fileInventory(outputRoot).map(f => f.path).sort()) !== hash([...emitted].sort())) {
    throw new Error('scientific_sciegqa_correspondence_inventory_changed');
  }
  console.log(JSON.stringify({verified: Boolean(values.verify), counts, papers: papers.length,
    pages: papers.reduce((n, p) => n + p.pages, 0), uniqueRegions: manifest.uniqueRegions,
    candidateRegions: manifest.candidateRegions, alignmentHash: manifest.alignmentHash}, null, 2));
} catch (error) {console.error(error.stack); process.exitCode = 1;}
