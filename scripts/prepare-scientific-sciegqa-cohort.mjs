import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
import {parseArgs} from 'node:util';
import {selectSciegqaCohort, verifySciegqaCohort} from '../evaluation/adapters/scientific-public/sciegqa-cohort.mjs';
import {publicPdfArtifactPath} from '../evaluation/adapters/scientific-public/pdf.mjs';
import {hash, readJson, ROOT, writeJson} from '../evaluation/lib/common.mjs';

const {values} = parseArgs({options: {verify: {type: 'boolean'}}, strict: true, allowPositionals: false});
try {
  const root = join(ROOT, 'evaluation/local/corpora/sciegqa-bench-v1');
  execFileSync('python3', [join(ROOT, 'scripts/prepare-scientific-sciegqa.py'),
    '--output-root', root, '--verify'], {cwd: ROOT, stdio: ['ignore', 'ignore', 'inherit']});
  const manifest = readJson(publicPdfArtifactPath(root, 'manifest.json'));
  const labels = readJson(publicPdfArtifactPath(root, 'labels.json'));
  const target = join(ROOT, 'evaluation/corpora/scientific-rag/sciegqa-cohort.lock.json');
  const cohort = values.verify ? verifySciegqaCohort(readJson(target), manifest, labels)
    : selectSciegqaCohort(manifest, labels);
  if (!values.verify) writeJson(target, cohort);
  console.log(JSON.stringify({verified: Boolean(values.verify), papers: cohort.papers.length,
    questions: cohort.questionCount, cohortHash: hash(cohort), scientificBaselineReady: false}, null, 2));
} catch (error) {console.error(error.stack); process.exitCode = 1;}
