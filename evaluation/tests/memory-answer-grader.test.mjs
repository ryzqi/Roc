import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { capabilityEngineeringCompletion, capabilityEngineeringDataset } from '../adapters/capability/fixture.mjs';
import { capabilityInput } from '../adapters/capability/run.mjs';
import { gradeCapability } from '../graders/capability.mjs';
import { executeApplication, prepareApplication } from '../lib/application.mjs';
import { fixtureConfig } from '../lib/fixture.mjs';
import { testArtifacts } from './test-artifacts.mjs';

const root = testArtifacts('memory-answer-grader');
const task = capabilityEngineeringDataset().tasks.find(task => task.id === 'memory-cross-session');
const artifact = await prepareApplication(root, { kind: 'roc-capability', taskTools: [
  { taskId: task.id, toolNames: task.environment.tools, runMode: 'chat' }
] });

const variants = [
  ['correct', value => value, true],
  ['wrong-summary', value => ({ ...value, rememberedText: 'The engineering detector calibration uses protocol cobalt-99.' }), false],
  ['missing-summary', ({ rememberedText: _unused, ...value }) => value, false],
  ['null-summary', value => ({ ...value, rememberedText: null }), false],
  ['negated-summary', value => ({ ...value, rememberedText: `It is false that ${value.rememberedText}` }), false],
  ['appended-denial', value => ({ ...value, rememberedText: `${value.rememberedText} This is incorrect.` }), false],
  ['wrong-key', value => ({ ...value, key: 'unrelated-memory' }), false]
];

for (const [name, alter, expected] of variants) {
  test(`cross-session final answer: ${name}`, async () => {
    const directory = join(root, name);
    mkdirSync(directory);
    let answersChanged = 0;
    const result = await executeApplication({ artifact, directory, input: capabilityInput('roc-capability', task),
      config: { ...fixtureConfig, taskTimeoutMs: 60000 }, signal: new AbortController().signal, record: () => {},
      complete: (body, signal, binding) => {
        const response = capabilityEngineeringCompletion(body, signal, binding);
        const message = response.choices[0].message;
        if (binding.phaseId === 'recall' && !message.tool_calls) {
          message.content = JSON.stringify(alter(JSON.parse(message.content)));
          answersChanged++;
        }
        return response;
      }
    });
    assert.equal(answersChanged, 1);
    const scored = gradeCapability(task, result, { directory });
    assert.equal(scored.status, 'scored', JSON.stringify(scored));
    for (const id of ['fact-stored', 'fact-recalled', 'memory-write', 'memory-search']) {
      assert.equal(scored.checks.find(check => check.id === id).passed, true, `${name}: ${id}`);
    }
    assert.equal(scored.success, expected, JSON.stringify(scored));
    assert.equal(scored.checks.find(check => check.kind === 'memory').passed, expected);
    assert.equal(scored.checks.find(check => check.id === 'remembered-text').passed, name === 'wrong-key' || expected);
    assert.equal(scored.checks.find(check => check.id === 'remembered-key').passed, name !== 'wrong-key');
    if (!expected) assert.equal(scored.failureClass, 'agent');

    // Independent memory grading must reject the bad answer even without JSON-value checks.
    const evidenceOnly = structuredClone(task);
    evidenceOnly.expected.checks = evidenceOnly.expected.checks.filter(check => check.kind !== 'json-value');
    assert.equal(gradeCapability(evidenceOnly, result, { directory }).success, expected);
  });
}
