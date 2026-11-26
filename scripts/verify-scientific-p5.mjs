import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {existsSync, lstatSync, readFileSync, realpathSync} from 'node:fs';
import {dirname, isAbsolute, join, relative, resolve, sep} from 'node:path';
import {fileURLToPath} from 'node:url';

const repo = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), '..'));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const hash = value => digest(JSON.stringify(value));
const read = path => JSON.parse(readFileSync(path, 'utf8'));
const within = (root, name) => {
  assert.equal(isAbsolute(name), false); const path = resolve(root, name), rel = relative(root, path);
  assert.ok(rel && rel !== '..' && !rel.startsWith(`..${sep}`)); return path;
};
const normalized = text => text.replace(/\s+/gu, ' ').trim();

assert.equal(process.argv.length, 3, 'Usage: node scripts/verify-scientific-p5.mjs REPORT_DIRECTORY');
const root = realpathSync(resolve(process.argv[2])), report = read(join(root, 'report.json'));
assert.equal(report.kind, 'scientific-p5-original-pdf-engineering');
assert.equal(report.status, 'verified-engineering-quality-pending');
assert.equal(report.releaseAccepted, false); assert.equal(report.scientificQualityMetrics, null);
for (const [path, sha256] of Object.entries(report.artifactHashes)) assert.equal(digest(readFileSync(within(root, path))), sha256, path);
for (const [path, sha256] of Object.entries(report.code.hashes)) assert.equal(digest(readFileSync(within(repo, path))), sha256, path);
const source = within(repo, report.source.path);
assert.equal(lstatSync(source).size, report.source.bytes); assert.equal(digest(readFileSync(source)), report.source.sha256);
assert.equal(existsSync(join(root, 'runtime.mjs')), false);
const processReceipts = ['production-e2e', 'cancelled-parse'].map(name => {
  const process = read(join(root, name, 'process.json')), trial = read(join(root, name, 'trial.json'));
  assert.deepEqual(process.report, trial); assert.equal(process.exit.code, 0); assert.equal(process.exit.signal, null);
  assert.equal(process.childExited, true); assert.equal(process.timedOut, false);
  assert.equal(process.scratchRemoved, true); assert.equal(trial.isolatedScratchRemoved, true);
  assert.equal(existsSync(join(root, name, 'scratch')), false);
  assert.ok(trial.rss.length > 1 && trial.processPeakRssBytes >= Math.max(...trial.rss.map(sample => sample.rssBytes)));
  return {process, trial};
});
const normal = processReceipts[0], cancelled = processReceipts[1];
assert.equal(normal.trial.status, 'verified-engineering'); assert.equal(normal.trial.failure, null);
assert.equal(cancelled.trial.status, 'cancelled'); assert.equal(cancelled.trial.failure.phase, 'parse');
assert.equal(cancelled.trial.failure.code, 'research_process_cancelled');
assert.equal(cancelled.process.cancelSent, true);
assert.equal(cancelled.trial.rss.some(sample => sample.phase === 'parse-start'), true);
assert.equal(cancelled.trial.rss.some(sample => sample.phase === 'parse-end'), false);
const observations = normal.trial.observation;
assert.deepEqual(observations, report.observation);
assert.equal(observations.providerCalls, 0); assert.equal(observations.modelTokens, 0);
assert.equal(observations.originalQuoteValidated, true); assert.equal(observations.forgedQuoteRejected, true);
assert.equal(observations.preAbortedQueryRejected, true);
assert.equal(observations.queries[0].hitHash, observations.queries[1].hitHash);
const query = read(join(root, 'production-e2e/query.json')), context = read(join(root, 'production-e2e/context.json')),
  evidence = read(join(root, 'production-e2e/evidence.json'));
assert.equal(hash(query.hits.map(hit => [hit.id, hit.contentHash])), observations.queries[0].hitHash);
assert.equal(query.sourceRefs.length, observations.queries[0].sourceRefs);
assert.equal(context.evidence.length, observations.contextObjects); assert.equal(context.usage.tokens, observations.contextTokens);
assert.equal(evidence.checked.canAnswerAsFacts, true); assert.equal(evidence.forged.canAnswerAsFacts, false);
assert.equal(evidence.checked.contextId, context.id);
assert.ok(query.sourceRefs.every(ref => ref.sourceHash === report.source.sha256 && ref.paperIrHash === observations.irHash));
assert.equal(query.legacy, null);

// Independent PDF.js reread: no production parser, IR builder or evidence validator is imported here.
const {getDocument} = await import('pdfjs-dist/legacy/build/pdf.mjs');
const task = getDocument({data: new Uint8Array(readFileSync(source)), useSystemFonts: true});
let checkedPages = 0;
try {
  const pdf = await task.promise; assert.equal(pdf.numPages, observations.pageCount);
  for (const statement of evidence.checked.statements) {
    const item = context.evidence.find(item => statement.evidenceIds.includes(item.id)); assert.ok(item);
    const passage = item.passages.find(passage => passage.text === statement.text); assert.ok(passage);
    const location = passage.sourceLocator.locations[0]; assert.ok(location && location.page >= 1 && location.page <= pdf.numPages);
    const page = await pdf.getPage(location.page), content = await page.getTextContent();
    const originalText = normalized(content.items.filter(item => 'str' in item).map(item => item.str).join(' '));
    assert.ok(originalText.includes(normalized(statement.text)), 'cited original quote must occur on the cited PDF page');
    checkedPages++; page.cleanup();
  }
} finally {await task.destroy();}
assert.ok(checkedPages > 0);
assert.equal(read(join(root, 'corpus-readiness.json')).corpusReady, report.corpusReady);
console.log(JSON.stringify({status: 'Verified passing', originalQuotePagesChecked: checkedPages,
  checkScope: 'Receipt integrity, source hash, whitespace-normalized quote on original PDF page, cancellation and cleanup.',
  semanticQuality: null, releaseAccepted: false, reportSha256: digest(readFileSync(join(root, 'report.json')))}, null, 2));
