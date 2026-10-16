import { readFileSync, readdirSync, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { scanPackageRegions } from './lib/renderer-chunk-attribution.mjs';

/**
 * Eager-graph module attribution report.
 *
 * Not a test: a diagnostic that answers "which node_modules ended up in the
 * *static* graph of the entry, and how much did each one cost". It exists because
 * `check-renderer-chunks.mjs` only enforces a byte budget, and a manual chunk
 * configuration can move a lazily loaded dependency into the eager graph without
 * any check firing — which is exactly what happened in P3 when `react-diff-view`
 * and `react` ended up sharing a chunk (`renderer-diff`, renamed by hand to
 * `renderer-react` once the cause was understood; see `electron.vite.config.ts`).
 *
 * Usage: `node scripts/report-renderer-eager-modules.mjs` after `pnpm build`.
 *
 * Attribution is textual: it reads the `//#region node_modules/.pnpm/<spec>/…`
 * comments rolldown emits. That is enough to answer "which package is in this
 * file", and it deliberately does not claim to apportion bytes between packages
 * inside one chunk (a region's byte ranges are not recorded in the output).
 */

const rendererRoot = join(process.cwd(), 'dist', 'renderer');
let manifest;
try {
  manifest = JSON.parse(readFileSync(join(rendererRoot, '.vite', 'manifest.json'), 'utf8'));
} catch (error) {
  // Running this before a build is the common mistake, so say that rather than
  // emitting a raw ENOENT/SyntaxError.
  throw new Error(`renderer_manifest_unreadable: run \`pnpm build\` first (${String(error)})`);
}

const entry = Object.entries(manifest).find(([, value]) => value.isEntry === true);
if (entry === undefined) {
  throw new Error('renderer_chunk_entry_missing');
}

const visited = new Set();
const chunks = [];
function visit(key) {
  if (visited.has(key)) {
    return;
  }
  const item = manifest[key];
  if (item === undefined) {
    throw new Error(`renderer_chunk_manifest_reference_missing:${key}`);
  }
  visited.add(key);
  chunks.push({ key, file: item.file });
  for (const imported of Array.isArray(item.imports) ? item.imports : []) {
    visit(imported);
  }
}
visit(entry[0]);

let eagerTotal = 0;
for (const chunk of chunks) {
  const path = join(rendererRoot, chunk.file);
  const size = statSync(path).size;
  eagerTotal += size;
  const source = readFileSync(path, 'utf8');
  const counts = scanPackageRegions(source);
  console.log(`${chunk.file}  ${size} B`);
  if (counts.size === 0) {
    console.log('   (no node_modules region markers)');
    continue;
  }
  for (const name of [...counts.keys()].sort()) {
    console.log(`   ${name}  (${counts.get(name)} region${counts.get(name) === 1 ? '' : 's'})`);
  }
}

console.log(`\nEager static graph: ${eagerTotal} bytes across ${chunks.length} file(s).`);
console.log(`Assets directory: ${readdirSync(join(rendererRoot, 'assets')).length} file(s).`);
console.log(`Entry: ${entry[0]} (${basename(manifest[entry[0]].file)})`);
console.log('\nLazy chunks (must NOT appear above):');
for (const [key, value] of Object.entries(manifest)) {
  if (visited.has(key) || value.isEntry === true) {
    continue;
  }
  console.log(`   ${value.file}  ${statSync(join(rendererRoot, value.file)).size} B   ${key}`);
}
