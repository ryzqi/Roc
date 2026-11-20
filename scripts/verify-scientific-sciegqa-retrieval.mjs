import {join, resolve} from 'node:path';
import {writeJson} from '../evaluation/lib/common.mjs';
import {verifySciegqaRetrievalRun} from '../evaluation/adapters/scientific-public/sciegqa-retrieval-run.mjs';

if (process.argv.length !== 3) throw new Error('Usage: node scripts/verify-scientific-sciegqa-retrieval.mjs RUN_ROOT');
try {
  const root = resolve(process.argv[2]);
  const verified = await verifySciegqaRetrievalRun(root);
  writeJson(join(root, 'verified-retrieval.json'), verified);
  console.log(JSON.stringify(verified, null, 2));
} catch (error) {console.error(error.stack); process.exitCode = 1;}
