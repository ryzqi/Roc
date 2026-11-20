import {execFileSync} from 'node:child_process';
import {lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync} from 'node:fs';
import {isAbsolute, join, relative, resolve, sep} from 'node:path';
import {parseArgs} from 'node:util';
import {publicPdfArtifactPath} from '../evaluation/adapters/scientific-public/pdf.mjs';
import {loadSciegqaCorrespondence} from '../evaluation/adapters/scientific-public/sciegqa-retrieval.mjs';
import {createSciegqaReviewMaterials, renderSciegqaReviewDocuments,
  verifySciegqaReviewMaterials} from '../evaluation/adapters/scientific-public/sciegqa-review.mjs';
import {fileInventory, hash, readJson, ROOT, sha256, writeJson} from '../evaluation/lib/common.mjs';

const {values} = parseArgs({options: {
  output: {type: 'string'}, verify: {type: 'boolean'},
}, strict: true, allowPositionals: false});

try {
  if (!values.output) throw new Error('Usage: --output evaluation/local/... [--verify]');
  // Source files and editable human work must never be overwritten.
  const localRoot = realpathSync(join(ROOT, 'evaluation/local'));
  const output = resolve(ROOT, values.output), rel = relative(localRoot, output);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)
    || !rel || rel.split(sep)[0] !== 'review-materials' || rel.split(sep).length < 2) {
    throw new Error('scientific_sciegqa_review_output_invalid');
  }
  for (let path = output; path !== localRoot; path = resolve(path, '..')) {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('scientific_sciegqa_review_output_link');
    } catch (error) {if (error.code !== 'ENOENT') throw error;}
  }
  const sourceRoot = join(ROOT, 'evaluation/local/corpora/sciegqa-bench-v1');
  const correspondenceRoot = join(ROOT, '.artifacts/scientific-rag/sciegqa-evidence-01');
  // Python independently rebuilds every exported label/asset from locked releases.
  execFileSync('python3', [join(ROOT, 'scripts/prepare-scientific-sciegqa.py'),
    '--output-root', sourceRoot, '--verify'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const manifest = readJson(publicPdfArtifactPath(sourceRoot, 'manifest.json'));
  const labelsPath = publicPdfArtifactPath(sourceRoot, 'labels.json');
  if (sha256(readFileSync(labelsPath)) !== manifest.labelsHash) {
    throw new Error('scientific_sciegqa_review_labels_bytes_changed');
  }
  const labels = readJson(labelsPath);
  const cohortPath = join(ROOT, 'evaluation/corpora/scientific-rag/sciegqa-cohort.lock.json');
  const cohort = readJson(cohortPath);
  const correspondence = loadSciegqaCorrespondence(correspondenceRoot, manifest, labels);
  const observed = readJson(publicPdfArtifactPath(correspondenceRoot, 'manifest.json'));
  const pin = path => ({path: relative(ROOT, path).split(sep).join('/'),
    bytes: lstatSync(path).size, sha256: sha256(readFileSync(path))});
  const sourcePins = [pin(join(sourceRoot, 'manifest.json')), pin(labelsPath), pin(cohortPath),
    pin(join(correspondenceRoot, 'manifest.json')), pin(join(correspondenceRoot, 'alignment.json'))];
  const correspondencePapers = new Map(observed.papers.map(p => {
    const path = publicPdfArtifactPath(correspondenceRoot, p.artifact);
    return [p.id, {path: p.artifact, artifactHash: p.artifactHash,
      bytes: lstatSync(path).size, sha256: sha256(readFileSync(path))}];
  }));
  const inputs = {manifest, labels, cohort, correspondence, correspondencePapers, sourcePins};
  if (!values.verify) {
    // Nonrecursive mkdir is the create-only boundary even for an empty old packet.
    mkdirSync(join(localRoot, 'review-materials'), {recursive: true, mode: 0o700});
    mkdirSync(output, {mode: 0o700});
    const {materials, worklist} = createSciegqaReviewMaterials(inputs);
    writeJson(join(output, 'materials.json'), materials);
    writeJson(join(output, 'WORKLIST.json'), worklist);
    mkdirSync(join(output, 'papers'), {mode: 0o700});
    for (const [path, text] of renderSciegqaReviewDocuments(materials, output, sourceRoot, correspondenceRoot)) {
      writeFileSync(join(output, path), text, {flag: 'wx', mode: 0o600});
    }
    writeJson(join(output, 'manifest.json'), {schemaVersion: 1,
      kind: 'sciegqa-review-material-inventory', materialsHash: hash(materials),
      worklistHash: hash(worklist), files: fileInventory(output),
      humanReviewed: false, scientificBaselineReady: false});
  }
  const materials = readJson(publicPdfArtifactPath(output, 'materials.json'));
  const worklist = readJson(publicPdfArtifactPath(output, 'WORKLIST.json'));
  const counts = verifySciegqaReviewMaterials(materials, worklist, inputs);
  for (const [path, text] of renderSciegqaReviewDocuments(materials, output, sourceRoot, correspondenceRoot)) {
    if (readFileSync(publicPdfArtifactPath(output, path), 'utf8') !== text) {
      throw new Error('scientific_sciegqa_review_document_changed');
    }
  }
  const inventory = readJson(publicPdfArtifactPath(output, 'manifest.json'));
  if (hash(inventory) !== hash({schemaVersion: 1, kind: 'sciegqa-review-material-inventory',
    materialsHash: hash(materials), worklistHash: hash(worklist),
    files: fileInventory(output).filter(f => f.path !== 'manifest.json'),
    humanReviewed: false, scientificBaselineReady: false})) {
    throw new Error('scientific_sciegqa_review_inventory_changed');
  }
  console.log(JSON.stringify({verified: true, output: relative(ROOT, output),
    ...counts, materialsHash: hash(materials), worklistHash: hash(worklist),
    inventoryHash: hash(inventory), files: inventory.files.length + 1,
    sourceLabelsByteHash: manifest.labelsHash, correspondenceHash: correspondence.alignmentHash}, null, 2));
} catch (error) {console.error(error.stack); process.exitCode = 1;}
