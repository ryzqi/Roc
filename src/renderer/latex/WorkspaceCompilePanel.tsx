import { useRef, useState, type ReactNode } from 'react';
import { Download, FileText, Play, Square } from 'lucide-react';
import type { WorkspaceLatexCompileResult } from '../../shared/schemas/research-production';
import type { RocClient } from '../shared/roc-client';
import { useAsyncAction } from '../app/use-async-resource';
import { primaryButtonClass } from './panel-shell';
import {WorkspaceProblems} from './WorkspaceProblems';
import {ActionButton} from '../shared/form-ui';
import {ActionStatus} from '../shared/action-status';

type Props = {
  client: RocClient;
  projectId: string | null;
  writable: boolean;
  files: readonly { path: string }[];
  beforeCompile: () => Promise<boolean>;
  onBusyChange: (busy: boolean) => void;
  onDiagnostic: (path: string, line: number | null) => void;
  onPreview: (path: string) => void;
  children: ReactNode;
};

export function WorkspaceCompilePanel({ client, projectId, writable, files, beforeCompile, onBusyChange, onDiagnostic, onPreview, children }: Props): React.JSX.Element {
  const candidates = files.filter(file => file.path.toLowerCase().endsWith('.tex'));
  const [selectedEntry, setSelectedEntry] = useState<string | null>(null);
  const entryPath = candidates.some(file => file.path === selectedEntry) ? selectedEntry! :
    candidates.find(file => file.path === 'main.tex')?.path ?? candidates[0]?.path ?? '';
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [cancelRequested, setCancelRequested] = useState(false);
  const [result, setResult] = useState<WorkspaceLatexCompileResult | null>(null);
  const [exported, setExported] = useState<string | null>(null);
  const requireProject = (): string => {
    if (projectId === null) throw new Error('请先选择研究项目。');
    return projectId;
  };
  const compile = useAsyncAction((id: string, entry: string) => client.api.research.compileWorkspaceLatex({ projectId: requireProject(), requestId: id, entryPath: entry }), { label: '编译文稿' });
  const cancel = useAsyncAction((id: string) => client.api.research.cancelWorkspaceLatex({ projectId: requireProject(), requestId: id }), { label: '取消编译' });
  const exportPdf = useAsyncAction((outputPath: string, pdfHash: string) => client.api.research.exportWorkspaceLatex({ projectId: requireProject(), outputPath, pdfHash }), { label: '导出 PDF' });

  const run = async (): Promise<void> => {
    if (busyRef.current || !writable || !entryPath || projectId === null) return;
    busyRef.current = true;
    setBusy(true);
    onBusyChange(true);
    setCancelRequested(false);
    compile.reset(); cancel.reset(); exportPdf.reset();
    setExported(null);
    try {
      if (!await beforeCompile()) return;
      setResult(null);
      const id = crypto.randomUUID();
      setRequestId(id);
      const response = await compile.run(id, entryPath);
      if (response.ok) setResult(response.data);
    } finally {
      setRequestId(null);
      busyRef.current = false;
      setBusy(false);
      onBusyChange(false);
    }
  };

  const cancelRun = async (): Promise<void> => {
    if (requestId === null || cancel.pending || cancelRequested) return;
    const response = await cancel.run(requestId);
    if (response.ok && response.data.requested) setCancelRequested(true);
  };

  const output = result?.status === 'ready' ? result : null;
  const error = compile.error ?? cancel.error ?? exportPdf.error;
  return <>{projectId === null ? null : <section className="authoring-compile" aria-label="文稿编译" data-testid="writing-compile-panel">
    <div className="authoring-compile-toolbar">
      <label className="authoring-entry"><span>主文件</span>
        <select aria-label="编译主文件" value={entryPath} disabled={busy || candidates.length === 0}
          onChange={event => setSelectedEntry(event.target.value)}>
          {candidates.length === 0 ? <option value="">没有 LaTeX 主文件</option> : candidates.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
        </select>
      </label>
      <ActionButton variant="unstyled" className={primaryButtonClass} disabled={busy || !writable || !entryPath}
        loading={busy} loadingLabel={requestId === null ? '正在保存…' : '正在编译…'}
        data-testid="writing-compile" onClick={() => void run()}>
        <Play size={14} aria-hidden="true" />编译
      </ActionButton>
      {requestId !== null ? <ActionButton variant="unstyled" className="authoring-secondary"
        loading={cancel.pending || cancelRequested} loadingLabel="正在取消…"
        disabled={cancel.pending || cancelRequested}
        onClick={() => void cancelRun()} data-testid="writing-compile-cancel">
        <Square size={14} aria-hidden="true" />取消编译
      </ActionButton> : null}
      {output?.outputPath && output.pdfHash ? <>
        <button type="button" className="authoring-secondary" disabled={busy} onClick={() => onPreview(output.outputPath!)}><FileText size={14} aria-hidden="true" />预览 PDF</button>
        <ActionButton variant="unstyled" className="authoring-secondary" disabled={busy || exportPdf.pending}
          loading={exportPdf.pending} loadingLabel="正在导出…" data-testid="writing-export"
          onClick={() => { setExported(null); void exportPdf.run(output.outputPath!, output.pdfHash!).then(response => { if (response.ok) setExported(response.data.path); }); }}>
          <Download size={14} aria-hidden="true" />导出 PDF
        </ActionButton>
      </> : null}
    </div>
    {busy ? <ActionStatus state="pending" icon={null} className="mt-2 w-full text-muted">
      {requestId === null ? '正在保存当前草稿' : cancelRequested ? '正在停止编译，等待完成回执' : `正在编译 ${entryPath}`}
    </ActionStatus> : null}
    {result !== null ? <ActionStatus
      state={result.status === 'ready' ? 'success' : result.status === 'cancelled' ? 'idle' : 'error'}
      role={result.status === 'cancelled' ? 'status' : undefined}
      className="mt-2 w-full text-muted" testId="writing-compile-result">
      {result.status === 'ready' ? `上次编译成功：${result.entryPath}` : result.status === 'cancelled' ? '编译已取消' : '编译失败'}
      {result.outputPath ? <span className="authoring-output-path" title={result.outputPath}>{result.outputPath}</span> : null}
    </ActionStatus> : null}
    {error ? <ActionStatus state="error" className="mt-2 w-full text-muted">{error}</ActionStatus> : null}
    {exported ? <ActionStatus state="success" className="mt-2 w-full text-muted">已导出至 {exported}</ActionStatus> : null}
  </section>}
  {children}
  {result !== null && result.diagnostics.length > 0 ? <WorkspaceProblems key={result.requestId} result={result} onDiagnostic={onDiagnostic}/> : null}
  </>;
}
