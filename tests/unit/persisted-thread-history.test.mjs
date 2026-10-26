import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as esbuild from 'esbuild';

const source = 'src/renderer/assistant/use-persisted-thread-history.ts';
let directory;
let api;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-persisted-thread-history-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'persisted-thread-history.mjs');
  await esbuild.build({
    entryPoints: [source],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent'
  });
  api = await import(outfile);
});

after(() => rmSync(directory, {recursive: true, force: true}));

function event(id, sequence, threadId = 'thread') {
  return {
    id,
    threadId,
    runId: 'run-' + threadId,
    createdAt: '2026-10-27T00:00:00.000Z',
    sequence,
    type: 'message',
    payload: {role: 'user', content: 'message ' + sequence}
  };
}

function page(items, options = {}) {
  return {
    items,
    oldestSequence: items[0]?.sequence ?? null,
    newestSequence: items.at(-1)?.sequence ?? null,
    hasMoreBefore: options.hasMoreBefore ?? false,
    hasMoreAfter: options.hasMoreAfter ?? false
  };
}

test('history retention keeps the requested edge and rejects invalid limits', () => {
  const events = [event('e1', 1), event('e2', 2), event('e3', 3), event('e4', 4)];
  assert.deepEqual(api.retainRecentPersistedEvents(events, 2), {events: events.slice(2), dropped: 2});
  assert.deepEqual(api.retainOldestPersistedEvents(events, 2), {events: events.slice(0, 2), dropped: 2});
  assert.deepEqual(api.retainRecentPersistedEvents(events, 4), {events, dropped: 0});
  assert.throws(() => api.retainRecentPersistedEvents(events, 0), /persisted_thread_history_limit_invalid/u);
  assert.throws(() => api.retainOldestPersistedEvents(events, 1.5), /persisted_thread_history_limit_invalid/u);
});

test('persisted pages validate thread identity, order, unique IDs, and edge metadata', () => {
  api.validatePersistedPage(page([]), 'thread');
  api.validatePersistedPage(page([event('e1', 1), event('e2', 2)]), 'thread');
  assert.throws(() => api.validatePersistedPage(page([event('e1', 1, 'other')]), 'thread'), /task_history_thread_mismatch/u);
  assert.throws(() => api.validatePersistedPage(page([event('e1', 2), event('e2', 2)]), 'thread'), /task_history_sequence_non_monotonic/u);
  assert.throws(() => api.validatePersistedPage(page([event('e1', 1), event('e1', 2)]), 'thread'), /task_history_event_id_duplicate/u);
  assert.throws(() => api.validatePersistedPage({...page([event('e1', 1)]), newestSequence: 2}, 'thread'), /task_history_page_metadata_mismatch/u);
});

test('history merge deduplicates matching identities and rejects either identity conflict', () => {
  const first = event('e1', 1);
  const second = event('e2', 2);
  const third = event('e3', 3);
  assert.deepEqual(api.mergePersistedEvents([first, second], [second, third]), [first, second, third]);
  assert.deepEqual(api.mergePersistedEvents([first, second], [first]), [first, second]);
  assert.throws(
    () => api.mergePersistedEvents([first], [event('e1', 9)]),
    /task_history_event_id_sequence_conflict/u
  );
  assert.throws(
    () => api.mergePersistedEvents([first], [event('different-id', 1)]),
    /task_history_sequence_id_conflict/u
  );
});
