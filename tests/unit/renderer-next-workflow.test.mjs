import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the research-workflow rules (P6/T6.1, gate 7).
 *
 * The plan's gate is specific: *locked / ready / running / waiting_approval / paused /
 * blocked / completed / failed × with and without a gate*. That is the matrix below.
 *
 * Two facts about the real contract are what make this test suite more than a table
 * transcription, and both were read out of `src/main` rather than assumed:
 *
 *   1. **`reject` does not produce a failed run.** `transitionWorkflow('reject')` sets the
 *      stage back to `running` with `gateApproved: false` and the reviewer's note in
 *      `lastError`, while the producing run stays `completed`. So "gate 3: after a
 *      rejection the main action is retry, not 立刻提交审核" cannot be satisfied by the
 *      status alone — `isStageRejectedByGate` has to look at the run too.
 *   2. **`retryRun` refuses a `completed` run.** The rejection branch therefore emits
 *      `rerunStage`, which the store turns into pause → start (the only pair the contract
 *      allows in that state). If someone "simplifies" it back to `retry`, this suite fails
 *      with the backend's own reason instead of the UI silently 500-ing.
 *
 * `workflow-rules.ts` imports only types plus two pure modules, so esbuild (already a
 * devDependency) produces a dependency-free bundle to import — the same technique as the
 * P2 project-store tests.
 */

let rules;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-workflow-rules-'));
  const outfile = join(tempDir, 'workflow-rules.mjs');
  await esbuild.build({
    entryPoints: ['src/renderer-next/canvas/workflow/workflow-rules.ts'],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    target: 'node22',
    logLevel: 'silent'
  });
  rules = await import(outfile);
});

after(() => {
  if (tempDir !== undefined) {
    rmSync(tempDir, { recursive: true, force: true });
  }
});

const ALL_STAGES = [
  'discovery',
  'retrieval',
  'reading',
  'ideation',
  'planning',
  'experiment',
  'figure',
  'writing',
  'review',
  'revision',
  'export'
];

/** The backend's own gate table (`src/main/plugins/research/repository.ts`). */
const GATE_REQUIRED = new Set(ALL_STAGES.filter((stage) => stage !== 'discovery'));

function stageState(stage, status, overrides = {}) {
  return {
    stage,
    status,
    activeRunId: null,
    artifactIds: [],
    enteredAt: null,
    completedAt: null,
    gateRequired: GATE_REQUIRED.has(stage),
    gateApproved: false,
    lastError: null,
    ...overrides
  };
}

function workflow(currentStage, stages, overrides = {}) {
  return {
    projectId: 'p1',
    currentStage,
    projectStatus: 'active',
    stages: ALL_STAGES.map((stage) => {
      const provided = stages[stage];
      if (provided !== undefined) {
        return provided;
      }
      // Stages before the current one are completed, after it locked — the shape the
      // backend produces for a project partway through.
      const before = ALL_STAGES.indexOf(stage) < ALL_STAGES.indexOf(currentStage);
      return stageState(stage, before ? 'completed' : 'locked');
    }),
    lastEvent: null,
    ...overrides
  };
}

function run(overrides = {}) {
  return {
    id: 'run1',
    projectId: 'p1',
    stage: 'discovery',
    requestId: 'req1',
    parentRunId: null,
    retryOfRunId: null,
    reviewCycleId: null,
    revisionRound: 0,
    role: 'researcher',
    outputKind: 'search_strategy',
    status: 'completed',
    instruction: '按研究目标写出检索策略',
    skillIds: [],
    skillHash: 'hash',
    toolNames: [],
    inputArtifactIds: [],
    outputArtifactIds: [],
    policy: {
      projectId: 'p1',
      stage: 'discovery',
      tier: 'balanced',
      model: { kind: 'app_default' },
      maxSteps: 30,
      timeoutMs: 180000
    },
    providerId: null,
    modelId: null,
    modelVersion: null,
    error: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    startedAt: null,
    endedAt: null,
    ...overrides
  };
}

function artifact(overrides = {}) {
  return {
    id: 'a1',
    projectId: 'p1',
    stage: 'discovery',
    kind: 'search_strategy',
    title: '检索策略 v1',
    path: null,
    status: 'draft',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides
  };
}

function plan(overrides = {}) {
  return rules.currentNextAction({
    workflow: overrides.workflow,
    runs: overrides.runs ?? [],
    artifacts: overrides.artifacts ?? [],
    description: overrides.description ?? '研究目标',
    instructionDraft: overrides.instructionDraft,
    projectWritable: overrides.projectWritable ?? true
  });
}

/* ------------------------------------------------------------------ */
/* 分组与只读规则                                                       */
/* ------------------------------------------------------------------ */

test('the six groups keep their stage membership and tabs', () => {
  assert.deepEqual(
    rules.RESEARCH_STAGE_GROUPS.map((group) => [group.id, group.stages.length]),
    [
      ['discover', 3],
      ['plan', 2],
      ['experiment', 2],
      ['write', 3],
      ['publish', 1],
      ['settings', 0]
    ]
  );
  const mapped = rules.RESEARCH_STAGE_GROUPS.flatMap((group) => group.stages);
  assert.deepEqual(mapped, ALL_STAGES, 'every one of the 11 stages belongs to exactly one group');
});

test('stageGroupForStage maps every stage, and null falls back to the first group', () => {
  assert.equal(rules.stageGroupForStage('discovery'), 'discover');
  assert.equal(rules.stageGroupForStage('reading'), 'discover');
  assert.equal(rules.stageGroupForStage('experiment'), 'experiment');
  assert.equal(rules.stageGroupForStage('review'), 'write');
  assert.equal(rules.stageGroupForStage('export'), 'publish');
  assert.equal(rules.stageGroupForStage(null), 'discover');
});

test('the settings group is never "current" and is always writable', () => {
  assert.equal(rules.isCurrentStageGroup('settings', 'discovery'), false);
  assert.equal(rules.isCurrentStageGroup('discover', 'discovery'), true);
  assert.equal(rules.isCurrentStageGroup('discover', 'retrieval'), true);
  assert.equal(rules.isCurrentStageGroup('plan', 'retrieval'), false);
  assert.equal(rules.stageGroupWriteAllowed('settings', null, undefined), true);
});

test('a non-current stage group is read-only, whatever its stage status says', () => {
  assert.equal(rules.stageGroupWriteAllowed('plan', 'discovery', 'ready'), false);
  assert.equal(rules.stageGroupWriteAllowed('discover', 'discovery', 'ready'), true);
});

test('writes are allowed only in the running states of the current stage', () => {
  const writable = ['ready', 'running', 'paused', 'waiting_approval', 'failed'];
  const readOnly = ['locked', 'blocked', 'completed'];
  for (const status of [...writable, ...readOnly]) {
    assert.equal(
      rules.stageGroupWriteAllowed('discover', 'discovery', status),
      writable.includes(status),
      `status ${status}`
    );
  }
  assert.equal(rules.stageGroupWriteAllowed('discover', 'discovery', undefined), false);
});

test('an archived project is not writable', () => {
  assert.equal(rules.isProjectWritable(null), false);
  assert.equal(rules.isProjectWritable({ status: 'archived' }), false);
  assert.equal(rules.isProjectWritable({ status: 'paused' }), true);
  assert.equal(rules.isProjectWritable({ status: 'completed' }), true);
});

/* ------------------------------------------------------------------ */
/* 下一步：状态 × 闸门 矩阵                                             */
/* ------------------------------------------------------------------ */

test('ready → start, with the stage-specific label', () => {
  const wf = workflow('discovery', { discovery: stageState('discovery', 'ready') });
  assert.equal(plan({ workflow: wf }).primary.label, '开始发现：写出检索策略');
  assert.equal(plan({ workflow: wf }).primary.testId, 'workflow-start-run');

  const retrieval = workflow('retrieval', { retrieval: stageState('retrieval', 'ready') });
  assert.equal(plan({ workflow: retrieval }).primary.label, '开始检索：文献集');
});

test('running with an in-flight run → status sentence + secondary cancel, never two primaries', () => {
  const wf = workflow('discovery', { discovery: stageState('discovery', 'running') });
  const active = run({ status: 'running', endedAt: null });
  const result = plan({ workflow: wf, runs: [active] });
  assert.equal(result.statusLine, '正在写出检索策略');
  assert.equal(result.primary, null);
  assert.deepEqual(result.secondary.map((button) => button.label), ['取消运行']);
  assert.equal(result.secondary[0].command.type, 'cancel');
  assert.equal(result.secondary[0].command.runId, 'run1');
});

test('running without a run yet still shows the running sentence (queued counts as in flight)', () => {
  const wf = workflow('retrieval', { retrieval: stageState('retrieval', 'running') });
  const result = plan({ workflow: wf, runs: [run({ stage: 'retrieval', status: 'queued', endedAt: null })] });
  assert.equal(result.statusLine, '正在准备文献集');
  assert.equal(result.primary, null);
  assert.equal(result.secondary.length, 1);
});

test('waiting_approval with a gate → 确认通过 + 退回修改', () => {
  const wf = workflow('retrieval', { retrieval: stageState('retrieval', 'waiting_approval', { artifactIds: ['a1'] }) });
  const result = plan({ workflow: wf, artifacts: [artifact({ stage: 'retrieval', id: 'a1', title: '文献集 v1' })] });
  assert.equal(result.primary.label, '确认通过');
  assert.equal(result.primary.command.type, 'approve');
  assert.deepEqual(result.secondary.map((button) => button.label), ['退回修改']);
  assert.equal(result.summaryLine, '文献集 v1');
});

test('waiting_approval on the review stage demands an explicit verdict', () => {
  const wf = workflow('review', { review: stageState('review', 'waiting_approval') });
  const result = plan({ workflow: wf });
  assert.equal(result.primary.label, '接受稿件');
  assert.deepEqual(result.primary.command, { type: 'approve', reviewDecision: 'accept' });
  assert.deepEqual(result.secondary.map((button) => button.label), ['退回修改', '要求修订']);
  assert.deepEqual(result.secondary[1].command, { type: 'approve', reviewDecision: 'revise' });
});

test('waiting_approval without a gate cannot happen, but is still handled as a decision', () => {
  const wf = workflow('discovery', {
    discovery: stageState('discovery', 'waiting_approval', { gateRequired: false })
  });
  const result = plan({ workflow: wf });
  assert.equal(result.primary.command.type, 'approve');
  assert.equal(result.secondary.length, 1);
});

test('gate rejection → the note becomes the detail line and the action is a retry, not a submit', () => {
  const wf = workflow('retrieval', {
    retrieval: stageState('retrieval', 'running', {
      gateApproved: false,
      lastError: '证据只覆盖了综述，请补充原始研究。其余部分无需修改。'
    })
  });
  const completed = run({ stage: 'retrieval', status: 'completed' });
  const result = plan({ workflow: wf, runs: [completed] });
  assert.equal(result.detailLine, '证据只覆盖了综述，请补充原始研究。', 'first sentence only');
  assert.equal(result.primary.testId, 'workflow-retry-run');
  assert.equal(result.primary.label, '用同一阶段指令重试');
  assert.equal(result.primary.command.type, 'rerunStage', 'retryRun refuses a completed run');
  assert.equal(result.primary.command.instruction, completed.instruction, 'the same stage instruction is reused');
  assert.equal(result.primary.label.includes('立刻提交'), false);
  assert.equal(result.primary.label.includes('提交审核'), false);
  assert.equal(result.primary.label.includes('恢复阶段'), false, '「恢复阶段」 wording is banned (plan gate 2)');
});

test('a failed run → retryRun with the same instruction, and the raw code is explained', () => {
  const wf = workflow('planning', { planning: stageState('planning', 'failed', { lastError: 'research_role_output_invalid' }) });
  const failed = run({ stage: 'planning', status: 'failed', error: 'research_role_output_invalid' });
  const result = plan({ workflow: wf, runs: [failed] });
  assert.equal(result.primary.command.type, 'retry');
  assert.equal(result.primary.command.runId, 'run1');
  assert.match(result.detailLine ?? '', /结构化结果不符合契约/u);
  assert.match(result.detailLine ?? '', /research_role_output_invalid/u, 'the code stays visible');
});

test('an unknown backend code is shown verbatim instead of a generic sentence', () => {
  const wf = workflow('reading', { reading: stageState('reading', 'failed', { lastError: 'research_something_new' }) });
  const result = plan({ workflow: wf, runs: [run({ stage: 'reading', status: 'failed', error: 'research_something_new' })] });
  assert.match(result.detailLine ?? '', /research_something_new/u);
});

test('paused → retry the interrupted run, and the interruption reason is shown', () => {
  const wf = workflow('reading', { reading: stageState('reading', 'paused') });
  const cancelled = run({ stage: 'reading', status: 'cancelled', error: 'research_run_cancelled' });
  const result = plan({ workflow: wf, runs: [cancelled] });
  assert.equal(result.primary.command.type, 'retry', 'cancelled runs ARE retryable');
  // The reason is real information about what happened to the run, not a dramatic
  // "failure" banner: a pause always carries the interruption marker.
  assert.match(result.detailLine ?? '', /运行被用户取消/u);
});

test('paused with an interrupted run explains the pause marker', () => {
  const wf = workflow('reading', { reading: stageState('reading', 'paused') });
  const interrupted = run({ stage: 'reading', status: 'interrupted', error: 'research_run_paused' });
  const result = plan({ workflow: wf, runs: [interrupted] });
  assert.equal(result.primary.command.type, 'retry');
  assert.match(result.detailLine ?? '', /暂停/u);
});

test('paused with no run at all → rerunStage (nothing to retry against)', () => {
  const wf = workflow('reading', { reading: stageState('reading', 'paused') });
  const result = plan({ workflow: wf });
  assert.equal(result.primary.command.type, 'rerunStage');
  assert.equal(result.primary.command.instruction, '研究目标', 'falls back to the project description');
});

test('blocked → the failure reason plus a retry', () => {
  const wf = workflow('experiment', { experiment: stageState('experiment', 'blocked', { lastError: 'research_run_timeout' }) });
  const result = plan({ workflow: wf });
  assert.equal(result.primary.testId, 'workflow-retry-run');
  assert.match(result.detailLine ?? '', /超时上限/u);
});

test('running with a finished gate-required output → 提交审核 (the transient pre-gate moment)', () => {
  const wf = workflow('retrieval', {
    retrieval: stageState('retrieval', 'running', { artifactIds: ['a1'] })
  });
  const result = plan({
    workflow: wf,
    runs: [run({ stage: 'retrieval' })],
    artifacts: [artifact({ stage: 'retrieval', id: 'a1' })]
  });
  assert.equal(result.primary.label, '提交审核');
  assert.equal(result.primary.command.type, 'complete');
});

test('running with a finished output on a gate-free stage → 完成<阶段>，进入<下一阶段>', () => {
  const wf = workflow('discovery', {
    discovery: stageState('discovery', 'running', { artifactIds: ['a1'] })
  });
  const result = plan({
    workflow: wf,
    runs: [run({ stage: 'discovery' })],
    artifacts: [artifact({ id: 'a1' })]
  });
  assert.equal(result.primary.label, '完成发现，进入检索');
  assert.equal(result.primary.command.type, 'complete');
  assert.equal(result.summaryLine, '检索策略 v1');
});

test('completed → no action at all when the workflow is over', () => {
  const wf = workflow('export', { export: stageState('export', 'completed') });
  wf.projectStatus = 'completed';
  const result = plan({ workflow: wf });
  assert.equal(result.primary, null);
  assert.equal(result.secondary.length, 0);
  assert.match(result.detailLine ?? '', /已完成/u);
});

test('locked → read-only, with the reason, and no primary action', () => {
  const wf = workflow('discovery', { discovery: stageState('discovery', 'ready') });
  const result = plan({ workflow: wf });
  // `discovery` is ready here, so assert against a genuinely locked current stage.
  const lockedWorkflow = workflow('reading', { reading: stageState('reading', 'locked') });
  const lockedResult = plan({ workflow: lockedWorkflow });
  assert.equal(lockedResult.primary, null);
  assert.match(lockedResult.detailLine ?? '', /上一阶段还没有完成/u);
  assert.notEqual(result.primary, null, 'a ready stage still has an action');
});

test('an archived project gets no primary action and says why', () => {
  const wf = workflow('discovery', { discovery: stageState('discovery', 'ready') });
  const result = plan({ workflow: wf, projectWritable: false });
  assert.equal(result.primary, null);
  assert.deepEqual(result.secondary, []);
  assert.match(result.readOnlyReason ?? '', /已归档/u);
});

test('a dirty instruction draft promotes a fresh start over re-running the failed one', () => {
  const wf = workflow('planning', {
    planning: stageState('planning', 'failed', { lastError: 'research_role_execution_failed' })
  });
  const failed = run({
    stage: 'planning',
    status: 'failed',
    error: 'research_role_execution_failed',
    instruction: '旧的阶段指令'
  });
  const dirty = plan({ workflow: wf, runs: [failed], instructionDraft: '换成新的阶段指令' });
  assert.equal(dirty.primary.command.type, 'start', 'a typed instruction must not be silently ignored');
  assert.equal(dirty.primary.label, '用当前指令重新运行');
  assert.deepEqual(
    dirty.secondary.map((button) => button.label),
    ['用同一阶段指令重试'],
    'retrying the old instruction stays available as a secondary'
  );
  // The same text as the failed run's instruction is not "dirty": gate 2 needs the retry
  // primary to survive a user who edited the box back to the original wording.
  const same = plan({ workflow: wf, runs: [failed], instructionDraft: '旧的阶段指令' });
  assert.equal(same.primary.command.type, 'retry');
});

test('an in-flight run ignores the instruction draft entirely', () => {
  const wf = workflow('discovery', { discovery: stageState('discovery', 'running') });
  const result = plan({
    workflow: wf,
    runs: [run({ status: 'running', endedAt: null })],
    instructionDraft: '下一轮要写的东西'
  });
  assert.equal(result.primary, null, 'a running stage has no primary action at all');
  assert.deepEqual(result.secondary.map((button) => button.label), ['取消运行']);
});

test('every status × gate combination yields exactly one primary or an explicit reason', () => {
  const statuses = ['locked', 'ready', 'running', 'waiting_approval', 'paused', 'blocked', 'completed', 'failed'];
  for (const status of statuses) {
    for (const gate of [true, false]) {
      const stage = gate ? 'retrieval' : 'discovery';
      const wf = workflow(stage, { [stage]: stageState(stage, status, { gateRequired: gate }) });
      const result = plan({ workflow: wf, runs: [run({ stage, status: 'completed' })] });
      assert.ok(
        result.primary !== null || result.readOnlyReason !== null || result.detailLine !== null,
        `${status} × gate=${gate} must be either actionable or explained`
      );
      if (result.primary !== null) {
        assert.equal(typeof result.primary.label, 'string');
        assert.ok(result.primary.label.trim().length > 0, `${status} × gate=${gate} label must not be empty`);
        assert.equal(
          result.primary.label.includes('恢复阶段'),
          false,
          `${status} × gate=${gate}: 「恢复阶段」 wording is banned`
        );
      }
    }
  }
});
