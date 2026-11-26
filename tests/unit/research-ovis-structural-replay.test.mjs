import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {mkdtemp, mkdir, readFile, writeFile, rm, stat} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import {spawnSync} from 'node:child_process';
import {createCanvas} from '@napi-rs/canvas';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
test('structural replay retains invalid pages and original errors while auditing later valid output', async () => {
  const root = await mkdtemp(resolve('.runtime/ovis-replay-test-'));
  try {
    const input = join(root, 'inference'), output = join(root, 'audit'); await mkdir(input);
    const config = JSON.parse(await readFile('evaluation/ovis-evaluator/paired-inference.json'));
    const image = join(root, 'page.png'), imageBytes = createCanvas(100, 100).toBuffer('image/png');
    await writeFile(image, imageBytes);
    const good = [{category: 'text', content: 'Retained evidence', bbox: [1, 1, 999, 999]}];
    const pages = [];
    for (const [id, valid] of [['invalid', false], ['valid', true]]) {
      const raw = valid ? JSON.stringify(good) : '[{"content":"repeated';
      const tokens = valid ? [17, 248046] : [17, 17];
      pages.push({id, image, sha256: hash(imageBytes), rawSha256: hash(raw), width: 100, height: 100,
        valid, errors: valid ? [] : ['json_invalid:Unterminated string', 'token_budget_exhausted'],
        generationTokens: 2, blockCount: valid ? 1 : null,
        termination: {finishReason: valid ? 'stop' : 'length', eosObserved: valid, truncated: !valid}});
      await writeFile(join(input, `${id}.raw.txt`), raw);
      await writeFile(join(input, `${id}.tokens.json`), JSON.stringify(tokens));
      if (valid) await writeFile(join(input, `${id}.parsed.json`), JSON.stringify(good));
    }
    const report = {status: 'invalid-output', variant: '8bit', pages, revision: config.modelRevision,
      receiptSha256: config.installationReceiptSha256, evaluatorSha256: config.inferenceScriptSha256,
      promptSha256: config.settings.promptSha256};
    const encoded = JSON.stringify(report); await writeFile(join(input, 'report.json'), encoded);
    const run = spawnSync(process.execPath, ['scripts/research/verify-ovis-structural-replay.mjs',
      '--inference', input, '--output', output], {encoding: 'utf8', timeout: 60000});
    assert.equal(run.status, 1, run.stderr);
    const audit = JSON.parse(await readFile(join(output, 'report.json')));
    assert.equal(audit.status, 'failed'); assert.equal(audit.totalPages, 2);
    assert.deepEqual(audit.pages.map(p => p.status), ['failed', 'passed']);
    assert.deepEqual(audit.pages[0].inference.errors, pages[0].errors);
    assert.deepEqual(audit.pages[0].inference.termination, pages[0].termination);
    assert.equal(audit.pages[0].rawSha256, pages[0].rawSha256);
    assert.equal(audit.pages[0].error.message, 'research_ovis_replay_invalid_model_output');
    assert.equal(audit.temporaryRemoved, true); assert.equal(audit.qualityQualification, false);
    assert.equal(await readFile(join(input, 'report.json'), 'utf8'), encoded);
    // Original decoder fixtures must not be relabelled as a candidate run.
    const candidateOutput = join(root, 'candidate-audit');
    const changedIdentity = spawnSync(process.execPath, ['scripts/research/verify-ovis-structural-replay.mjs',
      '--inference', input, '--output', candidateOutput,
      '--candidate', 'evaluation/ovis-decoder/sample-20-1.03.json'], {encoding: 'utf8', timeout: 60000});
    assert.equal(changedIdentity.status, 1);
    assert.match(changedIdentity.stderr, /diagnostic\.json/u);
    await assert.rejects(stat(candidateOutput), {code: 'ENOENT'});
  } finally {await rm(root, {recursive: true, force: true});}
});
