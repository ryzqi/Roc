import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

let dir, transcript, runState;
before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'roc-transcript-cache-'));
  for (const [entry, name] of [['transcript', 'transcript'], ['run-state', 'runState']]) {
    const outfile = join(dir, `${name}.mjs`);
    await build({ entryPoints: [`src/renderer/assistant/${entry}.ts`], outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent' });
    const mod = await import(outfile);
    if (name === 'transcript') transcript = mod;
    else runState = mod;
  }
});
after(() => rmSync(dir, { recursive: true, force: true }));

function event(threadId = 'thread') {
  return { id: 'event', threadId, runId: 'past', sequence: 1, type: 'message', payload: { role: 'user', content: 'history' }, createdAt: '2026-07-10T00:00:00.000Z' };
}

test('unchanged inputs reuse the result and live deltas retain historical objects', () => {
  const project = transcript.createChatTranscriptProjector();
  const input = { events: [event()], liveRun: { ...runState.createEmptyChatRunState(), threadId: 'thread', runId: 'live', status: 'running', assistantMessage: 'a' }, pendingUserInput: null, threadId: 'thread' };
  const first = project(input);
  assert.equal(first.length, 2);
  assert.strictEqual(project({ ...input, liveRun: { ...input.liveRun } }), first);
  const next = project({ ...input, liveRun: { ...input.liveRun, assistantMessage: 'ab' } });
  assert.strictEqual(next[0], first[0]);
  assert.equal(next[1].content, 'ab');
  assert.equal(first[1].content, 'a', 'live updates must not mutate cached messages');
});

test('history and thread switches invalidate the cache and match uncached projection', () => {
  const project = transcript.createChatTranscriptProjector();
  const input = { events: [event()], liveRun: null, pendingUserInput: null, threadId: 'thread' };
  const first = project(input);
  const changed = { ...input, events: [event(), { ...event(), id: 'event-2', sequence: 2 }] };
  assert.equal(project(changed).length, 2);
  assert.notStrictEqual(project(changed), first);
  for (const candidate of [input, changed, { ...input, threadId: 'other' }, { ...input, threadId: null, pendingUserInput: 'new' }, input]) {
    assert.deepEqual(project(candidate), transcript.projectChatTranscript(candidate));
  }
});
