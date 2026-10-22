import assert from 'node:assert/strict';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type Database from 'better-sqlite3';
import { AIMessage, HumanMessage, ToolMessage, type BaseMessage } from '@langchain/core/messages';
import { emptyCheckpoint } from '@langchain/langgraph';
import { RocSqliteCheckpointer } from '../../src/main/services/deep-agent/sqlite-checkpointer';
import { ContextArtifactStore } from '../../src/main/services/deep-agent/context/context-artifact-store';
import { createContextArtifactReadTool } from '../../src/main/services/deep-agent/context/context-artifact-tool';
import { runContextCompaction } from '../../src/main/services/deep-agent/context/context-compaction-pipeline';
import { collectUserConstraints, pinContextContract } from '../../src/main/services/deep-agent/context/context-contract';
import { createContextTokenCounter, deriveContextBudgetProfile } from '../../src/main/services/deep-agent/context/context-token-budget';
import { BlockStability, buildPromptBlocks } from '../../src/main/services/deep-agent/context/prompt-blocks';
import { RunBudgetLedger } from '../../src/main/services/deep-agent/run-budget-ledger';
import { decodeJson } from '../lib/decode-json';

export async function verifyContext(name: string, directory: string, db: Database.Database): Promise<unknown> {
  const artifacts = new ContextArtifactStore(db);
  if (name === 'context-artifacts') {
    const artifact = artifacts.persistArtifact({ content: '原始证据'.repeat(3000), kind: 'tool_result',
      runId: 'run', threadId: 'thread', workspaceHash: 'workspace' });
    const tool = createContextArtifactReadTool({ artifactStore: artifacts, threadId: 'thread', workspaceHash: 'workspace' });
    const slice = decodeJson<{ content: string; nextOffset: number }>(
      String(await tool.invoke({ artifactId: artifact.artifactId, sha256: artifact.sha256, offset: 100, limit: 50 })),
      'context_artifact_read_corrupt'
    );
    assert.equal(slice.content, artifact.content.slice(100, 150));
    assert.equal(slice.nextOffset, 150);
    await assert.rejects(createContextArtifactReadTool({ artifactStore: artifacts, threadId: 'other', workspaceHash: 'workspace' })
      .invoke({ artifactId: artifact.artifactId, sha256: artifact.sha256 }), /scope_mismatch/);
    db.prepare('UPDATE context_artifacts SET content = ? WHERE id = ?').run('tampered', artifact.artifactId);
    await assert.rejects(tool.invoke({ artifactId: artifact.artifactId, sha256: artifact.sha256 }), /content_corrupt/);
    db.prepare('UPDATE context_artifacts SET content = ?, created_at = ? WHERE id = ?')
      .run(artifact.content, '2020-01-01T00:00:00.000Z', artifact.artifactId);
    await assert.rejects(tool.invoke({ artifactId: artifact.artifactId, sha256: artifact.sha256 }), /artifact_expired/);
    return { paged: true, wrongScope: 'denied', corrupt: 'denied', expired: 'denied' };
  }
  if (name === 'context-prefix') {
    const base = { mode: 'run' as const, enabledCapabilities: { mcpServers: [], skills: [] },
      workspacePath: '/synthetic/project', workflowHint: null, tools: [{ name: 'z' }, { name: 'a' }],
      explicitSkillContexts: [], referencedFileContexts: [{ path: 'paper.pdf' }], researchProjectId: null };
    const a = buildPromptBlocks(base);
    const b = buildPromptBlocks({ ...base, workspacePath: '/synthetic/other', tools: [...base.tools].reverse(),
      referencedFileContexts: [{ path: 'untrusted.pdf' }] });
    const stable = (blocks: typeof a) => blocks.filter(block => [BlockStability.STATIC, BlockStability.CAPABILITY].includes(block.stability));
    assert.deepEqual(stable(a), stable(b));
    assert.equal(a.find(block => block.type === 'referenced_files')?.trustZone, 'user-reference');
    assert.ok(a.findIndex(block => block.stability === BlockStability.WORKSPACE) > stable(a).length - 1);
    return { stablePrefix: stable(a).map(block => block.hash), trustZones: a.map(block => block.trustZone) };
  }
  if (name === 'context-tokens') {
    const exact = createContextTokenCounter({ modelId: 'gpt-4o', providerType: 'openai_compatible', baseUrl: null });
    const fallback = createContextTokenCounter({ modelId: 'unsupported', providerType: 'custom', baseUrl: null });
    const samples = ['English evidence with a DOI 10.1/example', '中文论文表格：均值3.5，样本量12。',
      'PDF page 42\nTable 1: 3.50 ± 0.25\nSource [S12]', JSON.stringify({ tool: 'search', queries: ['研究', 'evidence'], page: 3 })];
    const measured = [];
    for (const text of samples) {
      const start = performance.now();
      const tokens = await exact.countText(text);
      const estimate = await fallback.countText(text);
      assert.equal(tokens.estimated, false);
      assert.equal(estimate.estimated, true);
      assert.ok(estimate.tokens >= tokens.tokens);
      measured.push({ bytes: Buffer.byteLength(text), tokens: tokens.tokens, conservative: estimate.tokens, cpuMs: performance.now() - start });
    }
    let counts = 0;
    const counted = { ...exact, countText: async (text: string) => { counts++; return await exact.countText(text); } };
    const input = { counter: counted, contextWindowTokens: 10000, systemPrompt: 'Policy', tools: [{ name: 'a', description: 'Read', schema: { type: 'object' } }] };
    const first = await deriveContextBudgetProfile(input);
    assert.deepEqual(await deriveContextBudgetProfile(input), first);
    assert.equal(counts, 1);
    await deriveContextBudgetProfile({ ...input, tools: [{ ...input.tools[0], description: 'Changed' }] });
    assert.equal(counts, 2);
    writeFileSync(join(directory, 'token-measurements.json'), JSON.stringify(measured, null, 2));
    return { measured, calibration: 'local OpenAI text tokenizer; provider message framing remains estimated', cacheInvalidated: true };
  }
  const ledger = new RunBudgetLedger(db);
  const createdAt = new Date().toISOString();
  db.prepare(`INSERT OR IGNORE INTO agent_threads (id, kind, title, goal, status, created_at, updated_at)
    VALUES ('thread','chat','context fixture','context fixture','active',?,?)`).run(createdAt, createdAt);
  db.prepare(`INSERT OR IGNORE INTO agent_runs
    (id, thread_id, run_number, user_input, status, started_at, enabled_capabilities_json)
    VALUES ('run','thread',1,'context fixture','running',?,'{}')`).run(createdAt);
  db.prepare(`INSERT OR IGNORE INTO agent_task_contracts (run_id, contract_json)
    VALUES ('run',?)`).run(JSON.stringify({ contractVersion: 1, objective: 'Preserve context fixture requirements',
      constraints: [], kind: 'task', criteria: ['A-01', 'A-02'].map(id => ({ id, description: `${id} fixture`, check: { kind: 'unverified' } })) }));
  db.prepare(`INSERT INTO agent_pending_interrupts VALUES ('run','thread','approval',0,'{}',?,?)`)
    .run(new Date().toISOString(), new Date().toISOString());
  const messages: BaseMessage[] = [new HumanMessage({ id: 'goal', content: 'Revise only the supplied draft.' })];
  for (let index = 0; index < 12; index++) {
    messages.push(new HumanMessage({ id: `constraint-${index}`, content: `constraint-${index}: ${'保留用户约束'.repeat(100)} END-${index}` }),
      new AIMessage({ id: `old-answer-${index}`, content: 'Old assistant explanation. '.repeat(500) }));
    if (index % 3 === 0) messages.push(
      new AIMessage({ id: `call-${index}`, content: '', tool_calls: [{ id: `read-${index}`, name: 'read_file', args: { page: index } }] }),
      new ToolMessage({ tool_call_id: `read-${index}`, name: 'read_file', content: `source-${index} ${'source text '.repeat(200)}` })
    );
  }
  const expected = new Set(collectUserConstraints(messages));
  const countTokens = async (items: readonly BaseMessage[]) => Math.ceil(items.reduce((sum, message) => sum + JSON.stringify(message.content).length, 0) / 4);
  const events: unknown[] = [];
  let summaries = 0;
  const input = { artifactStore: artifacts, readControlState: () => ledger.readContextControlState('run'),
    budgetProfile: { contextWindowTokens: 20000, modelInputTokens: 10000, reservedOutputTokens: 2000,
      systemToolOverheadTokens: 1000, summaryInputTokens: 5000, safetyMarginTokens: 1000 },
    emitEvent: (event: unknown) => events.push(event), mode: 'run' as const, model: { invoke: async () => { throw new Error('unexpected_model'); } } as never,
    runId: 'run', threadId: 'thread', sessionHistory: { recordPreCompactionFlush: () => {} }, workspaceHash: 'workspace', workspacePath: directory,
    countTokens, tokenCounter: { countMessages: async (items: readonly BaseMessage[]) => ({ tokens: await countTokens(items), estimated: true }),
      countText: async (text: string) => ({ tokens: Math.ceil(text.length / 4), estimated: true }), wasEstimated: () => true },
    toolResultPersistChars: 500,
    summarize: async () => {
      summaries++;
      if (name === 'context-summary-failure') throw new Error('context_summary_failed');
      return { goal: 'Lossy summary', facts: [], decisions: [], filesTouched: [], toolEvidence: [], verification: [], openQuestions: [], nextActions: [] };
    }
  };
  const seeded = pinContextContract(messages, messages, { acceptanceIds: ['A-01', 'A-02'], pendingEffects: [], pendingApprovals: [] }, []);
  let compacted = await runContextCompaction({ ...input, messages: seeded });
  writeFileSync(join(directory, 'compaction-events.json'), JSON.stringify(events, null, 2));
  assert.deepEqual(new Set(collectUserConstraints(compacted)), expected);
  assert.ok(summaries > 0, 'fixture must invoke summarization');
  assert.ok(JSON.stringify(compacted).includes('approval'));
  assert.ok(JSON.stringify(compacted).includes('A-01') && JSON.stringify(compacted).includes('A-02'));
  // A real checkpoint roundtrip precedes the second compaction.
  const saver = new RocSqliteCheckpointer(db);
  const checkpoint = emptyCheckpoint();
  checkpoint.channel_values = { messages: compacted };
  const config = await saver.put({ configurable: { thread_id: 'thread' } }, checkpoint,
    { source: 'update', step: 1, parents: {} }, {});
  const restored = await new RocSqliteCheckpointer(db).getTuple(config);
  assert.ok(restored);
  const continued = [...restored.checkpoint.channel_values.messages as BaseMessage[],
    ...Array.from({ length: 6 }, (_, index) => new AIMessage({ id: `continued-${index}`, content: 'More notes '.repeat(400) }))];
  compacted = await runContextCompaction({ ...input, messages: continued });
  assert.deepEqual(new Set(collectUserConstraints(compacted)), expected);
  assert.ok(JSON.stringify(compacted).includes('A-01') && JSON.stringify(compacted).includes('A-02'));
  assert.ok(summaries >= 2, 'both compactions must exercise the summary boundary');
  assert.ok(await countTokens(compacted) <= input.budgetProfile.modelInputTokens);
  writeFileSync(join(directory, 'compaction-events.json'), JSON.stringify(events, null, 2));
  writeFileSync(join(directory, 'compacted.json'), JSON.stringify(compacted, null, 2));
  return { summaries, constraints: expected.size, acceptanceIds: ['A-01', 'A-02'], checkpoint: checkpoint.id, summaryFailure: name === 'context-summary-failure' };
}
