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

for (const status of ['completed', 'cancelled', 'failed']) {
  test(`${status} answer stays visible until persisted history takes over the next run`, () => {
    const project = transcript.createChatTranscriptProjector();
    const history = [event()];
    const old = {...runState.createEmptyChatRunState(), threadId: 'thread', runId: 'old', status,
      assistantMessage: 'Long answer '.repeat(5000)};
    const input = {events: history, liveRun: old, pendingUserInput: null, threadId: 'thread'};
    project(input);
    const next = {...old, runId: 'next', status: 'running', assistantMessage: 'New answer'};
    const pending = project({...input, liveRun: next});
    assert.deepEqual(pending.map(message => message.key), ['user-past', 'assistant-old', 'assistant-next']);
    assert.equal(pending[1].content, old.assistantMessage, 'completed content must not disappear during history catchup');
    const partial = {...event(), id: 'old-partial', runId: 'old', sequence: 2,
      type: 'assistant_block', payload: {kind: 'text', blockId: 'old-text', phase: 'delta', text: 'Long '}};
    assert.equal(project({...input, liveRun: next, events: [...history, partial]})[1].content, old.assistantMessage);
    const intermediate = {...partial, type: 'message', payload: {role: 'assistant', content: 'Long '}};
    assert.equal(project({...input, liveRun: next, events: [...history, intermediate]})[1].content, old.assistantMessage);
    const persisted = {...event(), id: 'old-complete', runId: 'old', sequence: 3,
      ...(status === 'completed'
        ? {payload: {role: 'assistant', content: old.assistantMessage}}
        : {type: 'assistant_block', payload: {kind: 'text', blockId: 'old-text', phase: 'delta', text: old.assistantMessage}})};
    const newer = {...event(), id: 'next-prompt', runId: 'next', sequence: 4};
    const merged = project({...input, liveRun: next, events: [...history, persisted, newer]});
    assert.equal(merged.filter(message => message.key === 'assistant-old').length, 1);
    assert.equal(merged[1].source, 'persisted');
    assert.equal(project({...input, liveRun: next, events: []}).some(message => message.key === 'assistant-old'), false,
      'a covered answer must not reappear after history retention removes it');
  });
}

test('terminal handoff is bounded to one answer and cleared on thread changes', () => {
  const project = transcript.createChatTranscriptProjector();
  const input = {events: [], pendingUserInput: null, threadId: 'thread'};
  for (let index = 0; index < 20; index++) {
    const liveRun = {...runState.createEmptyChatRunState(), threadId: 'thread', runId: `run-${index}`,
      status: 'completed', assistantMessage: `Answer ${index}`};
    assert.ok(project({...input, liveRun}).length <= 2);
  }
  assert.deepEqual(project({...input, threadId: 'other', liveRun: null}), []);
  assert.deepEqual(project({...input, liveRun: null}), []);
});

test('a terminal answer outside the retained event window is released instead of resurrected', () => {
  const project = transcript.createChatTranscriptProjector();
  const input = {events: [event()], pendingUserInput: null, threadId: 'thread'};
  const previous = {...runState.createEmptyChatRunState(), threadId: 'thread', runId: 'old',
    status: 'cancelled', assistantMessage: 'Partial answer'};
  project({...input, liveRun: previous});
  const current = {...previous, runId: 'next', status: 'running', assistantMessage: 'Next answer'};
  const retained = [{...event(), id: 'newer', runId: 'next', sequence: 1000}];
  assert.deepEqual(project({...input, events: retained, liveRun: current}).map(message => message.key),
    ['user-next', 'assistant-next']);
  assert.deepEqual(project({...input, events: [], liveRun: current}).map(message => message.key), ['assistant-next']);
});

test('an empty failed next run does not discard the answer still awaiting history', () => {
  const project = transcript.createChatTranscriptProjector();
  const input = {events: [], pendingUserInput: null, threadId: 'thread'};
  const old = {...runState.createEmptyChatRunState(), threadId: 'thread', runId: 'old', status: 'completed', assistantMessage: 'Old answer'};
  project({...input, liveRun: old});
  const next = {...old, runId: 'next', status: 'running', assistantMessage: ''};
  project({...input, liveRun: next});
  assert.equal(project({...input, liveRun: {...next, status: 'failed'}})[0].content, 'Old answer');
});

test('tail trimming or replacing the history window clears the terminal handoff', () => {
  for (const change of [{historyTailTrimmed: true}, {historyWindowEpoch: 1}]) {
    const project = transcript.createChatTranscriptProjector();
    const input = {events: [], pendingUserInput: null, threadId: 'thread', historyWindowEpoch: 0};
    const old = {...runState.createEmptyChatRunState(), threadId: 'thread', runId: 'old', status: 'cancelled', assistantMessage: 'Old answer'};
    project({...input, liveRun: old});
    const next = {...old, runId: 'next', status: 'running', assistantMessage: 'New answer'};
    const messages = project({...input, ...change, liveRun: next});
    assert.deepEqual(messages.map(message => message.key), ['assistant-next']);
  }
});

test('final persisted messages take over with historical activity absent from live state', () => {
  const project = transcript.createChatTranscriptProjector();
  const input = {events: [], pendingUserInput: null, threadId: 'thread'};
  const old = {...runState.createEmptyChatRunState(), threadId: 'thread', runId: 'old', status: 'completed', assistantMessage: 'Old answer'};
  project({...input, liveRun: old});
  const events = [
    {...event(), id: 'guardrail', runId: 'old', sequence: 2, type: 'guardrail_nudge',
      payload: {nudgeKind: 'progress', content: 'Keep evidence boundaries'}},
    {...event(), id: 'final', runId: 'old', sequence: 3, payload: {role: 'assistant', content: 'Old answer'}}
  ];
  const messages = project({...input, events, liveRun: {...old, runId: 'next', status: 'running', assistantMessage: 'New answer'}});
  assert.equal(messages[0].source, 'persisted');
  assert.equal(messages[0].blocks[0].kind, 'guardrail');
});


test('task acceptance reports never appear in historical or live conversations', () => {
  const report = {taskId: 'task', runId: 'live', contractVersion: 1, status: 'partial',
    checkpointResumeAvailable: true, criteria: [], remainingItems: ['Continue from checkpoint'],
    blockedBy: [], nextSafeAction: 'Resume'};
  const acceptance = { ...event(), id: 'acceptance', type: 'task_acceptance', payload: {...report, runId: 'past'} };
  const started = { ...runState.createEmptyChatRunState(), threadId: 'thread', runId: 'live', status: 'completed' };
  const updated = runState.applyChatRunEvent(started, { type: 'task_acceptance', runId: 'live', report });
  assert.deepEqual(updated.activityBlocks, [{id: 'task-acceptance:task', kind: 'task_acceptance', report}]);
  const input = { events: [acceptance], pendingUserInput: null, threadId: 'thread', liveRun: null };
  assert.deepEqual(transcript.projectChatTranscript(input), []);
  const messages = transcript.projectChatTranscript({ ...input, liveRun: { ...updated, assistantMessage: 'Answer' } });
  assert.equal(messages.length, 1);
  assert.equal(messages[0].content, 'Answer');
  assert.deepEqual(messages[0].blocks, []);
});
