import {useEffect, useRef, useState} from 'react';
import type {TaskDiagnosticsExport} from '../../../shared/schemas/research-task-observability';
import {useAsyncAction} from '../../app/use-async-resource';
import {formSecondaryButtonClass} from '../../shared/form-ui';
import type {RocClient} from '../../shared/roc-client';
export function TaskDiagnosticsExportButton({client, projectId, taskId}: {
  client: RocClient; projectId: string; taskId: string;
}): React.JSX.Element {
  const [receipt, setReceipt] = useState<TaskDiagnosticsExport|null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const action = useAsyncAction(() => client.api.research.exportTaskDiagnostics({projectId, taskId}), {label: '导出离线诊断'});
  return <div className="grid min-w-0 gap-1" data-testid="mgmt-task-diagnostics-export">
    <button type="button" className={`${formSecondaryButtonClass} justify-self-start`} disabled={action.pending}
      onClick={() => {
        if (inFlight.current) return;
        inFlight.current = true;
        setReceipt(null);
        void action.run().then(result => {if (mounted.current && result.ok) setReceipt(result.data);})
          .finally(() => {inFlight.current = false;});
      }}>{action.pending ? '导出中…' : '导出离线诊断'}</button>
    {action.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{action.error}</p>}
    {receipt === null ? null : <div className="grid gap-1 text-subtle" role="status">
      <p>诊断已保存到本机 / {receipt.size} B</p>
      <p className="break-all select-text font-mono">{receipt.path}</p>
      <p className="break-all select-text font-mono">SHA256 {receipt.sha256}</p>
      <p>正文、工具参数与敏感字段已移除。没有外部 Trace 上传。</p>
    </div>}
  </div>;
}
