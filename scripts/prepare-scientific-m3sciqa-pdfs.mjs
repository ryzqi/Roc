import {mkdirSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {parseArgs} from 'node:util';
import {acquireM3PdfSources, defaultM3LabelsRoot, defaultM3PdfRoot} from '../evaluation/adapters/scientific-public/m3sciqa-pdf-sources.mjs';
import {writeJson} from '../evaluation/lib/common.mjs';

const {values} = parseArgs({options: {root: {type: 'string'}, 'labels-root': {type: 'string'},
  offline: {type: 'boolean'}, output: {type: 'string'}}, strict: true, allowPositionals: false});
try {
  const report = await acquireM3PdfSources({root: resolve(values.root ?? defaultM3PdfRoot),
    labelsRoot: resolve(values['labels-root'] ?? defaultM3LabelsRoot), offline: values.offline});
  if (values.output) {
    mkdirSync(dirname(resolve(values.output)), {recursive: true});
    writeJson(resolve(values.output), report);
  }
  console.log(JSON.stringify({sourceLockHash: report.sourceLockHash, downloadedPapers: report.downloadedPapers,
    failedPapers: report.failedPapers, publishedQuestions: report.publishedQuestions,
    totalBytes: report.files.reduce((sum, pin) => sum + pin.bytes, 0), scientificBaselineReady: false}, null, 2));
} catch (error) {console.error(error.stack);process.exitCode = 1;}
