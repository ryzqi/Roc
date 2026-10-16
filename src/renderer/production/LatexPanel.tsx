import { useCallback, useEffect, useRef, useState } from 'react';
import { Code2, FileText, Save } from 'lucide-react';
import type { FilePreviewResult } from '../../shared/types';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { formatBeijingDateTime, formatBytes } from '../shared/format';
import { fileName } from '../workspace/paths';
import { listTree, previewFile, writeTextFile } from '../workspace/workspace-store';
import { InlineHint, PanelSection, primaryButtonClass } from './panel-shell';

/**
 * 文稿 (P7/T7.5) — the workspace LaTeX/BibTeX editor behind the route's `latex` view.
 *
 * This replaces the legacy `LatexEditorView`, which "compiled" with a `setTimeout` over a local
 * file list. What it does now is the honest version of that surface:
 *
 *  - **Files come from the workspace** (`files.listTree` + `files.preview`), scoped to the
 *    extensions an author edits; nothing is synthesised.
 *  - **Saving is `files.writeText`** — and that call has **no `expectedHash`**: workspace writes
 *    are guarded by the backend's *recovery point* (`fileWriteResult.recoveryPoint` carries the
 *    pre-write sha256 and a snapshot path), not by optimistic concurrency. Hash-based concurrency
 *    exists only for *template* files (`research.template.saveFile`). The panel says so and shows
 *    the recovery point after a save, instead of claiming a guard the contract does not have.
 *  - **A truncated preview can never be saved.** `filePreviewResult.truncated` means the content
 *    is a prefix; saving it would overwrite the file with a fragment. The editor is read-only in
 *    that case with the reason.
 *  - **There is no compile button here.** Compiling is the template panel's
 *    `research.template.compile`, whose output the export stage consumes.
 */

const EDITABLE_EXTENSIONS = ['.tex', '.bib', '.cls', '.sty', '.bbl', '.txt', '.md', '.json', '.yaml', '.yml', '.csv'];

export function LatexPanel({ writeAllowed }: { writeAllowed?: boolean }): React.JSX.Element {
  /**
   * Whether this panel may write.
   *
   * The stage workspace decides it (`scope.writable && stageGroupWriteAllowed(...)`) and passes it
   * down, because the *stage-group* half of the rule exists only in the renderer: the backend
   * refuses artifact writes for a non-current stage (`requireEditableStage`) but happily starts an
   * experiment run or a template compile, so a panel that gated on the archived flag alone would
   * offer live buttons behind a 「只读：非当前阶段组」 badge. `undefined` keeps the route-rendered
   * case (the `latex` view) working with the project-level predicate.
   */
  const scope = useWorkspaceScope();
  const canWrite = writeAllowed ?? scope.writable;
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);

  const files = useAsyncResource<{ path: string; sizeBytes: number; updatedAt: string }[]>(
    scope.workspacePath === null ? null : `latex-files:${scope.workspacePath}`,
    async () => {
      const root = await listTree(scope.client, '');
      if (!root.ok) {
        return root;
      }
      const collected: { path: string; sizeBytes: number; updatedAt: string }[] = [];
      for (const entry of root.data.entries) {
        if (entry.type === 'file' && isEditable(entry.name)) {
          collected.push({ path: entry.relativePath, sizeBytes: entry.size, updatedAt: entry.updatedAt });
        }
      }
      // One extra level covers the usual `chapters/` / `sections/` / `refs/` layout without
      // duplicating the sidebar's lazy tree.
      for (const entry of root.data.entries) {
        if (entry.type !== 'directory') {
          continue;
        }
        const nested = await listTree(scope.client, entry.relativePath);
        if (!nested.ok) {
          continue;
        }
        for (const child of nested.data.entries) {
          if (child.type === 'file' && isEditable(child.name)) {
            collected.push({ path: child.relativePath, sizeBytes: child.size, updatedAt: child.updatedAt });
          }
        }
      }
      return { ok: true, data: collected };
    },
    { label: '扫描文稿文件' }
  );

  const preview = useAsyncResource<FilePreviewResult>(
    selectedPath === null ? null : `latex-preview:${selectedPath}`,
    () => previewFile(scope.client, selectedPath ?? ''),
    { label: '读取文稿文件' }
  );

  const save = useAsyncAction(
    (input: { path: string; content: string }) =>
      writeTextFile(scope.client, { relativePath: input.path, content: input.content, source: 'renderer/latex' }),
    { label: '保存文稿文件' }
  );
  const [recovery, setRecovery] = useState<string | null>(null);

  const previewData = preview.data;
  const isText = previewData !== null && previewData.kind === 'text';
  const isTruncated = isText && previewData.truncated;
  const canEdit = canWrite && isText && !isTruncated;

  /** Latch the loaded text into `draft` once per path, so typing does not fight the reload. */
  const loadedPathRef = useRef<string | null>(null);
  useEffect(() => {
    if (selectedPath === null || previewData === null || !isText) {
      return;
    }
    if (loadedPathRef.current === selectedPath) {
      return;
    }
    loadedPathRef.current = selectedPath;
    setDraft(previewData.content);
    // 不清 note/recovery：保存后会立刻 `preview.reload()`，而重读会让本效应再跑一次 —— 那会把
    // 「已保存 N 字节」与 recovery point 在不到一次 IPC 往返内抹掉（评审 P2）。清空只发生在换文件时。
  }, [isText, previewData, selectedPath]);

  const onSelect = useCallback((path: string) => {
    loadedPathRef.current = null;
    setDraft(null);
    setNote(null);
    setRecovery(null);
    setSelectedPath(path);
  }, []);

  if (scope.workspacePath === null) {
    return (
      <div className="flex h-full flex-col justify-center" data-testid="production-latex">
        <EmptyState
          icon={Code2}
          title="未绑定工作目录"
          description="文稿编辑的是工作区里的真实文件；先在左栏选择工作目录。"
          action={{ label: '重试绑定', onClick: scope.rebindWorkspace }}
          testId="production-latex-no-workspace"
        />
      </div>
    );
  }

  const dirty = canEdit && draft !== null && previewData !== null && draft !== previewData.content;

  return (
    <div className="flex h-full min-h-0" data-testid="production-latex">
      <nav
        aria-label="文稿文件"
        className="flex w-[260px] shrink-0 flex-col gap-1 overflow-y-auto border-r border-line p-2"
        data-testid="production-latex-files"
      >
        <span className="text-subtle text-[var(--font-micro-size)]">
          工作区可编辑文件（{files.data?.length ?? 0}）· files.listTree
        </span>
        {files.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: files.error ?? '扫描文件失败', retry: files.reload }} />
        ) : null}
        {(files.data ?? []).length === 0 ? (
          <InlineHint
            text="工作区里没有可编辑的文稿文件（.tex/.bib/…）。用文件视图新建，或让助手写一份。"
            testId="production-latex-empty"
          />
        ) : (
          <ul className="flex flex-col gap-0.5">
            {(files.data ?? []).map((file) => (
              <li key={file.path}>
                <button
                  type="button"
                  data-testid={`production-latex-file-${file.path}`}
                  data-selected={file.path === selectedPath ? 'true' : 'false'}
                  onClick={() => onSelect(file.path)}
                  className={[
                    'flex w-full min-w-0 flex-col items-start rounded-control px-2 py-1 text-left',
                    'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent',
                    file.path === selectedPath
                      ? 'bg-[var(--overlay-active)] text-ink'
                      : 'text-muted hover:bg-[var(--overlay-hover)] hover:text-ink'
                  ].join(' ')}
                >
                  <span className="w-full truncate font-mono text-[var(--font-meta-size)]" title={file.path}>
                    {file.path}
                  </span>
                  <span className="text-subtle text-[var(--font-micro-size)]">
                    {formatBytes(file.sizeBytes)} · {formatBeijingDateTime(file.updatedAt)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </nav>

      <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-y-auto p-3">
        {selectedPath === null ? (
          <EmptyState
            icon={FileText}
            title="选择一个文稿文件"
            description="保存走 files.writeText（后端会先留一个 recovery point）。"
            testId="production-latex-no-file"
          />
        ) : (
          <PanelSection
            title={fileName(selectedPath)}
            hint="files.preview / files.writeText（编译在模板面板：research.template.compile）"
            testId="production-latex-editor"
            action={{
              label: dirty ? '放弃修改' : '重新读取',
              onClick: () => {
                if (dirty) {
                  setDraft(previewData?.content ?? null);
                  setNote('已放弃未保存的修改。');
                  return;
                }
                preview.reload();
              },
              testId: 'production-latex-reload'
            }}
          >
            {preview.status === 'loading' ? <InlineHint text="正在读取文件…" /> : null}
            {preview.status === 'error' ? (
              <ErrorBar error={{ level: 'page', message: preview.error ?? '读取文件失败', retry: preview.reload }} />
            ) : null}
            {previewData !== null && previewData.kind !== 'text' ? (
              <InlineHint
                text={`这个文件是 ${previewData.kind}，不在文稿编辑器里打开（预览请用文件视图）。`}
                testId="production-latex-not-text"
              />
            ) : null}
            {isTruncated ? (
              <p className="text-[var(--st-warn)] text-[var(--font-meta-size)]" data-testid="production-latex-truncated" role="note">
                这个文件太大，后端只返回了前一段（truncated）：为避免把文件覆盖成片段，编辑器在此只读。
              </p>
            ) : null}
            {isText ? (
              <>
                <textarea
                  data-testid="production-latex-content"
                  value={draft ?? previewData.content}
                  rows={20}
                  spellCheck={false}
                  disabled={!canEdit}
                  onChange={(event) => setDraft(event.target.value)}
                  className="w-full resize-y rounded-control border border-line bg-bg px-2 py-1 font-mono text-ink text-[var(--font-code-size)] disabled:opacity-50 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent"
                />
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    data-testid="production-latex-save"
                    disabled={!canEdit || save.pending || !dirty || draft === null}
                    onClick={() => {
                      if (draft === null) {
                        return;
                      }
                      void save.run({ path: selectedPath, content: draft }).then((saved) => {
                        if (saved === null) {
                          return;
                        }
                        setNote(`已保存 ${saved.bytesWritten} 字节。`);
                        setRecovery(
                          `recovery point ${saved.recoveryPoint.id} · 写入前 sha256 ${saved.recoveryPoint.contentSha256.slice(0, 12)}`
                        );
                        loadedPathRef.current = null;
                        preview.reload();
                        files.reload();
                      });
                    }}
                    className={primaryButtonClass}
                  >
                    <Save size={12} aria-hidden="true" className="mr-1 inline" />
                    保存
                  </button>
                  <span className="text-subtle text-[var(--font-micro-size)]" data-testid="production-latex-state">
                    {canEdit ? (dirty ? '有未保存的修改' : '与磁盘一致') : '只读'} · {formatBytes(previewData.sizeBytes)}
                  </span>
                  {canWrite ? null : (
                    <span className="text-[var(--st-warn)] text-[var(--font-micro-size)]" data-testid="production-latex-readonly">
                      项目已归档：文件只读。
                    </span>
                  )}
                </div>
                {note === null ? null : (
                  <p className="text-muted text-[var(--font-meta-size)]" data-testid="production-latex-save-note">
                    {note}
                  </p>
                )}
                {recovery === null ? null : (
                  <p className="font-mono text-subtle text-[var(--font-micro-size)]" data-testid="production-latex-recovery">
                    {recovery}
                  </p>
                )}
                {save.error === null ? null : <InlineHint text={save.error} testId="production-latex-save-error" />}
              </>
            ) : null}
          </PanelSection>
        )}

        <p className="text-subtle text-[var(--font-micro-size)]" data-testid="production-latex-note">
          这里不做本地编译：编译是模板面板的 `research.template.compile`（产物 PDF 供导出阶段使用），旧壳的 `setTimeout`
          假编译已删除。工作区文件的写入没有 expectedHash，安全网是后端写入前的 recovery point。
        </p>
      </div>
    </div>
  );
}

function isEditable(name: string): boolean {
  const lower = name.toLowerCase();
  return EDITABLE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}
