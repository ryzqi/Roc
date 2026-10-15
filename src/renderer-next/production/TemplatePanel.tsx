import { useEffect, useMemo, useRef, useState } from 'react';
import { FileCode2, Play, RefreshCw, XCircle } from 'lucide-react';
import type { ResearchTemplate, ResearchTemplateFile, ResearchTemplateFileContent, ResearchToolchainStatus } from '../../shared/types';
import { useAsyncAction, useAsyncResource } from '../app/use-async-resource';
import { useWorkspaceScope } from '../app/workspace-scope';
import { EmptyState } from '../shell/EmptyState';
import { ErrorBar } from '../shell/ErrorBar';
import { ProgressTask } from '../shell/ProgressTask';
import { formatBeijingDateTime, formatBytes } from '../shared/format';
import {
  cancelTemplateCompile,
  compileTemplate,
  getTemplateFiles,
  getToolchainStatus,
  importTemplate,
  listTemplates,
  readTemplateFile,
  saveTemplateFile,
  setTemplateEntry
} from './production-store';
import {
  FieldLabel,
  InlineHint,
  KeyValue,
  PanelSection,
  primaryButtonClass,
  secondaryButtonClass,
  selectClass,
  textAreaClass,
  textInputClass
} from './panel-shell';

/**
 * 模板包 (P7/T7.5).
 *
 * Five contract facts shape it:
 *
 *  1. **`research.template.import` takes a path from the native picker** (`sourcePath`, a
 *     directory or a ZIP); the renderer never types one (ADR-M06). The smoke build returns a
 *     fixed file for the picker, so the harness drives import through IPC instead — the panel
 *     itself is still the real entry point.
 *  2. **`compile` is asynchronous and identity-checked**: a template is `compiling` iff
 *     `activeCompileId !== null`, and `ready` requires `compiledRevision === revision` plus a
 *     matching digest. So progress is **polling `getTemplate`**, and 「取消编译」 is the
 *     `template.cancel` capability rather than a renderer-side abort.
 *  3. **`saveFile` is optimistic**: it takes `expectedHash` (`null` for a new file), which is the
 *     file's current `sha256` from `template.files`.
 *  4. **`setEntry` needs the template's revision** — setting the entry point is a revision
 *     bump, so the editor sends the revision it just read.
 *  5. **The compiled PDF has no preview path** (B21: `research.template.preview` returns a
 *     `Response` and was never registered in `ipc-registry`). The panel shows `pdfPath` + hash and
 *     says why there is no frame, instead of an empty one.
 */

type Loadable<T> = { status: 'idle' | 'loading' | 'ready' | 'error'; data: T | null; error: string | null };

const idle = <T,>(): Loadable<T> => ({ status: 'idle', data: null, error: null });

export function TemplatePanel(): React.JSX.Element {
  const scope = useWorkspaceScope();
  const projectId = scope.projectId ?? '';

  const toolchain = useAsyncResource<ResearchToolchainStatus>('template-toolchain', () => getToolchainStatus(scope.client), {
    label: '读取工具链状态'
  });
  const templates = useAsyncResource<ResearchTemplate[]>(
    scope.projectId === null ? null : `templates:${scope.projectId}`,
    () => listTemplates(scope.client, projectId),
    { label: '读取模板' }
  );

  const [selectedId, setSelectedId] = useState<string | null>(null);
  const template = (templates.data ?? []).find((entry) => entry.id === selectedId) ?? (templates.data ?? [])[0] ?? null;

  const files = useAsyncResource<ResearchTemplateFile[]>(
    template === null ? null : `template-files:${template.id}:${template.revision}`,
    () => getTemplateFiles(scope.client, { projectId, templateId: template?.id ?? '' }),
    { label: '读取模板文件' }
  );

  const [openFile, setOpenFile] = useState<{ path: string; draft: string; original: ResearchTemplateFileContent } | null>(null);
  const [entryPath, setEntryPath] = useState('');

  const importRun = useAsyncAction(
    (sourcePath: string) => importTemplate(scope.client, { projectId, sourcePath }),
    { label: '导入模板' }
  );
  const compile = useAsyncAction((templateId: string) => compileTemplate(scope.client, { projectId, templateId }), {
    label: '编译模板'
  });
  const cancel = useAsyncAction((templateId: string) => cancelTemplateCompile(scope.client, { projectId, templateId }), {
    label: '取消编译'
  });
  const saveFile = useAsyncAction(
    (input: { path: string; content: string; expectedHash: string | null }) =>
      saveTemplateFile(scope.client, { projectId, templateId: template?.id ?? '', ...input }),
    { label: '保存模板文件' }
  );
  const setEntry = useAsyncAction(
    (path: string) =>
      setTemplateEntry(scope.client, {
        projectId,
        templateId: template?.id ?? '',
        entryPath: path,
        expectedRevision: template?.revision ?? 1
      }),
    { label: '设置入口文件' }
  );

  /** Poll while a compile is in flight (it is the only observable progress). */
  const compiling = template?.status === 'compiling';
  const refreshTemplates = templates.reload;
  const reloadRef = useRef(refreshTemplates);
  reloadRef.current = refreshTemplates;
  useEffect(() => {
    if (compiling !== true) {
      return;
    }
    const timer = window.setInterval(() => reloadRef.current(), 1500);
    return () => window.clearInterval(timer);
  }, [compiling]);

  const editableFiles = useMemo(() => files.data ?? [], [files.data]);
  const tectonicReady = toolchain.data?.available === true;

  if (scope.projectId === null) {
    return <InlineHint text="未进入项目。" />;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto" data-testid="production-template">
      <PanelSection title="工具链" hint="research.toolchain.status（TeX 引擎可用性驱动主操作）" testId="production-template-toolchain">
        {toolchain.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: toolchain.error ?? '读取工具链失败', retry: toolchain.reload }} />
        ) : null}
        <dl className="flex flex-col gap-0.5">
          <KeyValue
            label="工具链"
            value={
              toolchain.data === null
                ? '读取中'
                : toolchain.data.available
                  ? `可用 · tectonic ${toolchain.data.versions?.tectonic ?? '?'} · python ${toolchain.data.versions?.python ?? '?'}`
                  : `不可用：${toolchain.data.error ?? '未知原因'}`
            }
          />
        </dl>
        {tectonicReady ? null : (
          <p className="text-[var(--st-warn)] text-[var(--font-meta-size)]" data-testid="production-template-toolchain-note">
            工具链不可用：编译模板的主操作在这种情况下只会失败，所以先按提示修复工具链（设置中心 / 安装），而不是盲目点编译。
          </p>
        )}
      </PanelSection>

      <PanelSection
        title="模板包"
        hint="research.template.import / list / get"
        testId="production-template-list"
        action={{ label: '刷新', onClick: templates.reload, busy: templates.status === 'loading', testId: 'production-template-refresh' }}
      >
        {templates.status === 'error' ? (
          <ErrorBar error={{ level: 'page', message: templates.error ?? '读取模板失败', retry: templates.reload }} />
        ) : null}
        {(templates.data ?? []).length === 0 ? (
          <EmptyState
            icon={FileCode2}
            title="还没有模板包"
            description="导入一个包含 .tex 的目录或 ZIP：编译产物是 PDF，入口文件可以在这里指定。"
            compact
            testId="production-template-empty"
          />
        ) : (
          <ul className="flex flex-col gap-1" data-testid="production-template-items">
            {(templates.data ?? []).map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-center gap-2 text-[var(--font-meta-size)]">
                <button
                  type="button"
                  data-testid={`production-template-select-${entry.id}`}
                  onClick={() => {
                    setSelectedId(entry.id);
                    setOpenFile(null);
                    setEntryPath(entry.entryPath);
                  }}
                  className={entry.id === template?.id ? secondaryButtonClass + ' border-line-strong text-ink' : secondaryButtonClass}
                >
                  {entry.id}
                </button>
                <span className="text-subtle">{entry.status}</span>
                <span className="font-mono text-subtle">v{entry.revision}</span>
                <span className="min-w-0 flex-1 truncate font-mono text-subtle" title={entry.entryPath}>
                  {entry.entryPath}
                </span>
                <span className="text-subtle">{formatBeijingDateTime(entry.updatedAt)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            data-testid="production-template-import"
            disabled={!scope.writable || importRun.pending}
            onClick={() => {
              void scope.client.api.files.selectFromDialog().then((selection) => {
                // The picker answers with `{ filePaths: string[] }` (one entry in practice), and the
                // smoke build returns a fixed file — so the harness drives import through IPC while
                // the panel stays the real entry point.
                const sourcePath = selection.ok ? (selection.data?.filePaths[0] ?? null) : null;
                if (sourcePath === null) {
                  return;
                }
                void importRun.run(sourcePath).then((imported) => {
                  if (imported !== null) {
                    setSelectedId(imported.id);
                    templates.reload();
                  }
                });
              });
            }}
            className={secondaryButtonClass}
          >
            导入模板（目录或 ZIP）
          </button>
        </div>
        {importRun.error === null ? null : <InlineHint text={importRun.error} testId="production-template-import-error" />}
      </PanelSection>

      {template === null ? null : (
        <PanelSection title="编译与文件" hint="research.template.get / compile / cancel / files / readFile / saveFile / setEntry" testId="production-template-detail">
          <dl className="flex flex-col gap-0.5">
            <KeyValue label="状态" value={template.status} />
            <KeyValue label="版本" value={`${template.revision}（已编译 ${template.compiledRevision ?? '—'}）`} />
            <KeyValue label="入口" value={template.entryPath} />
            <KeyValue label="PDF" value={template.pdfPath ?? '—'} />
            <KeyValue label="源摘要" value={template.sourceDigest?.slice(0, 16) ?? '—'} />
            <KeyValue label="编译摘要" value={template.compiledDigest?.slice(0, 16) ?? '—'} />
            <KeyValue label="最近编译" value={template.lastCompiledAt === null ? '—' : formatBeijingDateTime(template.lastCompiledAt)} />
          </dl>
          {template.pdfPath === null ? null : (
            <p className="text-subtle text-[var(--font-micro-size)]" data-testid="production-template-pdf-note">
              编译产物在 research storage 里：`research.template.preview` 返回二进制 `Response` 且没有注册进 IPC（B21），
              所以这里只给路径与哈希，不画预览框。
            </p>
          )}
          {compiling ? (
            <ProgressTask
              label={`编译中：v${template.revision}`}
              detail={`activeCompileId ${template.activeCompileId ?? '—'}（轮询 getTemplate）`}
              polling
              onCancel={() => void cancel.run(template.id).then(() => templates.reload())}
              testId="production-template-progress"
            />
          ) : null}
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              data-testid="production-template-compile"
              disabled={!scope.writable || compile.pending || compiling === true || !tectonicReady}
              onClick={() => void compile.run(template.id).then(() => templates.reload())}
              className={primaryButtonClass}
            >
              <Play size={12} aria-hidden="true" className="mr-1 inline" />
              编译
            </button>
            {compiling === true ? (
              <button
                type="button"
                data-testid="production-template-cancel"
                disabled={cancel.pending}
                onClick={() => void cancel.run(template.id).then(() => templates.reload())}
                className={secondaryButtonClass}
              >
                <XCircle size={11} aria-hidden="true" className="mr-1 inline" />
                取消编译
              </button>
            ) : null}
            <button
              type="button"
              data-testid="production-template-close-detail"
              onClick={() => setSelectedId(null)}
              className={secondaryButtonClass}
            >
              关闭详情
            </button>
          </div>
          {compile.error === null ? null : <InlineHint text={compile.error} testId="production-template-compile-error" />}
          {template.errors.length === 0 ? null : (
            <ul className="flex flex-col gap-0.5" data-testid="production-template-errors">
              {template.errors.map((error, index) => (
                <li key={`${index}-${error}`} className="text-[var(--st-bad)] text-[var(--font-meta-size)]">
                  {error}
                </li>
              ))}
            </ul>
          )}
          {template.diagnostics.length === 0 ? null : (
            <ul className="flex flex-col gap-0.5" data-testid="production-template-diagnostics">
              {template.diagnostics.map((diagnostic, index) => (
                <li key={`${index}-${diagnostic.message}`} className="font-mono text-[var(--font-micro-size)] text-muted">
                  {diagnostic.severity} {diagnostic.file ?? '?'}:{diagnostic.line ?? '?'} {diagnostic.message}
                </li>
              ))}
            </ul>
          )}

          <div className="flex flex-wrap items-end gap-2">
            <label className="flex min-w-[240px] flex-1 flex-col gap-0.5">
              <FieldLabel text="入口文件（setEntry，使用当前 revision）" />
              <select
                data-testid="production-template-entry"
                value={entryPath}
                onChange={(event) => setEntryPath(event.target.value)}
                className={selectClass}
              >
                <option value="">— 选择 .tex —</option>
                {editableFiles
                  .filter((file) => file.path.toLowerCase().endsWith('.tex'))
                  .map((file) => (
                    <option key={file.path} value={file.path}>
                      {file.path}
                    </option>
                  ))}
              </select>
            </label>
            <button
              type="button"
              data-testid="production-template-set-entry"
              disabled={!scope.writable || setEntry.pending || entryPath.length === 0 || entryPath === template.entryPath}
              onClick={() => void setEntry.run(entryPath).then(() => templates.reload())}
              className={secondaryButtonClass}
            >
              设置入口
            </button>
          </div>
          {setEntry.error === null ? null : <InlineHint text={setEntry.error} testId="production-template-entry-error" />}

          <div className="flex flex-col gap-1" data-testid="production-template-files">
            <FieldLabel text={`模板文件（${editableFiles.length}）`} />
            <ul className="flex flex-col gap-1">
              {editableFiles.map((file) => (
                <li key={file.path} className="flex items-center gap-2 text-[var(--font-meta-size)]">
                  <span className="min-w-0 flex-1 truncate font-mono text-ink" title={file.path}>
                    {file.path}
                  </span>
                  <span className="shrink-0 text-subtle">{formatBytes(file.size)}</span>
                  <span className="shrink-0 text-subtle">{file.editable ? '可编辑' : '只读'}</span>
                  <button
                    type="button"
                    data-testid={`production-template-open-${file.path}`}
                    disabled={!file.editable}
                    onClick={() => {
                      void readTemplateFile(scope.client, { projectId, templateId: template.id, path: file.path }).then((result) => {
                        if (!result.ok) {
                          setOpenFile(null);
                          return;
                        }
                        setOpenFile({ path: file.path, draft: result.data.content, original: result.data });
                      });
                    }}
                    className={secondaryButtonClass}
                  >
                    打开
                  </button>
                </li>
              ))}
            </ul>
          </div>

          {openFile === null ? null : (
            <div className="flex flex-col gap-1" data-testid="production-template-editor">
              <div className="flex items-center gap-2">
                <span className="min-w-0 flex-1 truncate font-mono text-muted text-[var(--font-micro-size)]">{openFile.path}</span>
                <span className="text-subtle text-[var(--font-micro-size)]">hash {openFile.original.sha256.slice(0, 12)}</span>
              </div>
              <textarea
                data-testid="production-template-editor-content"
                value={openFile.draft}
                rows={12}
                disabled={!scope.writable}
                onChange={(event) => setOpenFile({ ...openFile, draft: event.target.value })}
                className={textAreaClass}
              />
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  data-testid="production-template-editor-save"
                  disabled={
                    !scope.writable ||
                    saveFile.pending ||
                    openFile.draft === openFile.original.content
                  }
                  onClick={() => {
                    void saveFile
                      .run({ path: openFile.path, content: openFile.draft, expectedHash: openFile.original.sha256 })
                      .then((saved) => {
                        if (saved !== null) {
                          setOpenFile(null);
                          files.reload();
                          templates.reload();
                        }
                      });
                  }}
                  className={primaryButtonClass}
                >
                  保存（expectedHash 乐观并发）
                </button>
                <button type="button" className={secondaryButtonClass} onClick={() => setOpenFile(null)}>
                  取消
                </button>
              </div>
              {saveFile.error === null ? null : <InlineHint text={saveFile.error} testId="production-template-editor-error" />}
            </div>
          )}

          <div className="flex items-center gap-2">
            <button
              type="button"
              data-testid="production-template-reload-files"
              onClick={() => files.reload()}
              className={secondaryButtonClass}
            >
              <RefreshCw size={11} aria-hidden="true" className="mr-1 inline" />
              刷新文件
            </button>
            <span className="text-subtle text-[var(--font-micro-size)]">
              文稿视图（「文稿」）可以直接编辑工作区里的 .tex/.bib 文件；这里是模板包内部的源文件。
            </span>
          </div>
        </PanelSection>
      )}
    </div>
  );
}
