import { useAsyncResource } from '../../app/use-async-resource';
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
  const data = resource.data;

  return (
    <FormSection title="项目 Python 环境" testId="mgmt-python-environment">
      <p className="text-muted text-[length:var(--font-meta-size)]">
        环境自动准备，无需选择解释器。
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
          {data.selections.length === 0 ? <p className="text-subtle">暂无环境记录</p> : (
            <details data-testid="mgmt-python-environment-history">
              <summary className="cursor-pointer text-muted focus-visible:outline-2 focus-visible:outline-focus-ring">
                环境记录（{data.selections.length}）
              </summary>
              <p className="mt-2 text-subtle">记录时已核验，运行前会再次检查。</p>
              <ol className="mt-2 grid gap-3 text-[length:var(--font-meta-size)]">
                {[...data.selections].reverse().map(({ snapshot }) => (
                  <li key={snapshot.id} className="grid min-w-0 gap-1">
                    <p className="text-ink">Python {snapshot.version}
                      <span className="ml-2 text-subtle">记录于 {date.format(new Date(snapshot.recordedAt))}</span>
                    </p>
                    <p dir="ltr" className="break-all font-mono text-muted">{snapshot.selectedExecutable}</p>
                  </li>
                ))}
              </ol>
            </details>
          )}
        </>
      )}
    </FormSection>
  );
}
