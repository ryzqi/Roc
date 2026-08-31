import { readFileSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';

const eagerBudgetBytes = 1_700_000;
const rendererRoot = join(process.cwd(), 'dist', 'renderer');
const manifestPath = join(rendererRoot, '.vite', 'manifest.json');
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
const entries = Object.entries(manifest);
const entry = entries.find(([, value]) => value.isEntry === true);
if (entry === undefined) {
  throw new Error('renderer_chunk_entry_missing');
}

const visited = new Set();
const files = new Set();
const forbidden = /markdown|streamdown|highlight|settings/iu;

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
  const dynamicImports = Array.isArray(item.dynamicImports) ? item.dynamicImports : [];
  void dynamicImports;
  for (const importedKey of imports) {
    visit(importedKey);
  }
}

visit(entry[0]);

let totalBytes = 0;
for (const file of files) {
  if (file.endsWith('.js')) {
    totalBytes += statSync(join(rendererRoot, file)).size;
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
