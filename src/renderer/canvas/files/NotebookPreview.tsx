import { useEffect, useRef, useState } from 'react';
import { Archive, RefreshCw, X } from 'lucide-react';
import type { ResearchNotebookPreview, ResearchNotebookReceipt } from '../../../shared/schemas/research-notebooks';
import type { RocClient } from '../../shared/roc-client';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import { ErrorBar } from '../../shell/ErrorBar';
import { formatBytes } from '../../shared/format';

type Props = {
  client: RocClient; projectId: string | null; workspacePath: string | null;
  relativePath: string; writable: boolean; onClose?: () => void;
};
const pageSize = 20;
const recordedDate = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'short', timeStyle: 'short' });
const buttonClass = 'inline-flex items-center gap-1 rounded-control border-[0.5px] border-line px-2 py-1 text-muted hover:text-ink active:bg-[var(--overlay-active)] disabled:opacity-50';

export default function NotebookPreview(props: Props): React.JSX.Element {
  return <NotebookPreviewContent key={JSON.stringify([props.projectId, props.workspacePath, props.relativePath])} {...props} />;
}

function NotebookPreviewContent({ client, projectId, workspacePath, relativePath, writable, onClose }: Props): React.JSX.Element {
  const [offset, setOffset] = useState(0);
  const [selected, setSelected] = useState<ResearchNotebookReceipt | null>(null);
  const importing = useRef(false);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {mounted.current = false;};
  }, []);
  const scope = projectId === null || workspacePath === null ? null : JSON.stringify([projectId, workspacePath, relativePath]);
  const current = useAsyncResource(scope, async () => {
    const [project, preview] = await Promise.all([
      client.api.research.getProject({ id: projectId! }),
      client.api.research.previewNotebook({ projectId: projectId!, path: relativePath })
    ]);
    if (!project.ok) return project;
    if (!preview.ok) return preview;
    if (project.data.id !== projectId || project.data.workspacePath !== workspacePath) {
      throw new Error('research_notebook_workspace_changed');
    }
    return { ok: true as const, data: { project: project.data, preview: preview.data } };
  }, { label: '读取 Notebook' });
  const history = useAsyncResource(scope === null ? null : JSON.stringify([projectId, offset]), async () => {
    const result = await client.api.research.listNotebooks({ projectId: projectId!, offset, limit: pageSize });
    if (result.ok && result.data.items.some(item => item.snapshot.request.projectId !== projectId)) {
      throw new Error('research_notebook_project_mismatch');
    }
    return result;
  }, { label: '读取 Notebook 导入记录' });
  const frozen = useAsyncResource(selected === null ? null : JSON.stringify([projectId, selected.snapshot.id, selected.snapshotHash]), async () => {
    const result = await client.api.research.getNotebook({
      projectId: projectId!, notebookId: selected!.snapshot.id, expectedHash: selected!.snapshotHash
    });
    if (result.ok && (result.data.receipt.snapshot.request.projectId !== projectId ||
      result.data.receipt.snapshotHash !== selected!.snapshotHash ||
      result.data.receipt.snapshot.id !== selected!.snapshot.id ||
      result.data.preview.sha256 !== selected!.snapshot.sha256)) {
      throw new Error('research_notebook_hash_mismatch');
    }
    return result;
  }, { label: '读取已导入 Notebook' });
  const importNotebook = useAsyncAction(async (expectedSha256: string) => {
    const result = await client.api.research.importNotebook({
      projectId: projectId!, path: relativePath, expectedSha256, requestId: crypto.randomUUID()
    });
    if (result.ok && (result.data.receipt.snapshot.request.projectId !== projectId ||
      result.data.receipt.snapshot.request.path !== relativePath ||
      result.data.receipt.snapshot.sha256 !== expectedSha256 || result.data.preview.sha256 !== expectedSha256)) {
      throw new Error('research_notebook_import_identity_mismatch');
    }
    return result;
  }, { label: '导入 Notebook' });
  const active = selected === null ? current : frozen;
  const preview = selected === null ? current.data?.preview ?? null : frozen.data?.preview ?? null;
  const canImport = scope !== null && writable && current.status === 'ready' && current.data?.project.status !== 'archived' && !importNotebook.pending;
  const changed = selected !== null && selected.snapshot.request.path === relativePath &&
    current.status === 'ready' && current.data?.preview.sha256 !== selected.snapshot.sha256;
  return (
    <div className="flex h-full min-h-0 flex-col" data-testid="file-preview" data-kind="notebook">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b-[0.5px] border-line px-3 py-2">
        <span className="min-w-0 flex-1 truncate font-mono text-xs" title={relativePath}>{relativePath}</span>
        <button type="button" className={buttonClass} disabled={importNotebook.pending} aria-label="重新读取 Notebook"
          onClick={() => { if (!importing.current) {current.reload(); history.reload(); frozen.reload();} }}>
          <RefreshCw size={13} aria-hidden="true" />
        </button>
        <button type="button" className={buttonClass} data-testid="file-notebook-import" disabled={!canImport}
          onClick={async () => {
            if (!canImport || importing.current) return;
            importing.current = true;
            try {
              const result = await importNotebook.run(current.data!.preview.sha256);
              if (mounted.current && result.ok) {setSelected(result.data.receipt); history.reload();}
            } finally {
              importing.current = false;
            }
          }}>
          <Archive size={13} aria-hidden="true" />{importNotebook.pending ? '导入中…' : '保存导入快照'}
        </button>
        {onClose === undefined ? null : <button type="button" className={buttonClass} onClick={onClose} aria-label="关闭文件预览">
          <X size={13} aria-hidden="true" />
        </button>}
      </div>
      <div className="min-h-0 flex-1 overflow-auto p-3" data-testid="file-notebook-scroll">
        <p className="text-muted text-xs" data-testid="file-notebook-trust">静态预览，未执行代码。已有输出未受信，不作为实验结果。</p>
        {scope === null ? <p className="mt-2 text-muted">请先选择有工作目录的项目。</p> : null}
        <div className="my-3 flex flex-wrap items-center gap-2">
          <button type="button" className={buttonClass} aria-pressed={selected === null} disabled={importNotebook.pending}
            onClick={() => {if (!importing.current) setSelected(null);}}>当前文件</button>
          <details className="min-w-0 max-w-full" data-testid="file-notebook-history">
            <summary className="cursor-pointer text-xs text-muted">项目导入记录{history.data === null ? '' : `（${history.data.total}）`}</summary>
            <div className="mt-2 space-y-1">
              {history.status === 'loading' ? <p role="status" className="text-muted text-xs">读取导入记录中…</p> : null}
              {history.data?.items.map(receipt => <button type="button" key={receipt.snapshot.id} className={`${buttonClass} flex w-full text-left`}
                aria-pressed={selected?.snapshot.id === receipt.snapshot.id} data-testid="file-notebook-history-item" disabled={importNotebook.pending}
                onClick={() => {if (!importing.current) setSelected(receipt);}}>
                <span className="min-w-0 break-all">{receipt.snapshot.request.path}</span>
                <span className="shrink-0 text-xs">{recordedDate.format(new Date(receipt.snapshot.recordedAt))}</span>
                <span className="shrink-0 font-mono text-xs">{receipt.snapshot.sha256.slice(0, 8)}</span>
              </button>)}
              {history.data?.total === 0 ? <p className="text-muted text-xs">暂无导入记录。</p> : null}
              {history.data !== null && history.data.total > pageSize ? <div className="flex items-center gap-2">
                <button type="button" className={buttonClass} disabled={offset === 0 || importNotebook.pending || history.status === 'loading'}
                  onClick={() => {if (!importing.current) setOffset(offset - pageSize);}}>上一页</button>
                <span className="text-xs tabular-nums">{offset + 1}–{Math.min(offset + pageSize, history.data.total)}</span>
                <button type="button" className={buttonClass} disabled={offset + pageSize >= history.data.total || importNotebook.pending || history.status === 'loading'}
                  onClick={() => {if (!importing.current) setOffset(offset + pageSize);}}>下一页</button>
              </div> : null}
            </div>
          </details>
        </div>
        {history.error === null ? null : <ErrorBar error={{ level: 'page', message: history.error, retry: history.reload }} />}
        {importNotebook.error === null ? null : <ErrorBar error={{ level: 'page', message: importNotebook.error }} />}
        {active.error === null ? null : <ErrorBar error={{ level: 'page', message: active.error, retry: active.reload }} />}
        {selected !== null ? <p className="my-2 break-all text-xs text-muted" data-testid="file-notebook-frozen">
          已导入快照 {selected.snapshot.request.path}，{recordedDate.format(new Date(selected.snapshot.recordedAt))}。原字节已保存。
        </p> : null}
        {changed ? <p className="my-2 text-xs text-[var(--st-warn)]" data-testid="file-notebook-source-changed">当前文件已改变，正在显示原导入版本。</p> : null}
        {selected !== null && current.error !== null ? <p className="my-2 text-xs text-muted">当前文件无法读取，导入版本保持可读。</p> : null}
        {active.status === 'loading' ? <p className="text-muted" role="status">读取 Notebook 中…</p> : null}
        {preview === null ? null : <NotebookCells preview={preview} />}
      </div>
    </div>
  );
}

function NotebookCells({ preview }: { preview: ResearchNotebookPreview }): React.JSX.Element {
  return (
    <div data-testid="file-notebook-cells">
      <div className="mb-3 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted">
        <span>{preview.cells.length} 个单元格</span><span>{formatBytes(preview.size)}</span>
        <span>语言 {preview.language ?? '未声明'}</span><span>内核 {preview.kernel ?? '未声明'}</span>
      </div>
      <details className="mb-3 text-xs text-muted">
        <summary className="cursor-pointer">文件来源哈希</summary>
        <p className="mt-1 break-all font-mono" data-testid="file-notebook-hash">{preview.sha256}</p>
      </details>
      {preview.cells.map(cell => <details key={cell.id} open={cell.index === 0} className="border-t-[0.5px] border-line py-2"
        data-testid="file-notebook-cell" data-cell-id={cell.id}>
        <summary className="cursor-pointer text-xs">
          <span className="mr-2 tabular-nums">{cell.index + 1}</span>
          <span className="mr-2">{cell.cellType}</span><span className="font-mono break-all">{cell.id}</span>
          {cell.cellType === 'code' ? <span className="ml-3 text-muted">原执行计数 {cell.executionCount ?? '未执行'}</span> : null}
        </summary>
        <pre className="my-2 overflow-x-auto rounded-control bg-code-surface p-2 font-mono text-xs text-[var(--code-text)]" dir="ltr"
          data-testid="file-notebook-source">{cell.source}</pre>
        {cell.source.length < cell.sourceCharacters ? <p className="text-xs text-muted">源码预览 {cell.source.length}/{cell.sourceCharacters} 字符，完整来源已保留。</p> : null}
        {cell.reviewIssues.length === 0 ? null : <ul className="my-2 space-y-1 text-xs text-muted" data-testid="file-notebook-review">
          {cell.reviewIssues.map((issue, index) => <li key={index} className="break-all">{issue.line === null ? '' : `第 ${issue.line} 行 `}{issue.kind}：{issue.detail}</li>)}
        </ul>}
        {cell.outputs.map(output => <div key={output.index} className="my-2 text-xs" data-testid="file-notebook-output">
          <p className="break-all text-muted">原输出 {output.index + 1}，{output.kind}，未受信</p>
          <pre className="my-1 overflow-x-auto rounded-control bg-code-surface p-2 font-mono text-[var(--code-text)]" dir="ltr">{output.text}</pre>
          {output.text.length < output.textCharacters ? <p className="text-muted">文本预览 {output.text.length}/{output.textCharacters} 字符</p> : null}
          <p className="break-all text-muted">MIME {output.mimeTypes.join(', ')}，仅显示纯文本。</p>
        </div>)}
        {cell.attachments.length === 0 ? null : <ul className="text-xs text-muted">
          {cell.attachments.map(attachment => <li key={attachment.name} className="break-all">附件 {attachment.name}，{attachment.mimeTypes.join(', ')}，未呈现。</li>)}
        </ul>}
        <details className="mt-2 text-xs text-muted" data-testid="file-notebook-cell-origin">
          <summary className="cursor-pointer">单元格来源</summary>
          <div className="space-y-1 break-all font-mono" dir="ltr">
            <p>cell {cell.cellHash}</p><p>source {cell.sourceHash}</p>
            {cell.outputs.map(output => <p key={output.index}>output {output.index + 1} {output.hash}</p>)}
            {cell.attachments.map(attachment => <p key={attachment.name}>attachment {attachment.name} {attachment.hash}</p>)}
          </div>
        </details>
      </details>)}
    </div>
  );
}
