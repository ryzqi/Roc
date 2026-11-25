import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { EAGER_FORBIDDEN_PACKAGES, readChunkPackages } from './lib/renderer-chunk-attribution.mjs';

/**
 * Renderer chunk guards.
 *
 * Four properties, because each one caught (or failed to catch) a real problem:
 *
 *   1. **Byte budget** — a coarse ceiling on what the first paint downloads.
 *   2. **Forbidden chunk/module names** — keeps the Markdown/streamdown/highlight/
 *      settings families out of the entry. Only names, so it is easy to satisfy by
 *      accident, which is why (3) exists.
 *   3. **Forbidden packages in the static graph** (P3) — reads the
 *      build-time module metadata, checked against each output's hash. This
 *      remains effective when minification removes source region comments.
 *   4. **Every JS chunk's size** — includes lazy application surfaces and shared
 *      vendors. Mermaid is restricted to our supported diagram formats at build
 *      time; the unused parser must stay out of all chunks. The ELK engine is a
 *      separately verified, local Worker asset, with only its API in chunks.
 *
 * (3) is not theoretical. Giving `react-diff-view` a manual chunk made rolldown
 * inline React's CommonJS module into it; the entry needs React, so it statically
 * imported that whole chunk — pulling react-diff-view (plus its CSS) into every
 * launch. Bytes (901,950 of 1,700,000) and names (`renderer-diff` matches nothing)
 * both passed. A design rule that only lives in a comment is not enforced, so the
 * packages whose *only* consumers are lazily loaded surfaces are listed here.
 */

const eagerBudgetBytes = 1_700_000;
const chunkBudgetBytes = 500_000;
const unsupportedDiagramPackages = ['@mermaid-js/parser'];
const rendererRoot = join(process.cwd(), 'dist', 'renderer');

/** Any eagerly loaded file whose name must not match (see rule 2 above). */
const forbidden = /markdown|streamdown|highlight|settings/iu;

let manifest;
try {
  manifest = JSON.parse(readFileSync(join(rendererRoot, '.vite', 'manifest.json'), 'utf8'));
} catch (error) {
  throw new Error(`renderer_chunk_manifest_unreadable: run \`pnpm build\` first (${String(error)})`);
}

const entries = Object.entries(manifest);
let workerAssets = {};
try {
  const metadata = JSON.parse(readFileSync(join(rendererRoot, '.vite', 'diagram-worker-assets.json'), 'utf8'));
  if (metadata.version !== 1 || metadata.assets === null || typeof metadata.assets !== 'object' ||
      Array.isArray(metadata.assets)) throw new Error('renderer_worker_asset_metadata_invalid');
  workerAssets = metadata.assets;
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}
let workerBytes = 0;
for (const [file, metadata] of Object.entries(workerAssets)) {
  if (!/^assets\/elk-worker\.min-[^/]+\.js$/u.test(file) || metadata?.kind !== 'elk') {
    throw new Error(`renderer_worker_asset_metadata_invalid:${file}`);
  }
  const source = readFileSync(join(rendererRoot, file));
  if (metadata.bytes !== source.length || metadata.sha256 !== createHash('sha256').update(source).digest('hex')) {
    throw new Error(`renderer_worker_asset_metadata_invalid:${file}: rebuild before checking`);
  }
  workerBytes += source.length;
}
const entry = entries.find(([key, value]) => key === 'index.html' && value.isEntry === true);
if (entry === undefined) {
  throw new Error('renderer_chunk_entry_missing');
}

const visited = new Set();
const files = new Set();

function visit(key) {
  if (visited.has(key)) {
    return;
  }
  const item = manifest[key];
  if (item === undefined) {
    throw new Error(`renderer_chunk_manifest_reference_missing:${key}`);
  }
  visited.add(key);
  files.add(item.file);
  if (forbidden.test(key) || forbidden.test(basename(item.file))) {
    throw new Error(`renderer_chunk_forbidden_eager_module:${key}:${item.file}`);
  }
  const imports = Array.isArray(item.imports) ? item.imports : [];
  // `dynamicImports` are the lazily loaded surfaces: they are supposed to be
  // outside this graph, so they are deliberately not visited.
  for (const importedKey of imports) {
    visit(importedKey);
  }
}

visit(entry[0]);

let totalBytes = 0;
for (const file of files) {
  const path = join(rendererRoot, file);
  totalBytes += statSync(path).size;
  if (!file.endsWith('.js')) {
    continue;
  }
  const source = readFileSync(path, 'utf8');
  const packages = readChunkPackages(rendererRoot, file, source);
  for (const name of EAGER_FORBIDDEN_PACKAGES.filter(name => packages.has(name))) {
    throw new Error(
      `renderer_chunk_eager_forbidden_package:${file}:${name}: this package must stay behind a dynamic import`
    );
  }
}

if (totalBytes > eagerBudgetBytes) {
  throw new Error(`renderer_chunk_budget_exceeded:${totalBytes}:${eagerBudgetBytes}`);
}

const html = readFileSync(join(rendererRoot, 'index.html'), 'utf8');
const modulepreload = [...html.matchAll(/<link[^>]+rel=["']modulepreload["'][^>]+href=["']([^"']+)["']/giu)]
  .map((match) => match[1].replace(/^\.\//u, '').replace(/^\//u, ''));
for (const file of modulepreload) {
  if (!files.has(file)) {
    throw new Error(`renderer_chunk_modulepreload_outside_eager_graph:${file}`);
  }
}

for (const [key, item] of entries) {
  if (!item.file.endsWith('.js')) continue;
  if (Object.hasOwn(workerAssets, item.file)) continue;
  const path = join(rendererRoot, item.file);
  const packages = readChunkPackages(rendererRoot, item.file, readFileSync(path, 'utf8'));
  for (const name of unsupportedDiagramPackages.filter(name => packages.has(name))) {
    throw new Error(`renderer_chunk_unsupported_diagram_package:${item.file}:${name}`);
  }
  const bytes = statSync(path).size;
  if (bytes > chunkBudgetBytes) {
    const category = item.isEntry || item.src?.startsWith('src/renderer/') ? 'app' : 'vendor';
    throw new Error(`renderer_chunk_${category}_budget_exceeded:${key}:${bytes}:${chunkBudgetBytes}`);
  }
}

// Vite lists ?worker outputs (including the existing PDF worker) in an entry's
// assets rather than as standalone chunks. Keep those references tracked too.
const knownJS = new Set([
  ...entries.flatMap(([, item]) => [item.file, ...(Array.isArray(item.assets) ? item.assets : [])]),
  ...Object.keys(workerAssets)
]);
for (const file of readdirSync(rendererRoot, {recursive: true})) {
  const normalized = file.replaceAll('\\', '/');
  if (normalized.endsWith('.js') && !knownJS.has(normalized)) {
    throw new Error(`renderer_chunk_untracked_javascript:${normalized}`);
  }
}

console.log(`Renderer eager JS: ${totalBytes} bytes (${files.size} files).`);
console.log(`Renderer JS chunks: within ${chunkBudgetBytes} bytes each; unsupported diagram packages absent.`);
if (workerBytes > 0) console.log(`Renderer local ELK Worker: ${workerBytes} bytes (prebuilt asset, hash verified).`);
