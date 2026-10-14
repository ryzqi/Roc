import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { findForbiddenPackages } from './lib/renderer-chunk-attribution.mjs';

/**
 * Renderer eager-graph guard.
 *
 * Three properties, because each one caught (or failed to catch) a real problem:
 *
 *   1. **Byte budget** — a coarse ceiling on what the first paint downloads.
 *   2. **Forbidden chunk/module names** — keeps the Markdown/streamdown/highlight/
 *      settings families out of the entry. Only names, so it is easy to satisfy by
 *      accident, which is why (3) exists.
 *   3. **Forbidden packages in the static graph** (P3) — reads the
 *      `//#region node_modules/.pnpm/<pkg>@…` markers rolldown emits inside each
 *      eager chunk.
 *
 * (3) is not theoretical. Giving `react-diff-view` a manual chunk made rolldown
 * inline React's CommonJS module into it; the entry needs React, so it statically
 * imported that whole chunk — pulling react-diff-view (plus its CSS) into every
 * launch. Bytes (901,950 of 1,700,000) and names (`renderer-diff` matches nothing)
 * both passed. A design rule that only lives in a comment is not enforced, so the
 * packages whose *only* consumers are lazily loaded surfaces are listed here.
 */

const eagerBudgetBytes = 1_700_000;
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
const entry = entries.find(([, value]) => value.isEntry === true);
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
  for (const name of findForbiddenPackages(source)) {
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

console.log(`Renderer eager JS: ${totalBytes} bytes (${files.size} files).`);
