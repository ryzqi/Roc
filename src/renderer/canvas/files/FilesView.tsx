import { FileText, FolderTree } from 'lucide-react';
import { useWorkspaceScope } from '../../app/workspace-scope';
import { EmptyState } from '../../shell/EmptyState';
import { ErrorBar } from '../../shell/ErrorBar';
import { checkRelativePath, pathRejectionMessage } from '../../workspace/paths';
import { FilePreview } from './FilePreview';

/**
 * The canvas `files` view (P3/T3.3).
 *
 * The tree lives in the sidebar; the canvas shows the **open file**. Which file
 * that is comes from the route (`?file=<workspace-relative path>`), so a reload
 * lands on the same file and a deep link works — the same reasoning that put
 * `stage` in the URL in P1 (ADR-M05).
 *
 * The path is validated *before* anything is requested, which is where gate 3
 * becomes visible: a hand-edited URL such as `?file=../../etc/passwd` renders the
 * refusal with its specific reason instead of producing a backend round trip
 * (R10). The backend refuses it too; failing locally is about the message, not
 * about being the only boundary.
 *
 * There is deliberately no separate preview *modal*: the canvas is the preview
 * surface, and a second overlay showing the same file would be two places to keep
 * the dirty-state warning in.
 */

export function FilesView(): React.JSX.Element {
  const scope = useWorkspaceScope();

  if (scope.workspacePath === null) {
    return (
      <div className="flex h-full min-h-0 flex-col p-3" data-testid="files-view" data-state="no-workspace">
        <EmptyState
          icon={FolderTree}
          title="未绑定工作目录"
          description="项目还没有工作目录，文件树与预览都无从谈起。先在左栏选择目录。"
          action={{ label: '重试绑定', onClick: scope.rebindWorkspace }}
          testId="files-view-no-workspace"
        />
      </div>
    );
  }

  const openFile = scope.openFile;
  if (openFile === null) {
    return (
      <div className="flex h-full min-h-0 flex-col p-3" data-testid="files-view" data-state="no-file">
        <EmptyState
          icon={FileText}
          title="尚未打开文件"
          description="在左栏文件树中选择一个文件，这里会显示内容预览。"
          testId="files-view-no-file"
        />
      </div>
    );
  }

  const check = checkRelativePath(openFile);
  if (!check.ok) {
    return (
      <div className="flex h-full min-h-0 flex-col gap-2 p-3" data-testid="files-view" data-state="rejected">
        <ErrorBar
          error={{
            level: 'blocked',
            message: pathRejectionMessage(check.reason),
            code: 'renderer_path_rejected',
            actionLabel: `被拒绝的路径：${openFile}`
          }}
        />
        <p className="text-muted text-[var(--font-meta-size)]">文件路径必须位于工作目录之内。</p>
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="files-view" data-state="preview">
      <FilePreview
        client={scope.client}
        relativePath={openFile}
        workspacePath={scope.workspacePath}
        writable={scope.writable}
      />
    </div>
  );
}
