import { CircleAlert, Plus, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { ResearchEditorPanel } from './ResearchEditorPanel';
import { ResearchEmbeddingPanel } from './ResearchEmbeddingPanel';
import { ResearchExperimentPanel } from './ResearchExperimentPanel';
import { ResearchIdeaPanel } from './ResearchIdeaPanel';
import { ResearchKnowledgePanel } from './ResearchKnowledgePanel';
import { ResearchLibraryPanel } from './ResearchLibraryPanel';
import { ResearchManuscriptPanel } from './ResearchManuscriptPanel';
import { ResearchPolicyPanel } from './ResearchPolicyPanel';
import { ResearchProductionPanel } from './ResearchProductionPanel';
import { ResearchWorkflowPanel } from './ResearchWorkflowPanel';
import { createResearchSession, type ResearchSession } from './research-session';
import { researchStageLabels } from './research-workflow';

export function ResearchView({ client, state }: { client: RocClient; state: LoadedState }): React.JSX.Element {
  const surfacesRef = useRef<{ client: RocClient; surfaces: ResearchSession } | null>(null);
  if (surfacesRef.current === null || surfacesRef.current.client !== client) {
    surfacesRef.current = { client, surfaces: createResearchSession(client) };
  }
  const surfaces = surfacesRef.current.surfaces;
  const { workbench, library, knowledge, experiments, policies, templates, manuscript, ideas, production } = surfaces;
  const [workbenchSnapshot, setWorkbenchSnapshot] = useState(workbench.getSnapshot());
  const [librarySnapshot, setLibrarySnapshot] = useState(library.getSnapshot());
  const [knowledgeSnapshot, setKnowledgeSnapshot] = useState(knowledge.getSnapshot());
  const [experimentSnapshot, setExperimentSnapshot] = useState(experiments.getSnapshot());
  const [policySnapshot, setPolicySnapshot] = useState(policies.getSnapshot());
  const [templateSnapshot, setTemplateSnapshot] = useState(templates.getSnapshot());
  const [manuscriptSnapshot, setManuscriptSnapshot] = useState(manuscript.getSnapshot());
  const [ideaSnapshot, setIdeaSnapshot] = useState(ideas.getSnapshot());
  const [productionSnapshot, setProductionSnapshot] = useState(production.getSnapshot());
  const [modelsReady, setModelsReady] = useState<boolean | null>(null);
  const [modelsDownloading, setModelsDownloading] = useState(false);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const {
    projects,
    project: selectedProject,
    workflow,
    events,
    runs,
    artifacts,
    indexStatus,
    instruction,
    loading,
    working: workbenchWorking,
    error: workbenchError
  } = workbenchSnapshot;
  const selectedProjectId = selectedProject?.id ?? null;
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [language, setLanguage] = useState<'zh' | 'en'>('zh');
  const [activeTab, setActiveTab] = useState<'workflow' | 'library' | 'ideas' | 'experiments' | 'manuscript' | 'editor' | 'production' | 'knowledge' | 'embedding' | 'policies'>('workflow');

  useEffect(() => {
    const unsubscribers = [
      workbench.subscribe(setWorkbenchSnapshot),
      library.subscribe(setLibrarySnapshot),
      knowledge.subscribe(setKnowledgeSnapshot),
      experiments.subscribe(setExperimentSnapshot),
      policies.subscribe(setPolicySnapshot),
      templates.subscribe(setTemplateSnapshot),
      manuscript.subscribe(setManuscriptSnapshot),
      ideas.subscribe(setIdeaSnapshot),
      production.subscribe(setProductionSnapshot)
    ];
    return () => {
      for (const unsubscribe of unsubscribers) unsubscribe();
    };
  }, [workbench, library, knowledge, experiments, policies, templates, manuscript, ideas, production]);

  useEffect(() => {
    void workbench.load();
  }, [workbench]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const result = await client.api.research.getModelsStatus();
      if (cancelled) return;
      if (!result.ok) {
        setModelsReady(false);
        setModelsError(result.error.message);
        return;
      }
      setModelsReady(result.data.ready);
      setModelsDownloading(result.data.downloading);
      setModelsError(result.data.error);
    })();
    return () => {
      cancelled = true;
    };
  }, [client]);

  useEffect(() => {
    surfaces.bindProject(selectedProjectId);
    void knowledge.loadEvidence();
  }, [knowledge, selectedProjectId, surfaces]);

  async function createProject(): Promise<void> {
    await workbench.createProject({
      title,
      description,
      workspacePath: state.workspace?.path ?? null,
      language
    });
    if (workbench.getSnapshot().error === null) {
      setTitle('');
      setDescription('');
      setCreateOpen(false);
    }
  }

  const surfaceError = librarySnapshot.error
    ?? knowledgeSnapshot.error
    ?? experimentSnapshot.error
    ?? policySnapshot.error
    ?? templateSnapshot.error
    ?? manuscriptSnapshot.error
    ?? ideaSnapshot.error
    ?? productionSnapshot.error
    ?? workbenchError;
  const working = workbenchWorking
    || librarySnapshot.working
    || knowledgeSnapshot.working
    || experimentSnapshot.working
    || policySnapshot.working
    || templateSnapshot.working
    || manuscriptSnapshot.working
    || ideaSnapshot.working
    || productionSnapshot.working;

  function clearErrors(): void {
    library.clearError();
    knowledge.clearError();
    experiments.clearError();
    policies.clearError();
    templates.clearError();
    manuscript.clearError();
    ideas.clearError();
    production.clearError();
    workbench.clearError();
  }

  async function downloadModels(): Promise<void> {
    setModelsDownloading(true);
    setModelsError(null);
    const result = await client.api.research.downloadModels();
    if (!result.ok) {
      setModelsReady(false);
      setModelsDownloading(false);
      setModelsError(result.error.message);
      return;
    }
    setModelsReady(result.data.ready);
    setModelsDownloading(result.data.downloading);
    setModelsError(result.data.error);
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

      {modelsReady === false ? (
        <div className="research-alert" role="status" data-testid="research-models-banner">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{modelsDownloading ? '正在下载解析模型…' : '解析模型未安装。文档解析需要先下载模型。'}</span>
          <button className="action-button action-button--primary" type="button" disabled={modelsDownloading} data-testid="research-models-download" onClick={() => void downloadModels()}>
            {modelsDownloading ? '下载中' : '下载模型'}
          </button>
        </div>
      ) : null}
      {modelsError === null || modelsDownloading || modelsError === 'research_models_unavailable' ? null : (
        <div className="research-alert" role="alert" data-testid="research-models-error">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{modelsError}</span>
        </div>
      )}

      <nav className="research-tabs" aria-label="科研工作台视图">
        {([
          ['workflow', '流程'],
          ['library', '文献库'],
          ['ideas', '构思'],
          ['experiments', '实验'],
          ['manuscript', '正文'],
          ['editor', '文稿'],
          ['production', '图稿导出'],
          ['knowledge', '知识库'],
          ['embedding', '嵌入配置'],
          ['policies', '阶段模型']
        ] as const).map(([tab, label]) => (
          <button className={activeTab === tab ? 'research-tab research-tab--active' : 'research-tab'} key={tab} type="button" onClick={() => {
            setActiveTab(tab);
            if (tab === 'embedding') void knowledge.loadEmbeddingConfigs();
            if (tab === 'library') void library.load();
            if (tab === 'experiments') void experiments.load();
            if (tab === 'production') void production.load();
            if (tab === 'editor') void templates.load();
            if (tab === 'policies') void policies.load();
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
            <textarea spellCheck={true} value={description} onChange={(event) => setDescription(event.target.value)} placeholder="写下要解释的问题和预期贡献" rows={3} />
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

      {surfaceError === null ? null : (
        <div className="research-alert" role="alert">
          <CircleAlert aria-hidden="true" size={16} />
          <span>{surfaceError}</span>
          <button type="button" title="关闭错误" aria-label="关闭错误" onClick={clearErrors}>
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
                onClick={() => void workbench.selectProject(project.id)}
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
                onApprove={(decision) => void workbench.transition('approve', { reviewDecision: decision })}
                onCancelRun={() => void workbench.cancelRun()}
                onControlIndex={(action) => void workbench.controlIndex(action)}
                onInstructionChange={(value) => workbench.setInstruction(value)}
                onRetryRun={() => void workbench.retryRun()}
                onStartRun={() => void workbench.startRun()}
                onTransition={(action, decision) => void workbench.transition(action, decision === undefined ? undefined : { reviewDecision: decision })}
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
          canvas={ideaSnapshot.canvas}
          draft={ideaSnapshot.draft}
          evidence={knowledgeSnapshot.evidence}
          onChange={(draft) => ideas.setDraft(draft)}
          onCreate={() => void ideas.create()}
          onPromote={() => void ideas.promote()}
          onSave={() => void ideas.save()}
          onSelect={(artifactId) => void ideas.select(artifactId)}
          selectedArtifactId={ideaSnapshot.selectedArtifactId}
          working={working}
        />
      ) : null}
      {activeTab === 'library' ? (
        <ResearchLibraryPanel
          bibliographyFormat={librarySnapshot.bibliographyFormat}
          doi={librarySnapshot.doi}
          exportPreview={librarySnapshot.exportPreview}
          items={librarySnapshot.items}
          onChangeDoi={(value) => library.setDoi(value)}
          onChangeFormat={(value) => library.setFormat(value)}
          onExport={() => void library.exportBibliography()}
          onImportDoi={() => void library.importDoi()}
          onImportFile={() => void library.importBibliography()}
          onImportRecord={(record) => void library.importRecord(record)}
          onImportDocument={() => void library.importDocument()}
          onLink={(item, linked) => void library.link(item, linked)}
          onOpen={(item) => void library.open(item)}
          onQueryChange={(value) => library.setQuery(value)}
          onSearch={() => void library.search()}
          onScopeChange={(value) => { void library.setScope(value); }}
          onToggleSelected={(id) => library.toggleSelected(id)}
          openContent={librarySnapshot.openContent}
          openDocuments={librarySnapshot.openDocuments}
          openItem={librarySnapshot.openItem}
          projectId={selectedProjectId}
          query={librarySnapshot.query}
          results={librarySnapshot.results}
          scope={librarySnapshot.scope}
          selectedIds={librarySnapshot.selectedIds}
          working={working}
        />
      ) : null}
      {activeTab === 'experiments' ? (
        <ResearchExperimentPanel
          draft={experimentSnapshot.draft}
          experiments={experimentSnapshot.experiments}
          log={experimentSnapshot.log}
          onCancel={(runId) => void experiments.cancel(runId)}
          onChange={(draft) => experiments.setDraft(draft)}
          onPublish={(runId) => void experiments.publish(runId)}
          onPublishFigure={(runId) => void experiments.publishFigure(runId)}
          onReadLog={(runId) => void experiments.readLog(runId)}
          onRefresh={() => void experiments.load()}
          onSelect={(runId) => experiments.select(runId)}
          onStart={() => void experiments.start()}
          projectId={selectedProjectId}
          selectedRunId={experimentSnapshot.selectedRunId}
          working={working}
        />
      ) : null}
      {activeTab === 'manuscript' ? (
        <ResearchManuscriptPanel
          artifacts={artifacts}
          claims={manuscriptSnapshot.claims}
          draft={manuscriptSnapshot.draft}
          evidence={knowledgeSnapshot.evidence}
          manuscript={manuscriptSnapshot.manuscript}
          onChange={(draft) => manuscript.setDraft(draft)}
          onCreate={() => void manuscript.create()}
          onCreateClaim={() => void manuscript.createClaim()}
          onSave={() => void manuscript.save()}
          onSelect={(artifactId) => void manuscript.select(artifactId)}
          selectedArtifactId={manuscriptSnapshot.selectedArtifactId}
          working={working}
        />
      ) : null}
      {activeTab === 'editor' ? (
        <ResearchEditorPanel
          files={templateSnapshot.files}
          onChangeDraft={(value) => templates.setOpenContent(value)}
          onCompile={() => void templates.compile()}
          onImport={() => void templates.importTemplate()}
          onOpenFile={(path) => void templates.openFile(path)}
          onSave={() => void templates.save()}
          onSelect={(templateId) => { void templates.select(templateId); }}
          openFile={templateSnapshot.openFile}
          selectedTemplateId={templateSnapshot.selectedTemplateId}
          templates={templateSnapshot.templates}
          working={working}
        />
      ) : null}
      {activeTab === 'production' ? (
        <ResearchProductionPanel
          destinationPath={productionSnapshot.destinationPath}
          exports={productionSnapshot.exports}
          figures={productionSnapshot.figures}
          manuscripts={artifacts.filter((item) => item.kind === 'manuscript')}
          onChangeDestination={(value) => production.setDestination(value)}
          onChangeTitle={(value) => production.setTitle(value)}
          onPrepareExport={() => void production.prepare()}
          onPublishExport={(exportId) => void production.publish(exportId)}
          onToggleFigure={(figureId) => production.toggleFigure(figureId)}
          onWriteExport={(exportId) => void production.write(exportId)}
          selectedFigureIds={productionSnapshot.selectedFigureIds}
          title={productionSnapshot.title}
          working={working}
        />
      ) : null}
      {activeTab === 'knowledge' ? (
        <ResearchKnowledgePanel
          evidence={knowledgeSnapshot.evidence}
          projectId={selectedProjectId}
          query={knowledgeSnapshot.query}
          result={knowledgeSnapshot.result}
          working={working}
          onCapture={(chunkId) => void knowledge.capture(chunkId)}
          onQueryChange={(value) => knowledge.setQuery(value)}
          onSearch={() => void knowledge.search()}
        />
      ) : null}
      {activeTab === 'policies' ? (
        <ResearchPolicyPanel
          draft={policySnapshot.draft}
          onChange={(draft) => policies.setDraft(draft)}
          onSave={() => void policies.save()}
          onSelect={(stage) => policies.select(stage)}
          policies={policySnapshot.policies}
          providers={state.providers}
          working={working}
        />
      ) : null}
      {activeTab === 'embedding' ? (
        <ResearchEmbeddingPanel
          configs={knowledgeSnapshot.embedding.configs}
          id={knowledgeSnapshot.embedding.id}
          name={knowledgeSnapshot.embedding.name}
          baseUrl={knowledgeSnapshot.embedding.baseUrl}
          model={knowledgeSnapshot.embedding.model}
          dimensions={knowledgeSnapshot.embedding.dimensions}
          apiKey={knowledgeSnapshot.embedding.apiKey}
          working={working}
          onIdChange={(value) => knowledge.setEmbeddingField('id', value)}
          onNameChange={(value) => knowledge.setEmbeddingField('name', value)}
          onBaseUrlChange={(value) => knowledge.setEmbeddingField('baseUrl', value)}
          onModelChange={(value) => knowledge.setEmbeddingField('model', value)}
          onDimensionsChange={(value) => knowledge.setEmbeddingField('dimensions', value)}
          onApiKeyChange={(value) => knowledge.setEmbeddingField('apiKey', value)}
          onSave={() => void knowledge.saveEmbeddingConfig()}
        />
      ) : null}
    </section>
  );
}
