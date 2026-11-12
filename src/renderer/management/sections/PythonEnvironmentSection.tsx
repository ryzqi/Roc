import { useState } from 'react';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import { FormSection, formSecondaryButtonClass } from '../../shared/form-ui';
import type { RocClient } from '../../shared/roc-client';

const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });

export function PythonEnvironmentSection({ client, projectId }: {
  client: RocClient; projectId: string;
}): React.JSX.Element {
  const resource = useAsyncResource(`python-environments:${projectId}`, async () => {
    const [project, selections] = await Promise.all([
      client.api.research.getProject({ id: projectId }),
      client.api.research.listPythonEnvironmentSelections({ projectId })
    ]);
    if (!project.ok) return project;
    if (!selections.ok) return selections;
    if (project.data.id !== projectId || selections.data.some(value => value.snapshot.request.projectId !== projectId)) {
      throw new Error('research_python_selection_project_mismatch');
    }
    return { ok: true as const, data: { project: project.data, selections: selections.data } };
  }, { label: '读取项目 Python 环境' });
  const select = useAsyncAction(async () => client.api.research.selectPythonEnvironment({
    projectId, requestId: crypto.randomUUID()
  }), { label: '选择 Python 环境' });
  const [notice, setNotice] = useState<'cancelled' | 'saved' | null>(null);
  const data = resource.data;
  const unavailable = resource.status !== 'ready' || data === null || data.project.status === 'archived'
    || data.project.workspacePath === null;

  return (
    <FormSection title="项目 Python 环境" testId="mgmt-python-environment">
      <p className="text-muted text-[length:var(--font-meta-size)]">
        请先在项目根目录准备 roc-python.lock.json，记录 Python 版本与完整依赖，再选择已有 CPython 3.14 环境。运行前重新核验，环境变化后需重新选择。
      </p>
      {resource.status === 'error' ? (
        <div className="grid gap-2">
          <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p>
          <button type="button" className={`${formSecondaryButtonClass} justify-self-start`}
            onClick={resource.reload}>重试读取 Python 环境</button>
        </div>
      ) : resource.status === 'loading' ? <p role="status" className="text-subtle">读取 Python 环境中…</p> : null}
      {data === null ? null : (
        <>
          {data.project.status === 'archived' ? <p className="text-subtle">项目已归档，环境记录只读。</p>
            : data.project.workspacePath === null ? <p className="text-subtle">请先为项目设置工作目录。</p> : null}
          {data.selections.length === 0 ? <p className="text-subtle">尚未选择 Python 环境。</p> : (
            <details data-testid="mgmt-python-environment-history">
              <summary className="cursor-pointer text-muted focus-visible:outline-2 focus-visible:outline-accent">
                选择记录（{data.selections.length}）
              </summary>
              <ol className="mt-2 grid gap-3 text-[length:var(--font-meta-size)]">
                {[...data.selections].reverse().map(({ snapshot }) => (
                  <li key={snapshot.id} className="grid min-w-0 gap-1">
                    <p className="text-ink">Python {snapshot.version}
                      <span className="ml-2 text-subtle">记录于 {date.format(new Date(snapshot.recordedAt))}</span>
                    </p>
                    <p dir="ltr" className="break-all font-mono text-muted">{snapshot.selectedExecutable}</p>
                    <p className="text-subtle">选择时已核验，当前可用性将在运行前检查。</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
      <button type="button" className={`${formSecondaryButtonClass} justify-self-start`}
        data-testid="mgmt-python-environment-select" disabled={unavailable || select.pending}
        onClick={() => {
          setNotice(null);
          void select.run().then(result => {
            if (!result.ok) return;
            setNotice(result.data === null ? 'cancelled' : 'saved');
            if (result.data !== null) resource.reload();
          });
        }}>{select.pending ? '选择并核验中…' : '选择 Python 环境…'}</button>
      {select.pending ? <p role="status" className="text-subtle">在系统面板选择解释器，随后核验环境与项目锁文件。</p> : null}
      {notice === null ? null : <p role="status" className="text-muted">
        {notice === 'cancelled' ? '已取消选择。' : '环境选择已记录。'}
      </p>}
      {select.error === null ? null : <p role="alert" className="break-words text-[var(--st-bad)]">{select.error}</p>}
    </FormSection>
  );
}
