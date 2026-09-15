import { CircleAlert, Plus, Send, X } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';

import type {
  ResearchArtifact,
  ResearchDocument,
  ResearchDocumentParse,
  ResearchEmbeddingConfig,
  ResearchEvidence,
  ResearchExperimentExecution,
  ResearchExperimentFileContent,
  ResearchExperimentRuntime,
  ResearchExportExecution,
  ResearchFigurePublication,
  ResearchIdeaCanvas,
  ResearchIdeaCanvasSaveRequest,
  ResearchIndexStatus,
  ResearchKnowledgeSearchResult,
  ResearchBibliographyFormat,
  ResearchLibraryExport,
  ResearchLibraryItem,
  ResearchLiterature,
  ResearchProject,
  ResearchStageRun,
  ResearchTemplate,
  ResearchTemplateFile,
  ResearchTemplateFileContent,
  ResearchWorkflowEvent,
  ResearchWorkflowSnapshot,
  ResearchWorkflowTransitionRequest
} from '../../../shared/types';
import { unwrap } from '../../loaded-state';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { canvasToDraft, emptyIdeaDraft, ResearchIdeaPanel } from './ResearchIdeaPanel';
import { ResearchEditorPanel } from './ResearchEditorPanel';
import { emptyExperimentDraft, ResearchExperimentPanel, type ResearchExperimentDraft } from './ResearchExperimentPanel';
import { ResearchLibraryPanel } from './ResearchLibraryPanel';
import { ResearchProductionPanel } from './ResearchProductionPanel';
import { ResearchWorkflowPanel } from './ResearchWorkflowPanel';
import { researchStageLabels } from './research-workflow';

export function ResearchView({ client, state }: { client: RocClient; state: LoadedState }): React.JSX.Element {
  const [projects, setProjects] = useState<ResearchProject[]>([]);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [workflow, setWorkflow] = useState<ResearchWorkflowSnapshot | null>(null);
  const [events, setEvents] = useState<ResearchWorkflowEvent[]>([]);
  const [runs, setRuns] = useState<ResearchStageRun[]>([]);
  const [artifacts, setArtifacts] = useState<ResearchArtifact[]>([]);
  const [instruction, setInstruction] = useState('');
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [activeTab, setActiveTab] = useState<'workflow' | 'library' | 'ideas' | 'experiments' | 'editor' | 'production' | 'knowledge' | 'embedding'>('workflow');
  const [literatureQuery, setLiteratureQuery] = useState('');
  const [literatureResults, setLiteratureResults] = useState<ResearchLiterature[]>([]);
  const [libraryItems, setLibraryItems] = useState<ResearchLibraryItem[]>([]);
  const [libraryScope, setLibraryScope] = useState<'project' | 'all'>('project');
  const [doi, setDoi] = useState('');
  const [bibliographyFormat, setBibliographyFormat] = useState<ResearchBibliographyFormat>('bibtex');
  const [selectedLibraryIds, setSelectedLibraryIds] = useState<string[]>([]);
  const [libraryExport, setLibraryExport] = useState<ResearchLibraryExport | null>(null);
  const [openLibraryItem, setOpenLibraryItem] = useState<ResearchLibraryItem | null>(null);
  const [openDocuments, setOpenDocuments] = useState<ResearchDocument[]>([]);
  const [openContent, setOpenContent] = useState<ResearchDocumentParse | null>(null);
  const [evidence, setEvidence] = useState<ResearchEvidence[]>([]);
  const [indexStatus, setIndexStatus] = useState<ResearchIndexStatus | null>(null);
  const [ideaArtifactId, setIdeaArtifactId] = useState<string | null>(null);
  const [ideaCanvas, setIdeaCanvas] = useState<ResearchIdeaCanvas | null>(null);
  const [ideaDraft, setIdeaDraft] = useState<ResearchIdeaCanvasSaveRequest | null>(null);
  const [knowledgeQuery, setKnowledgeQuery] = useState('');
  const [knowledgeResult, setKnowledgeResult] = useState<ResearchKnowledgeSearchResult | null>(null);
  const [embeddingConfigs, setEmbeddingConfigs] = useState<ResearchEmbeddingConfig[]>([]);
  const [embeddingId, setEmbeddingId] = useState('default');
  const [embeddingName, setEmbeddingName] = useState('默认嵌入模型');
  const [embeddingBaseUrl, setEmbeddingBaseUrl] = useState('https://api.openai.com/v1');
  const [embeddingModel, setEmbeddingModel] = useState('text-embedding-3-small');
  const [embeddingDimensions, setEmbeddingDimensions] = useState('1536');
  const [embeddingApiKey, setEmbeddingApiKey] = useState('');
  const [figures, setFigures] = useState<ResearchFigurePublication[]>([]);
  const [exports, setExports] = useState<ResearchExportExecution[]>([]);
  const [experiments, setExperiments] = useState<ResearchExperimentExecution[]>([]);
  const [experimentDraft, setExperimentDraft] = useState<ResearchExperimentDraft>(emptyExperimentDraft);
  const [selectedExperimentId, setSelectedExperimentId] = useState<string | null>(null);
  const [experimentLog, setExperimentLog] = useState<ResearchExperimentFileContent | null>(null);
  const [selectedFigureIds, setSelectedFigureIds] = useState<string[]>([]);
  const [exportTitle, setExportTitle] = useState('');
  const [destinationPath, setDestinationPath] = useState('');
  const [templates, setTemplates] = useState<ResearchTemplate[]>([]);
  const [templateFiles, setTemplateFiles] = useState<ResearchTemplateFile[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
  const [openTemplateFile, setOpenTemplateFile] = useState<ResearchTemplateFileContent | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    client.api.research
      .listProjects()
      .then((result) => {
        const nextProjects = unwrap('科研项目', result);
        if (cancelled) return;
        setProjects(nextProjects);
        setSelectedProjectId((current) => current ?? nextProjects[0]?.id ?? null);
        setError(null);
      })
      .catch((loadError: unknown) => {
        if (!cancelled) setError(loadError instanceof Error ? loadError.message : '科研项目加载失败。');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    if (selectedProjectId === null) {
      setWorkflow(null);
      setEvents([]);
      setRuns([]);
      setArtifacts([]);
      setIndexStatus(null);
      return;
    }
    let cancelled = false;
    Promise.all([
      client.api.research.getWorkflow({ id: selectedProjectId }),
      client.api.research.listWorkflowEvents({ projectId: selectedProjectId, limit: 40 }),
      client.api.research.listStageRuns({ projectId: selectedProjectId, limit: 40 }),
      client.api.research.listArtifacts({ projectId: selectedProjectId }),
      client.api.research.listEvidence({ projectId: selectedProjectId }),
      client.api.research.getIndexStatus({ projectId: selectedProjectId })
    ]).then(([workflowResult, eventResult, runResult, artifactResult, evidenceResult, indexResult]) => {
      if (cancelled) return;
      setWorkflow(unwrap('科研流程', workflowResult));
      setEvents(unwrap('科研事件', eventResult));
      setRuns(unwrap('阶段运行', runResult));
      setArtifacts(unwrap('阶段产物', artifactResult));
      setEvidence(unwrap('证据', evidenceResult));
      setIndexStatus(unwrap('项目索引', indexResult));
      setError(null);
    }).catch((loadError: unknown) => {
      if (!cancelled) setError(loadError instanceof Error ? loadError.message : '科研流程加载失败。');
    });
    return () => {
      cancelled = true;
    };
  }, [client, selectedProjectId]);

  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId]
  );

  async function createProject(): Promise<void> {
    if (title.trim().length === 0 || description.trim().length === 0) {
      setError('项目标题和研究目标不能为空。');
      return;
    }
    setWorking(true);
    try {
      const result = await client.api.research.createProject({
        title: title.trim(),
        description: description.trim(),
        workspacePath: state.workspace?.path ?? null,
        language
      });
      const project = unwrap('创建科研项目', result);
      setProjects((current) => [project, ...current]);
      setSelectedProjectId(project.id);
      setTitle('');
      setDescription('');
      setCreateOpen(false);
      setError(null);
    } catch (createError: unknown) {
      setError(createError instanceof Error ? createError.message : '科研项目创建失败。');
    } finally {
      setWorking(false);
    }
  }

  async function refreshProject(projectId: string): Promise<void> {
    const [workflowResult, eventResult, runResult, artifactResult, evidenceResult, indexResult] = await Promise.all([
      client.api.research.getWorkflow({ id: projectId }),
      client.api.research.listWorkflowEvents({ projectId, limit: 40 }),
      client.api.research.listStageRuns({ projectId, limit: 40 }),
      client.api.research.listArtifacts({ projectId }),
      client.api.research.listEvidence({ projectId }),
      client.api.research.getIndexStatus({ projectId })
    ]);
    const nextWorkflow = unwrap('科研流程', workflowResult);
    setWorkflow(nextWorkflow);
    setEvents(unwrap('科研事件', eventResult));
    setRuns(unwrap('阶段运行', runResult));
    setArtifacts(unwrap('阶段产物', artifactResult));
    setEvidence(unwrap('证据', evidenceResult));
    setIndexStatus(unwrap('项目索引', indexResult));
    setProjects((current) => current.map((project) => project.id === projectId
      ? { ...project, currentStage: nextWorkflow.currentStage, status: nextWorkflow.projectStatus, updatedAt: nextWorkflow.lastEvent?.createdAt ?? project.updatedAt }
      : project));
  }

  async function controlIndex(action: 'pause' | 'resume' | 'rebuild' | 'retry'): Promise<void> {
    if (selectedProjectId === null || indexStatus === null) return;
    setWorking(true);
    try {
      const request = action === 'retry'
        ? { projectId: selectedProjectId, action, expectedRevision: indexStatus.settings.revision, fileId: null }
        : { projectId: selectedProjectId, action, expectedRevision: indexStatus.settings.revision };
      setIndexStatus(unwrap('控制索引', await client.api.research.controlIndex(request)));
      setError(null);
    } catch (indexError: unknown) {
      setError(indexError instanceof Error ? indexError.message : '索引控制失败。');
    } finally {
      setWorking(false);
    }
  }

  async function transition(action: Exclude<ResearchWorkflowTransitionRequest['action'], 'move'>, reviewDecision?: 'accept' | 'revise'): Promise<void> {
    if (workflow === null || selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('更新科研流程', await client.api.research.transitionWorkflow({
        projectId: selectedProjectId,
        action,
        expectedStage: workflow.currentStage,
        note: action === 'reject' ? '请补充证据或修改阶段产物。' : undefined,
        ...(reviewDecision === undefined ? {} : { reviewDecision })
      }));
      await refreshProject(selectedProjectId);
      setError(null);
    } catch (transitionError: unknown) {
      setError(transitionError instanceof Error ? transitionError.message : '科研流程更新失败。');
    } finally {
      setWorking(false);
    }
  }

  async function startRun(): Promise<void> {
    if (workflow === null || selectedProjectId === null || instruction.trim().length === 0) return;
    setWorking(true);
    try {
      unwrap('启动阶段角色', await client.api.research.startStageRun({
        projectId: selectedProjectId, expectedStage: workflow.currentStage, instruction: instruction.trim(), requestId: crypto.randomUUID()
      }));
      await refreshProject(selectedProjectId);
      setError(null);
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : '阶段角色启动失败。');
    } finally {
      setWorking(false);
    }
  }

  async function cancelRun(): Promise<void> {
    const run = runs.find((item) => item.parentRunId === null && ['queued', 'running'].includes(item.status));
    if (run === undefined || selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('取消阶段角色', await client.api.research.cancelStageRun({ projectId: selectedProjectId, runId: run.id }));
      await refreshProject(selectedProjectId);
      setError(null);
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : '取消阶段角色失败。');
    } finally {
      setWorking(false);
    }
  }

  async function retryRun(): Promise<void> {
    const run = runs.find((item) => item.parentRunId === null && ['failed', 'cancelled', 'interrupted'].includes(item.status));
    if (run === undefined || selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('重试阶段角色', await client.api.research.retryStageRun({ projectId: selectedProjectId, runId: run.id, requestId: crypto.randomUUID() }));
      await refreshProject(selectedProjectId);
      setError(null);
    } catch (runError: unknown) {
      setError(runError instanceof Error ? runError.message : '重试阶段角色失败。');
    } finally {
      setWorking(false);
    }
  }

  async function searchLiterature(): Promise<void> {
    if (literatureQuery.trim().length === 0) return;
    setWorking(true);
    try {
      const result = await client.api.research.searchLiterature({
        query: literatureQuery.trim(),
        sources: ['openalex', 'crossref', 'semantic_scholar', 'arxiv', 'pubmed', 'europe_pmc'],
        limit: 20
      });
      setLiteratureResults(unwrap('论文检索', result));
      setError(null);
    } catch (searchError: unknown) {
      setError(searchError instanceof Error ? searchError.message : '论文检索失败。');
    } finally {
      setWorking(false);
    }
  }

  async function loadLibrary(projectId = selectedProjectId, scope = libraryScope, query = literatureQuery): Promise<void> {
    const result = await client.api.research.listLibrary({
      projectId: scope === 'project' ? projectId : null,
      query: query.trim(),
      includeArchived: false,
      limit: 100
    });
    setLibraryItems(unwrap('文献库', result));
  }

  async function importDoi(): Promise<void> {
    if (doi.trim().length === 0) return;
    setWorking(true);
    try {
      unwrap('导入 DOI', await client.api.research.importLibraryDoi({ doi: doi.trim(), projectId: selectedProjectId }));
      await loadLibrary();
      setError(null);
    } catch (importError: unknown) {
      setError(importError instanceof Error ? importError.message : 'DOI 导入失败。');
    } finally {
      setWorking(false);
    }
  }

  async function importBibliography(): Promise<void> {
    const selection = unwrap('选择参考文献', await client.api.files.selectFromDialog());
    const sourcePath = selection?.filePaths[0];
    if (sourcePath === undefined) return;
    setWorking(true);
    try {
      unwrap('导入参考文献', await client.api.research.importBibliography({
        sourcePath, format: bibliographyFormat, projectId: selectedProjectId
      }));
      await loadLibrary();
      setError(null);
    } catch (importError: unknown) {
      setError(importError instanceof Error ? importError.message : '参考文献导入失败。');
    } finally {
      setWorking(false);
    }
  }

  async function exportBibliography(): Promise<void> {
    if (selectedLibraryIds.length === 0) return;
    setWorking(true);
    try {
      setLibraryExport(unwrap('导出参考文献', await client.api.research.exportBibliography({
        ids: selectedLibraryIds, format: bibliographyFormat
      })));
      setError(null);
    } catch (exportError: unknown) {
      setError(exportError instanceof Error ? exportError.message : '参考文献导出失败。');
    } finally {
      setWorking(false);
    }
  }

  async function importRecord(record: ResearchLiterature): Promise<void> {
    setWorking(true);
    try {
      unwrap('导入文献', await client.api.research.importLibraryRecord({
        record, citationKey: (record.doi ?? record.externalId).replace(/[^A-Za-z0-9]+/g, '').slice(0, 40) || 'cite', projectId: selectedProjectId
      }));
      await loadLibrary();
      setError(null);
    } catch (importError: unknown) {
      setError(importError instanceof Error ? importError.message : '文献导入失败。');
    } finally {
      setWorking(false);
    }
  }

  async function linkItem(item: ResearchLibraryItem, linked: boolean): Promise<void> {
    if (selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('关联文献', await client.api.research.linkLibraryItem({ id: item.id, projectId: selectedProjectId, linked }));
      await loadLibrary();
      setError(null);
    } catch (linkError: unknown) {
      setError(linkError instanceof Error ? linkError.message : '文献关联失败。');
    } finally {
      setWorking(false);
    }
  }

  async function openItem(item: ResearchLibraryItem): Promise<void> {
    setWorking(true);
    try {
      await loadReader(item);
      setError(null);
    } catch (openError: unknown) {
      setError(openError instanceof Error ? openError.message : '文献阅读失败。');
    } finally {
      setWorking(false);
    }
  }

  async function loadReader(item: ResearchLibraryItem): Promise<void> {
    const documents = unwrap('文献附件', await client.api.research.listDocuments({ libraryItemId: item.id }));
    setOpenLibraryItem(item);
    setOpenDocuments(documents);
    const ready = documents.find((document) => document.status === 'ready' && document.currentParseId !== null);
    if (ready?.currentParseId === null || ready === undefined) setOpenContent(null);
    else setOpenContent(unwrap('文献全文', await client.api.research.getDocumentContent({ documentId: ready.id, parseId: ready.currentParseId })));
  }

  async function importDocument(): Promise<void> {
    if (openLibraryItem === null) return;
    const selection = unwrap('选择附件', await client.api.files.selectFromDialog());
    const sourcePath = selection?.filePaths[0];
    if (sourcePath === undefined) return;
    setWorking(true);
    try {
      const imported = unwrap('导入附件', await client.api.research.importDocument({
        target: 'library-item', sourcePath, libraryItemId: openLibraryItem.id, projectId: selectedProjectId
      }));
      unwrap('解析附件', await client.api.research.parseDocument({ documentId: imported.id }));
      await loadReader(openLibraryItem);
      setError(null);
    } catch (importError: unknown) {
      setError(importError instanceof Error ? importError.message : '附件导入失败。');
    } finally {
      setWorking(false);
    }
  }


  async function selectIdea(artifactId: string): Promise<void> {
    setIdeaArtifactId(artifactId);
    const canvas = unwrap('Idea Canvas', await client.api.research.getIdeaCanvas({ artifactId }));
    setIdeaCanvas(canvas);
    setIdeaDraft(canvas === null ? emptyIdeaDraft(artifactId) : canvasToDraft(canvas));
  }

  async function createIdea(): Promise<void> {
    if (selectedProjectId === null || workflow === null) return;
    setWorking(true);
    try {
      if (workflow.currentStage !== 'ideation') {
        unwrap('进入构思阶段', await client.api.research.transitionWorkflow({ projectId: selectedProjectId, expectedStage: workflow.currentStage, action: 'move', targetStage: 'ideation' }));
      }
      const current = unwrap('科研流程', await client.api.research.getWorkflow({ id: selectedProjectId }));
      if (current.stages.find((stage) => stage.stage === 'ideation')?.status === 'ready') {
        unwrap('开始构思', await client.api.research.transitionWorkflow({ projectId: selectedProjectId, expectedStage: 'ideation', action: 'start' }));
      }
      const artifact = unwrap('创建画布', await client.api.research.createArtifact({ projectId: selectedProjectId, stage: 'ideation', kind: 'idea_canvas', title: 'Idea Canvas', path: null }));
      await refreshProject(selectedProjectId);
      setIdeaArtifactId(artifact.id);
      setIdeaCanvas(null);
      setIdeaDraft(emptyIdeaDraft(artifact.id));
      setError(null);
    } catch (createError: unknown) {
      setError(createError instanceof Error ? createError.message : '创建 Idea Canvas 失败。');
    } finally {
      setWorking(false);
    }
  }

  async function saveIdea(): Promise<void> {
    if (ideaDraft === null) return;
    setWorking(true);
    try {
      const saved = unwrap('保存画布', await client.api.research.saveIdeaCanvas(ideaDraft));
      setIdeaCanvas(saved);
      setIdeaDraft(canvasToDraft(saved));
      if (selectedProjectId !== null) await refreshProject(selectedProjectId);
      setError(null);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : '保存 Idea Canvas 失败。');
    } finally {
      setWorking(false);
    }
  }

  async function promoteIdea(): Promise<void> {
    if (ideaCanvas === null) return;
    setWorking(true);
    try {
      const promoted = unwrap('晋升画布', await client.api.research.promoteIdeaCanvas({ artifactId: ideaCanvas.artifactId, expectedVersion: ideaCanvas.version }));
      setProjects((current) => [promoted.project, ...current.filter((item) => item.id !== promoted.project.id)]);
      setSelectedProjectId(promoted.project.id);
      setError(null);
    } catch (promoteError: unknown) {
      setError(promoteError instanceof Error ? promoteError.message : '晋升 Idea Canvas 失败。');
    } finally {
      setWorking(false);
    }
  }



  async function loadTemplates(projectId = selectedProjectId, templateId = selectedTemplateId): Promise<void> {
    if (projectId === null) {
      setTemplates([]);
      setTemplateFiles([]);
      setSelectedTemplateId(null);
      setOpenTemplateFile(null);
      return;
    }
    const listed = unwrap('模板', await client.api.research.listTemplates({ projectId }));
    setTemplates(listed);
    const selected = listed.find((item) => item.id === templateId) ?? listed[0] ?? null;
    if (selected === null) {
      setSelectedTemplateId(null);
      setTemplateFiles([]);
      setOpenTemplateFile(null);
      return;
    }
    setSelectedTemplateId(selected.id);
    setTemplateFiles(unwrap('模板文件', await client.api.research.getTemplateFiles({ projectId, templateId: selected.id })));
  }

  async function importTemplate(): Promise<void> {
    if (selectedProjectId === null) return;
    const selection = unwrap('选择模板', await client.api.files.selectFromDialog());
    const sourcePath = selection?.filePaths[0];
    if (sourcePath === undefined) return;
    setWorking(true);
    try {
      const imported = unwrap('导入模板', await client.api.research.importTemplate({ projectId: selectedProjectId, sourcePath }));
      setSelectedTemplateId(imported.id);
      await loadTemplates(selectedProjectId, imported.id);
      setError(null);
    } catch (importError: unknown) {
      setError(importError instanceof Error ? importError.message : '导入模板失败。');
    } finally {
      setWorking(false);
    }
  }

  async function openTemplateFilePath(path: string): Promise<void> {
    if (selectedProjectId === null || selectedTemplateId === null) return;
    setWorking(true);
    try {
      setOpenTemplateFile(unwrap('读取模板文件', await client.api.research.readTemplateFile({ projectId: selectedProjectId, templateId: selectedTemplateId, path })));
      setError(null);
    } catch (readError: unknown) {
      setError(readError instanceof Error ? readError.message : '读取模板文件失败。');
    } finally {
      setWorking(false);
    }
  }

  async function saveTemplateFile(): Promise<void> {
    if (selectedProjectId === null || selectedTemplateId === null || openTemplateFile === null) return;
    setWorking(true);
    try {
      const saved = unwrap('保存模板文件', await client.api.research.saveTemplateFile({
        projectId: selectedProjectId, templateId: selectedTemplateId, path: openTemplateFile.path,
        content: openTemplateFile.content, expectedHash: openTemplateFile.sha256
      }));
      setOpenTemplateFile(saved);
      await loadTemplates(selectedProjectId, selectedTemplateId);
      setError(null);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : '保存模板文件失败。');
    } finally {
      setWorking(false);
    }
  }

  async function compileTemplate(): Promise<void> {
    if (selectedProjectId === null || selectedTemplateId === null) return;
    setWorking(true);
    try {
      unwrap('编译模板', await client.api.research.compileTemplate({ projectId: selectedProjectId, templateId: selectedTemplateId }));
      await loadTemplates(selectedProjectId, selectedTemplateId);
      setError(null);
    } catch (compileError: unknown) {
      setError(compileError instanceof Error ? compileError.message : '编译模板失败。');
    } finally {
      setWorking(false);
    }
  }

  async function loadExperiments(projectId = selectedProjectId): Promise<void> {
    if (projectId === null) {
      setExperiments([]);
      setSelectedExperimentId(null);
      setExperimentLog(null);
      return;
    }
    setExperiments(unwrap('实验运行', await client.api.research.listExperiments({ projectId, limit: 100 })));
  }

  async function startExperiment(): Promise<void> {
    if (selectedProjectId === null) return;
    const sourcePath = experimentDraft.sourcePath.trim();
    const timeoutMs = Number(experimentDraft.timeoutMs);
    if (sourcePath.length === 0 || !Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 3_600_000) {
      setError('源文件必须填写，超时需在 1000 到 3600000 毫秒之间。');
      return;
    }
    if (experimentDraft.engine === 'matplotlib') {
      const widthInches = Number(experimentDraft.widthInches);
      const heightInches = Number(experimentDraft.heightInches);
      const dpi = Number(experimentDraft.dpi);
      const seed = Number(experimentDraft.seed);
      if (
        !Number.isFinite(widthInches) || widthInches < 1 || widthInches > 24
        || !Number.isFinite(heightInches) || heightInches < 1 || heightInches > 24
        || !Number.isInteger(dpi) || dpi < 72 || dpi > 1200
        || !Number.isInteger(seed) || seed < 0 || seed > 4294967295
      ) {
        setError('图稿尺寸需在 1–24 英寸，DPI 72–1200，随机种子为非负整数。');
        return;
      }
    }
    setWorking(true);
    try {
      const runtime = experimentRuntime(experimentDraft);
      const environment = unwrap('实验环境', await client.api.research.inspectExperimentEnvironment({
        projectId: selectedProjectId, runtime
      }));
      const figure = experimentDraft.engine === 'matplotlib' ? {
        widthInches: Number(experimentDraft.widthInches),
        heightInches: Number(experimentDraft.heightInches),
        dpi: Number(experimentDraft.dpi),
        seed: Number(experimentDraft.seed)
      } : undefined;
      const started = unwrap('启动实验', await client.api.research.startExperiment({
        projectId: selectedProjectId,
        requestId: crypto.randomUUID(),
        label: experimentDraft.label.trim() || sourcePath,
        engine: experimentDraft.engine,
        runtime,
        sourcePath,
        inputPaths: parseRelativePaths(experimentDraft.inputPaths),
        arguments: [],
        parameters: {},
        expectedEnvironmentHash: environment.hash,
        timeoutMs,
        network: experimentDraft.engine === 'matplotlib' ? 'disabled' : experimentDraft.network,
        ...(figure === undefined ? {} : { figure })
      }));
      setSelectedExperimentId(started.id);
      setExperimentLog(null);
      await loadExperiments(selectedProjectId);
      setError(null);
    } catch (startError: unknown) {
      setError(startError instanceof Error ? startError.message : '实验启动失败。');
    } finally {
      setWorking(false);
    }
  }

  async function cancelExperiment(runId: string): Promise<void> {
    if (selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('取消实验', await client.api.research.cancelExperiment({ projectId: selectedProjectId, runId }));
      await loadExperiments(selectedProjectId);
      setError(null);
    } catch (cancelError: unknown) {
      setError(cancelError instanceof Error ? cancelError.message : '取消实验失败。');
    } finally {
      setWorking(false);
    }
  }

  async function publishExperiment(runId: string): Promise<void> {
    if (selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('发布实验', await client.api.research.publishExperiment({ projectId: selectedProjectId, runId }));
      await loadExperiments(selectedProjectId);
      setError(null);
    } catch (publishError: unknown) {
      setError(publishError instanceof Error ? publishError.message : '发布实验失败。');
    } finally {
      setWorking(false);
    }
  }

  async function publishExperimentFigure(runId: string): Promise<void> {
    if (selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('发布图稿', await client.api.research.publishFigure({ projectId: selectedProjectId, runId, replacesFigureId: null }));
      await loadExperiments(selectedProjectId);
      setError(null);
    } catch (publishError: unknown) {
      setError(publishError instanceof Error ? publishError.message : '发布图稿失败。');
    } finally {
      setWorking(false);
    }
  }

  async function readExperimentLog(runId: string): Promise<void> {
    if (selectedProjectId === null) return;
    setWorking(true);
    try {
      const run = unwrap('实验运行', await client.api.research.getExperiment({ projectId: selectedProjectId, runId }));
      const logFile = run.files.find((file) => file.area === 'log' && file.path === 'stdout.txt')
        ?? run.files.find((file) => file.area === 'log' && file.path === 'stderr.txt')
        ?? run.files.find((file) => file.area === 'log');
      if (logFile === undefined) {
        setError('这次运行还没有日志。');
        return;
      }
      setSelectedExperimentId(runId);
      setExperimentLog(unwrap('实验日志', await client.api.research.readExperimentFile({
        projectId: selectedProjectId, runId, area: logFile.area, path: logFile.path
      })));
      setError(null);
    } catch (readError: unknown) {
      setError(readError instanceof Error ? readError.message : '读取实验日志失败。');
    } finally {
      setWorking(false);
    }
  }

  async function loadProduction(projectId = selectedProjectId): Promise<void> {
    if (projectId === null) {
      setFigures([]);
      setExports([]);
      return;
    }
    const [figureResult, exportResult] = await Promise.all([
      client.api.research.listFigures({ projectId, limit: 100 }),
      client.api.research.listExports({ projectId, limit: 40 })
    ]);
    setFigures(unwrap('图稿', figureResult));
    setExports(unwrap('导出作业', exportResult));
  }

  async function prepareExport(): Promise<void> {
    if (selectedProjectId === null) return;
    const manuscript = artifacts.find((item) => item.kind === 'manuscript' && item.status === 'approved');
    if (manuscript === undefined || exportTitle.trim().length === 0) return;
    setWorking(true);
    try {
      unwrap('准备导出', await client.api.research.prepareExport({
        projectId: selectedProjectId,
        requestId: crypto.randomUUID(),
        title: exportTitle.trim(),
        manuscriptArtifactId: manuscript.id,
        figureIds: selectedFigureIds,
        template: { kind: 'default', language: projects.find((item) => item.id === selectedProjectId)?.language ?? 'zh' }
      }));
      await loadProduction(selectedProjectId);
      setError(null);
    } catch (prepareError: unknown) {
      setError(prepareError instanceof Error ? prepareError.message : '准备导出失败。');
    } finally {
      setWorking(false);
    }
  }

  async function publishExport(exportId: string): Promise<void> {
    if (selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('发布导出', await client.api.research.publishExport({ projectId: selectedProjectId, exportId, replacesExportId: null }));
      await loadProduction(selectedProjectId);
      setError(null);
    } catch (publishError: unknown) {
      setError(publishError instanceof Error ? publishError.message : '发布导出失败。');
    } finally {
      setWorking(false);
    }
  }

  async function writeExport(exportId: string): Promise<void> {
    if (selectedProjectId === null || destinationPath.trim().length === 0) return;
    setWorking(true);
    try {
      unwrap('保存 ZIP', await client.api.research.writeExport({
        projectId: selectedProjectId, exportId, destinationPath: destinationPath.trim()
      }));
      await loadProduction(selectedProjectId);
      setError(null);
    } catch (writeError: unknown) {
      setError(writeError instanceof Error ? writeError.message : '保存 ZIP 失败。');
    } finally {
      setWorking(false);
    }
  }

  async function searchKnowledge(): Promise<void> {
    if (knowledgeQuery.trim().length === 0) return;
    setWorking(true);
    try {
      const result = await client.api.research.searchKnowledge({
        query: knowledgeQuery.trim(),
        projectId: selectedProjectId,
        limit: 20,
        embeddingConfigId: null
      });
      setKnowledgeResult(unwrap('知识库检索', result));
      setError(null);
    } catch (searchError: unknown) {
      setError(searchError instanceof Error ? searchError.message : '知识库检索失败。');
    } finally {
      setWorking(false);
    }
  }

  async function captureEvidence(chunkId: string): Promise<void> {
    if (selectedProjectId === null) return;
    setWorking(true);
    try {
      unwrap('捕获证据', await client.api.research.captureEvidence({ projectId: selectedProjectId, chunkId }));
      setEvidence(unwrap('证据', await client.api.research.listEvidence({ projectId: selectedProjectId })));
      setError(null);
    } catch (captureError: unknown) {
      setError(captureError instanceof Error ? captureError.message : '证据捕获失败。');
    } finally {
      setWorking(false);
    }
  }

  async function loadEmbeddingConfigs(): Promise<void> {
    try {
      const result = await client.api.research.listEmbeddingConfigs();
      const configs = unwrap('嵌入配置', result);
      setEmbeddingConfigs(configs);
      const active = configs.find((config) => config.enabled) ?? configs[0];
      if (active !== undefined) {
        setEmbeddingId(active.id);
        setEmbeddingName(active.name);
        setEmbeddingBaseUrl(active.baseUrl);
        setEmbeddingModel(active.model);
        setEmbeddingDimensions(String(active.dimensions));
      }
    } catch (loadError: unknown) {
      setError(loadError instanceof Error ? loadError.message : '嵌入配置读取失败。');
    }
  }

  async function saveEmbeddingConfig(): Promise<void> {
    const dimensions = Number(embeddingDimensions);
    if (!Number.isInteger(dimensions) || dimensions <= 0 || embeddingApiKey.trim().length === 0) {
      setError('嵌入维度必须为正整数，API Key 不能为空。');
      return;
    }
    setWorking(true);
    try {
      const result = await client.api.research.saveEmbeddingConfig({
        id: embeddingId.trim(),
        name: embeddingName.trim(),
        baseUrl: embeddingBaseUrl.trim(),
        model: embeddingModel.trim(),
        dimensions,
        apiKey: embeddingApiKey.trim(),
        enabled: true
      });
      const config = unwrap('保存嵌入配置', result);
      setEmbeddingConfigs((current) => [config, ...current.filter((item) => item.id !== config.id)]);
      setEmbeddingApiKey('');
      setError(null);
    } catch (saveError: unknown) {
      setError(saveError instanceof Error ? saveError.message : '嵌入配置保存失败。');
    } finally {
      setWorking(false);
    }
  }

  return (
    <section className="canvas-stage research-page" data-testid="research-view">
      <header className="research-header">
        <div>
          <div className="eyebrow">RESEARCH WORKBENCH</div>
          <h1>科研工作台</h1>
          <p>论文、证据、实验、图稿和 LaTeX 文稿，沿同一条可恢复流程推进。</p>
        </div>
        <button className="action-button research-create-button" type="button" onClick={() => setCreateOpen((open) => !open)}>
          <Plus aria-hidden="true" size={16} />
          新建项目
        </button>
      </header>

      <nav className="research-tabs" aria-label="科研工作台视图">
        {([
          ['workflow', '流程'],
          ['library', '文献库'],
          ['ideas', '构思'],
          ['experiments', '实验'],
          ['editor', '文稿'],
          ['production', '图稿导出'],
          ['knowledge', '知识库'],
          ['embedding', '嵌入配置']
        ] as const).map(([tab, label]) => (
          <button className={activeTab === tab ? 'research-tab research-tab--active' : 'research-tab'} key={tab} type="button" onClick={() => {
            setActiveTab(tab);
            if (tab === 'embedding') void loadEmbeddingConfigs();
            if (tab === 'library') void loadLibrary();
            if (tab === 'experiments') void loadExperiments();
            if (tab === 'production') void loadProduction();
            if (tab === 'editor') void loadTemplates();
          }}>
            {label}
          </button>
        ))}
      </nav>

      {createOpen ? (
        <section className="research-create-panel" aria-label="新建科研项目">
          <label>
            项目标题
            <input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="例如：多模态证据检索" />
          </label>
          <label>
            研究目标
            <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写下要解释的问题和预期贡献" rows={3} />
          </label>
          <label>
            项目语言
            <select data-testid="research-create-language" value={language} onChange={(event) => setLanguage(event.target.value === 'en' ? 'en' : 'zh')}>
              <option value="zh">中文</option>
              <option value="en">English</option>
            </select>
          </label>
          <div className="research-form-actions">
            <button className="action-button" type="button" onClick={() => setCreateOpen(false)}>
              取消
            </button>
            <button className="action-button action-button--primary" type="button" disabled={working} onClick={() => void createProject()}>
              创建项目
            </button>
          </div>
        </section>
      ) : null}

      {error === null ? null : (
        <div className="research-alert" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{error}</span>
          <button type="button" title="关闭错误" aria-label="关闭错误" onClick={() => setError(null)}>
            <X aria-hidden="true" size={15} />
          </button>
        </div>
      )}

      {activeTab === 'workflow' && loading ? <div className="research-loading">正在读取科研项目…</div> : null}
      {activeTab === 'workflow' && !loading && projects.length === 0 ? (
        <div className="research-empty">
          <div className="research-empty-mark">∑</div>
          <h2>从一个研究问题开始</h2>
          <p>创建项目后，Roc 会持续记录当前阶段、审核节点和每个产物的来源。</p>
          <button className="action-button action-button--primary" type="button" onClick={() => setCreateOpen(true)}>
            <Plus aria-hidden="true" size={16} />
            新建第一个项目
          </button>
        </div>
      ) : null}

      {activeTab === 'workflow' && !loading && projects.length > 0 ? (
        <div className="research-layout">
          <aside className="research-projects" aria-label="科研项目列表">
            <div className="research-section-label">项目</div>
            {projects.map((project) => (
              <button
                className={project.id === selectedProjectId ? 'research-project-row research-project-row--active' : 'research-project-row'}
                key={project.id}
                type="button"
                onClick={() => setSelectedProjectId(project.id)}
              >
                <span className="research-project-row-title">{project.title}</span>
                <span className="research-project-row-meta">
                  {researchStageLabels[project.currentStage]} · {project.status === 'completed' ? '已完成' : '进行中'}
                </span>
              </button>
            ))}
          </aside>

          <main className="research-main">
            {selectedProject === null || workflow === null ? (
              <div className="research-loading">选择项目以读取流程。</div>
            ) : (
              <ResearchWorkflowPanel
                artifacts={artifacts}
                events={events}
                indexStatus={indexStatus}
                instruction={instruction}
                onApprove={(decision) => void transition('approve', decision)}
                onCancelRun={() => void cancelRun()}
                onControlIndex={(action) => void controlIndex(action)}
                onInstructionChange={setInstruction}
                onRetryRun={() => void retryRun()}
                onStartRun={() => void startRun()}
                onTransition={(action, decision) => void transition(action, decision)}
                project={selectedProject}
                runs={runs}
                working={working}
                workflow={workflow}
              />
            )}
          </main>
        </div>
      ) : null}

      {activeTab === 'ideas' ? (
        <ResearchIdeaPanel
          artifacts={artifacts}
          canvas={ideaCanvas}
          draft={ideaDraft}
          evidence={evidence}
          onChange={setIdeaDraft}
          onCreate={() => void createIdea()}
          onPromote={() => void promoteIdea()}
          onSave={() => void saveIdea()}
          onSelect={(artifactId) => void selectIdea(artifactId)}
          selectedArtifactId={ideaArtifactId}
          working={working}
        />
      ) : null}
      {activeTab === 'library' ? (
        <ResearchLibraryPanel
          bibliographyFormat={bibliographyFormat}
          doi={doi}
          exportPreview={libraryExport}
          items={libraryItems}
          onChangeDoi={setDoi}
          onChangeFormat={setBibliographyFormat}
          onExport={() => void exportBibliography()}
          onImportDoi={() => void importDoi()}
          onImportFile={() => void importBibliography()}
          onImportRecord={(record) => void importRecord(record)}
          onImportDocument={() => void importDocument()}
          onLink={(item, linked) => void linkItem(item, linked)}
          onOpen={(item) => void openItem(item)}
          onQueryChange={setLiteratureQuery}
          onSearch={() => void searchLiterature()}
          onSearchLibrary={() => void loadLibrary()}
          onScopeChange={(value) => { setLibraryScope(value); void loadLibrary(selectedProjectId, value); }}
          onToggleSelected={(id) => setSelectedLibraryIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id])}
          openContent={openContent}
          openDocuments={openDocuments}
          openItem={openLibraryItem}
          projectId={selectedProjectId}
          query={literatureQuery}
          results={literatureResults}
          scope={libraryScope}
          selectedIds={selectedLibraryIds}
          working={working}
        />
      ) : null}
      {activeTab === 'experiments' ? (
        <ResearchExperimentPanel
          draft={experimentDraft}
          experiments={experiments}
          log={experimentLog}
          onCancel={(runId) => void cancelExperiment(runId)}
          onChange={setExperimentDraft}
          onPublish={(runId) => void publishExperiment(runId)}
          onPublishFigure={(runId) => void publishExperimentFigure(runId)}
          onReadLog={(runId) => void readExperimentLog(runId)}
          onRefresh={() => void loadExperiments()}
          onSelect={setSelectedExperimentId}
          onStart={() => void startExperiment()}
          projectId={selectedProjectId}
          selectedRunId={selectedExperimentId}
          working={working}
        />
      ) : null}
      {activeTab === 'editor' ? (
        <ResearchEditorPanel
          files={templateFiles}
          onChangeDraft={(value) => setOpenTemplateFile((current) => current === null ? current : { ...current, content: value })}
          onCompile={() => void compileTemplate()}
          onImport={() => void importTemplate()}
          onOpenFile={(path) => void openTemplateFilePath(path)}
          onSave={() => void saveTemplateFile()}
          onSelect={(templateId) => { setSelectedTemplateId(templateId); setOpenTemplateFile(null); void loadTemplates(selectedProjectId, templateId); }}
          openFile={openTemplateFile}
          selectedTemplateId={selectedTemplateId}
          templates={templates}
          working={working}
        />
      ) : null}
      {activeTab === 'production' ? (
        <ResearchProductionPanel
          destinationPath={destinationPath}
          exports={exports}
          figures={figures}
          manuscripts={artifacts.filter((item) => item.kind === 'manuscript')}
          onChangeDestination={setDestinationPath}
          onChangeTitle={setExportTitle}
          onPrepareExport={() => void prepareExport()}
          onPublishExport={(exportId) => void publishExport(exportId)}
          onToggleFigure={(figureId) => setSelectedFigureIds((current) => current.includes(figureId) ? current.filter((id) => id !== figureId) : [...current, figureId])}
          onWriteExport={(exportId) => void writeExport(exportId)}
          selectedFigureIds={selectedFigureIds}
          title={exportTitle}
          working={working}
        />
      ) : null}
      {activeTab === 'knowledge' ? (
        <KnowledgePanel
          evidence={evidence}
          projectId={selectedProjectId}
          query={knowledgeQuery}
          result={knowledgeResult}
          working={working}
          onCapture={(chunkId) => void captureEvidence(chunkId)}
          onQueryChange={setKnowledgeQuery}
          onSearch={() => void searchKnowledge()}
        />
      ) : null}
      {activeTab === 'embedding' ? (
        <EmbeddingPanel
          configs={embeddingConfigs}
          id={embeddingId}
          name={embeddingName}
          baseUrl={embeddingBaseUrl}
          model={embeddingModel}
          dimensions={embeddingDimensions}
          apiKey={embeddingApiKey}
          working={working}
          onIdChange={setEmbeddingId}
          onNameChange={setEmbeddingName}
          onBaseUrlChange={setEmbeddingBaseUrl}
          onModelChange={setEmbeddingModel}
          onDimensionsChange={setEmbeddingDimensions}
          onApiKeyChange={setEmbeddingApiKey}
          onSave={() => void saveEmbeddingConfig()}
        />
      ) : null}
    </section>
  );
}

function KnowledgePanel({
  evidence,
  projectId,
  query,
  result,
  working,
  onCapture,
  onQueryChange,
  onSearch
}: {
  evidence: ResearchEvidence[];
  projectId: string | null;
  query: string;
  result: ResearchKnowledgeSearchResult | null;
  working: boolean;
  onCapture: (chunkId: string) => void;
  onQueryChange: (value: string) => void;
  onSearch: () => void;
}): React.JSX.Element {
  const capturedChunkIds = new Set(evidence.map((item) => item.chunkId));
  return (
    <section className="research-tool-panel" data-testid="research-knowledge-panel">
      <div className="research-tool-heading">
        <div>
          <div className="research-section-label">Knowledge Base</div>
          <h2>知识库</h2>
          <p>关键词和向量混合召回，使用 RRF 合并排序。命中片段可捕获为当前项目证据。</p>
        </div>
        <form className="research-search-form" onSubmit={(event) => { event.preventDefault(); onSearch(); }}>
          <input aria-label="搜索知识库" data-testid="research-knowledge-query" value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="搜索证据、笔记或论文片段" />
          <button className="action-button action-button--primary" disabled={working} type="submit" data-testid="research-knowledge-search">
            <Send aria-hidden="true" size={15} />
            搜索
          </button>
        </form>
      </div>
      <div className="research-knowledge-summary">
        <span>关键词 {result?.keywordCount ?? 0}</span>
        <span>向量 {result?.vectorCount ?? 0}</span>
        <span>{result?.embeddingModel ?? '未启用嵌入模型'}</span>
        <span data-testid="research-evidence-count">已捕获 {evidence.length}</span>
      </div>
      <div className="research-knowledge-list">
        {result === null ? <div className="research-loading">输入查询开始召回证据。</div> : result.hits.map((hit) => (
          <article className="research-knowledge-row" key={hit.chunkId}>
            <div className="research-knowledge-rank">RRF {hit.rrfScore.toFixed(4)}</div>
            <h3>{hit.title}</h3>
            <p>{hit.content}</p>
            <div className="research-literature-meta">
              <span>{hit.sourceType} · {hit.sourceId}</span>
              <span>{hit.locator ?? '未定位'}</span>
              {capturedChunkIds.has(hit.chunkId) ? <span data-testid={`research-evidence-captured-${hit.chunkId}`}>已捕获</span> : (
                <button className="action-button" disabled={working || projectId === null} type="button" data-testid={`research-evidence-capture-${hit.chunkId}`} onClick={() => onCapture(hit.chunkId)}>捕获证据</button>
              )}
            </div>
          </article>
        ))}
      </div>
      {evidence.length === 0 ? null : (
        <div className="research-literature-list" data-testid="research-evidence-list">
          {evidence.map((item) => (
            <article className="research-literature-row" key={item.id}>
              <div className="research-literature-source">{item.locator}</div>
              <h3>{item.title}</h3>
              <p>{item.excerpt}</p>
            </article>
          ))}
        </div>
      )}
    </section>
  );
}

function EmbeddingPanel({
  configs,
  id,
  name,
  baseUrl,
  model,
  dimensions,
  apiKey,
  working,
  onIdChange,
  onNameChange,
  onBaseUrlChange,
  onModelChange,
  onDimensionsChange,
  onApiKeyChange,
  onSave
}: {
  configs: ResearchEmbeddingConfig[];
  id: string;
  name: string;
  baseUrl: string;
  model: string;
  dimensions: string;
  apiKey: string;
  working: boolean;
  onIdChange: (value: string) => void;
  onNameChange: (value: string) => void;
  onBaseUrlChange: (value: string) => void;
  onModelChange: (value: string) => void;
  onDimensionsChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onSave: () => void;
}): React.JSX.Element {
  return (
    <section className="research-tool-panel">
      <div className="research-tool-heading">
        <div>
          <div className="research-section-label">Embedding Provider</div>
          <h2>嵌入模型配置</h2>
          <p>连接 OpenAI 兼容 Embeddings API。Key 只写入本地加密 Secret Store。</p>
        </div>
        <span className="research-config-count">{configs.length} 个配置</span>
      </div>
      <div className="research-config-grid">
        <label>配置 ID<input value={id} onChange={(event) => onIdChange(event.target.value)} /></label>
        <label>名称<input value={name} onChange={(event) => onNameChange(event.target.value)} /></label>
        <label className="research-config-wide">Base URL<input value={baseUrl} onChange={(event) => onBaseUrlChange(event.target.value)} /></label>
        <label>模型<input value={model} onChange={(event) => onModelChange(event.target.value)} /></label>
        <label>向量维度<input inputMode="numeric" value={dimensions} onChange={(event) => onDimensionsChange(event.target.value)} /></label>
        <label className="research-config-wide">API Key<input type="password" value={apiKey} onChange={(event) => onApiKeyChange(event.target.value)} placeholder="保存时写入 Secret Store" /></label>
      </div>
      <div className="research-form-actions">
        <button className="action-button action-button--primary" disabled={working} type="button" onClick={onSave}>保存配置</button>
      </div>
      <div className="research-config-list">
        {configs.map((config) => <div className="research-config-row" key={config.id}><strong>{config.name}</strong><span>{config.model} · {config.dimensions} 维 · {config.keyConfigured ? 'Key 已配置' : '缺少 Key'}</span></div>)}
      </div>
    </section>
  );
}

function parseRelativePaths(value: string): string[] {
  return [...new Set(value.split(/[\n,]/u).map((item) => item.trim()).filter((item) => item.length > 0))];
}

function experimentRuntime(draft: ResearchExperimentDraft): ResearchExperimentRuntime {
  if (draft.engine === 'r') {
    return { kind: 'renv', rootPath: draft.rRootPath.trim(), libraryPath: draft.rLibraryPath.trim() };
  }
  if (draft.engine === 'julia') {
    return { kind: 'julia', rootPath: draft.juliaRootPath.trim(), depotPath: draft.juliaDepotPath.trim() };
  }
  return { kind: draft.runtimeKind === 'uv' ? 'uv' : 'bundled-python' };
}
