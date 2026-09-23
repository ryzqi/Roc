import { CircleAlert, X } from 'lucide-react';
import { forwardRef, lazy, Suspense, useEffect, useImperativeHandle, useState } from 'react';

import { TextArea } from '../../components/ui';
import type { LoadedState } from '../../loaded-state';
import type { ResearchSession } from './research-session';
import {
  RESEARCH_STAGE_GROUPS,
  isCurrentStageGroup,
  stageGroupWriteAllowed,
  type ResearchStageGroupId,
  type ResearchStageTab
} from './research-stage-groups';
import {
  currentStageState,
  formatResearchTime,
  latestCurrentRun,
  nextActionLabel,
  researchRunStatusLabels,
  researchStageLabels,
  researchStageStatusLabels,
  reviewDecisionRequired
} from './research-workflow';

const ResearchEditorPanel = lazy(() => import('./ResearchEditorPanel').then((module) => ({ default: module.ResearchEditorPanel })));
const ResearchEmbeddingPanel = lazy(() => import('./ResearchEmbeddingPanel').then((module) => ({ default: module.ResearchEmbeddingPanel })));
const ResearchExperimentPanel = lazy(() => import('./ResearchExperimentPanel').then((module) => ({ default: module.ResearchExperimentPanel })));
const ResearchFigurePanel = lazy(() => import('./ResearchFigurePanel').then((module) => ({ default: module.ResearchFigurePanel })));
const ResearchIdeaPanel = lazy(() => import('./ResearchIdeaPanel').then((module) => ({ default: module.ResearchIdeaPanel })));
const ResearchKnowledgePanel = lazy(() => import('./ResearchKnowledgePanel').then((module) => ({ default: module.ResearchKnowledgePanel })));
const ResearchLibraryPanel = lazy(() => import('./ResearchLibraryPanel').then((module) => ({ default: module.ResearchLibraryPanel })));
const ResearchManuscriptPanel = lazy(() => import('./ResearchManuscriptPanel').then((module) => ({ default: module.ResearchManuscriptPanel })));
const ResearchPolicyPanel = lazy(() => import('./ResearchPolicyPanel').then((module) => ({ default: module.ResearchPolicyPanel })));
const ResearchProductionPanel = lazy(() => import('./ResearchProductionPanel').then((module) => ({ default: module.ResearchProductionPanel })));

export type ResearchStageWorkspaceHandle = {
  clearSurfaceError: () => void;
};

type ResearchStageWorkspaceProps = {
  groupId: ResearchStageGroupId;
  onTabChange: (tab: ResearchStageTab) => void;
  session: ResearchSession;
  state: LoadedState;
  tab: ResearchStageTab;
};

export const ResearchStageWorkspace = forwardRef<ResearchStageWorkspaceHandle, ResearchStageWorkspaceProps>(
function ResearchStageWorkspace({
  groupId,
  onTabChange,
  session,
  state,
  tab
}, ref): React.JSX.Element {
  const [snapshot, setSnapshot] = useState(session.workbench.getSnapshot());
  const [librarySnapshot, setLibrarySnapshot] = useState(session.library.getSnapshot());
  const [knowledgeSnapshot, setKnowledgeSnapshot] = useState(session.knowledge.getSnapshot());
  const [experimentSnapshot, setExperimentSnapshot] = useState(session.experiments.getSnapshot());
  const [figureSnapshot, setFigureSnapshot] = useState(session.figures.getSnapshot());
  const [policySnapshot, setPolicySnapshot] = useState(session.policies.getSnapshot());
  const [templateSnapshot, setTemplateSnapshot] = useState(session.templates.getSnapshot());
  const [manuscriptSnapshot, setManuscriptSnapshot] = useState(session.manuscript.getSnapshot());
  const [ideaSnapshot, setIdeaSnapshot] = useState(session.ideas.getSnapshot());
  const [productionSnapshot, setProductionSnapshot] = useState(session.production.getSnapshot());
  const group = RESEARCH_STAGE_GROUPS.find((item) => item.id === groupId) ?? RESEARCH_STAGE_GROUPS[0]!;
  const current = snapshot.workflow === null ? undefined : currentStageState(snapshot.workflow);
  const writeAllowed = snapshot.project?.status !== 'archived'
    && stageGroupWriteAllowed(groupId, snapshot.workflow?.currentStage ?? null, current?.status);
  const currentGroup = isCurrentStageGroup(groupId, snapshot.workflow?.currentStage ?? null);
  const working = snapshot.working
    || librarySnapshot.working
    || knowledgeSnapshot.working
    || experimentSnapshot.working
    || figureSnapshot.working
    || policySnapshot.working
    || templateSnapshot.working
    || manuscriptSnapshot.working
    || ideaSnapshot.working
    || productionSnapshot.working;
  const selectedProjectId = snapshot.project?.id ?? null;
  const recentEvents = snapshot.events.slice(0, 4);
  const recentRuns = snapshot.runs.slice(0, 3);
  const recentEvidence = knowledgeSnapshot.evidence.slice(0, 4);
  const currentRun = snapshot.workflow === null ? null : latestCurrentRun(snapshot.runs, snapshot.workflow);
  const surfaceError = session.surfaceError();

  function clearSurfaceError(): void {
    session.clearErrors();
  }

  useImperativeHandle(ref, () => ({ clearSurfaceError }), [session]);

  useEffect(() => session.watchTab(tab, {
    workbench: setSnapshot,
    library: setLibrarySnapshot,
    knowledge: setKnowledgeSnapshot,
    experiments: setExperimentSnapshot,
    figures: setFigureSnapshot,
    policies: setPolicySnapshot,
    templates: setTemplateSnapshot,
    manuscript: setManuscriptSnapshot,
    ideas: setIdeaSnapshot,
    production: setProductionSnapshot
  }), [session, tab]);

  useEffect(() => {
    void session.loadTab(tab);
  }, [session, tab]);

  return (
    <section className="research-stage-workspace" data-testid="research-stage-workspace" data-group={groupId}>
      <aside className="research-stage-context" data-testid="research-stage-context">
        <div className="research-section-label">{group.label}</div>
        <p data-testid="research-stage-context-status">
          {currentGroup ? `当前阶段：${current === undefined ? '未开始' : researchStageLabels[current.stage]}` : `查看阶段组。当前阶段：${current === undefined ? '未开始' : researchStageLabels[current.stage]}`}
        </p>
        {current === undefined ? null : (
          <p>{researchStageStatusLabels[current.status]}</p>
        )}
        <nav aria-label={group.label} className="research-tabs">
          {group.tabs.map((item) => (
            <button
              aria-current={tab === item.id ? 'page' : undefined}
              className={tab === item.id ? 'research-tab research-tab--active' : 'research-tab'}
              data-testid={`research-stage-tab-${item.id}`}
              key={item.id}
              type="button"
              onClick={() => onTabChange(item.id)}
              onKeyDown={(event) => {
                if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') {
                  return;
                }
                const buttons = [...event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('.research-tab') ?? []];
                const index = buttons.indexOf(event.currentTarget);
                const next = buttons[index + (event.key === 'ArrowDown' ? 1 : -1)];
                if (next === undefined) {
                  return;
                }
                event.preventDefault();
                next.focus();
                next.click();
              }}
            >
              {item.label}
            </button>
          ))}
        </nav>
      </aside>
      <div className="research-stage-main">
        {writeAllowed ? null : (
          <div className="research-alert" role="status" data-testid="research-stage-readonly">
            当前阶段是{current === undefined ? '未开始' : researchStageLabels[current.stage]}。此阶段组仅可查看，写入已禁用。
          </div>
        )}
        {surfaceError === null ? null : (
          <div className="research-alert" role="alert" data-testid="research-stage-error">
            <CircleAlert aria-hidden="true" size={16} />
            <span>{surfaceError}</span>
            <button aria-label="关闭错误" className="research-toolbar-button" type="button" onClick={() => {
              clearSurfaceError();
            }}>
              <X aria-hidden="true" size={15} />
            </button>
          </div>
        )}
        {currentGroup && snapshot.workflow !== null && current !== undefined ? (
          <div className="research-stage-actions" data-testid="research-stage-current-actions">
            <p className="research-stage-copy">{nextActionLabel(snapshot.workflow)}</p>
            {current.status === 'ready' ? (
              <button className="ui-button ui-button--primary" disabled={working} type="button" onClick={() => void session.workbench.transition('start')}>开始阶段</button>
            ) : null}
            {current.status === 'running' ? (
              <>
                <button className="ui-button ui-button--secondary" disabled={working} type="button" onClick={() => void session.workbench.transition('pause')}>暂停</button>
                <button className="ui-button ui-button--primary" disabled={working} type="button" onClick={() => void session.workbench.transition('complete')}>{current.gateRequired ? '提交审核' : '完成阶段'}</button>
              </>
            ) : null}
            {current.status === 'paused' ? (
              <button className="ui-button ui-button--primary" disabled={working} type="button" onClick={() => void session.workbench.transition('resume')}>继续</button>
            ) : null}
            {current.status === 'waiting_approval' && !reviewDecisionRequired(snapshot.workflow) ? (
              <>
                <button className="ui-button ui-button--secondary" disabled={working} type="button" onClick={() => void session.workbench.transition('reject')}>退回修改</button>
                <button className="ui-button ui-button--primary" disabled={working} type="button" data-testid="research-approve" onClick={() => void session.workbench.transition('approve')}>确认通过</button>
              </>
            ) : null}
            {reviewDecisionRequired(snapshot.workflow) ? (
              <>
                <button className="ui-button ui-button--secondary" disabled={working} type="button" onClick={() => void session.workbench.transition('reject')}>退回修改</button>
                <button className="ui-button ui-button--secondary" disabled={working} type="button" data-testid="research-review-revise" onClick={() => void session.workbench.transition('approve', { reviewDecision: 'revise' })}>要求修订</button>
                <button className="ui-button ui-button--primary" disabled={working} type="button" data-testid="research-review-accept" onClick={() => void session.workbench.transition('approve', { reviewDecision: 'accept' })}>接受稿件</button>
              </>
            ) : null}
            {(current.status === 'ready' || current.status === 'running' || current.status === 'paused' || current.status === 'failed' || current.status === 'blocked') && (currentRun === null || !['queued', 'running'].includes(currentRun.status)) ? (
              <label className="research-run-instruction">
                角色指令
                <TextArea data-testid="research-run-input" spellCheck={true} value={snapshot.instruction} onChange={(event) => session.workbench.setInstruction(event.target.value)} rows={3} placeholder="例如：基于已有证据形成可检验假设。" />
              </label>
            ) : null}
            {currentRun === null || !['queued', 'running', 'failed', 'cancelled', 'interrupted'].includes(currentRun.status) ? (
              <button className="ui-button ui-button--secondary" disabled={working || snapshot.instruction.trim().length === 0} type="button" data-testid="research-start-run" onClick={() => void session.workbench.startRun()}>启动角色</button>
            ) : null}
            {currentRun !== null && ['queued', 'running'].includes(currentRun.status) ? (
              <button className="ui-button ui-button--secondary" disabled={working} type="button" data-testid="research-cancel-run" onClick={() => void session.workbench.cancelRun()}>取消运行</button>
            ) : null}
            {currentRun !== null && ['failed', 'cancelled', 'interrupted'].includes(currentRun.status) ? (
              <button className="ui-button ui-button--secondary" disabled={working} type="button" data-testid="research-retry-run" onClick={() => void session.workbench.retryRun()}>重试运行</button>
            ) : null}
          </div>
        ) : null}
        <Suspense fallback={<div className="research-loading" role="status">正在加载阶段面板…</div>}>
        {tab === 'library' ? (
          <ResearchLibraryPanel
            bibliographyFormat={librarySnapshot.bibliographyFormat}
            doi={librarySnapshot.doi}
            exportPreview={librarySnapshot.exportPreview}
            items={librarySnapshot.items}
            onChangeDoi={(value) => session.library.setDoi(value)}
            onChangeFormat={(value) => session.library.setFormat(value)}
            onExport={() => void session.library.exportBibliography()}
            onImportDoi={() => void session.library.importDoi()}
            onImportFile={() => void session.library.importBibliography()}
            onImportRecord={(record) => void session.library.importRecord(record)}
            onImportDocument={() => void session.library.importDocument()}
            onLink={(item, linked) => void session.library.link(item, linked)}
            onOpen={(item) => void session.library.open(item)}
            onQueryChange={(value) => session.library.setQuery(value)}
            onSearch={() => void session.library.search()}
            onScopeChange={(value) => { void session.library.setScope(value); }}
            onToggleSelected={(id) => session.library.toggleSelected(id)}
            openContent={librarySnapshot.openContent}
            openDocuments={librarySnapshot.openDocuments}
            openItem={librarySnapshot.openItem}
            projectId={selectedProjectId}
            query={librarySnapshot.query}
            results={librarySnapshot.results}
            scope={librarySnapshot.scope}
            selectedIds={librarySnapshot.selectedIds}
            working={working}
            readOnly={!writeAllowed}
          />
        ) : null}
        {tab === 'knowledge' ? (
          <ResearchKnowledgePanel
            evidence={knowledgeSnapshot.evidence}
            projectId={selectedProjectId}
            query={knowledgeSnapshot.query}
            result={knowledgeSnapshot.result}
            working={working}
            readOnly={!writeAllowed}
            onCapture={(chunkId) => void session.knowledge.capture(chunkId)}
            onQueryChange={(value) => session.knowledge.setQuery(value)}
            onSearch={() => void session.knowledge.search()}
          />
        ) : null}
        {tab === 'ideas' ? (
          <ResearchIdeaPanel
            artifacts={snapshot.artifacts}
            canvas={ideaSnapshot.canvas}
            draft={ideaSnapshot.draft}
            evidence={knowledgeSnapshot.evidence}
            onChange={(draft) => session.ideas.setDraft(draft)}
            onChooseWorkspace={async () => {
              const selected = await session.chooseWorkspace();
              return selected;
            }}
            onCreate={() => void session.ideas.create()}
            onPromote={(workspacePath) => void session.ideas.promote(workspacePath)}
            onSave={() => void session.ideas.save()}
            onSelect={(artifactId) => void session.ideas.select(artifactId)}
            selectedArtifactId={ideaSnapshot.selectedArtifactId}
            working={working}
            readOnly={!writeAllowed}
          />
        ) : null}
        {tab === 'experiments' ? (
          <ResearchExperimentPanel
            draft={experimentSnapshot.draft}
            experiments={experimentSnapshot.experiments}
            log={experimentSnapshot.log}
            onCancel={(runId) => void session.experiments.cancel(runId)}
            onChange={(draft) => session.experiments.setDraft(draft)}
            onPublish={(runId) => void session.experiments.publish(runId)}
            onReadLog={(runId) => void session.experiments.readLog(runId)}
            onRefresh={() => void session.experiments.load()}
            onSelect={(runId) => session.experiments.select(runId)}
            onStart={() => void session.experiments.start()}
            projectId={selectedProjectId}
            selectedRunId={experimentSnapshot.selectedRunId}
            working={working}
            readOnly={!writeAllowed}
          />
        ) : null}
        {tab === 'figures' ? (
          <ResearchFigurePanel
            draft={figureSnapshot.draft}
            log={figureSnapshot.log}
            onCancel={(runId) => void session.figures.cancel(runId)}
            onChange={(draft) => session.figures.setDraft(draft)}
            onPublish={(runId) => void session.figures.publish(runId)}
            onReadLog={(runId) => void session.figures.readLog(runId)}
            onRefresh={() => void session.figures.load()}
            onSelect={(runId) => session.figures.select(runId)}
            onStart={() => void session.figures.start()}
            projectId={selectedProjectId}
            runs={figureSnapshot.runs}
            selectedRunId={figureSnapshot.selectedRunId}
            working={working}
            readOnly={!writeAllowed}
          />
        ) : null}
        {tab === 'manuscript' ? (
          <ResearchManuscriptPanel
            artifacts={snapshot.artifacts}
            claims={manuscriptSnapshot.claims}
            draft={manuscriptSnapshot.draft}
            evidence={knowledgeSnapshot.evidence}
            manuscript={manuscriptSnapshot.manuscript}
            onChange={(draft) => session.manuscript.setDraft(draft)}
            onCreate={() => void session.manuscript.create()}
            onCreateClaim={() => void session.manuscript.createClaim()}
            onSave={() => void session.manuscript.save()}
            onSelect={(artifactId) => void session.manuscript.select(artifactId)}
            selectedArtifactId={manuscriptSnapshot.selectedArtifactId}
            working={working}
            readOnly={!writeAllowed}
          />
        ) : null}
        {tab === 'editor' ? (
          <ResearchEditorPanel
            files={templateSnapshot.files}
            onChangeDraft={(value) => session.templates.setOpenContent(value)}
            onCompile={() => void session.templates.compile()}
            onImport={() => void session.templates.importTemplate()}
            onOpenFile={(path) => void session.templates.openFile(path)}
            onSave={() => void session.templates.save()}
            onSelect={(templateId) => { void session.templates.select(templateId); }}
            openFile={templateSnapshot.openFile}
            selectedTemplateId={templateSnapshot.selectedTemplateId}
            templates={templateSnapshot.templates}
            working={working}
            readOnly={!writeAllowed}
          />
        ) : null}
        {tab === 'production' ? (
          <ResearchProductionPanel
            destinationPath={productionSnapshot.destinationPath}
            exports={productionSnapshot.exports}
            figures={productionSnapshot.figures}
            manuscripts={snapshot.artifacts.filter((item) => item.kind === 'manuscript')}
            onChangeDestination={(value) => session.production.setDestination(value)}
            onChangeTitle={(value) => session.production.setTitle(value)}
            onPrepareExport={() => void session.production.prepare()}
            onPublishExport={(exportId) => void session.production.publish(exportId)}
            onToggleFigure={(figureId) => session.production.toggleFigure(figureId)}
            onWriteExport={(exportId) => void session.production.write(exportId)}
            selectedFigureIds={productionSnapshot.selectedFigureIds}
            title={productionSnapshot.title}
            working={working}
            readOnly={!writeAllowed}
          />
        ) : null}
        {tab === 'policies' ? (
          <ResearchPolicyPanel
            draft={policySnapshot.draft}
            onChange={(draft) => session.policies.setDraft(draft)}
            onSave={() => void session.policies.save()}
            onSelect={(stage) => session.policies.select(stage)}
            policies={policySnapshot.policies}
            providers={state.providers}
            working={working}
          />
        ) : null}
        {tab === 'embedding' ? (
          <ResearchEmbeddingPanel
            configs={knowledgeSnapshot.embedding.configs}
            id={knowledgeSnapshot.embedding.id}
            name={knowledgeSnapshot.embedding.name}
            baseUrl={knowledgeSnapshot.embedding.baseUrl}
            model={knowledgeSnapshot.embedding.model}
            dimensions={knowledgeSnapshot.embedding.dimensions}
            apiKey={knowledgeSnapshot.embedding.apiKey}
            working={working}
            onIdChange={(value) => session.knowledge.setEmbeddingField('id', value)}
            onNameChange={(value) => session.knowledge.setEmbeddingField('name', value)}
            onBaseUrlChange={(value) => session.knowledge.setEmbeddingField('baseUrl', value)}
            onModelChange={(value) => session.knowledge.setEmbeddingField('model', value)}
            onDimensionsChange={(value) => session.knowledge.setEmbeddingField('dimensions', value)}
            onApiKeyChange={(value) => session.knowledge.setEmbeddingField('apiKey', value)}
            onSave={() => void session.knowledge.saveEmbeddingConfig()}
          />
        ) : null}
        </Suspense>
      </div>
      <aside className="research-stage-rail" data-testid="research-stage-rail">
        <div className="research-section-label">证据</div>
        {recentEvidence.length === 0 ? <p className="research-empty-inline">还没有捕获证据。</p> : recentEvidence.map((item) => (
          <p className="research-rail-item" key={item.id}>{item.title}</p>
        ))}
        <div className="research-section-label">运行</div>
        {recentRuns.length === 0 ? <p className="research-empty-inline">没有阶段运行。</p> : recentRuns.map((run) => (
          <p className="research-rail-item" key={run.id}>{researchStageLabels[run.stage]} · {researchRunStatusLabels[run.status]}</p>
        ))}
        <div className="research-section-label">最近活动</div>
        {recentEvents.length === 0 ? <p className="research-empty-inline">暂无活动。</p> : recentEvents.map((event) => (
          <p className="research-rail-item" key={event.id}>{event.message} · {formatResearchTime(event.createdAt)}</p>
        ))}
      </aside>
    </section>
  );
});
