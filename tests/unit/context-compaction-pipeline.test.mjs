import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AIMessage, HumanMessage, SystemMessage, ToolMessage } from '@langchain/core/messages';
import * as esbuild from 'esbuild';

const source = 'src/main/services/deep-agent/context/context-compaction-pipeline.ts';
const artifactToolSource = 'src/main/services/deep-agent/context/context-artifact-tool.ts';
let directory;
let api;
let artifactToolApi;

before(async () => {
  directory = mkdtempSync(join(tmpdir(), 'roc-context-compaction-pipeline-'));
  symlinkSync(join(process.cwd(), 'node_modules'), join(directory, 'node_modules'), 'dir');
  const outfile = join(directory, 'context-compaction-pipeline.mjs');
  const artifactToolOutfile = join(directory, 'context-artifact-tool.mjs');
  const bundleOptions = {
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node22',
    packages: 'external',
    logLevel: 'silent'
  };
  await Promise.all([
    esbuild.build({...bundleOptions, entryPoints: [source], outfile}),
    esbuild.build({...bundleOptions, entryPoints: [artifactToolSource], outfile: artifactToolOutfile})
  ]);
  [api, artifactToolApi] = await Promise.all([import(outfile), import(artifactToolOutfile)]);
});

after(() => rmSync(directory, {recursive: true, force: true}));

function withIteration(message, iteration) {
  message.additional_kwargs = {...message.additional_kwargs, forge_iteration_index: iteration};
  return message;
}

function summary(overrides = {}) {
  return {
    goal: 'Keep the current task coherent.',
    facts: ['A verified fact'],
    decisions: ['Keep the existing boundary'],
    filesTouched: [],
    toolEvidence: [],
    verification: ['The focused check passed'],
    openQuestions: [],
    nextActions: ['Continue with the next task'],
    ...overrides
  };
}

function createFixture({
  messages = [new HumanMessage('Continue the current task.')],
  countTokens = async () => 90,
  summarize = async () => summary(),
  artifactRecoveryEnabled,
  toolResultPersistChars,
  summaryInputTokens = 1000,
  controlState = {acceptanceIds: [], pendingEffects: [], pendingApprovals: []}
} = {}) {
  const events = [];
  const flushes = [];
  const persisted = [];
  const persistedArtifacts = [];
  const storedArtifacts = new Map();
  const artifactStore = {
    persistArtifact(input) {
      persisted.push(input);
      const artifactId = 'artifact-' + persisted.length;
      const artifact = {
        artifactId,
        content: input.content,
        kind: input.kind,
        originalChars: input.content.length,
        preview: input.content.slice(0, 80),
        runId: input.runId,
        sha256: String(persisted.length).padStart(64, '0'),
        threadId: input.threadId,
        toolCallId: input.toolCallId ?? null,
        toolName: input.toolName ?? null,
        workspaceHash: input.workspaceHash,
        expiresAt: '2026-10-28T00:00:00.000Z'
      };
      persistedArtifacts.push(artifact);
      storedArtifacts.set(artifactId, artifact);
      return artifact;
    },
    readArtifact({artifactId, expectedSha256, threadId, workspaceHash}) {
      const artifact = storedArtifacts.get(artifactId);
      if (artifact === undefined || artifact.sha256 !== expectedSha256 || artifact.threadId !== threadId || artifact.workspaceHash !== workspaceHash) {
        return null;
      }
      return artifact;
    }
  };
  const input = {
    artifactStore,
    readControlState: () => controlState,
    artifactRecoveryEnabled,
    budgetProfile: {
      contextWindowTokens: 1000,
      modelInputTokens: 100,
      summaryInputTokens,
      reservedOutputTokens: 0,
      systemToolOverheadTokens: 0,
      safetyMarginTokens: 0
    },
    emitEvent: event => events.push(event),
    mode: 'chat',
    model: {invoke: async () => new AIMessage('unused')},
    runId: 'run-1',
    sessionHistory: {recordPreCompactionFlush: record => flushes.push(record)},
    threadId: 'thread-1',
    tokenCounter: {
      countText: async () => ({tokens: 0, estimated: false}),
      countMessages: async () => ({tokens: 0, estimated: false}),
      wasEstimated: () => false
    },
    toolResultPersistChars,
    workspaceHash: 'workspace-hash',
    workspacePath: '/workspace/project',
    messages,
    countTokens,
    summarize
  };
  return {input, events, flushes, persisted, persistedArtifacts, artifactStore};
}

function hasEvent(events, type) {
  return events.some(event => event.type === type);
}

test('summary is skipped below 90 percent and starts at the exact threshold', async () => {
  let belowSummaryCalls = 0;
  const below = createFixture({
    countTokens: async () => 89,
    summarize: async () => { belowSummaryCalls += 1; return summary(); }
  });
  await api.runContextCompaction(below.input);
  assert.equal(belowSummaryCalls, 0);
  assert.equal(hasEvent(below.events, 'context_summary_skipped'), true);
  assert.equal(hasEvent(below.events, 'context_summary_started'), false);

  let thresholdSummaryCalls = 0;
  const atThreshold = createFixture({
    countTokens: async () => 90,
    summarize: async () => { thresholdSummaryCalls += 1; return summary(); }
  });
  await api.runContextCompaction(atThreshold.input);
  assert.equal(thresholdSummaryCalls, 1);
  assert.equal(hasEvent(atThreshold.events, 'context_summary_completed'), true);
  assert.equal(atThreshold.flushes.length, 1);
});

test('deterministic edits restore a removed tool result and leave caller messages unchanged', async () => {
  const system = new SystemMessage('System context');
  const user = withIteration(new HumanMessage('Keep this user constraint.'), 0);
  const toolCall = withIteration(new AIMessage({
    id: 'assistant-call',
    content: '',
    tool_calls: [{id: 'call-1', name: 'search_docs', args: {query: 'history'}, type: 'tool_call'}]
  }), 0);
  const toolResult = withIteration(new ToolMessage({
    id: 'tool-result',
    tool_call_id: 'call-1',
    name: 'search_docs',
    content: 'A persisted result that must remain paired with its tool call.'
  }), 0);
  const messages = [
    system,
    user,
    toolCall,
    toolResult,
    withIteration(new AIMessage('Older response.'), 1),
    withIteration(new AIMessage('Next response.'), 2),
    withIteration(new AIMessage('Recent response.'), 3),
    withIteration(new AIMessage('Newest response.'), 4)
  ];
  const originalMessages = [...messages];
  let tokenCalls = 0;
  const fixture = createFixture({
    messages,
    countTokens: async () => (++tokenCalls <= 3 ? 100 : 89)
  });

  const compacted = await api.runContextCompaction(fixture.input);
  const callIndex = compacted.indexOf(toolCall);
  assert.notEqual(callIndex, -1);
  assert.strictEqual(compacted[callIndex + 1], toolResult);
  assert.equal(compacted.some(message => message.id === 'tool-result'), true);
  assert.equal(compacted.some(message => message.id === 'roc-context-contract'), false);
  assert.deepEqual(messages, originalMessages);
  assert.equal(hasEvent(fixture.events, 'context_summary_skipped'), true);
});

test('recoverable summary failure falls back to persisted artifact locators', async () => {
  const largeResult = 'search result '.repeat(400);
  const toolCall = new AIMessage({
    id: 'assistant-call',
    content: '',
    tool_calls: [{id: 'call-large', name: 'search_docs', args: {query: 'source'}, type: 'tool_call'}]
  });
  const toolResult = new ToolMessage({
    id: 'large-tool-result',
    tool_call_id: 'call-large',
    name: 'search_docs',
    content: largeResult
  });
  let summaryInput;
  const fixture = createFixture({
    messages: [
      new SystemMessage('System context'),
      new HumanMessage('Preserve the source evidence.'),
      toolCall,
      toolResult,
      new HumanMessage('Continue after checking the source.')
    ],
    countTokens: async () => 90,
    toolResultPersistChars: 100,
    summarize: async input => {
      summaryInput = input;
      throw new Error('context_summary_failed');
    }
  });

  const compacted = await api.runContextCompaction(fixture.input);
  const output = compacted.map(message => String(message.content)).join('\n');
  assert.equal(fixture.persisted.length, 1);
  assert.equal(fixture.persisted[0].kind, 'tool_result');
  assert.equal(fixture.persisted[0].toolCallId, 'call-large');
  assert.equal(summaryInput.artifactReferences.length, 1);
  assert.match(output, /artifact-1/u);
  assert.equal(output.includes(largeResult), false);
  assert.match(output, /preview:/u);
  const readArtifact = artifactToolApi.createContextArtifactReadTool({
    artifactStore: fixture.artifactStore,
    threadId: 'thread-1',
    workspaceHash: 'workspace-hash'
  });
  const reference = fixture.persistedArtifacts[0];
  const firstSlice = JSON.parse(await readArtifact.invoke({artifactId: reference.artifactId, sha256: reference.sha256}));
  assert.equal(firstSlice.complete, false);
  assert.equal(firstSlice.nextOffset, firstSlice.content.length);
  const finalSlice = JSON.parse(await readArtifact.invoke({
    artifactId: reference.artifactId,
    sha256: reference.sha256,
    offset: firstSlice.nextOffset,
    limit: 12_000
  }));
  assert.equal(finalSlice.complete, true);
  assert.equal(firstSlice.content + finalSlice.content, largeResult);
  assert.equal(hasEvent(fixture.events, 'context_tool_result_persisted'), true);
  assert.equal(hasEvent(fixture.events, 'context_compaction_failed'), true);
  assert.equal(hasEvent(fixture.events, 'context_summary_completed'), false);
  assert.equal(fixture.flushes.length, 0);
  assert.equal(String(toolResult.content), largeResult);
});

test('disabled artifact recovery keeps the complete tool result in memory', async () => {
  const largeResult = 'complete tool result '.repeat(200);
  const toolResult = new ToolMessage({
    id: 'large-tool-result',
    tool_call_id: 'call-large',
    name: 'search_docs',
    content: largeResult
  });
  const fixture = createFixture({
    messages: [new HumanMessage('Retain this result.'), toolResult],
    countTokens: async () => 89,
    artifactRecoveryEnabled: false,
    toolResultPersistChars: 10
  });
  const compacted = await api.runContextCompaction(fixture.input);
  assert.equal(fixture.persisted.length, 0);
  assert.equal(compacted.some(message => message.id === 'large-tool-result' && message.content === largeResult), true);
  assert.equal(hasEvent(fixture.events, 'context_summary_skipped'), true);
});

test('summary pins old user constraints and runtime facts while enforcing the hard budget', async () => {
  const firstConstraint = new HumanMessage('Never change the public API.');
  const oldConstraint = new HumanMessage('Preserve the original data format.');
  const messages = [
    new SystemMessage('System context'),
    firstConstraint,
    withIteration(new AIMessage('Old response 0.'), 0),
    oldConstraint,
    withIteration(new AIMessage('Old response 1.'), 1),
    withIteration(new AIMessage('Old response 2.'), 2),
    withIteration(new AIMessage('Old response 3.'), 3),
    withIteration(new AIMessage('Old response 4.'), 4),
    withIteration(new AIMessage('Old response 5.'), 5),
    withIteration(new AIMessage('Recent response 6.'), 6),
    new HumanMessage('Continue with the approved implementation.'),
    withIteration(new AIMessage('Recent response 7.'), 7)
  ];
  const controlState = {
    acceptanceIds: ['acceptance-7'],
    pendingEffects: ['effect-3'],
    pendingApprovals: ['approval-2']
  };
  const fixture = createFixture({
    messages,
    countTokens: async inputMessages => inputMessages.some(message => message.id === 'roc-context-contract')
      ? inputMessages.length * 20
      : 90,
    controlState
  });

  const compacted = await api.runContextCompaction(fixture.input);
  const contract = compacted.find(message => message.id === 'roc-context-contract');
  assert.ok(contract, 'runtime contract should survive summary and hard-limit compaction');
  const contractData = JSON.parse(String(contract.content));
  assert.deepEqual(contractData.userConstraints, ['Preserve the original data format.']);
  assert.deepEqual(contractData.acceptanceIds, ['acceptance-7']);
  assert.deepEqual(contractData.pendingEffects, ['effect-3']);
  assert.deepEqual(contractData.pendingApprovals, ['approval-2']);
  assert.ok(compacted.includes(firstConstraint));
  assert.ok(compacted.some(message => message.id === 'roc-context-contract'));
  assert.ok(compacted.length <= 5, 'the hard limit should remove unprotected history');
  assert.equal(hasEvent(fixture.events, 'context_summary_completed'), true);
  assert.equal(hasEvent(fixture.events, 'context_compaction_failed'), false);
  assert.equal(fixture.flushes.length, 1);
  assert.equal(fixture.flushes[0].threadId, 'thread-1');
});

test('protected context that alone exceeds the hard budget fails explicitly', async () => {
  const fixture = createFixture({
    messages: [new SystemMessage('Protected system context.'), new HumanMessage('Protected user request.')],
    countTokens: async inputMessages => inputMessages.some(message => message.id === 'roc-context-contract') ? 200 : 90,
    controlState: {acceptanceIds: ['acceptance-9'], pendingEffects: [], pendingApprovals: []}
  });
  await assert.rejects(api.runContextCompaction(fixture.input), /context_budget_exhausted/u);
  assert.equal(hasEvent(fixture.events, 'context_compaction_failed'), true);
  assert.equal(hasEvent(fixture.events, 'context_summary_completed'), false);
});

test('non-recoverable summary errors remain visible to the caller', async () => {
  const fixture = createFixture({
    countTokens: async () => 90,
    summarize: async () => { throw new Error('summary_state_corrupt'); }
  });
  await assert.rejects(api.runContextCompaction(fixture.input), /summary_state_corrupt/u);
  assert.equal(hasEvent(fixture.events, 'context_compaction_failed'), true);
  assert.equal(hasEvent(fixture.events, 'context_summary_completed'), false);
  assert.equal(fixture.flushes.length, 0);
});
