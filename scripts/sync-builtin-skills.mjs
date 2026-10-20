#!/usr/bin/env node
/**
 * Regenerates `resources/builtin-skills` from the two upstream repositories.
 *
 * Usage:
 *   pnpm sync:builtin-skills                     # both sources, upstream HEAD of their refs
 *   pnpm sync:builtin-skills --source=nature-skills
 *   pnpm sync:builtin-skills --from-dir=/path/to/checkout --commit=<sha>
 *
 * The pipeline itself lives in `scripts/builtin-skills/vendor.ts` and imports the main-process
 * modules, so it is bundled with esbuild first (the same technique `generate-ipc-schema.mjs`
 * uses). That keeps one implementation of archive extraction, snapshot layout and link handling
 * for the vendor path and the runtime sync.
 */
import { build } from 'esbuild';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = resolve(fileURLToPath(import.meta.url), '..', '..');
const entryPoint = resolve(repoRoot, 'scripts/builtin-skills/vendor.ts');

const compiled = await build({
  bundle: true,
  entryPoints: [entryPoint],
  format: 'esm',
  logLevel: 'silent',
  platform: 'node',
  target: 'node22',
  write: false
});
const output = compiled.outputFiles[0];
if (output === undefined) {
  throw new Error('Vendor bundle produced no output.');
}
const moduleUrl = `data:text/javascript;base64,${Buffer.from(output.text).toString('base64')}`;
const vendor = await import(moduleUrl);
await vendor.main(process.argv.slice(2), repoRoot);
