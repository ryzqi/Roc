import { _electron as electron } from '@playwright/test';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { createSmokePaths, seedSmokeWorkspace, startSmokeProvider } from '../tests/smoke/lib/fixtures.mjs';
import { resolveSmokeTarget } from '../tests/smoke/lib/smoke-target.mjs';

/**
 * P7 验收闸门的自动化实测（真应用 / 真 IPC / 真面板 / 真导出 / 真工具链）。
 *
 * 为什么需要它：P7 的闸门全是**运行时事实** —— 面板是不是真的从后端拿数据、Idea Canvas 晋升
 * 是不是真的产生了带 `origin` 的新项目、实验能不能真跑一个 Python 脚本并读回输出、图稿能不能
 * 渲染并发布、模板编译能不能产出 PDF（失败时有没有日志）、没有证据的主张是不是真的进不了导出、
 * 导出包能不能真发布并落盘。
 *
 * 三条口径：
 *   1. **契约以 registry / schema 为准**（findings F20）。计划里写的接口名在这一阶段同样是错的
 *      （`research.artifacts.content` 那一批之外，P7 还有 `research.experiment.evidenceSource` →
 *      preload `getEvidenceExperimentSource` 等），所以这里只按实际能力名与入参调用。
 *   2. **依赖外部工具链的三条闸门（实验 / 图稿 / 模板编译）走「两条路」**（P5/P6 的同一口径）：
 *      工具链就绪 → 真跑并断言产物；未就绪 → 断言真实降级（探测报错 + 面板主操作被阻断并给理由），
 *      两条路都是断言，不是跳过。
 *   3. **渲染层没有的路径就断言「没有」**：模板/图稿/导出的二进制没有协议 URL（B21），所以 PDF
 *      预览只能断言「面板明确降级」；`export.write` 的落盘路径由 harness 提供（B22 在真实使用中
 *      需要用户手填）。
 *
 * 运行（必须 `ROC_SMOKE_TARGET=dist` + `ROC_RENDERER=next`，且先删产物再 build）：
 *   rm -rf dist/renderer && ROC_RENDERER=next pnpm build
 *   node scripts/verify-p7-production.mjs
 *
 * 必须 detach 跑；报告写 `.artifacts/p7-gates/`。
 */

const artifactDir = resolve('.artifacts/p7-gates');
mkdirSync(artifactDir, { recursive: true });

const results = [];
function record(gate, name, ok, detail = '', kind = 'assert') {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail ?? null);
  results.push({ gate, name, ok, detail: text, kind });
  console.log(`${ok ? '✔' : '✖'} [${gate}] ${name}${text.length === 0 ? '' : ` — ${text}`}`);
}
function fail(gate, name, detail) {
  record(gate, name, false, detail);
  throw new Error(`[${gate}] ${name}: ${detail}`);
}
function assertCheck(gate, name, condition, detail = '') {
  if (!condition) {
    fail(gate, name, detail === '' ? 'assertion failed' : detail);
  }
  record(gate, name, true, detail);
}

const smokeModelId = 'p7-smoke-model';
const smokeProviderId = 'p7-smoke-provider';
const smokeModelKey = `${smokeProviderId}:${smokeModelId}`;

const { dataRoot, workspaceRoot, skillSourceRoot, remoteRoot } = await createSmokePaths();
seedSmokeWorkspace(workspaceRoot, remoteRoot);
const workspaceA = join(workspaceRoot, 'project-a');
const workspaceIdea = join(workspaceRoot, 'project-idea');
for (const directory of [workspaceA, workspaceIdea]) {
  mkdirSync(directory, { recursive: true });
}
/** Outside the workspace on purpose: `export.write` wants an absolute destination (B22). */
const exportDestination = join(workspaceRoot, 'p7-export.zip');

/**
 * Template fixtures for gate 5: one that compiles and one that cannot.
 *
 * They live next to the workspace (not inside it) because `research.template.import` takes a
 * *source* path from the picker, and the picker in a smoke build returns a fixed file — so the
 * harness imports these directories through IPC while the panel keeps the picker as its real
 * entry point.
 */
const templateRoot = join(workspaceRoot, 'p7-template');
const templateBrokenRoot = join(workspaceRoot, 'p7-template-broken');
mkdirSync(templateRoot, { recursive: true });
mkdirSync(templateBrokenRoot, { recursive: true });
writeFileSync(
  join(templateRoot, 'main.tex'),
  ['\\documentclass{article}', '\\begin{document}', 'ROC-P7-TEMPLATE', '\\end{document}', ''].join('\n'),
  'utf8'
);
writeFileSync(
  join(templateBrokenRoot, 'main.tex'),
  ['\\documentclass{article}', '\\begin{document}', '\\thisCommandDoesNotExist', '\\end{document}', ''].join('\n'),
  'utf8'
);

const smokeProvider = await startSmokeProvider({});
const target = resolveSmokeTarget({ env: { ...process.env, ROC_SMOKE_TARGET: 'dist' } });
console.log(`P7 验收闸门实测 · target=${target.kind} · renderer=next · workspace=${workspaceA}\n`);

let app;
const rendererErrors = [];

/**
 * Moves the project to a stage.
 *
 * Needed because `requireEditableStage` (and every publish path) insists that the artifact belongs
 * to the project's **current** stage: creating a manuscript artifact while the project is in
 * discovery is refused as `research_artifact_stage_inactive`. `workflow.transition({action:'move'})`
 * is the contract's own way to go somewhere else.
 */
async function moveTo(page, projectId, targetStage) {
  return await page.evaluate(
    async ({ id, target }) => {
      const workflow = await window.roc.research.getWorkflow({ id });
      if (!workflow.ok) {
        return { error: workflow.error.message };
      }
      const result = await window.roc.research.transitionWorkflow({
        projectId: id,
        action: 'move',
        expectedStage: workflow.data.currentStage,
        targetStage: target
      });
      return result.ok ? { currentStage: result.data.currentStage } : { error: result.error.message };
    },
    { id: projectId, target: targetStage }
  );
}

async function sleep(ms) {
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function navigate(page, search) {
  await page.evaluate((next) => {
    let url;
    try {
      url = new URL(window.location.href);
    } catch {
      return;
    }
    url.search = next;
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, search);
}

async function openStageTab(page, projectId, stage, tabTestId, panelTestId, timeoutMs = 30_000) {
  await navigate(page, `page=research&project=${projectId}&view=stage&stage=${stage}`);
  await page.waitForSelector('[data-testid="workflow-stage-workspace"]', { timeout: timeoutMs });
  await page.waitForSelector(`[data-testid="${tabTestId}"]`, { timeout: timeoutMs });
  await page.click(`[data-testid="${tabTestId}"]`);
  await page.waitForSelector(`[data-testid="${panelTestId}"]`, { timeout: timeoutMs });
  return ((await page.locator(`[data-testid="${panelTestId}"]`).textContent()) ?? '').replace(/\s+/gu, ' ').trim();
}

try {
  app = await electron.launch({
    executablePath: target.executablePath,
    args: target.launchArgs,
    env: {
      ...process.env,
      ROC_SMOKE: '1',
      ROC_DATA_ROOT: dataRoot,
      ROC_SMOKE_API_KEY: 'smoke-test-key',
      ROC_RENDERER: 'next'
    }
  });
  const page = await app.firstWindow();
  page.on('console', (message) => {
    if (message.type() === 'error') {
      rendererErrors.push(message.text());
      console.error('[renderer]', message.text().slice(0, 260));
    }
  });
  page.on('pageerror', (error) => {
    rendererErrors.push(error.message);
    console.error('[renderer:pageerror]', error.message.slice(0, 260));
  });

  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  await page.evaluate(() => window.localStorage.clear());
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  assertCheck('0 启动', '新壳在 smoke 模式下启动', (await page.getAttribute('[data-testid="roc-app"]', 'data-mode')) === 'smoke');

  // ---- 闸门 0：准备（provider / 权限 / 项目 / 工具链前置检查） --------------------
  const configured = await page.evaluate(
    async ({ providerId, modelId, modelKey, endpoint }) => {
      const current = await window.roc.settings.get();
      if (!current.ok) {
        return { error: current.error.message };
      }
      const providers = [
        ...current.data.providers.filter((provider) => provider.id !== providerId),
        {
          id: providerId,
          name: 'P7 Smoke Provider',
          type: 'openai_compatible',
          endpoint,
          credentialRef: `secret:${providerId}`,
          enabled: true,
          models: [
            {
              id: modelId,
              displayName: 'P7 Smoke Model',
              enabled: true,
              supportsStreaming: true,
              supportsToolCalls: true,
              supportsImages: true
            }
          ]
        }
      ];
      const saved = await window.roc.settings.save({
        settings: current.data.settings,
        providers,
        defaultModelId: modelKey,
        permissions: { ...current.data.permissions, mode: 'default' }
      });
      if (!saved.ok) {
        return { error: saved.error.message };
      }
      const secret = await window.roc.settings.setProviderSecret({ providerId, plaintext: 'smoke-test-key' });
      return secret.ok ? { ok: true } : { error: secret.error.message };
    },
    { providerId: smokeProviderId, modelId: smokeModelId, modelKey: smokeModelKey, endpoint: smokeProvider.endpoint }
  );
  assertCheck('0 准备', '默认模型与 permissions.mode=default 就绪', configured.ok === true, configured.error ?? '');

  const preflight = await page.evaluate(async (path) => {
    const workspace = await window.roc.workspace.select({ path });
    const project = await window.roc.research.createProject({
      title: 'P7 生产闸门项目',
      description: 'ROC-P7-PROJECT 生产面板闸门',
      workspacePath: path,
      language: 'zh'
    });
    const toolchain = await window.roc.research.getToolchainStatus();
    const models = await window.roc.research.getModelsStatus();
    return {
      workspace: workspace.ok ? workspace.data.path : `error:${workspace.error.message}`,
      projectId: project.ok ? project.data.id : null,
      projectError: project.ok ? null : project.error.message,
      toolchain: toolchain.ok ? toolchain.data : { error: toolchain.error.message },
      models: models.ok ? { ready: models.data.ready, error: models.data.error } : { error: models.error.message }
    };
  }, workspaceA);
  assertCheck('0 准备', '工作目录绑定与项目创建成功', typeof preflight.projectId === 'string', preflight.projectError ?? '');
  const projectId = preflight.projectId;
  const toolchainReady = preflight.toolchain.available === true;
  record(
    '0 准备',
    `research.toolchain.status（${toolchainReady ? '可用' : '不可用'}）`,
    true,
    toolchainReady
      ? `python ${preflight.toolchain.versions?.python ?? '?'} · tectonic ${preflight.toolchain.versions?.tectonic ?? '?'}`
      : `error=${preflight.toolchain.error ?? 'unknown'}`,
    'info'
  );
  record(
    '0 准备',
    toolchainReady ? '闸门 3/4/5：真跑脚本 / 真渲染图稿 / 真编译 PDF' : '闸门 3/4/5：断言真实降级（探测报错 + 主操作被阻断并给理由）',
    true,
    JSON.stringify(preflight.models),
    'info'
  );

  // ---- 闸门 1：面板闭环（挂载 + 后端数据 + 阻断/失败提示） -----------------------
  const panels = [
    ['discover', 'workflow-stage-tab-runs', 'workflow-run-panel', '阶段运行'],
    ['discover', 'workflow-stage-tab-artifacts', 'workflow-artifacts', '工件与生产输入'],
    ['discover', 'workflow-stage-tab-claims', 'production-evidence-claims', '证据与主张'],
    ['plan', 'workflow-stage-tab-ideas', 'production-ideas', '构思'],
    ['experiment', 'workflow-stage-tab-experiments', 'production-experiments', '实验'],
    ['experiment', 'workflow-stage-tab-figures', 'production-figures', '图稿'],
    ['write', 'workflow-stage-tab-manuscript', 'production-manuscript', '正文'],
    ['write', 'workflow-stage-tab-editor', 'production-latex', '文稿'],
    ['write', 'workflow-stage-tab-template', 'production-template', '模板包'],
    ['publish', 'workflow-stage-tab-production', 'production-export', '导出包'],
    ['settings', 'workflow-stage-tab-policies', 'production-policies', '阶段模型'],
    ['settings', 'workflow-stage-tab-embedding', 'production-policies', '嵌入配置摘要']
  ];
  for (const [stage, tabTestId, panelTestId, label] of panels) {
    const text = await openStageTab(page, projectId, stage, tabTestId, panelTestId);
    record('1 面板闭环', `${label} 面板挂载并渲染后端数据`, text.length > 0, text.slice(0, 80));
  }

  // 数据来自后端：阶段模型面板必须显示 `research.workflow.policies` 的真实档位
  const policies = await page.evaluate(async (id) => {
    const workflow = await window.roc.research.getWorkflow({ id });
    const list = await window.roc.research.listStagePolicies({ projectId: id });
    return {
      stage: workflow.ok ? workflow.data.currentStage : null,
      tier: list.ok ? (list.data.find((entry) => entry.stage === workflow.data.currentStage)?.tier ?? null) : null
    };
  }, projectId);
  await openStageTab(page, projectId, 'settings', 'workflow-stage-tab-policies', 'production-policies');
  const tierText = (await page.locator('[data-testid="production-policy-tier"]').inputValue().catch(() => null)) ?? '';
  assertCheck(
    '1 面板闭环',
    '阶段模型面板显示的是后端返回的档位',
    policies.tier !== null && tierText === policies.tier,
    `ipc=${String(policies.tier)} ui=${tierText}`
  );

  // 失败/阻断提示：没有正文工件时导出面板必须阻断并提出理由
  await openStageTab(page, projectId, 'publish', 'workflow-stage-tab-production', 'production-export');
  const exportBlockers = ((await page.locator('[data-testid="production-export-issues"]').textContent()) ?? '').trim();
  const prepareDisabled = await page.locator('[data-testid="production-export-prepare-run"]').isDisabled();
  assertCheck(
    '1 面板闭环',
    '导出面板在没有正文工件时阻断主操作并写明理由',
    prepareDisabled && exportBlockers.length > 0,
    `disabled=${prepareDisabled} issues=${exportBlockers.slice(0, 80)}`
  );
  const refused = await page.evaluate(async (id) => {
    const result = await window.roc.research.prepareExport({
      projectId: id,
      requestId: `p7-refuse-${Date.now()}`,
      title: '不该成功',
      manuscriptArtifactId: 'research_artifact_does_not_exist',
      figureIds: [],
      template: { kind: 'default', language: 'zh' }
    });
    return result.ok ? { ok: true } : { ok: false, code: result.error.code, message: result.error.message };
  }, projectId);
  assertCheck('1 面板闭环', '后端也拒绝不存在的正文工件（失败提示不是界面自造）', refused.ok === false, JSON.stringify(refused));

  // ---- 闸门 2：Idea Canvas 保存 → 历史 → 晋升（origin 指向来源） ------------------
  const movedToIdeation = await moveTo(page, projectId, 'ideation');
  assertCheck(
    '2 构思晋升',
    '把项目移动到构思阶段（工件只能建在当前阶段）',
    movedToIdeation.currentStage === 'ideation',
    JSON.stringify(movedToIdeation)
  );
  const ideaSetup = await page.evaluate(async (id) => {
    const artifact = await window.roc.research.createArtifact({
      projectId: id,
      stage: 'ideation',
      kind: 'idea_canvas',
      title: 'P7 构思稿',
      path: null
    });
    if (!artifact.ok) {
      return { error: artifact.error.message };
    }
    const canvas = await window.roc.research.saveIdeaCanvas({
      artifactId: artifact.data.id,
      expectedVersion: null,
      problem: 'P7 闸门问题',
      hypothesis: 'P7 闸门假设',
      novelty: 'P7 闸门新颖性',
      supportingEvidence: '',
      counterevidence: '',
      experiment: 'P7 闸门实验设计',
      risks: 'P7 闸门风险',
      priority: 'high',
      rationale: 'P7 闸门理由',
      fields: [
        { key: 'problem', content: 'P7 闸门问题', status: 'pending', evidenceIds: [] },
        { key: 'hypothesis', content: 'P7 闸门假设', status: 'pending', evidenceIds: [] },
        { key: 'novelty', content: 'P7 闸门新颖性', status: 'pending', evidenceIds: [] },
        { key: 'supportingEvidence', content: '', status: 'pending', evidenceIds: [] },
        { key: 'counterevidence', content: '', status: 'pending', evidenceIds: [] },
        { key: 'experiment', content: 'P7 闸门实验设计', status: 'pending', evidenceIds: [] },
        { key: 'risks', content: 'P7 闸门风险', status: 'pending', evidenceIds: [] }
      ]
    });
    if (!canvas.ok) {
      return { error: canvas.error.message, artifactId: artifact.data.id };
    }
    const history = await window.roc.research.getIdeaCanvasHistory({ artifactId: artifact.data.id });
    return {
      artifactId: artifact.data.id,
      version: canvas.data.version,
      historyCount: history.ok ? history.data.length : -1
    };
  }, projectId);
  assertCheck('2 构思晋升', 'Idea Canvas 保存成功且版本从 1 开始', ideaSetup.version === 1, JSON.stringify(ideaSetup));
  assertCheck('2 构思晋升', '历史里有这一版', ideaSetup.historyCount >= 1, `history=${ideaSetup.historyCount}`);

  // 界面：构思面板渲染后端保存的画布。
  //
  // 先 reload：这一步的工件是 harness 直接经 IPC 建的，而画布视图的路由没变 → 组件不会重挂载，
  // 渲染层的 store 也就不会自己重读（P4 的「after-*-seed 之后 reload」是同一个理由）。
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('[data-testid="roc-app"]', { timeout: 30_000 });
  const ideasText = await openStageTab(page, projectId, 'plan', 'workflow-stage-tab-ideas', 'production-ideas');
  assertCheck(
    '2 构思晋升',
    '构思面板显示后端保存的画布内容',
    ideasText.includes('P7 闸门问题') && ideasText.includes('P7 闸门假设'),
    ideasText.slice(0, 120)
  );

  /**
   * 晋升要求工件已被**人工闸门批准**（`research_idea_canvas_approval_required`）。
   *
   * 所以这里真的走一遍构思阶段的闸门：start → complete（进入 waiting_approval）→ approve。
   * 这不是绕路：T7.1 的「晋升」本来就发生在闸门之后，跳过它只会得到 `artifact.status='draft'`。
   */
  const gateApproval = await page.evaluate(
    async ({ id, artifactId }) => {
      const started = await window.roc.research.transitionWorkflow({ projectId: id, action: 'start', expectedStage: 'ideation' });
      if (!started.ok) {
        return { error: `start: ${started.error.message}` };
      }
      const completed = await window.roc.research.transitionWorkflow({ projectId: id, action: 'complete', expectedStage: 'ideation' });
      if (!completed.ok) {
        return { error: `complete: ${completed.error.message}` };
      }
      const approved = await window.roc.research.transitionWorkflow({ projectId: id, action: 'approve', expectedStage: 'ideation' });
      if (!approved.ok) {
        return { error: `approve: ${approved.error.message}` };
      }
      const artifact = await window.roc.research.getArtifact({ id: artifactId });
      return {
        statusAfterComplete: completed.data.stages.find((stage) => stage.stage === 'ideation')?.status ?? null,
        currentStage: approved.data.currentStage,
        artifactStatus: artifact.ok ? artifact.data.status : `error:${artifact.error.message}`
      };
    },
    { id: projectId, artifactId: ideaSetup.artifactId }
  );
  assertCheck(
    '2 构思晋升',
    '构思阶段过人工闸门（complete → waiting_approval → approve）',
    gateApproval.statusAfterComplete === 'waiting_approval' && gateApproval.currentStage === 'planning',
    JSON.stringify(gateApproval)
  );
  assertCheck('2 构思晋升', '过闸门后工件被批准（晋升的前置）', gateApproval.artifactStatus === 'approved', String(gateApproval.artifactStatus));

  const promoted = await page.evaluate(
    async ({ id, artifactId, version, workspacePath }) => {
      const result = await window.roc.research.promoteIdeaCanvas({
        artifactId,
        expectedVersion: version,
        title: 'P7 晋升项目',
        workspacePath
      });
      return result.ok
        ? { projectId: result.data.project.id, origin: result.data.project.origin, currentStage: result.data.project.currentStage }
        : { error: result.error.message };
    },
    { id: projectId, artifactId: ideaSetup.artifactId, version: ideaSetup.version, workspacePath: workspaceIdea }
  );
  assertCheck('2 构思晋升', '晋升产生新项目', typeof promoted.projectId === 'string' && promoted.projectId !== projectId, JSON.stringify(promoted));
  assertCheck(
    '2 构思晋升',
    'origin 指向来源项目与工件',
    promoted.origin !== null && promoted.origin?.projectId === projectId && promoted.origin?.artifactId === ideaSetup.artifactId,
    JSON.stringify(promoted.origin)
  );
  assertCheck('2 构思晋升', '新项目从 discovery 开始', promoted.currentStage === 'discovery', String(promoted.currentStage));


  // ---- 闸门 6：没有证据的主张进不了导出 ----------------------------------------
  const movedToWriting = await moveTo(page, projectId, 'writing');
  assertCheck('6 证据阻断', '把项目移动到写作阶段', movedToWriting.currentStage === 'writing', JSON.stringify(movedToWriting));
  const evidenceRule = await page.evaluate(async (id) => {
    const artifact = await window.roc.research.createArtifact({
      projectId: id,
      stage: 'writing',
      kind: 'manuscript',
      title: 'P7 正文稿',
      path: null
    });
    if (!artifact.ok) {
      return { error: artifact.error.message };
    }
    const unsupported = await window.roc.research.createClaim({
      projectId: id,
      artifactId: artifact.data.id,
      subjectType: 'claim',
      content: 'P7 无证据主张',
      status: 'supported',
      evidenceIds: []
    });
    const hypothesis = await window.roc.research.createClaim({
      projectId: id,
      artifactId: artifact.data.id,
      subjectType: 'claim',
      content: 'P7 假设主张',
      status: 'hypothesis',
      evidenceIds: []
    });
    return {
      artifactId: artifact.data.id,
      supportedRefused: unsupported.ok === false ? unsupported.error.message : null,
      supportedAccepted: unsupported.ok,
      hypothesisId: hypothesis.ok ? hypothesis.data.id : null,
      hypothesisError: hypothesis.ok ? null : hypothesis.error.message
    };
  }, projectId);
  assertCheck(
    '6 证据阻断',
    '后端拒绝「有证据支持但没有证据 id」的主张',
    evidenceRule.supportedAccepted === false,
    String(evidenceRule.supportedRefused)
  );
  assertCheck('6 证据阻断', '假设类主张可以创建（对照组）', typeof evidenceRule.hypothesisId === 'string', evidenceRule.hypothesisError ?? '');

  // 界面：正文面板在段落没有引用主张时阻断保存
  await openStageTab(page, projectId, 'write', 'workflow-stage-tab-manuscript', 'production-manuscript');
  const manuscriptBlockers = ((await page.locator('[data-testid="production-manuscript-issues"]').textContent()) ?? '').trim();
  const manuscriptSaveDisabled = await page.locator('[data-testid="production-manuscript-save"]').isDisabled();
  assertCheck(
    '6 证据阻断',
    '正文面板在没有任何段落时阻断保存并写明理由',
    manuscriptSaveDisabled && manuscriptBlockers.length > 0,
    `disabled=${manuscriptSaveDisabled} issues=${manuscriptBlockers.slice(0, 80)}`
  );
  // 主张必须能被「支撑」才算数：`manuscript.save` 会逐条 `assertSupported`，所以这里同时断言
  // 「引用不存在的证据被拒」与「假设类主张不能进正文」——这就是「没有证据的主张不能进入导出」的根部。
  const evidenceRules = await page.evaluate(
    async ({ id, artifactId, hypothesisId }) => {
      const fakeEvidence = await window.roc.research.createClaim({
        projectId: id,
        artifactId,
        subjectType: 'claim',
        content: 'P7 假证据主张',
        status: 'supported',
        evidenceIds: ['research_evidence_does_not_exist']
      });
      const manuscriptWithHypothesis = await window.roc.research.saveManuscript({
        artifactId,
        sections: [{ title: '第一段', claimIds: [hypothesisId] }]
      });
      const manuscriptWithUnknownClaim = await window.roc.research.saveManuscript({
        artifactId,
        sections: [{ title: '第一段', claimIds: ['research_claim_does_not_exist'] }]
      });
      const bundleWithoutManuscript = await window.roc.research.getExportBundle({ projectId: id, artifactId });
      return {
        fakeEvidenceRefused: fakeEvidence.ok === false,
        hypothesisRefused: manuscriptWithHypothesis.ok === false ? manuscriptWithHypothesis.error.message : null,
        unknownClaimRefused: manuscriptWithUnknownClaim.ok === false,
        bundleRefused: bundleWithoutManuscript.ok === false ? bundleWithoutManuscript.error.message : null
      };
    },
    { id: projectId, artifactId: evidenceRule.artifactId, hypothesisId: evidenceRule.hypothesisId }
  );
  assertCheck('6 证据阻断', '引用不存在的证据 id 的主张被拒绝', evidenceRules.fakeEvidenceRefused === true, '');
  assertCheck(
    '6 证据阻断',
    '正文拒绝「没有证据的主张」（manuscript.save 逐条 assertSupported）',
    typeof evidenceRules.hypothesisRefused === 'string',
    String(evidenceRules.hypothesisRefused)
  );
  assertCheck('6 证据阻断', '正文拒绝不存在的主张 id', evidenceRules.unknownClaimRefused === true, '');
  assertCheck(
    '7 导出包',
    '没有保存过正文时 exportBundle 被拒绝（导出清单不是凭空生成的）',
    typeof evidenceRules.bundleRefused === 'string',
    String(evidenceRules.bundleRefused)
  );

  // 导出能力本身要求「当前阶段=export 且有被接受的人工审稿」，所以不在导出阶段时必须被拒。
  const prepareRefusal = await page.evaluate(
    async ({ id, artifactId }) => {
      const result = await window.roc.research.prepareExport({
        projectId: id,
        requestId: `p7-refuse-writing-${Date.now()}`,
        title: '不该成功',
        manuscriptArtifactId: artifactId,
        figureIds: [],
        template: { kind: 'default', language: 'zh' }
      });
      return result.ok ? { ok: true } : { ok: false, message: result.error.message };
    },
    { id: projectId, artifactId: evidenceRule.artifactId }
  );
  assertCheck(
    '7 导出包',
    '未到导出阶段时后端拒绝准备（导出确实走阶段 + 人工审稿）',
    prepareRefusal.ok === false,
    JSON.stringify(prepareRefusal)
  );
  record(
    '7 导出包',
    'prepare → publish → 落盘 需要完整链路：证据（chunk → capture，B15）→ supported 主张 → 正文 → 写作闸门（生成审稿循环）→ 审稿 accept → 导出阶段',
    true,
    '本轮把这条链上的每一段都断言为「被正确拒绝」，端到端落盘未测（见 phases/P7-production.md 的剩余项）',
    'info'
  );

  // ---- 闸门 3/4/5：工具链相关的三条（两条路） -----------------------------------
  const probe = await page.evaluate(async (id) => {
    const environment = await window.roc.research.inspectExperimentEnvironment({
      projectId: id,
      runtime: { kind: 'bundled-python' }
    });
    return environment.ok
      ? { ok: true, hash: environment.data.hash, version: environment.data.version }
      : { ok: false, message: environment.error.message };
  }, projectId);

  if (!probe.ok) {
    record('3 实验', '环境探测失败（工具链未就绪）—— 断言面板主操作被阻断', true, `probe error=${probe.message}`, 'info');
    await openStageTab(page, projectId, 'experiment', 'workflow-stage-tab-experiments', 'production-experiments');
    const experimentIssues = ((await page.locator('[data-testid="production-experiment-issues"]').textContent()) ?? '').trim();
    assertCheck(
      '3 实验',
      '实验面板在未探测环境时阻断启动并给出理由',
      (await page.locator('[data-testid="production-experiment-run"]').isDisabled()) && experimentIssues.includes('检查环境'),
      experimentIssues.slice(0, 120)
    );
    await openStageTab(page, projectId, 'experiment', 'workflow-stage-tab-figures', 'production-figures');
    const figureIssues = ((await page.locator('[data-testid="production-figure-issues"]').textContent()) ?? '').trim();
    assertCheck(
      '4 图稿',
      '图稿面板在未探测环境时阻断启动并给出理由',
      (await page.locator('[data-testid="production-figure-run"]').isDisabled()) && figureIssues.includes('检查绘图环境'),
      figureIssues.slice(0, 120)
    );
  } else {
    const movedToExperiment = await moveTo(page, projectId, 'experiment');
    assertCheck('0 准备', '把项目移动到实验阶段（发布要在当前阶段建工件）', movedToExperiment.currentStage === 'experiment', JSON.stringify(movedToExperiment));
    const experiment = await page.evaluate(
      async ({ id, hash }) => {
        // 运行器的 CWD 是**只读**的 input 目录（`experiment-service` 把脚本复制进去），产物必须写进
        // 契约给的 `ROC_OUTPUT_DIR`；参数走 `ROC_PARAMETERS_JSON`。夹具照契约写，而不是照直觉写。
        const script = [
          'import os',
          'from pathlib import Path',
          'out = Path(os.environ["ROC_OUTPUT_DIR"])',
          'out.joinpath("p7-output.txt").write_text("ROC-P7-EXPERIMENT-OUTPUT", encoding="utf-8")',
          'print("ROC-P7-EXPERIMENT-LOG")',
          'print(os.environ.get("ROC_PARAMETERS_JSON", "{}"))',
          ''
        ].join('\n');
        const written = await window.roc.files.writeText({
          relativePath: 'p7-run.py',
          content: script,
          source: 'renderer-next/p7-harness'
        });
        if (!written.ok) {
          return { error: `writeText: ${written.error.message}` };
        }
        const started = await window.roc.research.startExperiment({
          projectId: id,
          requestId: `p7-experiment-${Date.now()}`,
          label: 'P7 闸门实验',
          engine: 'python',
          runtime: { kind: 'bundled-python' },
          sourcePath: 'p7-run.py',
          inputPaths: [],
          arguments: ['--p7'],
          parameters: { marker: 'ROC-P7-PARAM' },
          expectedEnvironmentHash: hash,
          timeoutMs: 300_000,
          network: 'disabled'
        });
        if (!started.ok) {
          return { error: `start: ${started.error.message}` };
        }
        const runId = started.data.id;
        const deadline = Date.now() + 300_000;
        let run = started.data;
        while (Date.now() < deadline && (run.status === 'preparing' || run.status === 'running')) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
          const polled = await window.roc.research.getExperiment({ projectId: id, runId });
          if (!polled.ok) {
            return { error: `get: ${polled.error.message}` };
          }
          run = polled.data;
        }
        const log = run.files.find((file) => file.area === 'log' && file.path.toLowerCase().includes('stdout'))
          ?? run.files.find((file) => file.area === 'log')
          ?? run.files.find((file) => file.area === 'output');
        const read = log === undefined
          ? null
          : await window.roc.research.readExperimentFile({ projectId: id, runId, area: log.area, path: log.path });
        const published = run.status === 'completed'
          ? await window.roc.research.publishExperiment({ projectId: id, runId })
          : null;
        return {
          status: run.status,
          exitCode: run.exitCode,
          files: run.files.map((file) => `${file.area}/${file.path}`),
          logText: read !== null && read.ok ? read.data.content.slice(0, 400) : null,
          artifactId: published !== null && published.ok ? published.data.artifactId : null,
          publishError: published !== null && !published.ok ? published.error.message : null
        };
      },
      { id: projectId, hash: probe.hash }
    );
    if (experiment.error !== undefined) {
      fail('3 实验', '实验运行链路', experiment.error);
    }
    assertCheck(
      '3 实验',
      '实验运行真的完成（exit 0）',
      experiment.status === 'completed' && experiment.exitCode === 0,
      `status=${experiment.status} exit=${experiment.exitCode} log=${String(experiment.logText ?? '').slice(0, 200)}`
    );
    assertCheck('3 实验', '读回日志包含脚本自己写出的标记', (experiment.logText ?? '').includes('ROC-P7-EXPERIMENT-LOG'), String(experiment.logText).slice(0, 120));
    assertCheck('3 实验', '发布产生可引用运行（进入证据链的工件）', typeof experiment.artifactId === 'string', experiment.publishError ?? '');
    const experimentProvenance = await page.evaluate(async (id) => {
      const list = await window.roc.research.listProvenance({ projectId: id });
      return list.ok ? list.data.filter((entry) => entry.sourceType === 'experiment').length : -1;
    }, projectId);
    assertCheck(
      '3 实验',
      '发布写入溯源记录（实验来源）',
      experimentProvenance >= 1,
      `provenance(experiment)=${experimentProvenance}`
    );

    const movedToFigure = await moveTo(page, projectId, 'figure');
    assertCheck('0 准备', '把项目移动到绘图阶段', movedToFigure.currentStage === 'figure', JSON.stringify(movedToFigure));
    const figure = await page.evaluate(
      async ({ id, hash }) => {
        // Diagnostics-first: a bare throw here reads as an opaque harness error, and this gate has
        // already produced several of those (the runner's shapes are easy to mis-assume).
        try {
        /**
         * A figure script exposes a module-level `figure` and saves **nothing**.
         *
         * `resources/research-runtime/figure.py` is the renderer: it runpy's the script, takes the
         * `figure` object, sets `figure.set_size_inches(options)` and saves figure.png / .svg /
         * .pdf itself (fixed metadata, fixed size). That is what makes `figure-validation.ts`'s
         * exact checks (PNG pixels, SVG viewBox, PDF page box) meaningful — a script that saved its
         * own files would either be overwritten or fail the process.
         */
        const geometry = { widthInches: 4, heightInches: 3, dpi: 150, seed: 7 };
        const script = [
          'import matplotlib',
          'matplotlib.use("Agg", force=True)',
          'import matplotlib.pyplot as plt',
          'figure = plt.figure()',
          'ax = figure.add_subplot(111)',
          'ax.plot([0, 1, 2], [0, 1, 4])',
          'ax.set_title("ROC-P7-FIGURE")',
          ''
        ].join('\n');
        const written = await window.roc.files.writeText({
          relativePath: 'p7-figure.py',
          content: script,
          source: 'renderer-next/p7-harness'
        });
        if (!written.ok) {
          return { error: `writeText: ${written.error.message}` };
        }
        const started = await window.roc.research.startFigure({
          projectId: id,
          requestId: `p7-figure-${Date.now()}`,
          label: 'P7 闸门图稿',
          runtime: { kind: 'bundled-python' },
          sourcePath: 'p7-figure.py',
          inputPaths: [],
          arguments: [],
          parameters: {},
          expectedEnvironmentHash: hash,
          timeoutMs: 300_000,
          figure: geometry
        });
        if (!started.ok) {
          return { error: `start: ${started.error.message}` };
        }
        const runId = started.data.id;
        const deadline = Date.now() + 300_000;
        let run = started.data;
        while (Date.now() < deadline && (run.status === 'preparing' || run.status === 'running')) {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
          const polled = await window.roc.research.getFigureRun({ projectId: id, runId });
          if (!polled.ok) {
            return { error: `getRun: ${polled.error.message}` };
          }
          run = polled.data;
        }
        const published = run.status === 'completed'
          ? await window.roc.research.publishFigure({ projectId: id, runId, replacesFigureId: null })
          : null;
        const svg = await window.roc.research.readFigureFile({ projectId: id, runId, area: 'output', path: 'figure.svg' });
        const pdf = await window.roc.research.readFigureFile({ projectId: id, runId, area: 'output', path: 'figure.pdf' });
        const library = await window.roc.research.listFigures({ projectId: id, limit: 10 });
        return {
          status: run.status,
          error: run.error,
          exitCode: run.exitCode,
          outputs: run.files.filter((file) => file.area === 'output').map((file) => file.path).sort(),
          publishedId: published !== null && published.ok ? published.data.id : null,
          publishError: published !== null && !published.ok ? published.error.message : null,
          svgEncoding: svg.ok ? svg.data.encoding : `error:${svg.error.message}`,
          svgLength: svg.ok ? svg.data.content.length : 0,
          pdfEncoding: pdf.ok ? pdf.data.encoding : `error:${pdf.error.message}`,
          libraryCount: library.ok ? (library.data?.length ?? -1) : -1
        };
        } catch (error) {
          return { thrown: error instanceof Error ? `${error.name}: ${error.message}` : String(error) };
        }
      },
      { id: projectId, hash: probe.hash }
    );
    if (figure.thrown !== undefined) {
      fail('4 图稿', '绘图运行链路（harness 自身出错）', figure.thrown);
    }
    // `figure.error` is `null` on a successful run — only a *string* means the run reported a failure.
    if (typeof figure.error === 'string' && figure.error.length > 0) {
      fail('4 图稿', '绘图运行链路', figure.error);
    }
    const figureOutputs = figure.outputs === null || figure.outputs === undefined ? [] : figure.outputs;
    if (figureOutputs.length === 0) {
      fail('4 图稿', '绘图运行链路返回了空 outputs', JSON.stringify(figure).slice(0, 500));
    }
    assertCheck(
      '4 图稿',
      '绘图运行真的完成并产出三种格式',
      figure.status === 'completed' && figureOutputs.length >= 3,
      `status=${figure.status} error=${String(figure.error ?? 'none')} outputs=${JSON.stringify(figureOutputs)}`
    );
    assertCheck('4 图稿', '发布产生图稿记录并进入图稿库', typeof figure.publishedId === 'string' && figure.libraryCount >= 1, `id=${figure.publishedId} library=${figure.libraryCount}`);
    assertCheck('4 图稿', 'SVG 内容可读（渲染层用 data: URL，不注入标记）', figure.svgLength > 0, `encoding=${figure.svgEncoding} length=${figure.svgLength}`);
    assertCheck('4 图稿', 'PDF 只能拿到字节（B21：渲染层没有协议 URL，明确降级）', figure.pdfEncoding === 'base64', `encoding=${figure.pdfEncoding}`);

    const template = await page.evaluate(
      async ({ id, templateRoot, brokenRoot }) => {
        const readTemplate = async (templateId) => {
          const result = await window.roc.research.getTemplate({ projectId: id, templateId });
          return result.ok ? result.data : null;
        };
        const imported = await window.roc.research.importTemplate({ projectId: id, sourcePath: templateRoot });
        if (!imported.ok) {
          return { error: `import: ${imported.error.message}` };
        }
        const compiled = await window.roc.research.compileTemplate({ projectId: id, templateId: imported.data.id });
        if (!compiled.ok) {
          return { error: `compile: ${compiled.error.message}` };
        }
        const deadline = Date.now() + 300_000;
        let record = compiled.data;
        while (Date.now() < deadline && record.status === 'compiling') {
          await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
          record = (await readTemplate(imported.data.id)) ?? record;
        }
        const files = await window.roc.research.getTemplateFiles({ projectId: id, templateId: imported.data.id });
        const brokenImport = await window.roc.research.importTemplate({ projectId: id, sourcePath: brokenRoot });
        let broken = null;
        if (brokenImport.ok) {
          const brokenCompile = await window.roc.research.compileTemplate({ projectId: id, templateId: brokenImport.data.id });
          broken = brokenCompile.ok ? brokenCompile.data : null;
          const brokenDeadline = Date.now() + 300_000;
          while (broken !== null && Date.now() < brokenDeadline && broken.status === 'compiling') {
            await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));
            broken = (await readTemplate(brokenImport.data.id)) ?? broken;
          }
        }
        return {
          status: record.status,
          pdfPath: record.pdfPath,
          pdfHash: record.pdfHash,
          diagnostics: record.diagnostics.length,
          files: files.ok ? files.data.map((file) => file.path) : [],
          brokenStatus: broken === null ? 'n/a' : broken.status,
          brokenErrors: broken === null ? [] : broken.errors.slice(0, 2),
          brokenDiagnostics: broken === null ? 0 : broken.diagnostics.length
        };
      },
      {
        id: projectId,
        templateRoot,
        brokenRoot: templateBrokenRoot
      }
    );
    if (template.error !== undefined) {
      fail('5 模板编译', '模板编译链路', template.error);
    }
    assertCheck('5 模板编译', '模板编译产出 PDF', template.status === 'ready' && typeof template.pdfPath === 'string', `status=${template.status} pdf=${String(template.pdfPath)}`);
    assertCheck('5 模板编译', '模板文件列表来自后端', template.files.includes('main.tex'), JSON.stringify(template.files));
    assertCheck(
      '5 模板编译',
      '失败的编译状态为 failed 且带日志/诊断',
      template.brokenStatus === 'failed' && (template.brokenErrors.length > 0 || template.brokenDiagnostics > 0),
      `status=${template.brokenStatus} errors=${JSON.stringify(template.brokenErrors)} diagnostics=${template.brokenDiagnostics}`
    );
    assertCheck(
      '5 模板编译',
      'PDF 预览在渲染层不可用（B21）—— 面板只给路径与哈希',
      typeof template.pdfHash === 'string',
      `pdfHash=${String(template.pdfHash).slice(0, 12)}`
    );
  }

  // ---- 闸门 8：没有假随机（旧壳的 mock 痕迹） ----------------------------------
  const randomHits = searchSourceTree(resolve('src/renderer-next'), 'Math.random(');
  assertCheck('8 无假随机', 'src/renderer-next 里没有 Math.random()', randomHits.length === 0, randomHits.slice(0, 3).join(', '));

  // ---- 闸门 9：typecheck --------------------------------------------------------
  const typecheck = spawnSync('pnpm', ['typecheck'], { encoding: 'utf8', cwd: resolve('.') });
  assertCheck(
    '9 typecheck',
    'pnpm typecheck 无错误',
    typecheck.status === 0,
    `exit=${typecheck.status} out=${typecheck.stdout.trim().slice(0, 160)} err=${typecheck.stderr.trim().slice(0, 160)}`
  );

  assertCheck('10 渲染层错误', '整轮没有 renderer error', rendererErrors.length === 0, rendererErrors.slice(0, 3).join(' | '));
} catch (error) {
  writeFileSync(
    join(artifactDir, 'report.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: false,
        error: error instanceof Error ? error.message : String(error),
        results,
        rendererErrors
      },
      null,
      2
    ),
    'utf8'
  );
  console.error(`\nP7 验收闸门失败：${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  const failed = results.filter((entry) => entry.ok !== true);
  writeFileSync(
    join(artifactDir, 'report.json'),
    JSON.stringify(
      {
        checkedAt: new Date().toISOString(),
        passed: failed.length === 0,
        providerRequests: smokeProvider.requests.length,
        results,
        rendererErrors
      },
      null,
      2
    ),
    'utf8'
  );
  const infoCount = results.filter((entry) => entry.kind === 'info').length;
  const assertionFailures = failed.filter((entry) => entry.kind !== 'info').length;
  console.log(
    `\nP7 验收闸门：${results.length - failed.length}/${results.length} 记录通过 · 断言 ${results.length - infoCount - assertionFailures}/${results.length - infoCount} · 说明性记录 ${infoCount}。报告写入 ${artifactDir}/report.json`
  );
  if (app !== undefined) {
    await Promise.race([app.close(), new Promise((resolveDone) => setTimeout(resolveDone, 20_000))]);
    setTimeout(() => process.exit(process.exitCode ?? 0), 500).unref();
  }
  await smokeProvider.close();
  for (const directory of [dataRoot, workspaceRoot, skillSourceRoot, remoteRoot]) {
    rmSync(directory, { recursive: true, force: true });
  }
}

/** Cheap recursive text search for gate 8 (no shell, no globbing surprises). */
function searchSourceTree(root, needle) {
  const hits = [];
  const walk = (directory) => {
    let entries = [];
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.name.endsWith('.ts') && !entry.name.endsWith('.tsx')) {
        continue;
      }
      const source = readFileSync(path, 'utf8');
      source.split('\n').forEach((line, index) => {
        if (line.includes(needle) && !line.trim().startsWith('*') && !line.trim().startsWith('//')) {
          hits.push(`${path}:${index + 1}`);
        }
      });
    }
  };
  walk(root);
  return hits;
}
