import { useCallback, useEffect, useMemo, useState } from 'react';
import { Diff, Hunk, parseDiff, type FileData as GitDiffFileData } from 'react-diff-view';
import 'react-diff-view/style/index.css';

import type {
  GitFileDiffResult,
  GitStatusChange,
  ResearchArtifact,
  ResearchProject,
  ResearchStageRun,
  ResearchWorkflowSnapshot
} from '../../../shared/types';
import type { LoadedState } from '../../loaded-state';
import type { RocClient } from '../../shared/roc-client';
import { buildGitDiffTitle, normalizeGitDiffText, selectGitDiffFile } from '../../git-diff-adapter';
import { buildGitChangeStateLabel } from '../../workbench/git-helpers';
import {
  artifactStatusLabel,
  formatResearchTime,
  researchRunStatusLabels,
  researchStageLabels
} from './research-workflow';

/**
 * 右栏的改动/产物面板：对话产生的文件改动、阶段产物和阶段运行。
 * 文稿真身是工作目录里的 LaTeX 文件，所以「改了什么」以工作区 git diff 为准，而不是数据库里的产物记录。
 */
export function ResearchChangesView({
  artifacts,
  client,
  onOpenArtifact,
  onOpenRuns,
  project,
  runs,
  state,
  workflow
}: {
  artifacts: ResearchArtifact[];
  client: RocClient;
  onOpenArtifact: (artifactId: string) => void;
  onOpenRuns: () => void;
  project: ResearchProject;
  runs: ResearchStageRun[];
  state: LoadedState;
  workflow: ResearchWorkflowSnapshot;
}): React.JSX.Element {
  const changes = state.gitStatus?.changes ?? [];
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [preview, setPreview] = useState<GitFileDiffResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selectedChange = useMemo(
    () => changes.find((change) => change.relativePath === selectedPath) ?? null,
    [changes, selectedPath]
  );

  const loadDiff = useCallback(async (relativePath: string) => {
    setSelectedPath(relativePath);
    setLoading(true);
    setError(null);
    const result = await client.api.git.fileDiff({ relativePath });
    if (!result.ok) {
      setPreview(null);
      setLoading(false);
      setError(result.error.message);
      return;
    }
    setPreview(result.data);
    setLoading(false);
  }, [client]);

  // 工作区变化后，原来选中的文件可能已经不在了；退回到第一个改动。
  useEffect(() => {
    if (changes.length === 0) {
      setSelectedPath(null);
      setPreview(null);
      return;
    }
    if (selectedPath !== null && changes.some((change) => change.relativePath === selectedPath)) {
      return;
    }
    void loadDiff(changes[0]!.relativePath);
  }, [changes, loadDiff, selectedPath]);

  const diffFile = useMemo<GitDiffFileData | null>(() => {
    if (selectedChange === null || preview === null || preview.relativePath !== selectedChange.relativePath) {
      return null;
    }
    const parsed = parseDiff(normalizeGitDiffText(preview.patch), { nearbySequences: 'zip' });
    return selectGitDiffFile(parsed, selectedChange.relativePath);
  }, [preview, selectedChange]);

  const currentStage = workflow.stages.find((entry) => entry.stage === workflow.currentStage);
  const recentRuns = runs.slice(0, 5);

  return (
    <div className="research-changes" data-testid="research-changes-view">
      <header className="research-changes-head">
        <h2>改动与产物</h2>
        <p>
          {project.title}
          {' · '}
          {researchStageLabels[workflow.currentStage]}
          {currentStage === undefined ? '' : ` · ${currentStage.status === 'waiting_approval' ? '待审核' : '进行中'}`}
        </p>
      </header>

      <section className="research-changes-section" aria-label="文件改动" data-testid="research-changes-files">
        <div className="research-section-label">
          文件改动
          <span className="research-changes-count">{changes.length}</span>
        </div>
        {changes.length === 0 ? (
          <p className="research-empty-inline" role="status">工作目录当前没有未提交的改动。</p>
        ) : (
          <>
            <div className="execution-change-list" role="listbox" aria-label="改动文件">
              {changes.map((change) => (
                <button
                  aria-selected={change.relativePath === selectedPath}
                  className={change.relativePath === selectedPath ? 'execution-change execution-change--selected' : 'execution-change'}
                  data-testid={`research-change-${change.relativePath}`}
                  key={change.porcelain}
                  role="option"
                  type="button"
                  onClick={() => void loadDiff(change.relativePath)}
                >
                  <span className="execution-change-path">{change.relativePath}</span>
                  <span className="execution-change-state">{buildGitChangeStateLabel(change)}</span>
                </button>
              ))}
            </div>
            <ChangePreview
              diffFile={diffFile}
              error={error}
              loading={loading}
              selectedChange={selectedChange}
            />
          </>
        )}
      </section>

      <section className="research-changes-section" aria-label="阶段产物" data-testid="research-changes-artifacts">
        <div className="research-section-label">
          阶段产物
          <span className="research-changes-count">{artifacts.length}</span>
        </div>
        {artifacts.length === 0 ? (
          <p className="research-empty-inline" role="status">当前阶段还没有产物。</p>
        ) : (
          <ul className="research-changes-list">
            {artifacts.slice(0, 12).map((artifact) => (
              <li key={artifact.id}>
                <button
                  className="research-changes-row"
                  data-testid={`research-change-artifact-${artifact.id}`}
                  type="button"
                  onClick={() => onOpenArtifact(artifact.id)}
                >
                  <span className="research-changes-row-title">{artifact.title}</span>
                  <span className="research-changes-row-meta">
                    {researchStageLabels[artifact.stage]} · {artifactStatusLabel(artifact.status)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="research-changes-section" aria-label="阶段运行" data-testid="research-changes-runs">
        <div className="research-section-label">
          阶段运行
          <button className="research-toolbar-button" type="button" onClick={onOpenRuns}>全部</button>
        </div>
        {recentRuns.length === 0 ? (
          <p className="research-empty-inline" role="status">还没有阶段运行。</p>
        ) : (
          <ul className="research-changes-list">
            {recentRuns.map((run) => (
              <li className="research-changes-run" key={run.id}>
                <span className="research-changes-run-stage">{researchStageLabels[run.stage]}</span>
                <span className="research-changes-run-status">{researchRunStatusLabels[run.status]}</span>
                <time className="research-changes-run-time">{formatResearchTime(run.createdAt)}</time>
                {run.error === null ? null : <span className="research-changes-run-error">{run.error}</span>}
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function ChangePreview({
  diffFile,
  error,
  loading,
  selectedChange
}: {
  diffFile: GitDiffFileData | null;
  error: string | null;
  loading: boolean;
  selectedChange: GitStatusChange | null;
}): React.JSX.Element | null {
  if (selectedChange === null) {
    return null;
  }
  if (error !== null) {
    return (
      <p className="research-empty-inline" role="alert" data-testid="research-change-error">
        {error}
      </p>
    );
  }
  if (loading) {
    return <p className="research-empty-inline" role="status">正在读取 diff…</p>;
  }
  if (diffFile === null) {
    return <p className="research-empty-inline" role="status">当前文件没有可显示的 diff。</p>;
  }
  return (
    <div className="research-change-diff" data-testid="research-change-diff">
      <div className="research-change-diff-head">
        <span>{buildGitDiffTitle(diffFile)}</span>
        <span>{diffFile.type}</span>
      </div>
      <div className="research-change-diff-body">
        <Diff diffType={diffFile.type} hunks={diffFile.hunks} viewType="unified">
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      </div>
    </div>
  );
}
