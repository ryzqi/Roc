import assert from 'node:assert/strict';
import { execFile, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';

import { execa } from 'execa';

const scutilPath = '/usr/sbin/scutil';
const maxBuffer = 1024 * 1024;
const prototypeDirectory = fileURLToPath(new URL('.', import.meta.url));

function runExecFile(command, args, options) {
  return new Promise((resolve) => {
    execFile(command, args, options, (error, stdout) => resolve({ error, stdout }));
  });
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function errorToEmptyWithExecFile(command, args) {
  const { error, stdout } = await runExecFile(command, args, { encoding: 'utf8', timeout: 1000, maxBuffer });
  if (error === null && typeof stdout === 'string') return stdout;
  return '';
}

async function errorToEmptyWithExeca(command, args) {
  try {
    return (await execa(command, args, { timeout: 1000, maxBuffer, stripFinalNewline: false })).stdout;
  } catch {
    return '';
  }
}

test('Execa preserves the read-only scutil output', { skip: process.platform !== 'darwin' }, async () => {
  const [baseline, candidate] = await Promise.all([
    runExecFile(scutilPath, ['--proxy'], { encoding: 'utf8', timeout: 1000, maxBuffer }),
    execa(scutilPath, ['--proxy'], {
      timeout: 1000,
      maxBuffer,
      stripFinalNewline: false
    })
  ]);
  assert.equal(baseline.error, null, 'execFile scutil probe must succeed');
  assert.equal(candidate.exitCode, 0, 'Execa scutil probe must succeed');
  const baselineText = typeof baseline.stdout === 'string' ? baseline.stdout : '';
  const candidateText = candidate.stdout;
  if (digest(baselineText) !== digest(candidateText)) {
    throw new Error('scutil_output_mismatch');
  }
  process.stdout.write(`${JSON.stringify({
    probe: 'scutil --proxy',
    bytes: Buffer.byteLength(baselineText),
    trailingNewline: baselineText.endsWith('\n'),
    outputMatches: true
  })}\n`);
});

test('both command wrappers preserve error-to-empty behavior on a nonzero exit', async () => {
  const command = [process.execPath, ['-e', 'process.exitCode = 7']];
  const [baseline, candidate] = await Promise.all([
    errorToEmptyWithExecFile(command[0], command[1]),
    errorToEmptyWithExeca(command[0], command[1])
  ]);
  assert.equal(baseline, '');
  assert.equal(candidate, '');
});

test('Execa defaults strip a final newline; disabling it matches execFile', async () => {
  const command = [process.execPath, ['-e', "process.stdout.write('roc-proxy\\n')"]];
  const baseline = await runExecFile(command[0], command[1], { encoding: 'utf8', timeout: 1000 });
  const defaultCandidate = await execa(command[0], command[1], { timeout: 1000 });
  const matchingCandidate = await execa(command[0], command[1], {
    timeout: 1000,
    stripFinalNewline: false
  });
  assert.equal(baseline.error, null);
  assert.equal(baseline.stdout, 'roc-proxy\n');
  assert.equal(defaultCandidate.stdout, 'roc-proxy');
  assert.equal(matchingCandidate.stdout, baseline.stdout);
});

test('maxBuffer sends TERM and escalates for an over-budget long-running child', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'roc-execa-max-buffer-'));
  const markerPath = join(directory, 'child-survived.txt');
  const childSource = `process.on('SIGTERM',()=>{});process.stdout.on('error',()=>{});process.stdout.write('x'.repeat(1024*1024));setTimeout(()=>require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'survived'),250);setInterval(()=>{},1000)`;
  try {
    const command = execa(process.execPath, ['-e', childSource], {
      maxBuffer: 1024,
      forceKillAfterDelay: 50
    });
    await assert.rejects(command, (error) => error.isMaxBuffer === true && error.isForcefullyTerminated === true);
    await delay(350);
    assert.equal(existsSync(markerPath), false, 'child should be killed before its delayed marker write');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('timeout escalates TERM to KILL when the child ignores TERM', async () => {
  const command = execa(process.execPath, ['-e', "process.on('SIGTERM',()=>{});process.stdout.write('ready');setInterval(()=>{},1000)"], {
    timeout: 400,
    forceKillAfterDelay: 100
  });
  await new Promise((resolve) => command.stdout.once('data', resolve));
  await assert.rejects(command, (error) => error.timedOut === true && error.isForcefullyTerminated === true);
});

test('AbortSignal cancellation terminates a running child', async () => {
  const controller = new AbortController();
  const command = execa(process.execPath, ['-e', "process.stdout.write('ready\\n');setInterval(()=>{},1000)"], {
    cancelSignal: controller.signal,
    forceKillAfterDelay: 50
  });
  await new Promise((resolve, reject) => {
    command.stdout.once('data', (chunk) => {
      assert.match(chunk.toString(), /ready/u);
      resolve();
    });
    command.stdout.once('error', reject);
  });
  try {
    controller.abort();
    await assert.rejects(command, (error) => error.isCanceled === true);
  } finally {
    controller.abort();
    await command.catch(() => {});
  }
});

test('killDescendants is required to stop grandchildren; cleanup defaults on parent exit', async () => {
  assert.equal(await descendantWritesMarker(false), true, 'without killDescendants the grandchild survives');
  assert.equal(await descendantWritesMarker(true), false, 'killDescendants stops the whole process group');
  assert.equal(await childSurvivesParentExit(), false, 'default cleanup kills the direct subprocess when its parent exits');
});

async function descendantWritesMarker(killDescendants) {
  const directory = mkdtempSync(join(tmpdir(), 'roc-execa-descendants-'));
  const markerPath = join(directory, 'grandchild-survived.txt');
  const grandchildSource = `process.stdout.write('grandchild-ready\\n');setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'survived');process.exit(0)},300);setInterval(()=>{},1000)`;
  const parentSource = `process.on('SIGTERM',()=>{});const {spawn}=require('node:child_process');const grandchild=spawn(process.execPath,['-e',${JSON.stringify(grandchildSource)}],{stdio:['ignore','pipe','ignore']});grandchild.stdout.on('data',(chunk)=>process.stdout.write(chunk));setInterval(()=>{},1000)`;
  let child;
  let settled = false;
  try {
    child = execa(process.execPath, ['-e', parentSource], {
      killDescendants,
      forceKillAfterDelay: 50
    });
    child.catch(() => {});
    const ready = await new Promise((resolve, reject) => {
      child.stdout.once('data', (chunk) => resolve(chunk.toString()));
      child.stdout.once('error', reject);
    });
    assert.match(ready, /grandchild-ready/u);
    child.kill();
    await assert.rejects(child, (error) => error.isTerminated === true);
    settled = true;
    await delay(450);
    return existsSync(markerPath);
  } finally {
    if (child !== undefined && !settled) {
      child.kill('SIGKILL');
      await child.catch(() => {});
    }
    rmSync(directory, { recursive: true, force: true });
  }
}

async function childSurvivesParentExit() {
  const directory = mkdtempSync(join(tmpdir(), 'roc-execa-cleanup-'));
  const markerPath = join(directory, 'child-survived.txt');
  const execaEntry = pathToFileURL(join(prototypeDirectory, 'node_modules/execa/index.js')).href;
  const childSource = `setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(markerPath)},'survived');process.exit(0)},300)`;
  const runnableParent = `import {execa} from ${JSON.stringify(execaEntry)};execa(process.execPath,['-e',${JSON.stringify(childSource)}]);setTimeout(()=>process.exit(0),25);`;
  try {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', runnableParent], {
      encoding: 'utf8',
      timeout: 2000
    });
    assert.equal(result.error, undefined, result.error?.message);
    assert.equal(result.status, 0, result.stderr);
    await delay(450);
    return existsSync(markerPath);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
