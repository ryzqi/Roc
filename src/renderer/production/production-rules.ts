import type {
  ResearchClaim,
  ResearchEvidence,
  ResearchExperimentEnvironment,
  ResearchExportBundle,
  ResearchExportExecution,
  ResearchFigurePublication,
  ResearchTemplate
} from '../../shared/types';
import type { ResearchExperimentRuntime } from '../../shared/schemas/research-experiments';

/**
 * Pure production rules (P7/T7.1–T7.7).
 *
 * Same discipline as P6's `workflow-rules.ts`: everything a panel *decides* lives here as a
 * function of the real contract, so it can be unit-tested without a DOM or an IPC stub. Four
 * of these functions exist because the contract has a subtlety that is easy to get wrong in a
 * component:
 *
 *   - `ideaCanvasFields` — the save request demands **exactly seven** `fields` whose `content`
 *     is byte-identical to the named sections (`researchIdeaCanvasSaveRequestSchema`). Deriving
 *     them is the only way to guarantee that; a second editable copy of the same text would
 *     fail validation the moment the two drifted.
 *   - `engineForSourcePath` / `runtimeForEngine` — `research.experiment.start` cross-checks the
 *     engine, the file extension and the runtime kind. Choosing them independently in the UI
 *     means an avoidable `research_experiment_runtime_mismatch`.
 *   - `exportReadiness` — the backend refuses to publish a manuscript whose claims have no
 *     evidence (`research_claim_unverified`); gate 6 asks for that block to be *visible before*
 *     the user tries, so the same rule is computed here.
 *   - `environmentReadiness` — an environment probe decides whether the main action is
 *     "启动运行" or "先检查环境" (T7.2/T7.3).
 */

export type ProductionIssue = {
  message: string;
  /** Where to look, when the issue is about a specific thing (artifact, claim, file). */
  reference: string | null;
};

/* ------------------------------------------------------------------ */
/* 构思 (T7.1)                                                         */
/* ------------------------------------------------------------------ */

export const IDEA_FIELD_KEYS = [
  'problem',
  'hypothesis',
  'novelty',
  'supportingEvidence',
  'counterevidence',
  'experiment',
  'risks'
] as const;

export type IdeaFieldKey = (typeof IDEA_FIELD_KEYS)[number];

export type IdeaFieldDraft = {
  key: IdeaFieldKey;
  content: string;
  status: 'supported' | 'hypothesis' | 'pending';
  evidenceIds: string[];
};

/**
 * Builds the save payload's `fields` from the named sections.
 *
 * `status`/`evidenceIds` are kept from the previous version when a field already existed, so
 * editing the prose does not silently reset a field's verification state (the schema would
 * accept it either way, which is exactly why the decision has to live in one place).
 */
export function ideaCanvasFields(
  sections: Record<IdeaFieldKey, string>,
  previous: readonly IdeaFieldDraft[] = []
): IdeaFieldDraft[] {
  return IDEA_FIELD_KEYS.map((key) => {
    const existing = previous.find((field) => field.key === key);
    return {
      key,
      content: sections[key],
      status: existing?.status ?? 'pending',
      evidenceIds: existing?.evidenceIds ?? []
    };
  });
}

export function emptyIdeaSections(): Record<IdeaFieldKey, string> {
  return {
    problem: '',
    hypothesis: '',
    novelty: '',
    supportingEvidence: '',
    counterevidence: '',
    experiment: '',
    risks: ''
  };
}

export function ideaSectionsFromCanvas(canvas: {
  problem: string;
  hypothesis: string;
  novelty: string;
  supportingEvidence: string;
  counterevidence: string;
  experiment: string;
  risks: string;
}): Record<IdeaFieldKey, string> {
  return {
    problem: canvas.problem,
    hypothesis: canvas.hypothesis,
    novelty: canvas.novelty,
    supportingEvidence: canvas.supportingEvidence,
    counterevidence: canvas.counterevidence,
    experiment: canvas.experiment,
    risks: canvas.risks
  };
}

/** The schema requires non-empty text for these; the optional ones may be blank. */
export const IDEA_REQUIRED_KEYS: readonly IdeaFieldKey[] = ['problem', 'hypothesis', 'novelty', 'experiment', 'risks'];

export function ideaSaveBlockers(sections: Record<IdeaFieldKey, string>, rationale: string): ProductionIssue[] {
  const issues: ProductionIssue[] = [];
  for (const key of IDEA_REQUIRED_KEYS) {
    if (sections[key].trim().length === 0) {
      issues.push({ message: `「${ideaFieldLabel(key)}」不能为空`, reference: key });
    }
  }
  if (rationale.trim().length === 0) {
    issues.push({ message: '「立项理由」不能为空', reference: 'rationale' });
  }
  return issues;
}

export function ideaFieldLabel(key: IdeaFieldKey): string {
  const labels: Record<IdeaFieldKey, string> = {
    problem: '问题',
    hypothesis: '假设',
    novelty: '新颖性',
    supportingEvidence: '支持性证据',
    counterevidence: '反面证据',
    experiment: '实验设计',
    risks: '风险'
  };
  return labels[key];
}

/**
 * Feeds the idea panel's evidence picker.
 *
 * `fields[].status === 'supported'` requires `evidenceIds` that really exist
 * (`evidence.assertSupported`), so the picker must offer only captured evidence — which,
 * per B15, means only what RAG retrieval captured.
 */
export function evidenceOptionsForIdea(evidence: readonly ResearchEvidence[]): Array<{ id: string; label: string }> {
  return evidence.map((item) => ({
    id: item.id,
    label: `${item.title} · ${item.locator}`
  }));
}

/* ------------------------------------------------------------------ */
/* 实验与图稿 (T7.2 / T7.3)                                            */
/* ------------------------------------------------------------------ */

export type ExperimentEngine = 'python' | 'r' | 'julia';

const ENGINE_EXTENSIONS: Record<ExperimentEngine, string> = { python: '.py', r: '.r', julia: '.jl' };

/** Derives the engine from the workspace file's extension, or null when it is not a script. */
export function engineForSourcePath(path: string): ExperimentEngine | null {
  const lower = path.toLowerCase();
  const found = (Object.keys(ENGINE_EXTENSIONS) as ExperimentEngine[]).find((engine) =>
    lower.endsWith(ENGINE_EXTENSIONS[engine])
  );
  return found ?? null;
}

/** The runtime kinds the schema accepts for each engine. */
export function runtimesForEngine(engine: ExperimentEngine): Array<{ kind: ResearchExperimentRuntime['kind']; label: string }> {
  if (engine === 'r') {
    return [{ kind: 'renv', label: 'renv（项目内 R 库）' }];
  }
  if (engine === 'julia') {
    return [{ kind: 'julia', label: 'julia（本地 depot）' }];
  }
  return [
    { kind: 'bundled-python', label: '内置 Python' },
    { kind: 'uv', label: 'uv 虚拟环境' }
  ];
}

/**
 * Whether a start request can be sent at all, and which engine terms it needs.
 *
 * Returns the *reason* rather than a boolean so the panel can disable its main action with an
 * explanation — the pattern the plan asks for ("未就绪环境时主操作是检查环境").
 */
export function experimentStartBlockers(input: {
  sourcePath: string | null;
  environment: ResearchExperimentEnvironment | null;
  engine: ExperimentEngine | null;
  runtime: ResearchExperimentRuntime | null;
  label: string;
}): ProductionIssue[] {
  const issues: ProductionIssue[] = [];
  if (input.sourcePath === null) {
    issues.push({ message: '先选择一个工作区脚本文件', reference: 'sourcePath' });
  } else if (input.engine === null) {
    issues.push({ message: '脚本扩展名必须是 .py / .r / .jl（后端按扩展名校验引擎）', reference: input.sourcePath });
  }
  if (input.environment === null) {
    issues.push({ message: '先检查运行环境：主操作要用真实的环境快照', reference: 'environment' });
  }
  if (input.environment !== null && input.runtime === null) {
    issues.push({ message: '先选择运行时（与引擎匹配）', reference: 'runtime' });
  }
  // 「环境自上次探测后变化」不在前端判断：启动时把探测到的 `expectedEnvironmentHash` 钉进请求，
  // 由后端比对并报 `research_experiment_environment_changed` —— 前端拿不到两次探测之间的变化。
  if (input.label.trim().length === 0) {
    issues.push({ message: '给这次运行一个标签', reference: 'label' });
  }
  return issues;
}

export type EnvironmentReadiness = {
  ready: boolean;
  summary: string;
  detail: string;
};

export function environmentReadiness(environment: ResearchExperimentEnvironment | null): EnvironmentReadiness {
  if (environment === null) {
    return { ready: false, summary: '尚未检查环境', detail: '先探测运行时，主操作会由探测结果决定。' };
  }
  return {
    ready: true,
    summary: `${environment.executable} ${environment.version}`,
    detail: `${environment.platform}/${environment.architecture} · ${environment.packages.length} 个包 · 工具链 ${environment.toolchainHash.slice(0, 8)}`
  };
}

export const FIGURE_FORMATS = ['png', 'svg', 'pdf'] as const;
export type FigureFormat = (typeof FIGURE_FORMATS)[number];

export function figureFormatForPath(path: string): FigureFormat | null {
  const lower = path.toLowerCase();
  return FIGURE_FORMATS.find((format) => lower.endsWith(`.${format}`)) ?? null;
}

/**
 * How a figure file can be shown, given that there is no protocol URL for research storage
 * (B21): SVG is text (inline), PNG arrives as base64 (a `data:` URL is the only option),
 * PDF cannot be previewed at all.
 */
export function figureRenderMode(format: FigureFormat, encoding: 'utf8' | 'base64'): 'data-url' | 'unsupported' {
  if (format === 'pdf') {
    return 'unsupported';
  }
  // SVG arrives as text, PNG as base64 — both end up in an `<img src="data:…">`. Inlining the SVG
  // markup (`dangerouslySetInnerHTML`) would execute whatever the file carries, so the renderer
  // deliberately has only this one mode and the rule says so (评审备注：词汇要与消费者一致).
  return 'data-url';
}

/* ------------------------------------------------------------------ */
/* 证据与主张 (T7.6)                                                   */
/* ------------------------------------------------------------------ */

export type ClaimSupportRow = {
  claim: ResearchClaim;
  evidence: ResearchEvidence[];
  /** `supported` with no evidence is a contract violation, not a display choice. */
  missingEvidence: boolean;
};

export function claimSupportRows(
  claims: readonly ResearchClaim[],
  evidence: readonly ResearchEvidence[]
): ClaimSupportRow[] {
  const byId = new Map(evidence.map((item) => [item.id, item]));
  return claims.map((claim) => {
    const linked = claim.evidenceIds.map((id) => byId.get(id)).filter((item): item is ResearchEvidence => item !== undefined);
    return {
      claim,
      evidence: linked,
      missingEvidence: claim.status === 'supported' && claim.evidenceIds.length === 0
    };
  });
}

export function claimStatusLabel(status: ResearchClaim['status']): string {
  if (status === 'supported') return '有证据支持';
  if (status === 'hypothesis') return '假设';
  return '待验证';
}

/* ------------------------------------------------------------------ */
/* 正文与导出 (T7.4 / T7.7)                                            */
/* ------------------------------------------------------------------ */

/**
 * Whether the manuscript can go into an export bundle.
 *
 * `manuscripts.assertPublishable` / `evidence.assertPublishable` reject the bundle when a
 * claim has no evidence, so the readiness is computed here and shown **before** the attempt
 * (gate 6: 「没有证据的主张不能进入导出」).
 */
export function exportReadiness(bundle: ResearchExportBundle | null): { ready: boolean; issues: ProductionIssue[] } {
  if (bundle === null) {
    return { ready: false, issues: [{ message: '还没有稿件：先生成并保存正文', reference: 'manuscript' }] };
  }
  const issues: ProductionIssue[] = [];
  for (const claim of bundle.claims) {
    if (claim.status === 'supported' && claim.evidenceIds.length === 0) {
      issues.push({ message: `主张缺少证据：${claim.content.slice(0, 40)}`, reference: claim.id });
    }
  }
  if (bundle.manuscript.sections.length === 0) {
    issues.push({ message: '正文还没有任何段落', reference: 'manuscript' });
  }
  return { ready: issues.length === 0, issues };
}

export function exportStatusLabel(status: ResearchExportExecution['status']): string {
  if (status === 'preparing') return '准备中';
  if (status === 'ready') return '已就绪';
  if (status === 'failed') return '失败';
  if (status === 'cancelled') return '已取消';
  return '已中断';
}

export function exportApprovalLabel(approval: ResearchExportExecution['approval']): string {
  if (approval === 'approved') return '已批准';
  if (approval === 'superseded') return '已替换';
  if (approval === 'draft') return '草稿';
  return '未发布';
}

/** The template selection `research.export.prepare` needs, or null when the import is incomplete. */
export function exportTemplateSelection(
  template: ResearchTemplate | null
): { kind: 'imported'; templateId: string; expectedRevision: number; expectedSourceDigest: string } | null {
  if (template === null || template.sourceDigest === null || template.status !== 'ready') {
    return null;
  }
  return {
    kind: 'imported',
    templateId: template.id,
    expectedRevision: template.revision,
    expectedSourceDigest: template.sourceDigest
  };
}

/**
 * Splits the export bundle's inspectable lists, so the panel can show 「PDF/LaTeX/BibTeX/图片清单」
 * without inventing a taxonomy: the archive entries are the backend's own file list.
 */
export function exportFileKinds(files: readonly { path: string }[]): Record<'latex' | 'pdf' | 'bibliography' | 'figure' | 'other', string[]> {
  const groups = { latex: [], pdf: [], bibliography: [], figure: [], other: [] } as Record<
    'latex' | 'pdf' | 'bibliography' | 'figure' | 'other',
    string[]
  >;
  for (const file of files) {
    const lower = file.path.toLowerCase();
    if (lower.endsWith('.tex') || lower.endsWith('.ltx')) groups.latex.push(file.path);
    else if (lower.endsWith('.pdf')) groups.pdf.push(file.path);
    else if (lower.endsWith('.bib')) groups.bibliography.push(file.path);
    else if (figureFormatForPath(lower) !== null) groups.figure.push(file.path);
    else groups.other.push(file.path);
  }
  return groups;
}

export function figurePublicationLabel(figure: ResearchFigurePublication): string {
  const size = `${figure.validation.widthPixels}×${figure.validation.heightPixels}`;
  return `${figure.title} · ${size}px · ${figure.status}`;
}

/** The environment hash a run should be pinned to (its own probe), for `expectedEnvironmentHash`. */
export function expectedEnvironmentHash(environment: ResearchExperimentEnvironment | null): string | undefined {
  return environment === null ? undefined : environment.hash;
}

/**
 * A claim used in two paragraphs is rejected by `researchManuscriptSaveRequestSchema`
 * (「Each paragraph must appear only once」). Computing it here lets the editor disable Save with
 * the reason, instead of the user discovering it as a backend refusal.
 */
export function duplicateClaimIds(sections: readonly { claimIds: string[] }[]): string[] {
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  for (const section of sections) {
    for (const id of section.claimIds) {
      if (seen.has(id)) {
        duplicates.add(id);
      }
      seen.add(id);
    }
  }
  return [...duplicates];
}

/** The manuscript editor's blockers (T7.4), mirroring the three schema rules. */
export function manuscriptBlockers(sections: readonly { title: string; claimIds: string[] }[]): ProductionIssue[] {
  const issues: ProductionIssue[] = [];
  if (sections.length === 0) {
    issues.push({ message: '至少需要一个段落', reference: 'sections' });
  }
  const empty = sections.filter((section) => section.claimIds.length === 0).length;
  if (empty > 0) {
    issues.push({ message: `有 ${empty} 个段落没有引用任何主张`, reference: 'claimIds' });
  }
  const duplicates = duplicateClaimIds(sections);
  if (duplicates.length > 0) {
    issues.push({ message: `同一条主张被用在多个段落：${duplicates.join('、')}`, reference: 'claimIds' });
  }
  if (sections.some((section) => section.title.trim().length === 0)) {
    issues.push({ message: '段落标题不能为空', reference: 'title' });
  }
  return issues;
}

/** Only the operator-editable fields count as a change: `savePolicy` compares whole objects. */
export function policyChanged(
  next: { tier: string; maxSteps: number; timeoutMs: number; model: { kind: string; providerId?: string; modelId?: string } },
  previous: { tier: string; maxSteps: number; timeoutMs: number; model: { kind: string; providerId?: string; modelId?: string } }
): boolean {
  if (next.tier !== previous.tier || next.maxSteps !== previous.maxSteps || next.timeoutMs !== previous.timeoutMs) {
    return true;
  }
  if (next.model.kind !== previous.model.kind) {
    return true;
  }
  if (next.model.kind !== 'model') {
    return false;
  }
  return next.model.providerId !== previous.model.providerId || next.model.modelId !== previous.model.modelId;
}
