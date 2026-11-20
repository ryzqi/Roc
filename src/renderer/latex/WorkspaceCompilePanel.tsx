import { useRef, useState } from 'react';
import { Download, FileText, Loader2, Play, Square } from 'lucide-react';
import type { WorkspaceLatexCompileResult } from '../../shared/schemas/research-production';
import type { RocClient } from '../shared/roc-client';
import { useAsyncAction } from '../app/use-async-resource';
import { primaryButtonClass } from './panel-shell';

type Props = {
  client: RocClient;
  projectId: string;
  writable: boolean;
  files: readonly { path: string }[];
  beforeCompile: () => Promise<boolean>;
  onBusyChange: (busy: boolean) => void;
  onDiagnostic: (path: string, line: number | null) => void;
  onPreview: (path: string) => void;
};

export function WorkspaceCompilePanel({ client, projectId, writable, files, beforeCompile, onBusyChange, onDiagnostic, onPreview }: Props): React.JSX.Element {
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
  const compile = useAsyncAction((id: string, entry: string) => client.api.research.compileWorkspaceLatex({ projectId, requestId: id, entryPath: entry }), { label: '编译文稿' });
  const cancel = useAsyncAction((id: string) => client.api.research.cancelWorkspaceLatex({ projectId, requestId: id }), { label: '取消编译' });
  const exportPdf = useAsyncAction((outputPath: string, pdfHash: string) => client.api.research.exportWorkspaceLatex({ projectId, outputPath, pdfHash }), { label: '导出 PDF' });

  const run = async (): Promise<void> => {
    if (busyRef.current || !writable || !entryPath) return;
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
  return <section className="authoring-compile" aria-label="文稿编译" data-testid="writing-compile-panel">
    <div className="authoring-compile-toolbar">
      <label className="authoring-entry"><span>主文件</span>
        <select aria-label="编译主文件" value={entryPath} disabled={busy || candidates.length === 0}
          onChange={event => setSelectedEntry(event.target.value)}>
          {candidates.length === 0 ? <option value="">没有 LaTeX 主文件</option> : candidates.map(file => <option key={file.path} value={file.path}>{file.path}</option>)}
        </select>
      </label>
      <button type="button" className={primaryButtonClass} disabled={busy || !writable || !entryPath}
        data-testid="writing-compile" onClick={() => void run()}>
        {busy ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Play size={14} aria-hidden="true" />}
        {busy ? requestId === null ? '正在保存…' : '正在编译…' : '编译'}
      </button>
      {requestId !== null ? <button type="button" className="authoring-secondary" disabled={cancel.pending || cancelRequested}
        onClick={() => void cancelRun()} data-testid="writing-compile-cancel"><Square size={14} aria-hidden="true" />{cancel.pending || cancelRequested ? '正在取消…' : '取消编译'}</button> : null}
      {output?.outputPath && output.pdfHash ? <>
        <button type="button" className="authoring-secondary" disabled={busy} onClick={() => onPreview(output.outputPath!)}><FileText size={14} aria-hidden="true" />预览 PDF</button>
        <button type="button" className="authoring-secondary" disabled={busy || exportPdf.pending} data-testid="writing-export"
          onClick={() => { setExported(null); void exportPdf.run(output.outputPath!, output.pdfHash!).then(response => { if (response.ok) setExported(response.data.path); }); }}>
          {exportPdf.pending ? <Loader2 size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" /> : <Download size={14} aria-hidden="true" />}{exportPdf.pending ? '正在导出…' : '导出 PDF'}
        </button>
      </> : null}
    </div>
    {busy ? <p role="status">{requestId === null ? '正在保存当前草稿' : cancelRequested ? '正在停止编译，等待完成回执' : `正在编译 ${entryPath}`}</p> : null}
    {result !== null ? <p role="status" data-testid="writing-compile-result">
      {result.status === 'ready' ? `上次编译成功：${result.entryPath}` : result.status === 'cancelled' ? '编译已取消' : '编译失败'}
      {result.outputPath ? <span className="authoring-output-path" title={result.outputPath}>{result.outputPath}</span> : null}
    </p> : null}
    {error ? <p role="alert">{error}</p> : null}
    {exported ? <p role="status">已导出至 {exported}</p> : null}
    {result !== null && result.diagnostics.length > 0 ? <details className="authoring-diagnostics" open={result.status === 'failed'}>
      <summary>构建问题（{result.diagnostics.length}）</summary>
      <ul>{result.diagnostics.map((diagnostic, index) => <li key={index}>
        <span>{diagnostic.severity === 'error' ? '错误' : diagnostic.severity === 'warning' ? '警告' : '提示'}</span>
        {diagnostic.file ? <button type="button" className="authoring-diagnostic-link" onClick={() => onDiagnostic(diagnostic.file!, diagnostic.line)}>
          {diagnostic.file}{diagnostic.line === null ? '' : `:${diagnostic.line}`}
        </button> : null}
        <span>{diagnostic.message}</span>
      </li>)}</ul>
    </details> : null}
  </section>;
}
