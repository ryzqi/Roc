import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { after, before, test } from 'node:test';
import * as esbuild from 'esbuild';

let tempDir;
let GitService;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-git-service-'));
  const outfile = join(tempDir, 'git-service.mjs');
  await esbuild.build({
    entryPoints: ['src/main/services/git-service.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    logLevel: 'silent'
  });
  ({ GitService } = await import(outfile));
});

after(() => {
  if (tempDir !== undefined) rmSync(tempDir, { recursive: true, force: true });
});

test('status preserves unusual NUL-delimited names and runs porcelain status once in an unborn repository', async () => {
  const repository = makeRepository('unborn');
  const names = ['space name.txt', 'line\nbreak.txt', '中文.txt', ' leading and trailing .txt'];
  for (const name of names) writeFileSync(join(repository, name), 'content');

  const statusLog = join(tempDir, 'status-commands.log');
  const wrapper = makeGitWrapper(`
    if [ "$1" = "status" ]; then printf '%s\\n' "$*" >> "$ROC_GIT_TEST_STATUS_LOG"; fi
    exec "$ROC_GIT_TEST_REAL" "$@"
  `);
  const previousLog = process.env.ROC_GIT_TEST_STATUS_LOG;
  const previousReal = process.env.ROC_GIT_TEST_REAL;
  process.env.ROC_GIT_TEST_STATUS_LOG = statusLog;
  process.env.ROC_GIT_TEST_REAL = realGitPath();
  try {
    const service = serviceFor(repository, { gitExecutable: wrapper });
    const status = await service.getStatus();
    assert.equal(status.branch, 'main');
    assert.equal(status.changedFiles, names.length);
    assert.deepEqual(status.changes.map((change) => change.relativePath).sort(), [...names].sort());
    assert.deepEqual(status.porcelain, status.changes.map((change) => change.porcelain));
    assert.equal(readFileSync(statusLog, 'utf8').trim().split('\n').length, 1);
    assert.equal(readFileSync(statusLog, 'utf8').trim(), 'status --porcelain=v1 -z');

    const staged = await service.stageFiles(names);
    assert.equal(staged.changedFiles, names.length);
    assert.deepEqual(staged.changes.map((change) => change.relativePath).sort(), [...names].sort());
    assert.deepEqual(readFileSync(statusLog, 'utf8').trim().split('\n'), [
      'status --porcelain=v1 -z',
      'status --porcelain=v1 -z'
    ]);
  } finally {
    restoreEnv('ROC_GIT_TEST_STATUS_LOG', previousLog);
    restoreEnv('ROC_GIT_TEST_REAL', previousReal);
  }
});

test('status parses renames and accepts linked worktrees whose .git entry is a file', async () => {
  const repository = makeRepository('rename-worktree');
  writeFileSync(join(repository, 'old name.txt'), 'tracked');
  git(repository, 'add', '--', 'old name.txt');
  git(repository, '-c', 'user.name=Roc Test', '-c', 'user.email=roc@example.invalid', 'commit', '-m', 'initial');
  git(repository, 'mv', 'old name.txt', 'new name.txt');

  const service = serviceFor(repository);
  const status = await service.getStatus();
  assert.equal(status.changedFiles, 1);
  assert.deepEqual(status.changes[0], {
    porcelain: 'R  old name.txt -> new name.txt',
    index: 'R',
    worktree: ' ',
    relativePath: 'new name.txt',
    originalPath: 'old name.txt'
  });

  const worktree = join(tempDir, 'linked-worktree');
  git(repository, 'worktree', 'add', '--quiet', '-b', 'linked', worktree);
  assert.equal(statSync(join(worktree, '.git')).isFile(), true);
  service.selectWorkspace(worktree);
  const worktreeStatus = await service.getStatus();
  assert.equal(worktreeStatus.branch, 'linked');
  assert.equal(worktreeStatus.changedFiles, 0);
});

test('repository metadata access errors other than ENOENT are not reported as a missing repository', async () => {
  const missingRepository = join(tempDir, 'missing-repository');
  await assert.rejects(serviceFor(missingRepository).getStatus(), (error) => error.code === 'git_repository_missing');

  const filePath = join(tempDir, 'not-a-directory');
  writeFileSync(filePath, 'file');
  await assert.rejects(serviceFor(filePath).getStatus(), (error) => error.code === 'ENOTDIR');
});

test('file operations treat Git pathspec-looking names literally', async () => {
  const repository = makeRepository('literal-pathspec');
  const literalName = ':(glob)**';
  writeFileSync(join(repository, literalName), 'base literal');
  writeFileSync(join(repository, 'sibling.txt'), 'base sibling');
  git(repository, 'add', '--', literalName, 'sibling.txt');
  git(repository, 'commit', '-m', 'initial');
  writeFileSync(join(repository, literalName), 'changed literal');
  writeFileSync(join(repository, 'sibling.txt'), 'changed sibling');

  const service = serviceFor(repository);
  const diff = await service.getFileDiff(literalName);
  assert.match(diff.patch, /\(glob\)\*\*/);
  assert.doesNotMatch(diff.patch, /sibling\.txt/);

  const staged = await service.stageFile(literalName);
  assert.equal(staged.changes.find((change) => change.relativePath === literalName)?.index, 'M');
  assert.equal(staged.changes.find((change) => change.relativePath === 'sibling.txt')?.worktree, 'M');

  const discarded = await service.discardFileChanges(literalName);
  assert.deepEqual(discarded.changes.map((change) => change.relativePath), ['sibling.txt']);
  assert.equal(readFileSync(join(repository, literalName), 'utf8'), 'base literal');
  assert.equal(readFileSync(join(repository, 'sibling.txt'), 'utf8'), 'changed sibling');
});

test('repository write operations are serialized by Git common directory', async () => {
  const repository = makeRepository('write-queue');
  writeFileSync(join(repository, 'one.txt'), 'one');
  writeFileSync(join(repository, 'two.txt'), 'two');
  const eventLog = join(tempDir, 'write-events.log');
  const wrapper = makeGitWrapper(`
    git_command=$1
    if [ "$1" = "--literal-pathspecs" ]; then git_command=$2; fi
    if [ "$git_command" = "add" ]; then
      printf 'start\\n' >> "$ROC_GIT_TEST_EVENTS"
      sleep 0.12
      "$ROC_GIT_TEST_REAL" "$@"
      result=$?
      printf 'end\\n' >> "$ROC_GIT_TEST_EVENTS"
      exit "$result"
    fi
    exec "$ROC_GIT_TEST_REAL" "$@"
  `);
  const previousEvents = process.env.ROC_GIT_TEST_EVENTS;
  const previousReal = process.env.ROC_GIT_TEST_REAL;
  process.env.ROC_GIT_TEST_EVENTS = eventLog;
  process.env.ROC_GIT_TEST_REAL = realGitPath();
  try {
    const service = serviceFor(repository, { gitExecutable: wrapper });
    await Promise.all([service.stageFile('one.txt'), service.stageFile('two.txt')]);
    assert.deepEqual(readFileSync(eventLog, 'utf8').trim().split('\n'), ['start', 'end', 'start', 'end']);
  } finally {
    restoreEnv('ROC_GIT_TEST_EVENTS', previousEvents);
    restoreEnv('ROC_GIT_TEST_REAL', previousReal);
  }
});

test('writes in separate repositories do not share a global queue', async () => {
  const first = makeRepository('queue-first');
  const second = makeRepository('queue-second');
  writeFileSync(join(first, 'first.txt'), 'one');
  writeFileSync(join(second, 'second.txt'), 'two');
  const eventLog = join(tempDir, 'parallel-write-events.log');
  const wrapper = makeGitWrapper(`
    git_command=$1
    if [ "$1" = "--literal-pathspecs" ]; then git_command=$2; fi
    if [ "$git_command" = "add" ]; then
      printf 'start %s\\n' "$PWD" >> "$ROC_GIT_TEST_EVENTS"
      sleep 0.2
      "$ROC_GIT_TEST_REAL" "$@"
      result=$?
      printf 'end %s\\n' "$PWD" >> "$ROC_GIT_TEST_EVENTS"
      exit "$result"
    fi
    exec "$ROC_GIT_TEST_REAL" "$@"
  `);
  const previousEvents = process.env.ROC_GIT_TEST_EVENTS;
  const previousReal = process.env.ROC_GIT_TEST_REAL;
  process.env.ROC_GIT_TEST_EVENTS = eventLog;
  process.env.ROC_GIT_TEST_REAL = realGitPath();
  try {
    const service = serviceFor(first, { gitExecutable: wrapper });
    const firstWrite = service.stageFile('first.txt');
    service.selectWorkspace(second);
    const secondWrite = service.stageFile('second.txt');
    await Promise.all([firstWrite, secondWrite]);
    const events = readFileSync(eventLog, 'utf8').trim().split('\n');
    assert.equal(events.length, 4);
    assert.match(events[0], /^start /);
    assert.match(events[1], /^start /);
    assert.match(events[2], /^end /);
    assert.match(events[3], /^end /);
  } finally {
    restoreEnv('ROC_GIT_TEST_EVENTS', previousEvents);
    restoreEnv('ROC_GIT_TEST_REAL', previousReal);
  }
});

test('push can be cancelled by operation id and maps timeout separately', async () => {
  const repository = makeRepository('cancel-timeout');
  const fakeGit = makeGitWrapper(`
    case "$1" in
      rev-parse) printf '.git\\n';;
      branch) printf 'main\\n';;
      config) printf 'origin\\n';;
      push) printf 'started\\n' >> "$ROC_GIT_TEST_PUSH_STARTED"; exec sleep 30;;
      *) exit 0;;
    esac
  `);
  const pushStarted = join(tempDir, 'push-started.log');
  const previousStarted = process.env.ROC_GIT_TEST_PUSH_STARTED;
  process.env.ROC_GIT_TEST_PUSH_STARTED = pushStarted;
  try {
    const service = serviceFor(repository, { gitExecutable: fakeGit, commandTimeoutMs: 2000, killGraceMs: 25 });
    const operationId = 'a21a2784-a9f3-4a35-a19c-44362fa126ae';
    const push = service.push({ operationId });
    await waitForFile(pushStarted);
    assert.equal(service.cancelOperation(operationId), true);
    await assert.rejects(push, (error) => error.code === 'git_command_cancelled');
    assert.equal(service.cancelOperation(operationId), false);

    const timeoutService = serviceFor(repository, { gitExecutable: fakeGit, commandTimeoutMs: 100, killGraceMs: 25 });
    await assert.rejects(timeoutService.push(), (error) => error.code === 'git_command_timeout');
  } finally {
    restoreEnv('ROC_GIT_TEST_PUSH_STARTED', previousStarted);
  }
});

test('Git output is bounded and missing remote configuration remains distinct from push failure', async () => {
  const repository = makeRepository('output-remote');
  const oversizedGit = makeGitWrapper(`
    case "$1" in
      branch) printf 'main\\n';;
      status) printf '%4096s' x;;
      *) exit 0;;
    esac
  `);
  const service = serviceFor(repository, { gitExecutable: oversizedGit, maxOutputBytes: 128 });
  await assert.rejects(service.getStatus(), (error) => error.code === 'git_output_limit_exceeded');

  const realService = serviceFor(repository);
  await assert.rejects(realService.push(), (error) => error.code === 'git_push_remote_missing');
  git(repository, 'config', 'branch.main.remote', 'origin');
  await assert.rejects(realService.push(), (error) => error.code === 'git_command_failed');
});

function serviceFor(initialPath, options = {}) {
  let selectedPath = initialPath;
  const workspaceService = {
    requireWorkspace: () => ({ path: selectedPath }),
    resolveInsideWorkspace: (relativePath) => resolve(selectedPath, relativePath)
  };
  const service = new GitService(workspaceService, options);
  service.selectWorkspace = (path) => { selectedPath = path; };
  return service;
}

function makeRepository(name) {
  const repository = mkdtempSync(join(tempDir, `${name}-`));
  git(repository, 'init', '--quiet', '--initial-branch=main');
  git(repository, 'config', 'user.name', 'Roc Test');
  git(repository, 'config', 'user.email', 'roc@example.invalid');
  return repository;
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

function makeGitWrapper(body) {
  const path = join(tempDir, `git-wrapper-${Math.random().toString(16).slice(2)}`);
  writeFileSync(path, `#!/bin/sh\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function realGitPath() {
  return execFileSync('which', ['git'], { encoding: 'utf8' }).trim();
}

function restoreEnv(key, value) {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}

async function waitForFile(path) {
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    try {
      readFileSync(path);
      return;
    } catch {
      await new Promise((resolveWait) => setTimeout(resolveWait, 10));
    }
  }
  assert.fail('Git push command did not start before the test deadline');
}
