import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';

import { importTypeScriptModule } from '../../scripts/lib/bundle-ts.mjs';
import { executeApplication, prepareApplication } from '../../evaluation/lib/application.mjs';
import { fixtureCompletion, fixtureConfig } from '../../evaluation/lib/fixture.mjs';
import { gradeQasper, importQasper, qasperInput } from '../../evaluation/lib/qasper.mjs';
import { testArtifacts } from '../../evaluation/tests/test-artifacts.mjs';

const root = testArtifacts('context-policy');
const options = { platform: 'node', external: ['langchain', '@langchain/*', 'deepagents', 'better-sqlite3', 'zod'], tempDir: root };
const { assembleContextHarness } = await importTypeScriptModule('src/main/services/deep-agent/context/context-assembler.ts', options);
const { BlockStability, buildPromptBlocks } = await importTypeScriptModule('src/main/services/deep-agent/context/prompt-blocks.ts', options);
const contract = {
  contractVersion: 1, objective: 'Return only JSON with the requested answer and source identifiers.',
  constraints: [], kind: 'reply', criteria: [{ id: 'A-01', description: 'Produce a visible response.', check: { kind: 'response' } }]
};
const base = {
  memoryApplicability: '', artifactStore: {}, mode: 'run',
  enabledCapabilities: { mcpServers: [], skills: [] }, workflowHint: null, workspacePath: root,
  memorySources: [], baseTools: [], allowedToolNames: ['ls', 'read_file'],
  searchSessions: () => { throw new Error('unexpected_session_search'); },
  searchMemory: () => { throw new Error('unexpected_memory_search'); },
  remember: () => { throw new Error('unexpected_remember'); },
  runId: 'context-policy-run', threadId: 'context-policy-thread',
  explicitSkillContexts: [], referencedFileContexts: [], researchProjectId: null, taskContract: contract
};
const unavailable = ['ask_user', 'memory_search', 'session_search', 'remember', 'write_file', 'edit_file', 'run_shell_command', 'roc_self_config'];

test('context policy includes framework tools from the manifest and excludes unauthorized custom guidance', () => {
  const harness = assembleContextHarness({
    ...base,
    baseTools: unavailable.map(name => ({ name, description: `forbidden-descriptor-${name}` }))
  });
  assert.deepEqual(harness.tools, []);
  assert.match(harness.systemPrompt, /Available Tools:\n- ls\n- read_file\n/);
  for (const name of unavailable) assert.equal(harness.systemPrompt.includes(name), false, name);
  assert.equal(harness.systemPrompt.includes('BLOCK:context_recall:'), false);
  assert.equal(harness.systemPrompt.includes('BLOCK:memory:'), false);
  assert.match(harness.systemPrompt, /\/workspace\//);
  assert.ok(harness.systemPrompt.includes(JSON.stringify(contract)));
  assert.deepEqual(harness.memorySources, []);
});

test('plan context keeps its read-only response contract while filtering manifest-authorized write tools', () => {
  const harness = assembleContextHarness({
    ...base, mode: 'plan',
    allowedToolNames: [...base.allowedToolNames, 'ask_user', 'memory_search', 'remember', 'write_file', 'edit_file', 'run_shell_command'],
    baseTools: [{ name: 'ask_user', description: 'Ask for a missing decision.' }]
  });
  assert.deepEqual(harness.tools.map(tool => tool.name).sort(), ['ask_user', 'memory_search']);
  for (const name of ['remember', 'write_file', 'edit_file', 'run_shell_command']) {
    assert.equal(harness.systemPrompt.includes(name), false, name);
  }
  assert.match(harness.systemPrompt, /<proposed_plan>/);
  assert.match(harness.systemPrompt, /no local mutation, execution, or task commits/);
  assert.ok(harness.systemPrompt.includes(JSON.stringify(contract)));
});

test('partial recall manifests never instruct the absent recall tool and retain injected-memory routing', () => {
  for (const [present, absent] of [['memory_search', 'session_search'], ['session_search', 'memory_search']]) {
    const harness = assembleContextHarness({
      ...base, allowedToolNames: [...base.allowedToolNames, present], memorySources: ['/memory/global/MEMORY.md']
    });
    assert.deepEqual(harness.tools.map(tool => tool.name), [present]);
    assert.ok(harness.systemPrompt.includes(present));
    assert.equal(harness.systemPrompt.includes(absent), false);
    assert.ok(harness.systemPrompt.includes('/memory/global/MEMORY.md'));
    assert.equal(harness.systemPrompt.includes('remember'), false);
  }
  const readOnlyMemory = assembleContextHarness({ ...base, memorySources: ['/memory/global/MEMORY.md'] });
  assert.ok(readOnlyMemory.systemPrompt.includes('/memory/global/MEMORY.md'));
  assert.equal(readOnlyMemory.systemPrompt.includes('BLOCK:context_recall:'), false);
});

test('context prefixes stay deterministic under tool ordering and keep request text in its trust zone', () => {
  const input = { ...base, tools: [], allowedToolNames: ['read_file', 'ls', 'read_file'] };
  const first = buildPromptBlocks(input);
  const reordered = buildPromptBlocks({ ...input, allowedToolNames: [...input.allowedToolNames].reverse() });
  assert.deepEqual(first, reordered);
  const otherWorkspace = buildPromptBlocks({ ...input, workspacePath: null, taskContract: { ...contract, objective: 'Different request.' } });
  const stable = blocks => blocks.filter(block => [BlockStability.STATIC, BlockStability.CAPABILITY].includes(block.stability));
  assert.deepEqual(stable(first), stable(otherWorkspace));
  assert.equal(first.find(block => block.type === 'task_contract').trustZone, 'user-reference');
  assert.equal((first.find(block => block.type === 'tools').content.match(/^- read_file$/gm) ?? []).length, 1);
  const noTools = assembleContextHarness({ ...base, allowedToolNames: [] });
  for (const name of [...unavailable, 'ls', 'read_file']) assert.equal(noTools.systemPrompt.includes(`- ${name}`), false);
});

test('real Roc worker receives the filtered policy and strict QASPER scoring keeps invalid final JSON as failure', async () => {
  const artifact = await prepareApplication(root);
  const [task] = importQasper({
    paper: { title: 'Visible source', abstract: 'visible-policy-paper-sentinel', full_text: [],
      qas: [{ question_id: 'missing-answer', question: 'Which unavailable result is reported?',
        answers: [{ answer: { unanswerable: true, extractive_spans: [], free_form_answer: '', yes_no: null, evidence: [] } }] }]
    }
  });
  const input = qasperInput(task);
  for (const fenced of [false, true]) {
    const directory = join(root, fenced ? 'fenced' : 'plain');
    mkdirSync(directory);
    const requests = [];
    const result = await executeApplication({
      artifact, input, directory, config: fixtureConfig,
      signal: new AbortController().signal, record: () => {},
      complete: body => {
        requests.push(body);
        const response = fixtureCompletion(body);
        if (fenced && requests.length === 2) response.choices[0].message.content = '```json\n{"answer":"Unanswerable","evidence":[]}\n```';
        return response;
      }
    });
    assert.equal(requests.length, 2);
    assert.equal(result.runtimeVerification.status, 'verified');
    for (const request of requests) {
      assert.deepEqual(request.tools.map(tool => tool.function.name).sort(), ['ls', 'read_file']);
      const system = request.messages.filter(message => message.role === 'system').flatMap(({ content }) =>
        typeof content === 'string' ? [content] : content.map(block => {
          assert.equal(block.type, 'text');
          return block.text;
        })
      ).join('\n');
      assert.match(system, /Available Tools:\n- ls\n- read_file\n/);
      assert.match(system, /return only the requested JSON value: no Markdown fences/);
      assert.match(system, /shortest sufficient answer/);
      assert.equal(system.includes('BLOCK:context_recall:'), false);
      assert.ok(system.includes('BLOCK:task_contract:'));
    }
    const grade = gradeQasper(task, result.output);
    if (fenced) {
      assert.equal(result.output, '```json\n{"answer":"Unanswerable","evidence":[]}\n```');
      assert.equal(grade.reason, 'output_not_json');
      assert.deepEqual(grade.metrics, { answerF1: 0, evidenceF1: 0, citationValidity: 0 });
    } else {
      assert.deepEqual(grade.metrics, { answerF1: 1, evidenceF1: 1, citationValidity: 1 });
    }
  }
});
