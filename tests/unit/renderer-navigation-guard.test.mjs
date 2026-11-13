import {after, before, test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import * as esbuild from 'esbuild';

let directory, requestNavigation, BEFORE_NAVIGATE;
let requestReadingChange, BEFORE_READING_CHANGE;
before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'roc-navigation-guard-'));
  const outfile = join(directory, 'navigation.mjs');
  await esbuild.build({entryPoints: ['src/renderer/app/navigation-guard.ts'], outfile,
    bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent'});
  ({requestNavigation, BEFORE_NAVIGATE} = await import(outfile));
  const readingFile = join(directory, 'reading.mjs');
  await esbuild.build({entryPoints: ['src/renderer/literature/reading-interactions.ts'], outfile: readingFile,
    bundle: true, format: 'esm', platform: 'neutral', logLevel: 'silent'});
  ({requestReadingChange, BEFORE_READING_CHANGE} = await import(readingFile));
});
after(async () => {
  delete globalThis.window;
  if (directory) await rm(directory, {recursive: true, force: true});
});
const next = {page: 'project', projectId: 'next-project'};

test('navigation waits for every independent surface and resumes only once', () => {
  globalThis.window = new EventTarget();
  const resumes = [];
  let count = 0;
  window.addEventListener(BEFORE_NAVIGATE, event => resumes.push(event.detail.defer()));
  window.addEventListener(BEFORE_NAVIGATE, event => resumes.push(event.detail.defer()));
  requestNavigation(next, () => count++);
  assert.equal(count, 0);
  resumes[0]();
  resumes[0]();
  assert.equal(count, 0);
  resumes[1]();
  resumes[1]();
  assert.equal(count, 1);
});

test('a hard veto survives all deferred confirmations', () => {
  globalThis.window = new EventTarget();
  let resume, count = 0;
  window.addEventListener(BEFORE_NAVIGATE, event => {resume = event.detail.defer();});
  window.addEventListener(BEFORE_NAVIGATE, event => event.preventDefault());
  requestNavigation(next, () => count++);
  resume();
  assert.equal(count, 0);
});

test('an obsolete continuation cannot complete a newer navigation', () => {
  globalThis.window = new EventTarget();
  const resumes = [], results = [];
  window.addEventListener(BEFORE_NAVIGATE, event => resumes.push(event.detail.defer()));
  requestNavigation(next, () => results.push('old'));
  requestNavigation(next, () => results.push('new'));
  resumes[0]();
  assert.deepEqual(results, []);
  resumes[1]();
  assert.deepEqual(results, ['new']);
});

test('synchronous deferrals still honor later listeners before navigation', () => {
  globalThis.window = new EventTarget();
  let count = 0;
  window.addEventListener(BEFORE_NAVIGATE, event => event.detail.defer()());
  window.addEventListener(BEFORE_NAVIGATE, event => event.preventDefault());
  requestNavigation(next, () => count++);
  assert.equal(count, 0);
});

test('reading source changes wait for all editors and complete once', () => {
  globalThis.window = new EventTarget();
  const resumes = [];
  let count = 0;
  window.addEventListener(BEFORE_READING_CHANGE, event => resumes.push(event.detail.defer()));
  window.addEventListener(BEFORE_READING_CHANGE, event => resumes.push(event.detail.defer()));
  requestReadingChange('project-a', () => count++);
  resumes[0]();
  resumes[0]();
  assert.equal(count, 0);
  resumes[1]();
  resumes[1]();
  assert.equal(count, 1);
});

test('reading source hard veto survives deferred and synchronous confirmations', () => {
  globalThis.window = new EventTarget();
  let resume, count = 0;
  window.addEventListener(BEFORE_READING_CHANGE, event => {resume = event.detail.defer();});
  window.addEventListener(BEFORE_READING_CHANGE, event => event.detail.defer()());
  window.addEventListener(BEFORE_READING_CHANGE, event => event.preventDefault());
  requestReadingChange('project-a', () => count++);
  resume();
  assert.equal(count, 0);
});

test('obsolete reading source confirmations cannot replace the latest source', () => {
  globalThis.window = new EventTarget();
  const resumes = [], results = [];
  window.addEventListener(BEFORE_READING_CHANGE, event => resumes.push(event.detail.defer()));
  requestReadingChange('project-a', () => results.push('old'));
  requestReadingChange('project-a', () => results.push('new'));
  resumes[0]();
  assert.deepEqual(results, []);
  resumes[1]();
  assert.deepEqual(results, ['new']);
});
