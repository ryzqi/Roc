import { useMemo, useRef, useState } from 'react';
import { Diff, Hunk, parseDiff, type FileData as GitDiffFileData } from 'react-diff-view';
import { ChevronDown, ChevronRight, Loader2 } from 'lucide-react';
import 'react-diff-view/style/index.css';
import type { RocClient } from '../../shared/roc-client';
import { useAsyncResource } from '../../app/use-async-resource';
import { EmptyState } from '../../shell/EmptyState';
import { ErrorBar } from '../../shell/ErrorBar';
import {
  buildGitDiffCacheKey,
  buildGitDiffTitle,
  isLargeGitDiff,
  normalizeGitDiffText,
  rememberGitDiffParse,
  selectGitDiffFile
} from '../../workspace/git-store';
import { gitFileDiff } from '../../workspace/git-store';

/**
 * Diff rendering for one changed file (P3/T3.5).
 *
 * `react-diff-view` needs a parsed `FileData`, and parsing a whole patch is the
 * expensive part, so parsed results go through a bounded LRU keyed on the patch
 * text (`rememberGitDiffParse`). The panel stays mounted while a run is open, so
 * without the bound the cache would grow with every file ever inspected.
 *
 * A big diff starts **collapsed**: a 5,000-line generated file would otherwise
 * dominate the drawer and make the change list unreachable. The threshold and the
 * guard are pure functions so the behaviour is testable.
 *
 * The `--diff-*` CSS variables are set by the `.roc-diff` scope in
 * `styles/index.css`; without them react-diff-view falls back to light colours on
 * a dark surface.
 */

export type GitFileDiffProps = {
  client: RocClient;
  /** Bound workspace, used as part of the resource key so switches drop data. */
  workspacePath: string | null;
  relativePath: string;
  /** Human label for the change state ("未跟踪", "已暂存"…). */
  stateLabel: string;
};

export function GitFileDiff({
  client,
  workspacePath,
  relativePath,
  stateLabel
}: GitFileDiffProps): React.JSX.Element {
  const resource = useAsyncResource(
    workspacePath === null ? null : JSON.stringify([workspacePath, relativePath]),
    () => gitFileDiff(client, relativePath),
    { label: '读取文件 diff' }
  );
  const [expandedLarge, setExpandedLarge] = useState(false);
  // One cache for the lifetime of the panel: a fresh map per render would parse
  // the patch on every render and would never actually be a cache.
  const parseCacheRef = useRef(new Map<string, GitDiffFileData[]>());

  const patch = resource.data?.patch ?? '';
  const large = useMemo(() => isLargeGitDiff(patch), [patch]);
  const parsedFiles = useMemo<GitDiffFileData[]>(() => {
    if (patch.length === 0 || (large && !expandedLarge)) {
      return [];
    }
    return rememberGitDiffParse(
      parseCacheRef.current,
      buildGitDiffCacheKey({ relativePath, patch }),
      () => parseDiff(normalizeGitDiffText(patch), { nearbySequences: 'zip' })
    );
  }, [large, expandedLarge, patch, relativePath]);

  if (resource.status === 'loading' && resource.data === null) {
    return (
      <p className="flex items-center gap-2 p-3 text-muted" role="status" data-testid="git-diff-loading">
        <Loader2 size={13} aria-hidden="true" className="animate-spin" />
        正在读取文件 diff…
      </p>
    );
  }

  if (resource.status === 'error' || resource.data === null) {
    return (
      <div className="p-2">
        <ErrorBar
          error={{
            level: 'page',
            message: resource.error ?? '读取文件 diff 失败',
            retry: resource.reload
          }}
        />
      </div>
    );
  }

  if (large && !expandedLarge) {
    return (
      <div className="flex flex-col gap-2 p-3" data-testid="git-diff-large">
        <p className="text-ink">该 diff 较大（{patch.length.toLocaleString('zh-CN')} 字符），已折叠。</p>
        <p className="text-muted text-[var(--font-meta-size)]">展开后可能占用较多内存与渲染时间。</p>
        <button
          type="button"
          onClick={() => setExpandedLarge(true)}
          data-testid="git-diff-expand"
          className="h-[var(--control-height)] self-start rounded-control border border-line bg-surface-strong px-3 text-ink hover:bg-[var(--surface-card-hover)] active:bg-[var(--overlay-active)]"
        >
          展开 diff
        </button>
      </div>
    );
  }

  const file = selectGitDiffFile(parsedFiles, relativePath);
  if (file === null) {
    return (
      <EmptyState
        title="该文件没有可显示的 diff"
        testId="git-diff-empty"
      />
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="git-diff">
      <div className="flex shrink-0 items-center gap-2 border-b border-line px-3 py-1.5">
        <span className="min-w-0 flex-1 truncate font-mono text-[var(--font-meta-size)]" title={relativePath}>
          {relativePath}
        </span>
        <span className="text-subtle text-[var(--font-micro-size)]">{stateLabel}</span>
        <span className="text-subtle text-[var(--font-micro-size)]">{file.type}</span>
        {large ? (
          <button
            type="button"
            onClick={() => setExpandedLarge(false)}
            className="flex items-center gap-1 rounded-control px-1.5 py-0.5 text-muted hover:text-ink active:bg-[var(--overlay-active)]"
            data-testid="git-diff-collapse"
          >
            <ChevronDown size={11} aria-hidden="true" />
            <span className="text-[var(--font-micro-size)]">折叠</span>
          </button>
        ) : (
          <span className="flex items-center gap-1 text-subtle text-[var(--font-micro-size)]">
            <ChevronRight size={11} aria-hidden="true" />
            {buildGitDiffTitle(file)}
          </span>
        )}
      </div>
      <div className="roc-diff min-h-0 flex-1 overflow-auto" data-selectable="true">
        <Diff diffType={file.type} hunks={file.hunks} viewType="unified">
          {(hunks) => hunks.map((hunk) => <Hunk key={hunk.content} hunk={hunk} />)}
        </Diff>
      </div>
    </div>
  );
}
