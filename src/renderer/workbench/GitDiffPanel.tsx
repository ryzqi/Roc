import { Diff, Hunk, type FileData as GitDiffFileData } from 'react-diff-view';
import 'react-diff-view/style/index.css';
import type { GitFileDiffResult, GitStatusChange } from '../../shared/types';
import type { LoadedState } from '../loaded-state';
import { buildGitDiffTitle } from '../git-diff-adapter';
import { buildGitChangeStateLabel, gitSelectionEmptyMessage } from './git-helpers';

type GitDiffPanelProps = {
  failedPath: string | null;
  loadingPath: string | null;
  selectedChange: GitStatusChange | null;
  selectedDiffFile: GitDiffFileData | null;
  selectionPreview: GitFileDiffResult | null;
  state: LoadedState;
};

export function GitDiffPanel({
  failedPath,
  loadingPath,
  selectedChange,
  selectedDiffFile,
  selectionPreview,
  state
}: GitDiffPanelProps): React.JSX.Element {
  if (selectedChange === null) {
    return (
      <div className="git-selection-empty" data-testid="workbench-git-selection">
        <strong>尚未选中文件</strong>
        <p>{gitSelectionEmptyMessage(state)}</p>
      </div>
    );
  }

  if (failedPath === selectedChange.relativePath && loadingPath !== selectedChange.relativePath) {
    return (
      <div className="git-selection-empty" data-testid="workbench-git-selection">
        <strong>{selectedChange.relativePath}</strong>
        <p>当前文件 diff 加载失败。</p>
      </div>
    );
  }

  if (selectionPreview === null) {
    return (
      <div className="git-selection-empty" data-testid="workbench-git-selection">
        <strong>{selectedChange.relativePath}</strong>
        <p>正在读取当前文件 diff。</p>
      </div>
    );
  }

  if (selectedDiffFile === null) {
    return (
      <div className="git-selection-empty" data-testid="workbench-git-selection">
        <strong>{selectedChange.relativePath}</strong>
        <p>当前文件没有可显示的 diff。</p>
      </div>
    );
  }

  const selectionStatus = buildGitChangeStateLabel(selectedChange);
  return (
    <div className="git-diff-panel" data-testid="workbench-git-selection">
      <div className="git-diff-header">
        <div className="git-diff-titleblock">
          <div className="git-selection-title" data-testid="workbench-git-selection-path">
            {selectedChange.relativePath}
          </div>
          <div className="git-selection-subtitle">{selectionStatus}</div>
        </div>
        <span className="selection-chip active">{selectionStatus}</span>
      </div>
      <div className="git-diff-toolbar">
        <span>{buildGitDiffTitle(selectedDiffFile)}</span>
        <span>{selectedDiffFile.type}</span>
      </div>
      <div className="git-diff-body">
        <div className="git-diff-scroll" data-testid="workbench-git-selection-preview">
          <Diff diffType={selectedDiffFile.type} hunks={selectedDiffFile.hunks} viewType="unified">
            {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
          </Diff>
        </div>
      </div>
    </div>
  );
}
