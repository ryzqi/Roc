import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as esbuild from 'esbuild';

/**
 * Unit tests for the management drawer's pure projections (P9/T9.1–T9.4).
 *
 * Same discipline as P6/P7/P8: each test pins a *contract* subtlety that a component would
 * otherwise re-derive and get subtly wrong, and every one of them is a place where the phase
 * text and the real backend disagree (F24):
 *
 *   - memory has **five** slots (including the project `AGENTS.md`) and no `workspace/user`;
 *   - the backend counts **code points**, so the capacity bar must not use `String.length`;
 *   - a refused memory write is a domain outcome carrying the scan findings, not an error;
 *   - a **cron** trigger carries `nextRunAt` too, so the form must collect a first fire time;
 *   - `mcpServerConfigSchema` has no args/env, so a stdio server is one command string.
 *
 * The four model modules import only types (plus the shared task-status label table), so esbuild
 * yields a dependency-free bundle.
 */

let memory;
let skill;
let mcp;
let task;
let tempDir;

before(async () => {
  tempDir = mkdtempSync(join(tmpdir(), 'roc-management-models-'));
  const entries = [
    ['memory-model', 'src/renderer/management/memory-model.ts'],
    ['skill-model', 'src/renderer/management/skill-model.ts'],
    ['mcp-model', 'src/renderer/management/mcp-model.ts'],
    ['background-task-model', 'src/renderer/management/background-task-model.ts']
  ];
  for (const [name, entry] of entries) {
    await esbuild.build({
      entryPoints: [entry],
      outfile: join(tempDir, `${name}.mjs`),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      target: 'node22',
      logLevel: 'silent'
    });
  }
  memory = await import(join(tempDir, 'memory-model.mjs'));
  skill = await import(join(tempDir, 'skill-model.mjs'));
  mcp = await import(join(tempDir, 'mcp-model.mjs'));
  task = await import(join(tempDir, 'background-task-model.mjs'));
});

after(() => {
  rmSync(tempDir, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* 记忆                                                                */
/* ------------------------------------------------------------------ */

test('the five backend slots are listed, and workspace/user is not one of them', () => {
  assert.deepEqual(
    memory.MEMORY_SLOTS.map((slot) => memory.memorySlotKey(slot.scope, slot.kind)),
    ['global:user', 'global:agents', 'global:memory', 'workspace:agents', 'workspace:memory']
  );
  assert.equal(memory.findSlot('workspace', 'user'), null);
  assert.equal(memory.findSlot('global', 'agents').virtualPath, '/memory/global/AGENTS.md');
  assert.equal(memory.findSlot('workspace', 'memory').requiresWorkspace, true);
});

test('capacity uses code points, not UTF-16 units', () => {
  assert.equal(memory.codePointCount('a😀b'), 3);
  assert.equal('a😀b'.length, 4);
  const meta = { scope: 'global', kind: 'user', exists: true, charCount: 3, charLimit: 10, absolutePath: '/memory/global/USER.md', effective: true, updatedAt: null };
  assert.equal(memory.capacityRatio(meta), 0.3);
  assert.equal(memory.capacityState(meta), 'ok');
  assert.equal(memory.capacityState({ ...meta, charCount: 9 }), 'near');
  assert.equal(memory.capacityState({ ...meta, charCount: 11 }), 'over');
  assert.equal(memory.capacityState(null), 'ok');
});

test('a slot the backend did not report is distinguishable from an empty one', () => {
  const slot = memory.findSlot('workspace', 'agents');
  assert.equal(memory.slotUnavailableReason(null, slot), '后端没有返回这个槽位。');
  // An ineffective workspace slot now means "no working directory is bound", so the reason must be
  // actionable (bind one) rather than describing a permanent wiring gap — B26 is fixed.
  const workspaceReason = memory.slotUnavailableReason(
    { scope: 'workspace', kind: 'agents', exists: false, charCount: 0, charLimit: 20000, absolutePath: '', effective: false, updatedAt: null },
    slot
  );
  assert.match(workspaceReason, /绑定工作目录/u);
  assert.doesNotMatch(workspaceReason, /B26/u);
  assert.doesNotMatch(memory.MEMORY_WORKSPACE_UNAVAILABLE_NOTE, /永远不可用|B26/u);
  assert.match(memory.MEMORY_WORKSPACE_UNAVAILABLE_NOTE, /workspaceHash/u);
  assert.equal(
    memory.slotUnavailableReason(
      { scope: 'global', kind: 'user', exists: true, charCount: 0, charLimit: 20000, absolutePath: '/memory/global/USER.md', effective: true, updatedAt: null },
      memory.findSlot('global', 'user')
    ),
    null
  );
});

test('a refused write is a domain outcome and carries the scan findings', () => {
  const blocked = memory.describeWriteOutcome({
    ok: false,
    reason: 'security_scan',
    detail: '发现 1 处凭据',
    issues: [{ category: 'credential', pattern: 'sk-[A-Za-z0-9]+', matchExcerpt: 'sk-live-abc' }]
  });
  assert.equal(blocked.status, 'blocked');
  assert.match(blocked.message, /安全扫描/);
  assert.equal(blocked.issues.length, 1);
  assert.equal(blocked.issues[0].category, 'credential');

  const capacity = memory.describeWriteOutcome({
    ok: false,
    reason: 'capacity_exceeded',
    detail: '超出上限',
    chars: 21000,
    limit: 20000
  });
  assert.match(capacity.message, /21,000 \/ 20,000 字符/);

  const saved = memory.describeWriteOutcome({
    ok: true,
    meta: { scope: 'global', kind: 'user', exists: true, charCount: 12, charLimit: 20000, absolutePath: '/memory/global/USER.md', effective: true, updatedAt: null }
  });
  assert.equal(saved.status, 'saved');
  assert.match(saved.message, /已写入 \/memory\/global\/USER\.md/);
});

test('the outline is a projection of the text: ATX headings only, fences skipped', () => {
  const text = ['# 标题', '正文', '```sh', '# 注释不是标题', '```', '## 二级', '#### 四级'].join('\n');
  const outline = memory.outlineFromMarkdown(text);
  assert.deepEqual(
    outline.map((entry) => [entry.level, entry.title, entry.line]),
    [
      [1, '标题', 1],
      [2, '二级', 6],
      [4, '四级', 7]
    ]
  );
  // The offset points at the heading's line start, so the editor can select it.
  assert.equal(text.slice(outline[1].offset, outline[1].offset + 5), '## 二级');
  assert.deepEqual(memory.outlineFromMarkdown('没有标题'), []);
});

test('the snapshot preview is matched by virtual path, and the assist prompt asks for a draft', () => {
  const slot = memory.findSlot('global', 'user');
  const preview = '# DeepAgents Memory Preview\n\n## /memory/global/USER.md\n\n- 用中文回答';
  assert.equal(memory.snapshotIncludesSlot(preview, slot), true);
  assert.equal(memory.snapshotIncludesSlot(preview, memory.findSlot('global', 'memory')), false);

  const prompt = memory.buildMemoryAssistPrompt(slot, '- 用中文回答');
  assert.match(prompt, /\/memory\/global\/USER\.md/);
  assert.match(prompt, /只输出 Markdown 正文/);
  assert.match(prompt, /- 用中文回答/);
  assert.match(memory.buildMemoryAssistPrompt(slot, '   '), /（当前是空的）/);
});

test('every auto-memory audit action and candidate type has a label', () => {
  for (const action of ['accepted', 'rejected', 'duplicate_skipped', 'conflict_rejected', 'maintenance_merged', 'maintenance_deleted', 'write_failed']) {
    assert.equal(typeof memory.autoMemoryActionLabels[action], 'string');
  }
  for (const type of ['user_preference', 'workspace_fact', 'decision', 'pitfall', 'verification', 'transient_task_result']) {
    assert.equal(typeof memory.autoMemoryTypeLabels[type], 'string');
  }
  assert.match(
    memory.auditRecordLine({
      id: 'a1',
      createdAt: '2026-10-16T00:00:00.000Z',
      action: 'duplicate_skipped',
      type: 'user_preference',
      confidence: 'high',
      key: 'k',
      summary: '重复的偏好',
      sourceRunId: 'r1',
      reason: 'duplicate',
      workspacePath: null,
      targetPath: null
    }),
    /重复，跳过 · 用户偏好 · 高 · 重复的偏好/
  );
});

/* ------------------------------------------------------------------ */
/* 技能                                                                */
/* ------------------------------------------------------------------ */

test('skills sort enabled-first then by name, and the summary counts invalids', () => {
  const skills = [
    { id: 'b', name: 'Bravo', enabled: false, path: '/x/b', description: '', status: 'ready' },
    { id: 'a', name: 'Alpha', enabled: true, path: '/x/a', description: '', status: 'ready' },
    { id: 'c', name: 'Charlie', enabled: true, path: '/x/c', description: '', status: 'invalid' }
  ];
  assert.deepEqual(
    skill.sortSkills(skills).map((entry) => entry.id),
    ['a', 'c', 'b']
  );
  assert.equal(skill.skillSummary(skills), '3 个技能 · 2 个已启用 · 1 个无效');
  assert.equal(skill.skillSummary([]), '0 个技能 · 0 个已启用');
});

test('the import path must be absolute, because the backend resolves it against the cwd', () => {
  assert.equal(skill.validateSkillImportPath('/Users/me/skill'), null);
  assert.equal(skill.validateSkillImportPath(''), null);
  assert.match(skill.validateSkillImportPath('./skill'), /绝对路径/);
  assert.match(skill.validateSkillImportPath('/a\u0000b'), /空字符/);
  assert.match(skill.validateSkillImportPathRequired('   '), /先填/);
  assert.equal(skill.validateSkillImportPathRequired('/abs/dir'), null);
});

test('tree paths join and split the way the backend returns them', () => {
  assert.equal(skill.joinRelativePath('', 'SKILL.md'), 'SKILL.md');
  assert.equal(skill.joinRelativePath('scripts/', 'run.py'), 'scripts/run.py');
  assert.equal(skill.parentRelativePath('scripts/run.py'), 'scripts');
  assert.equal(skill.parentRelativePath('SKILL.md'), '');
  assert.deepEqual(skill.pathSegments('a/b/c.md'), ['a', 'b', 'c.md']);
  assert.deepEqual(skill.pathSegments(''), []);
});

test('directories sort first, then names', () => {
  const entries = [
    { name: 'z.md', relativePath: 'z.md', type: 'file', size: 1, updatedAt: 'x' },
    { name: 'scripts', relativePath: 'scripts', type: 'directory', size: 0, updatedAt: 'x' },
    { name: 'a.md', relativePath: 'a.md', type: 'file', size: 1, updatedAt: 'x' }
  ];
  assert.deepEqual(
    skill.sortEntries(entries).map((entry) => entry.name),
    ['scripts', 'a.md', 'z.md']
  );
});

test('image previews arrive as data URLs and markdown is recognised by extension', () => {
  const base = { id: 's', relativePath: 'assets/diagram.png', content: 'data:image/png;base64,AAA', truncated: false, sizeBytes: 3 };
  assert.equal(skill.filePreviewKind({ ...base, kind: 'image', mediaType: 'image/png' }), 'image');
  assert.equal(skill.filePreviewKind({ ...base, kind: 'binary' }), 'binary');
  assert.equal(skill.filePreviewKind({ ...base, kind: 'text', relativePath: 'SKILL.md' }), 'markdown');
  assert.equal(skill.filePreviewKind({ ...base, kind: 'text', relativePath: 'scripts/run.py' }), 'text');
  assert.equal(skill.previewSizeLabel({ ...base, kind: 'text', relativePath: 'a.md' }), '3 B');
  assert.match(skill.previewSizeLabel({ ...base, kind: 'text', relativePath: 'a.md', truncated: true }), /已截断/);
  assert.match(skill.previewTruncatedNote({ ...base, kind: 'text', relativePath: 'a.md', truncated: true }), /截断/);
  assert.equal(skill.previewTruncatedNote({ ...base, kind: 'text', relativePath: 'a.md' }), null);
  assert.match(skill.SKILL_FIELD_NOTE, /没有分类与版本字段/);
  assert.match(skill.LICENSE_BOUNDARY_NOTE, /CC BY-NC 4\.0/);
});

/* ------------------------------------------------------------------ */
/* MCP                                                                 */
/* ------------------------------------------------------------------ */

test('a stdio server needs a command and an http server needs a parseable http(s) URL', () => {
  const base = mcp.emptyMcpDraft();
  assert.deepEqual(
    mcp.validateMcpDraft({ ...base, id: 'x', name: 'X' }).map((issue) => issue.field),
    ['command']
  );
  assert.equal(mcp.issueFor(mcp.validateMcpDraft({ ...base, id: 'x', name: 'X', command: 'npx -y server' }), 'command'), null);

  const http = { ...base, id: 'y', name: 'Y', transport: 'http', url: 'not a url' };
  assert.match(mcp.issueFor(mcp.validateMcpDraft(http), 'url'), /合法的绝对地址/);
  assert.match(mcp.issueFor(mcp.validateMcpDraft({ ...http, url: 'ftp://host/mcp' }), 'url'), /http 或 https/);
  assert.equal(mcp.issueFor(mcp.validateMcpDraft({ ...http, url: 'https://mcp.example.test/mcp' }), 'url'), null);
});

test('the id pattern is stricter than the schema on purpose (it lands in tool names)', () => {
  const draft = { ...mcp.emptyMcpDraft(), id: 'has space', name: 'X', command: 'run' };
  assert.match(mcp.issueFor(mcp.validateMcpDraft(draft), 'id'), /只允许字母、数字、点、下划线和短横线/);
  assert.equal(mcp.issueFor(mcp.validateMcpDraft({ ...draft, id: 'ok-id_1' }), 'id'), null);
  assert.match(mcp.issueFor(mcp.validateMcpDraft({ ...draft, id: '' }), 'id'), /不能为空/);
});

test('draft → config keeps preset, clears the other transport field, and splits tool lines', () => {
  const existing = {
    id: 'exa-hosted',
    name: 'Exa Hosted MCP',
    enabled: false,
    transport: 'http',
    preset: true,
    riskLevel: 'medium',
    url: 'https://mcp.exa.ai/mcp',
    allowedTools: ['web_search_exa']
  };
  const stdioDraft = {
    ...mcp.draftFromServer(existing),
    transport: 'stdio',
    command: '/usr/bin/server',
    allowedToolsText: 'a\n\nb\n'
  };
  const config = mcp.toServerConfig(stdioDraft, existing);
  assert.equal(config.preset, true);
  assert.equal(config.command, '/usr/bin/server');
  assert.equal(config.url, undefined);
  assert.deepEqual(config.allowedTools, ['a', 'b']);

  const httpConfig = mcp.toServerConfig({ ...stdioDraft, transport: 'http', url: 'https://x.test/mcp' }, null);
  assert.equal(httpConfig.preset, false);
  assert.equal(httpConfig.command, undefined);
  assert.equal(httpConfig.url, 'https://x.test/mcp');

  assert.match(
    mcp.issueFor(mcp.validateMcpDraft({ ...mcp.emptyMcpDraft(), id: 'x', name: 'X', command: 'run', allowedToolsText: 'a\na' }), 'allowedToolsText'),
    /重复/
  );
});

test('per-server tool names come from the capability preview manifest, not from the snapshot', () => {
  const preview = {
    builtInTools: ['read_file'],
    toolCards: [],
    skillCards: [],
    subagents: [],
    manifest: {
      tools: [
        { provenance: { kind: 'builtin', source: 'roc' }, modelVisibleName: 'read_file', riskLevel: 'low', approvalPolicy: { kind: 'none' }, executionScopes: ['main'], effectClass: 'none' },
        { provenance: { kind: 'mcp', serverId: 'exa-hosted' }, modelVisibleName: 'web_search_exa', riskLevel: 'medium', approvalPolicy: { kind: 'required' }, executionScopes: ['main'], effectClass: 'external_call' },
        { provenance: { kind: 'mcp', serverId: 'other' }, modelVisibleName: 'other_tool', riskLevel: 'high', approvalPolicy: { kind: 'required' }, executionScopes: ['main'], effectClass: 'external_call' }
      ],
      skippedCapabilities: [{ id: 'ghost', type: 'mcp_server', reason: 'disabled' }]
    }
  };
  const tools = mcp.manifestToolsForServer(preview, 'exa-hosted');
  assert.deepEqual(tools.map((tool) => tool.name), ['web_search_exa']);
  assert.equal(tools[0].approval, 'required');
  assert.deepEqual(mcp.builtInTools(preview), ['read_file']);
  assert.deepEqual(mcp.skippedCapabilities(preview), [{ id: 'ghost', type: 'MCP 服务', reason: '未启用' }]);
  assert.match(mcp.previewSummary(preview), /内置工具 1 个 · MCP 工具 0 个/);
  assert.match(mcp.previewSummary(null), /尚未读取/);
});

/* ------------------------------------------------------------------ */
/* 后台定时任务                                                        */
/* ------------------------------------------------------------------ */

function validDraft(overrides = {}) {
  return {
    ...task.emptyTaskDraft(),
    goal: '每天检查构建',
    triggerDescription: '每天 09:00',
    firstRunAt: '2999-01-01T09:00',
    cronExpression: '0 9 * * *',
    ...overrides
  };
}

test('a cron trigger also carries nextRunAt, so the form must collect a first fire time', () => {
  const trigger = task.triggerFromDraft(validDraft({ triggerType: 'cron' }));
  assert.equal(trigger.type, 'cron');
  assert.equal(trigger.cronExpression, '0 9 * * *');
  assert.equal(typeof trigger.nextRunAt, 'string');
  assert.match(trigger.nextRunAt, /Z$/u);

  const once = task.triggerFromDraft(validDraft({ triggerType: 'once' }));
  assert.equal(once.type, 'once');
  assert.equal(once.cronExpression, undefined);

  const manual = task.triggerFromDraft(validDraft({ triggerType: 'manual' }));
  assert.deepEqual(manual, { type: 'manual', description: '每天 09:00' });
  assert.equal(manual.nextRunAt, undefined);
});

test('the once/cron time must parse and be in the future', () => {
  assert.equal(task.taskIssueFor(task.validateTaskDraft(validDraft({ triggerType: 'cron' }), '/ws'), 'firstRunAt'), null);
  assert.match(
    task.taskIssueFor(task.validateTaskDraft(validDraft({ triggerType: 'once', firstRunAt: '' }), '/ws'), 'firstRunAt'),
    /一次触发需要时间/
  );
  assert.match(
    task.taskIssueFor(task.validateTaskDraft(validDraft({ triggerType: 'cron', firstRunAt: '2020-01-01T00:00' }), '/ws'), 'firstRunAt'),
    /晚于现在/
  );
  // A manual trigger ignores the field entirely.
  assert.equal(task.validateTaskDraft(validDraft({ triggerType: 'manual', firstRunAt: '' }), '/ws').length, 0);
});

test('the cron field count mirrors the backend message, and the schedule is never computed', () => {
  const issue = task.taskIssueFor(task.validateTaskDraft(validDraft({ triggerType: 'cron', cronExpression: '0 9 * *' }), '/ws'), 'cronExpression');
  assert.match(issue, /五段标准 cron 表达式/);
  assert.match(issue, /当前 4 段/);
  assert.equal(task.taskIssueFor(task.validateTaskDraft(validDraft({ triggerType: 'cron' }), '/ws'), 'cronExpression'), null);
  const request = task.toPreviewRequest(validDraft({ triggerType: 'cron' }), '/ws');
  // The request carries the expression and the first fire time; nothing derived from them.
  assert.equal(request.trigger.type, 'cron');
  assert.equal(typeof request.trigger.nextRunAt, 'string');
  assert.equal(request.workspacePath, '/ws');
  assert.equal(request.failurePolicy, 'pause_and_report');
  assert.equal(request.notificationPolicy, 'failures_and_confirmations');
});

test('goal, description and workspace are required; overlapping actions are refused', () => {
  assert.match(task.taskIssueFor(task.validateTaskDraft({ ...validDraft(), goal: ' ' }, '/ws'), 'goal'), /目标不能为空/);
  assert.match(
    task.taskIssueFor(task.validateTaskDraft({ ...validDraft(), triggerDescription: '' }, '/ws'), 'triggerDescription'),
    /触发描述不能为空/
  );
  assert.match(task.taskIssueFor(task.validateTaskDraft(validDraft(), null), 'goal'), /必须有工作目录/);
  const overlapping = validDraft({ allowedActionsText: 'npm test\nnpm lint', forbiddenActionsText: 'npm test' });
  assert.match(task.taskIssueFor(task.validateTaskDraft(overlapping, '/ws'), 'forbiddenActionsText'), /同时出现在允许与禁止/);
  assert.equal(task.taskIssueFor(task.validateTaskDraft(validDraft({ allowedActionsText: 'npm test' }), '/ws'), 'forbiddenActionsText'), null);
});

test('an ISO instant round-trips through the datetime-local field', () => {
  const local = task.toLocalDateTimeInput(new Date(2026, 9, 20, 9, 30).toISOString());
  assert.equal(local, '2026-10-20T09:30');
  assert.equal(task.toLocalDateTimeInput('not a date'), '');
});

test('the list row and the run history row are rendered from backend fields', () => {
  const recorded = {
    id: 't1',
    threadId: 'th1',
    runId: 'r1',
    goal: '每天检查构建',
    status: 'paused',
    scheduled: true,
    triggerType: 'cron',
    triggerDescription: '每天 09:00',
    nextRunAt: '2026-10-17T01:00:00.000Z',
    cronExpression: '0 9 * * *',
    workspacePath: '/ws',
    allowedActions: [],
    forbiddenActions: [],
    failurePolicy: 'pause_and_report',
    notificationPolicy: 'failures_and_confirmations',
    riskLevel: 'low',
    requiresConfirmation: false,
    lastRunAt: null,
    lastRunStatus: null,
    runCount: 3,
    createdAt: '2026-10-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
    enabledCapabilities: null
  };
  const line = task.taskSummaryLine(recorded);
  assert.match(line, /已暂停/);
  assert.match(line, /每天 09:00/);
  assert.match(line, /2026-10-17T01:00:00\.000Z/);
  assert.match(line, /已运行 3 次/);

  assert.match(
    task.scheduledRunLine({ id: 'r', backgroundTaskId: 't1', taskRunId: null, scheduledAt: '2026-10-16T01:00:00.000Z', triggeredAt: null, status: 'skipped', skipReason: '上一轮还在跑' }),
    /已跳过 · 2026-10-16T01:00:00\.000Z · 上一轮还在跑/
  );
  assert.match(task.scheduledRunStatusLabels.fired, /已触发/);
  assert.equal(task.taskSummaryLine({ ...recorded, nextRunAt: null }).includes('无下次运行'), true);
});
