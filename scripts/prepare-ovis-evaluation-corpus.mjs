#!/usr/bin/env node
// Acquire immutable public research inputs; never run models or invent reviews.
import { createHash, randomUUID } from 'node:crypto';
import { constants, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { link, open, rm } from 'node:fs/promises';
import http from 'node:http';
import https from 'node:https';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';

const ROOT = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const LOCAL = 'evaluation/local/sources/ovis-ocr';
const CORPUS = 'evaluation/corpora/ovis-ocr';
const REPOSITORY = 'opendatalab/OmniDocBench';
const CURRENT = 'aa1ee96d106dbe53d0ae59474d75c6e6d9b53fec';
const ORIGINAL = 'f5f559bddf50e36f7f9899d842d0006f13ce8afc';
const LABEL_HASH = 'a45cd84b04ad8b793e775089640e6b681209abea33ead54c1828ddca35fae496';
const IMAGE_IDS_HASH = '132634cd1ba7a64cffdfd4cee45175942b66380894d19ccdb335b4bf3cb00589';
const PDF_IDS_HASH = 'f73f27feab548301d54bcc2219f153a5d08bfd291b2fc9dc3d053abef4cf20ed';
const SLICE_IMAGE_IDS_HASH = 'e68e05f1a4df2bbf56a59b94ab2bde892af0c7ca76d313b25b1dda1c2f30fa3f';
const MAX_FILE_BYTES = 64 * 1024 * 1024;
const LICENSE = 'upstream-research-only-noncommercial';
const SELECTOR = 'all-academic-literature-and-research-report-image-path-asc-v1';
const sha256 = data => createHash('sha256').update(data).digest('hex');
const gitBlob = data => createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
const jsonBytes = data => Buffer.from(`${JSON.stringify(data, null, 2)}\n`);
const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const idsHash = values => sha256(`${[...values].sort(compare).join('\n')}\n`);
const requireValue = (value, code) => { if (!value) throw new Error(`ovis_corpus_${code}`); };

function relativePath(name) {
  requireValue(typeof name === 'string' && !/[\\\x00-\x1f]/u.test(name)
    && !name.startsWith('/') && name.split('/').every(part => part && part !== '.' && part !== '..'), 'path_invalid');
  return name;
}

// Inspect every component, including dangling symlinks, before reading/writing.
function localPath(name, create = false) {
  const parts = relativePath(name).split('/');
  let path = ROOT;
  for (const [i, part] of parts.entries()) {
    path = join(path, part);
    let stat;
    try { stat = lstatSync(path); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!stat && create && i < parts.length - 1) { mkdirSync(path, { mode: 0o700 }); stat = lstatSync(path); }
    if (stat) requireValue(!stat.isSymbolicLink() && (i === parts.length - 1 ? stat.isFile() : stat.isDirectory()), 'path_invalid');
  }
  return path;
}

export async function writeOnce(name, bytes, verify = false) {
  const path = localPath(name, !verify);
  if (existsSync(path)) {
    requireValue(readFileSync(path).equals(bytes), `existing_file_changed:${name}`);
    return;
  }
  requireValue(!verify, `file_missing:${name}`);
  const part = `${path}.part-${randomUUID()}`;
  try {
    const file = await open(part, 'wx', 0o600);
    try { await file.writeFile(bytes); await file.sync(); } finally { await file.close(); }
    // Hard-link promotion is atomic and refuses to replace a competing target.
    await link(part, path);
  } finally { await rm(part, { force: true }); }
}

function trustedUrl(input) {
  const url = new URL(input);
  requireValue(url.protocol === 'https:' && !url.username && !url.password && !url.hash
    && (url.hostname === 'huggingface.co' || url.hostname.endsWith('.huggingface.co')
      || url.hostname === 'hf.co' || url.hostname.endsWith('.hf.co')), 'url_untrusted');
  return url;
}

function requestBytes(input, limit, signal, hops = 0) {
  const url = trustedUrl(input);
  requireValue(hops <= 8, 'redirect_limit');
  return new Promise((resolveRequest, reject) => {
    const request = https.get(url, { signal, headers: {
      'User-Agent': 'Roc-Ovis-evaluation-acquisition/1', 'Accept-Encoding': 'identity'
    } }, response => {
      const status = response.statusCode ?? 0;
      if ([301, 302, 303, 307, 308].includes(status)) {
        const location = response.headers.location;
        response.resume();
        if (!location) { reject(new Error('ovis_corpus_redirect_missing')); return; }
        try { resolveRequest(requestBytes(new URL(location, url).href, limit, signal, hops + 1)); }
        catch (error) { reject(error); }
        return;
      }
      if (status !== 200) {
        response.resume();
        reject(Object.assign(new Error(`ovis_corpus_http_${status}`), { retryable: status === 429 || status >= 500 }));
        return;
      }
      const chunks = [];
      let count = 0;
      response.on('data', chunk => {
        count += chunk.length;
        if (count > limit) { response.destroy(new Error('ovis_corpus_response_too_large')); return; }
        chunks.push(chunk);
      });
      response.on('end', () => resolveRequest({ bytes: Buffer.concat(chunks), headers: response.headers }));
      response.on('error', reject);
      response.on('aborted', () => reject(Object.assign(new Error('ovis_corpus_response_aborted'), { retryable: true })));
    });
    request.on('error', reject);
  });
}

async function download(url, limit, signal) {
  for (let attempt = 0; attempt < 3; attempt++) {
    signal.throwIfAborted();
    try { return await requestBytes(url, limit, AbortSignal.any([signal, AbortSignal.timeout(90_000)])); }
    catch (error) {
      const retryable = error.retryable ?? ['ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ECONNREFUSED', 'ABORT_ERR'].includes(error.code);
      if (!retryable || signal.aborted || attempt === 2) throw error;
      console.error(`Retry ${attempt + 1}/2: ${new URL(url).pathname}`);
      await delay((attempt + 1) * 2000, undefined, { signal });
    }
  }
  throw new Error('ovis_corpus_download_failed');
}

function validateTreeRow(row) {
  requireValue(row && ['directory', 'file'].includes(row.type) && /^[a-f0-9]{40}$/u.test(row.oid)
    && Number.isSafeInteger(row.size) && row.size >= 0, 'metadata_invalid');
  relativePath(row.path);
  if (row.lfs) requireValue(row.type === 'file' && /^[a-f0-9]{64}$/u.test(row.lfs.oid)
    && row.lfs.size === row.size, 'lfs_metadata_invalid');
}

async function tree(revision, folder, context) {
  const prefix = `https://huggingface.co/api/datasets/${REPOSITORY}/tree/${revision}`;
  let url = `${prefix}${folder ? `/${folder}` : ''}?recursive=${Boolean(folder)}&expand=false&limit=1000`;
  const files = new Map();
  const seenUrls = new Set();
  for (let index = 0; url; index++) {
    requireValue(index < 10 && !seenUrls.has(url), 'metadata_pagination_invalid');
    seenUrls.add(url);
    const name = `metadata/${revision}/${folder || 'root'}-${index}.json`;
    const path = localPath(`${LOCAL}/${name}`, !context.verify);
    let envelope;
    if (existsSync(path)) envelope = JSON.parse(readFileSync(path, 'utf8'));
    else {
      requireValue(!context.verify, `metadata_missing:${name}`);
      const { bytes, headers } = await download(url, 4 * 1024 * 1024, context.signal);
      const matches = [...(headers.link ?? '').matchAll(/<([^>]+)>;\s*rel="next"/gu)];
      requireValue(matches.length <= 1, 'metadata_pagination_invalid');
      envelope = { url, next: matches[0]?.[1] ?? null, body: bytes.toString('utf8') };
      await writeOnce(`${LOCAL}/${name}`, jsonBytes(envelope));
    }
    requireValue(envelope.url === url && typeof envelope.body === 'string'
      && (envelope.next === null || (typeof envelope.next === 'string'
        && envelope.next.startsWith(`${prefix}${folder ? `/${folder}` : ''}?`))), 'metadata_identity_changed');
    const response = JSON.parse(envelope.body);
    requireValue(Array.isArray(response) && response.length <= 1000, 'metadata_invalid');
    for (const row of response) {
      validateTreeRow(row);
      requireValue(!files.has(row.path) && (!folder || row.path.startsWith(`${folder}/`)), 'metadata_duplicate_or_scope');
      files.set(row.path, row);
    }
    context.metadata.push({ path: name, url, next: envelope.next, responseSha256: sha256(envelope.body),
      sha256: sha256(readFileSync(path)) });
    url = envelope.next;
  }
  return files;
}

function asset(row, revision, path, role) {
  requireValue(row?.type === 'file' && row.size > 0 && row.size <= MAX_FILE_BYTES, 'asset_metadata_invalid');
  return { repository: REPOSITORY, revision, upstreamPath: row.path, path,
    url: `https://huggingface.co/datasets/${REPOSITORY}/resolve/${revision}/${row.path.split('/').map(encodeURIComponent).join('/')}`,
    bytes: row.size, upstreamBlobOid: row.oid, upstreamLfsSha256: row.lfs?.oid ?? null, role, license: LICENSE };
}

export function verifyAssetBytes(pin, bytes) {
  requireValue(bytes.length === pin.bytes, `size_mismatch:${pin.path}`);
  const hash = sha256(bytes);
  if (pin.upstreamLfsSha256) requireValue(hash === pin.upstreamLfsSha256, `lfs_mismatch:${pin.path}`);
  else requireValue(gitBlob(bytes) === pin.upstreamBlobOid, `git_blob_mismatch:${pin.path}`);
  if (pin.sha256) requireValue(hash === pin.sha256, `sha256_mismatch:${pin.path}`);
  if (pin.role === 'original-pdf-slice') requireValue(bytes.subarray(0, 5).toString('ascii') === '%PDF-', 'pdf_signature_invalid');
  let media = {};
  if (pin.role === 'page-image') {
    const png = bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'));
    const jpg = bytes.subarray(0, 3).equals(Buffer.from('ffd8ff', 'hex'));
    requireValue(png || jpg, 'image_signature_invalid');
    media = { detectedMediaType: png ? 'image/png' : 'image/jpeg',
      filenameExtensionMatchesMediaType: png ? pin.path.endsWith('.png') : pin.path.endsWith('.jpg') };
  }
  return { ...pin, ...media, sha256: hash,
    verification: pin.upstreamLfsSha256 ? 'lfs-sha256-and-size' : 'git-blob-sha1-and-size-plus-raw-sha256' };
}

async function acquire(pin, context) {
  const path = localPath(`${LOCAL}/${pin.path}`, !context.verify);
  if (existsSync(path)) {
    requireValue(lstatSync(path).size === pin.bytes, `size_mismatch:${pin.path}`);
    const verified = verifyAssetBytes(pin, readFileSync(path));
    context.reusedFiles++;
    return verified;
  }
  requireValue(!context.verify, `asset_missing:${pin.path}`);
  const publicName = pin.path === 'labels.json' ? 'labels.json' : pin.path;
  const candidate = pin.revision === CURRENT && !pin.path.startsWith('provenance/')
    ? localPath(`evaluation/local/sources/scientific-public/omnidocbench/${publicName}`) : null;
  let bytes;
  if (candidate && existsSync(candidate)) {
    requireValue(lstatSync(candidate).size === pin.bytes, `reuse_size_mismatch:${pin.path}`);
    bytes = readFileSync(candidate);
    context.copiedFiles++;
  } else {
    ({ bytes } = await download(pin.url, pin.bytes, context.signal));
    context.downloadedFiles++;
    context.downloadedBytes += bytes.length;
  }
  const verified = verifyAssetBytes(pin, bytes);
  await writeOnce(`${LOCAL}/${pin.path}`, bytes);
  return verified;
}

function counts(pages) {
  const attributeCounts = field => Object.fromEntries([...pages.reduce((map, page) => {
    const value = page.page_info.page_attribute[field];
    map.set(value, (map.get(value) ?? 0) + 1); return map;
  }, new Map())].sort(([a], [b]) => compare(a, b)));
  const objects = (category, key) => {
    const rows = pages.map(page => page.layout_dets.filter(row => row.category_type === category && !row.ignore && row[key]));
    return { pages: rows.filter(row => row.length).length, objects: rows.reduce((sum, row) => sum + row.length, 0) };
  };
  return { pages: pages.length, sources: attributeCounts('data_source'), languages: attributeCounts('language'),
    layouts: attributeCounts('layout'), subsets: attributeCounts('subset'),
    isolatedFormulasWithLatex: objects('equation_isolated', 'latex'), tablesWithHtml: objects('table', 'html'),
    declaredFuzzyScans: pages.filter(page => page.page_info.page_attribute.special_issue?.includes('fuzzy_scan')).length };
}

export async function prepare({ verify = false, workers = 4, signal = new AbortController().signal } = {}) {
  requireValue(Number.isInteger(workers) && workers >= 1 && workers <= 4, 'workers_invalid');
  http.setGlobalProxyFromEnv?.();
  const context = { verify, signal, metadata: [], downloadedFiles: 0, downloadedBytes: 0, copiedFiles: 0, reusedFiles: 0 };
  const oldLockPath = localPath(`${CORPUS}/sources.lock.json`);
  const previous = existsSync(oldLockPath) ? JSON.parse(readFileSync(oldLockPath, 'utf8')) : null;
  requireValue(!verify || previous, 'lock_missing');
  if (previous) {
    requireValue(previous.schemaVersion === 1 && previous.id === 'ovis-ocr-scientific-pages-v1'
      && previous.datasetRevision === CURRENT && previous.originalPdfRevision === ORIGINAL, 'lock_identity_changed');
    // Existing lock seals cached metadata too, before using it to derive inputs.
    for (const pin of previous.metadata) requireValue(sha256(readFileSync(localPath(`${LOCAL}/${pin.path}`))) === pin.sha256,
      `metadata_changed:${pin.path}`);
  }
  const currentRoot = await tree(CURRENT, '', context);
  const oldRoot = await tree(ORIGINAL, '', context);
  const labelsPin = asset(currentRoot.get('OmniDocBench.json'), CURRENT, 'labels.json', 'full-upstream-annotations');
  requireValue(labelsPin.bytes === 42_208_096 && labelsPin.upstreamLfsSha256 === LABEL_HASH, 'labels_identity_changed');
  const files = [await acquire(labelsPin, context)];
  const labels = JSON.parse(readFileSync(localPath(`${LOCAL}/labels.json`), 'utf8'));
  requireValue(Array.isArray(labels) && labels.length === 1651, 'labels_page_count_changed');
  const selected = labels.filter(page => ['academic_literature', 'research_report'].includes(page.page_info?.page_attribute?.data_source))
    .sort((a, b) => compare(a.page_info.image_path, b.page_info.image_path));
  requireValue(selected.length === 347 && new Set(selected.map(page => page.page_info.image_path)).size === 347
    && idsHash(selected.map(page => page.page_info.image_path)) === IMAGE_IDS_HASH, 'image_selection_changed');
  const images = await tree(CURRENT, 'images', context);
  const oldImages = await tree(ORIGINAL, 'images', context);
  const originalPdfs = await tree(ORIGINAL, 'ori_pdfs', context);
  requireValue(images.size === 1651 && oldImages.size === 981 && originalPdfs.size === 981, 'upstream_tree_count_changed');
  const pins = [asset(currentRoot.get('README.md'), CURRENT, 'provenance/current-README.md', 'license-and-annotation-method'),
    asset(oldRoot.get('README.md'), ORIGINAL, 'provenance/original-pdf-README.md', 'original-pdf-provenance')];
  const pages = selected.map(page => {
    const imageName = page.page_info.image_path;
    requireValue(!imageName.includes('/') && /\.(png|jpg)$/u.test(imageName), 'image_name_invalid');
    const imagePath = `images/${imageName}`;
    pins.push(asset(images.get(imagePath), CURRENT, imagePath, 'page-image'));
    const pdfPath = `ori_pdfs/${imageName.replace(/\.(png|jpg)$/u, '')}.pdf`;
    const pdf = originalPdfs.get(pdfPath);
    let originalPdf = null;
    if (pdf) {
      const oldImage = oldImages.get(imagePath), currentImage = images.get(imagePath);
      requireValue(oldImage && oldImage.oid === currentImage.oid && oldImage.size === currentImage.size, 'historical_image_changed');
      pins.push(asset(pdf, ORIGINAL, pdfPath, 'original-pdf-slice'));
      originalPdf = { path: pdfPath, revision: ORIGINAL, historicalImage: { path: imagePath, revision: ORIGINAL,
        bytes: oldImage.size, upstreamBlobOid: oldImage.oid, upstreamLfsSha256: oldImage.lfs?.oid ?? null },
      geometryQualification: 'not_performed', nativeTextLayerQualification: 'not_performed',
      originalDocumentIdentity: null, crossPageQualification: 'not_performed' };
    }
    return { imagePath, annotationImagePath: imageName, upstreamPageNo: page.page_info.page_no,
      width: page.page_info.width, height: page.page_info.height, attributes: page.page_info.page_attribute,
      annotationIds: page.layout_dets.map(row => row.anno_id), originalPdf };
  });
  const slices = pages.filter(page => page.originalPdf);
  requireValue(slices.length === 210 && idsHash(slices.map(page => page.originalPdf.path)) === PDF_IDS_HASH
    && idsHash(slices.map(page => page.annotationImagePath)) === SLICE_IMAGE_IDS_HASH, 'pdf_selection_changed');
  requireValue(new Set(pins.map(pin => pin.path)).size === pins.length && pins.length === 559
    && pins.reduce((sum, pin) => sum + pin.bytes, labelsPin.bytes) < 300 * 1024 * 1024, 'asset_budget_or_duplicates');
  const controller = new AbortController();
  const workContext = { ...context, signal: AbortSignal.any([signal, controller.signal]) };
  let next = 0, completed = 0, firstError;
  const results = new Array(pins.length);
  const worker = async () => {
    while (next < pins.length) {
      const index = next++;
      try { results[index] = await acquire(pins[index], workContext); }
      catch (error) {
        firstError ??= Object.assign(new Error(`${pins[index].path}: ${error.message}`), { cause: error });
        controller.abort(firstError);
        throw error;
      }
      completed++;
      if (completed % 25 === 0 || completed === pins.length) console.error(`Verified ${completed}/${pins.length} Ovis evaluation assets`);
    }
  };
  const outcomes = await Promise.allSettled(Array.from({ length: workers }, worker));
  const failed = outcomes.find(outcome => outcome.status === 'rejected');
  if (failed) throw firstError ?? failed.reason;
  files.push(...results);
  files.sort((a, b) => compare(a.path, b.path));
  const gold = jsonBytes(selected);
  const goldPin = { path: 'scientific-gold.json', bytes: gold.length, sha256: sha256(gold),
    derivation: 'selected upstream objects without field edits; pages sorted by image_path' };
  await writeOnce(`${LOCAL}/${goldPin.path}`, gold, verify);
  const sliceNames = new Set(slices.map(page => page.annotationImagePath));
  const provenance = { kind: 'published-manual-and-assisted-expert-checked-annotations',
    methodSource: 'https://arxiv.org/abs/2412.07626', localIndependentReview: 'not_performed',
    localIndependentReviewerCount: 0, upstreamAnnotatorCount: null, verifiedOriginalDocumentCount: null,
    trainingHoldoutIndependence: 'not_established', fullScientificQualityQualified: false };
  const selection = { schemaVersion: 1, id: 'ovis-ocr-scientific-pages-v1', selector: SELECTOR,
    labelsSha256: LABEL_HASH, imagePathsSha256: IMAGE_IDS_HASH,
    originalPdfPathsSha256: PDF_IDS_HASH, originalPdfImagePathsSha256: SLICE_IMAGE_IDS_HASH,
    component: counts(selected), originalPdfCandidates: counts(selected.filter(page => sliceNames.has(page.page_info.image_path))),
    provenance, pages };
  const selectionBytes = jsonBytes(selection);
  const lock = { schemaVersion: 1, id: selection.id, repository: REPOSITORY,
    datasetRevision: CURRENT, originalPdfRevision: ORIGINAL, selector: SELECTOR,
    license: LICENSE, codeLicenseNotDatasetLicense: true, rawAssetsRedistributed: false,
    provenance, localSourceRoot: LOCAL, metadata: context.metadata.sort((a, b) => compare(a.path, b.path)),
    files, derivedGold: goldPin, selection: { path: `${CORPUS}/selection.json`, sha256: sha256(selectionBytes) },
    counts: { componentPages: 347, originalPdfSlices: 210, sourceFiles: files.length,
      imagesBytes: files.filter(pin => pin.role === 'page-image').reduce((sum, pin) => sum + pin.bytes, 0),
      originalPdfsBytes: files.filter(pin => pin.role === 'original-pdf-slice').reduce((sum, pin) => sum + pin.bytes, 0),
      totalSourceBytes: files.reduce((sum, pin) => sum + pin.bytes, 0) } };
  await writeOnce(`${CORPUS}/selection.json`, selectionBytes, verify);
  await writeOnce(`${CORPUS}/sources.lock.json`, jsonBytes(lock), verify);
  return { status: 'verified-acquired-inputs-only', offline: verify, sourceLockSha256: sha256(jsonBytes(lock)),
    ...lock.counts, downloadedFiles: workContext.downloadedFiles, downloadedBytes: workContext.downloadedBytes,
    copiedFiles: workContext.copiedFiles, reusedFiles: workContext.reusedFiles,
    component: selection.component, originalPdfCandidates: selection.originalPdfCandidates, provenance };
}

async function main() {
  const { values } = parseArgs({ options: { verify: { type: 'boolean' }, workers: { type: 'string', default: '4' },
    help: { type: 'boolean' } }, strict: true, allowPositionals: false });
  if (values.help) { console.log('node scripts/prepare-ovis-evaluation-corpus.mjs [--verify] [--workers 1..4]'); return; }
  const controller = new AbortController();
  const stop = () => controller.abort(new Error('ovis_corpus_cancelled'));
  process.once('SIGINT', stop); process.once('SIGTERM', stop);
  let lease;
  const leaseName = `${LOCAL}/.acquisition.lock`;
  try {
    if (!values.verify) {
      lease = await open(localPath(leaseName, true), constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
      await lease.writeFile(`${process.pid}\n`);
    }
    console.log(JSON.stringify(await prepare({ verify: values.verify, workers: Number(values.workers), signal: controller.signal }), null, 2));
  } finally {
    if (lease) { await lease.close(); await rm(localPath(leaseName), { force: true }); }
    process.off('SIGINT', stop); process.off('SIGTERM', stop);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
