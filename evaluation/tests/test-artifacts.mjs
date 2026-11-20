import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { after } from 'node:test';
import { directory, EVAL_ROOT } from '../lib/common.mjs';

// Register lifetime ownership before any test can fail. Never scan/delete the
// archive or another concurrently running test's outputs.
export function testArtifacts(name, parent = join(EVAL_ROOT, '.runtime/tests')) {
  const root = directory(parent, name);
  after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
