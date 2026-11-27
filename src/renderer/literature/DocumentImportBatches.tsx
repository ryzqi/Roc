import {useEffect, useRef, useState} from 'react';
import type {DocumentImportBatch} from '../../shared/schemas/research-document-import-batch';
import {runIpcAction} from '../app/loaded-state';
import type {RocClient} from '../shared/roc-client';
import {ActionButton, formInputClass} from '../shared/form-ui';
import {ActionStatus} from '../shared/action-status';

const labels: Record<DocumentImportBatch['entries'][number]['status'], string> = {
  queued: '等待保存', receiving: '正在保存', saved: '原件已保存', importing: '登记文献中',
  waiting_parse: '等待解析', parsing: '正在解析', parsed: '解析完成', duplicate: '重复跳过', failed: '失败'
};
const explanations: Record<string, string> = {
  ENOENT: '找不到原件，请恢复文件位置后重试。',
  EACCES: '无法读取文件，请检查访问权限。',
  EPERM: '无法读取文件，请检查访问权限。',
  ENOSPC: '磁盘空间不足，请清理后重试。',
  research_source_format_unsupported: '文件格式不支持。',
  research_document_source_changed: '源文件已发生变化，请重新选择。',
  research_file_size_invalid: '原件为空或超过 512 MB。',
  research_document_not_found: '文档已移除。',
  research_models_unavailable: '需要先下载解析模型。',
  research_document_parse_cancelled: '解析已取消。',
  research_document_body_empty_or_invalid: '解析未提取到可用正文。'
};

type BatchSummary = {id: string; createdAt: string; total: number; pending: number; failed: number};
type Props = {client: RocClient; projectId: string | null; initialBatchId: string | null; writable: boolean; onDocumentsChanged: () => void};
const pageSize = 20;

export function DocumentImportBatches({client, projectId, initialBatchId, writable, onDocumentsChanged}: Props) {
  const [offset, setOffset] = useState(0);
  const [history, setHistory] = useState<BatchSummary[]>([]);
  const [selected, setSelected] = useState(initialBatchId);
  const [batch, setBatch] = useState<DocumentImportBatch | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const associated = useRef(new Set<string>());
  const onChange = useRef(onDocumentsChanged);
  onChange.current = onDocumentsChanged;

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout>;
    const update = async (): Promise<void> => {
      const result = await runIpcAction(() => client.api.research.listDocumentImportBatches({projectId, offset}));
      if (stopped) return;
      if (!result.ok) {setError(result.error); return;}
      setHistory(result.data);
      const batchId = selected ?? result.data[0]?.id;
      if (batchId === undefined) {setBatch(null); return;}
      const detail = await runIpcAction(() => client.api.research.readDocumentImportBatch({projectId, batchId}));
      if (stopped) return;
      if (!detail.ok) {setError(detail.error); return;}
      setError(null);
      setBatch(detail.data);
      const newDocuments = detail.data.entries.flatMap(entry => entry.documentId && !associated.current.has(entry.documentId) ? [entry.documentId] : []);
      if (newDocuments.length > 0) {
        for (const id of newDocuments) associated.current.add(id);
        onChange.current();
      }
      if (result.data.some(entry => entry.pending > 0)) timer = setTimeout(() => void update(), 1500);
    };
    void update();
    return () => {stopped = true; clearTimeout(timer);};
  }, [client, projectId, selected, offset, refresh]);

  if (batch === null && history.length === 0 && error === null && offset === 0) return null;
  const entries = batch?.entries ?? [];
  const parsed = entries.filter(entry => entry.status === 'parsed').length;
  const duplicate = entries.filter(entry => entry.status === 'duplicate').length;
  const failed = entries.filter(entry => entry.status === 'failed').length;
  const pending = entries.length - parsed - duplicate - failed;

  return (
    <section aria-label="文档导入批次" className="flex flex-col gap-2">
      {history.length > 0 && <label className="flex items-center gap-2">
        <span>导入记录</span>
        <select className={formInputClass} value={selected ?? history[0]?.id} onChange={event => {
          setSelected(event.target.value);
          setBatch(null);
        }}>
          {history.map(entry => <option key={entry.id} value={entry.id}>
            {new Date(entry.createdAt).toLocaleString()} · {entry.total} 份
          </option>)}
        </select>
      </label>}
      {(offset > 0 || history.length === pageSize) && <div className="flex gap-2">
        <ActionButton disabled={offset === 0} onClick={() => {setSelected(null); setBatch(null); setOffset(offset - pageSize);}}>上一批记录</ActionButton>
        <ActionButton disabled={history.length < pageSize} onClick={() => {setSelected(null); setBatch(null); setOffset(offset + pageSize);}}>更早的记录</ActionButton>
      </div>}
      {error !== null && <ActionStatus state="error">{error}</ActionStatus>}
      {batch !== null && <>
        <p role="status">共 {entries.length} 份 · 解析完成 {parsed} · 重复 {duplicate} · 处理中 {pending} · 失败 {failed}</p>
        <details open={failed > 0 || undefined}>
          <summary>逐文件状态</summary>
          <ul className="max-h-52 overflow-auto">
            {entries.map(entry => <li key={entry.id} className="break-words py-1">
              {entry.filename} · {labels[entry.status]}
              {entry.error && <span className="ml-2 text-muted">{explanations[entry.error] ?? entry.error}</span>}
            </li>)}
          </ul>
        </details>
        {writable && failed > 0 && <ActionButton loading={retrying} onClick={() => {
          setRetrying(true);
          void runIpcAction(() => client.api.research.retryDocumentImportBatch({projectId, batchId: batch.id})).then(result => {
            setRetrying(false);
            if (!result.ok) {setError(result.error); return;}
            setBatch(result.data);
            setRefresh(value => value + 1);
          });
        }}>重试失败文档</ActionButton>}
      </>}
    </section>
  );
}
