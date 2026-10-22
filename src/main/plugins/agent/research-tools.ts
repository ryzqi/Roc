import { DynamicStructuredTool } from '@langchain/core/tools';
import type { StructuredToolInterface } from '@langchain/core/tools';
import { interrupt } from '@langchain/langgraph';
import { tool } from 'langchain';
import { z } from 'zod';

import { researchLiteratureSourceSchema, researchStageSchema } from '../../../shared/schemas/research';
import type { ResearchProseLintReport } from '../../../shared/schemas/research-prose';
import type {
  ResearchArtifact,
  ResearchArtifactContent,
  ResearchEvidence,
  ResearchLiterature,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowSnapshot
} from '../../../shared/types';
import type { RocCapabilityRegistry } from '../../kernel/types';

/**
 * 对话代理在绑定研究项目后拿到的科研工具。工具本体只做两件事：
 * 把项目身份钉死在路由参数上，以及把 capability 的返回压成模型能读的规模。
 * 阶段推进与闸门都走界面同一条 capability，不另起一套流程。
 */
export type ResearchToolDescriptor = {
  name: string;
  scope: 'app' | 'workspace' | 'memory' | 'network' | 'external';
  effectClass: 'none' | 'network_read' | 'external_call' | 'host_execution' | 'workspace_mutation';
  riskLevel: 'none' | 'low' | 'medium' | 'high' | 'critical';
  executionScopes: Array<'main' | 'subagent'>;
};

const readScopes: ResearchToolDescriptor['executionScopes'] = ['main', 'subagent'];

/** 工具名与权限的唯一来源：manifest 和工具装配都读这张表，避免两处漂移。 */
export const RESEARCH_TOOL_DESCRIPTORS: readonly ResearchToolDescriptor[] = [
  { name: 'research_overview', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: readScopes },
  { name: 'research_list_artifacts', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: readScopes },
  { name: 'research_read_artifact', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: readScopes },
  { name: 'research_lint_manuscript', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: readScopes },
  { name: 'research_list_evidence', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: readScopes },
  { name: 'research_stage_runs', scope: 'app', effectClass: 'none', riskLevel: 'low', executionScopes: readScopes },
  { name: 'research_search_knowledge', scope: 'memory', effectClass: 'network_read', riskLevel: 'low', executionScopes: readScopes },
  { name: 'research_search_literature', scope: 'network', effectClass: 'network_read', riskLevel: 'low', executionScopes: readScopes },
  { name: 'research_capture_evidence', scope: 'app', effectClass: 'external_call', riskLevel: 'low', executionScopes: ['main'] },
  { name: 'research_run_stage', scope: 'app', effectClass: 'external_call', riskLevel: 'medium', executionScopes: ['main'] },
  { name: 'research_cancel_stage_run', scope: 'app', effectClass: 'external_call', riskLevel: 'medium', executionScopes: ['main'] },
  { name: 'research_approve_gate', scope: 'app', effectClass: 'external_call', riskLevel: 'high', executionScopes: ['main'] }
];

const GATE_TOOL_NAME = 'research_approve_gate';
const defaultLiteratureSources = ['openalex', 'crossref', 'arxiv'] as const;
const maxInlineChars = 12000;

export function createResearchTools(input: {
  capabilities: RocCapabilityRegistry;
  projectId: string;
  signal: AbortSignal;
}): StructuredToolInterface[] {
  const projectId = input.projectId;
  const invoke = async <TOutput>(name: string, request: unknown): Promise<TOutput> => {
    input.signal.throwIfAborted();
    const result = await input.capabilities.invoke<unknown, TOutput>(name, request);
    input.signal.throwIfAborted();
    return result;
  };
  const workflow = async (): Promise<ResearchWorkflowSnapshot> =>
    await invoke<ResearchWorkflowSnapshot>('research.workflow.get', { id: projectId });

  return [
    tool(async () => summarizeOverview(
      await invoke<ResearchProject>('research.projects.get', { id: projectId }),
      await workflow(),
      await invoke<ResearchArtifact[]>('research.artifacts.list', { projectId })
    ), {
      name: 'research_overview',
      description: '读取当前研究项目的目标、当前阶段、阶段状态、人工闸门、工件数量和下一步建议。任何阶段操作前先看这里。',
      schema: z.object({}).strict()
    }),
    tool(async ({ stage }) => {
      const artifacts = await invoke<ResearchArtifact[]>('research.artifacts.list', stage === undefined ? { projectId } : { projectId, stage });
      return { total: artifacts.length, artifacts: artifacts.map(artifactSummary) };
    }, {
      name: 'research_list_artifacts',
      description: '列出当前项目的阶段产物（策略、文献集、笔记、正文、审稿、导出包等），可按阶段过滤。',
      schema: z.object({ stage: researchStageSchema.optional() }).strict()
    }),
    tool(async ({ artifactId }) => {
      const artifact = await invoke<ResearchArtifact>('research.artifacts.get', { id: artifactId });
      if (artifact.projectId !== projectId) throw new Error('research_artifact_project_mismatch');
      const content = await invoke<ResearchArtifactContent | null>('research.artifacts.content', { projectId, artifactId });
      if (content === null) {
        return { artifact: artifactSummary(artifact), hasContent: false, note: '该产物没有结构化内容，请直接读取工作目录文件。' };
      }
      return {
        artifact: artifactSummary(artifact),
        hasContent: true,
        title: content.output.title,
        verdict: content.output.verdict,
        markdown: clip(content.output.markdown),
        markdownChars: content.output.markdown.length,
        claims: content.output.claims.slice(0, 40).map((claim) => ({
          subjectType: claim.subjectType, status: claim.status, content: clip(claim.content, 600), evidenceIds: claim.evidenceIds
        })),
        sections: content.output.sections
      };
    }, {
      name: 'research_read_artifact',
      description: '按 artifactId 读取阶段产物的结构化内容（正文 markdown、主张、章节）。读正文优先用这个，不要猜文件名。',
      schema: z.object({ artifactId: z.string().trim().min(1) }).strict()
    }),
    tool(async ({ artifactId, offset, limit }) => {
      const artifact = await invoke<ResearchArtifact>('research.artifacts.get', { id: artifactId });
      if (artifact.projectId !== projectId) throw new Error('research_artifact_project_mismatch');
      const report = await invoke<ResearchProseLintReport>('research.prose.lint', { projectId, artifactId });
      // 报告可能很长（上限 2000 条），按 severity 先给汇总再分页给明细，
      // 既不丢信息也不把整份报告塞进上下文。
      return { artifactId, artifactTitle: report.artifactTitle, language: report.language,
        valeVersion: report.valeVersion, counts: report.counts, truncated: report.truncated,
        droppedUnits: report.droppedUnits,
        findings: report.findings.slice(offset, offset + limit).map((finding) => ({
          claimId: finding.claimId, sectionIndex: finding.sectionIndex, sectionTitle: finding.sectionTitle,
          line: finding.line, severity: finding.severity, check: finding.check,
          message: finding.message, match: finding.match
        })),
        totalFindings: report.findings.length,
        nextOffset: offset + limit < report.findings.length ? offset + limit : null };
    }, {
      name: 'research_lint_manuscript',
      description: '用随包的确定性检查器检查正文的措辞与证据口径（模糊限定词、无出处的「有研究表明」、超出证据的论断、冗余表达）。'
        + '每条命中有 claimId 与行号。写审稿意见或修订前先跑一次，不要凭印象断言文稿没问题。',
      schema: z.object({ artifactId: z.string().trim().min(1), offset: z.number().int().nonnegative(),
        limit: z.number().int().min(1).max(200) }).strict()
    }),
    tool(async () => {
      const evidence = await invoke<ResearchEvidence[]>('research.evidence.list', { projectId });
      return {
        total: evidence.length,
        evidence: evidence.slice(0, 60).map((entry) => ({
          id: entry.id, title: entry.title, sourceType: entry.sourceType, locator: entry.locator, excerpt: clip(entry.excerpt, 800)
        }))
      };
    }, {
      name: 'research_list_evidence',
      description: '列出本项目已保存的证据片段及其准确 id、定位和原文。主张只能引用这里返回的 id 或本对话新捕获的 id。',
      schema: z.object({}).strict()
    }),
    tool(async ({ runId, limit }) => {
      if (runId !== undefined) {
        return summarizeRun(await invoke<ResearchStageRun>('research.workflow.getRun', { projectId, runId }));
      }
      const runs = await invoke<ResearchStageRun[]>('research.workflow.listRuns', { projectId, limit: limit ?? 10 });
      return { runs: runs.map(summarizeRun) };
    }, {
      name: 'research_stage_runs',
      description: '查看阶段运行状态。传 runId 看单次；不传则列出最近若干次。启动阶段运行后用这个跟进。',
      schema: z.object({ runId: z.string().trim().min(1).optional(), limit: z.number().int().min(1).max(50).optional() }).strict()
    }),
    tool(async ({ query, limit }) => {
      const result = await invoke<{ hits: unknown[]; keywordCount: number; vectorCount: number; embeddingModel: string | null }>(
        'research.knowledge.search',
        { query, projectId, limit: limit ?? 6, embeddingConfigId: null }
      );
      return {
        ...result,
        hits: (result.hits as Array<{ chunkId: string; title: string; content: string; locator: string | null }>).map((hit) => ({
          ...hit, content: clip(hit.content, 2000)
        }))
      };
    }, {
      name: 'research_search_knowledge',
      description: '先用它检索本项目与全局文献材料，返回真实 chunkId 和定位。拿到 chunkId 后可用 research_capture_evidence 存成证据。',
      schema: z.object({ query: z.string().trim().min(1), limit: z.number().int().min(1).max(20).optional() }).strict()
    }),
    tool(async ({ query, limit, sources }) => {
      const records = await invoke<ResearchLiterature[]>('research.literature.search', {
        query,
        sources: sources === undefined || sources.length === 0 ? [...defaultLiteratureSources] : sources,
        limit: limit ?? 10
      });
      return records.map((record) => ({
        id: record.id, source: record.source, title: record.title, doi: record.doi, publishedYear: record.publishedYear,
        citationCount: record.citationCount, url: record.url, abstract: record.abstract === null ? null : clip(record.abstract, 1500)
      }));
    }, {
      name: 'research_search_literature',
      description: '按关键词检索开放学术 API。真实摘要会自动进入全局知识库，之后可检索并捕获为证据。不传 sources 时用默认来源。',
      schema: z.object({
        query: z.string().trim().min(1),
        limit: z.number().int().min(1).max(30).optional(),
        sources: z.array(researchLiteratureSourceSchema.exclude(['doi'])).optional()
      }).strict()
    }),
    tool(async ({ chunkId }) => {
      const evidence = await invoke<ResearchEvidence>('research.evidence.capture', { projectId, chunkId });
      return { ...evidence, excerpt: clip(evidence.excerpt, 4000) };
    }, {
      name: 'research_capture_evidence',
      description: '把真实知识库片段保存成带定位的证据快照，返回可用于主张的 evidenceId。chunkId 必须来自检索结果。',
      schema: z.object({ chunkId: z.string().trim().min(1) }).strict()
    }),
    tool(async ({ stage, instruction }) => {
      const snapshot = await workflow();
      const expectedStage = stage ?? snapshot.currentStage;
      const resolvedInstruction = instruction ?? await defaultStageInstruction(invoke, projectId, expectedStage);
      const run = await invoke<ResearchStageRun>('research.workflow.startRun', {
        projectId, expectedStage, instruction: resolvedInstruction, requestId: randomRequestId()
      });
      return {
        ...summarizeRun(run),
        note: '阶段运行已在后台继续，不阻塞本对话。用 research_stage_runs 跟进；完成后若该阶段需要人工闸门，用 research_approve_gate 让用户确认。'
      };
    }, {
      name: 'research_run_stage',
      description: '启动当前（或指定）阶段的角色运行。运行在后台继续，立即返回 runId；用它推进"发现→检索→…→导出"的每个阶段。',
      schema: z.object({ stage: researchStageSchema.optional(), instruction: z.string().trim().min(1).max(10000).optional() }).strict()
    }),
    tool(async ({ runId }) => summarizeRun(await invoke<ResearchStageRun>('research.workflow.cancelRun', { projectId, runId })), {
      name: 'research_cancel_stage_run',
      description: '取消仍在排队或执行中的阶段运行。运行已结束时不要调用。',
      schema: z.object({ runId: z.string().trim().min(1) }).strict()
    }),
    // 闸门工具自己发 interrupt：用户在对话里点批准/退回，决定后才真正推进流程。
    // 这里不用 manifest 的 approvalPolicy，否则 approvalPolicy 会先拦一次工具调用，语义变成"是否允许调用这个工具"。
    new DynamicStructuredTool({
      name: GATE_TOOL_NAME,
      description: '在对话里请用户确认当前阶段的产物：批准则通过闸门并推进阶段，退回则让阶段回到执行中。阶段处于待审核（waiting_approval）时调用它，不要替用户决定。',
      schema: z.object({ note: z.string().trim().max(2000).optional() }),
      func: async ({ note }) => {
        const snapshot = await workflow();
        const current = snapshot.stages.find((entry) => entry.stage === snapshot.currentStage);
        if (current === undefined) throw new Error('research_stage_not_found');
        if (current.status !== 'waiting_approval') {
          throw new Error(`research_gate_not_waiting_approval:${current.status}`);
        }
        const isReview = current.stage === 'review';
        const artifacts = await invoke<ResearchArtifact[]>('research.artifacts.list', { projectId, stage: current.stage });
        const resume = interrupt({
          kind: 'approval',
          request: {
            actionRequests: [{
              name: GATE_TOOL_NAME,
              args: {
                projectId,
                stage: current.stage,
                artifactTitles: artifacts.map((artifact) => artifact.title),
                summary: isReview
                  ? '确认审稿结论：接受正文则进入导出，要求修订则回到修订阶段，退回则重跑本阶段。'
                  : '确认本阶段产物是否可以进入下一阶段。'
              },
              description: '人工闸门'
            }],
            // 审稿阶段有第三态（要求修订）；其他阶段的闸门只有通过/退回。
            reviewConfigs: [{
              actionName: GATE_TOOL_NAME,
              allowedDecisions: isReview ? ['approve', 'revise', 'reject'] : ['approve', 'reject']
            }]
          }
        }) as { decisions?: Array<{ type?: unknown; message?: unknown }> };
        const decision = resume.decisions?.[0];
        const type = decision?.type;
        const decisionNote = typeof decision?.message === 'string' ? decision.message : note;
        if (type === 'approve') {
          const transitioned = await invoke<ResearchWorkflowSnapshot>('research.workflow.transition', {
            projectId,
            expectedStage: current.stage,
            action: 'approve',
            ...(isReview ? { reviewDecision: 'accept' as const } : {})
          });
          return summarizeGateOutcome('approve', transitioned);
        }
        // 要求修订与退回都走 approve+reviewDecision:'revise'：这样审稿周期进入 revision_required、
        // 回到修订阶段，而不是把审稿阶段整体重跑（重跑会丢掉审稿意见）。
        if (type === 'revise' || (isReview && type === 'reject')) {
          const transitioned = await invoke<ResearchWorkflowSnapshot>('research.workflow.transition', {
            projectId,
            expectedStage: current.stage,
            action: 'approve',
            reviewDecision: 'revise' as const,
            ...(decisionNote === undefined ? {} : { note: decisionNote })
          });
          return summarizeGateOutcome('revise', transitioned);
        }
        if (type !== 'reject') {
          throw new Error('research_gate_decision_invalid');
        }
        const transitioned = await invoke<ResearchWorkflowSnapshot>('research.workflow.transition', {
          projectId,
          expectedStage: current.stage,
          action: 'reject',
          note: decisionNote ?? '用户要求重做本阶段。'
        });
        return summarizeGateOutcome('reject', transitioned);
      }
    })
  ];
}

/** 闸门结果回给模型：说清落在哪个阶段，以及下一步该做什么。 */
function summarizeGateOutcome(decision: 'approve' | 'revise' | 'reject', snapshot: ResearchWorkflowSnapshot) {
  const stage = snapshot.stages.find((entry) => entry.stage === snapshot.currentStage);
  const next: Record<typeof decision, string> = {
    approve: '闸门已通过，可以开始下一阶段。',
    revise: '已要求修订，当前在修订阶段；改完正文后重跑修订阶段再走审稿闸门。',
    reject: '已退回，当前阶段需要重做。'
  };
  return {
    decision,
    currentStage: snapshot.currentStage,
    status: stage?.status ?? null,
    next: next[decision]
  };
}

function artifactSummary(artifact: ResearchArtifact) {
  return {
    id: artifact.id, stage: artifact.stage, kind: artifact.kind, title: artifact.title,
    status: artifact.status, path: artifact.path, updatedAt: artifact.updatedAt
  };
}

function summarizeRun(run: ResearchStageRun) {
  return {
    runId: run.id, stage: run.stage, status: run.status, role: run.role, outputKind: run.outputKind,
    error: run.error, outputArtifactIds: run.outputArtifactIds, startedAt: run.startedAt, endedAt: run.endedAt
  };
}

function summarizeOverview(project: ResearchProject, snapshot: ResearchWorkflowSnapshot, artifacts: ResearchArtifact[]) {
  const current = snapshot.stages.find((entry) => entry.stage === snapshot.currentStage);
  return {
    project: {
      id: project.id, title: project.title, goal: project.description, language: project.language,
      status: project.status, workspacePath: project.workspacePath
    },
    currentStage: snapshot.currentStage,
    stageStatus: current?.status ?? null,
    gateRequired: current?.gateRequired ?? false,
    gateApproved: current?.gateApproved ?? false,
    activeRunId: current?.activeRunId ?? null,
    lastError: current?.lastError ?? null,
    lastEvent: snapshot.lastEvent,
    stages: snapshot.stages.map((entry) => ({ stage: entry.stage, status: entry.status, artifacts: entry.artifactIds.length })),
    artifactCount: artifacts.length,
    nextAction: nextActionHint(snapshot, current?.status ?? null)
  };
}

/** 与界面「当前下一步」同义的粗粒度提示，供模型决定该调用哪个工具，不替代界面文案。 */
function nextActionHint(snapshot: ResearchWorkflowSnapshot, status: string | null): string {
  if (status === 'ready') return '用 research_run_stage 开始当前阶段。';
  if (status === 'running') return '阶段运行进行中，用 research_stage_runs 跟进。';
  if (status === 'waiting_approval') return '用 research_approve_gate 请用户确认产物。';
  if (status === 'failed' || status === 'blocked') return '查看 research_stage_runs 的失败原因，再用 research_run_stage 重试。';
  if (status === 'paused') return '用 research_run_stage 重新开始当前阶段。';
  if (status === 'completed') {
    const index = snapshot.stages.findIndex((entry) => entry.stage === snapshot.currentStage);
    const next = snapshot.stages[index + 1];
    return next === undefined ? '流程已走到导出。' : `用 research_run_stage 进入${next.stage}阶段。`;
  }
  return '读取 research_overview 后判断。';
}

/** 阶段指令留空时用研究目标，与界面「没有手写指令就用研究目标」一致。 */
async function defaultStageInstruction(
  invoke: <TOutput>(name: string, request: unknown) => Promise<TOutput>,
  projectId: string,
  stage: string
): Promise<string> {
  const project = await invoke<ResearchProject>('research.projects.get', { id: projectId });
  return `继续研究项目「${project.title}」的${stage}阶段。研究目标：${project.description}`;
}

function clip(text: string, max: number = maxInlineChars): string {
  return text.length <= max ? text : `${text.slice(0, max)}\n…（已截断，共 ${text.length} 字符）`;
}

function randomRequestId(): string {
  return `chat-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
