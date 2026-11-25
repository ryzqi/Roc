import { useEffect, useState } from 'react';
import { CheckCircle2, Circle, CircleAlert, LoaderCircle, Square } from 'lucide-react';
import { pythonEnvironmentActivePhases, type ResearchPythonEnvironmentOperation } from '../../../shared/schemas/research-python-environments';
import { useAsyncAction, useAsyncResource } from '../../app/use-async-resource';
import { FormSection, formSecondaryButtonClass } from '../../shared/form-ui';
import type { RocClient } from '../../shared/roc-client';

const date = new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' });
const phaseLabels: Record<ResearchPythonEnvironmentOperation['phase'], string> = {
  queued: '等待准备', validating: '检查项目配置', downloading_runtime: '下载 Python 运行环境', creating_venv: '创建项目环境',
  resolving: '解析项目依赖', syncing: '安装项目依赖', verifying: '核验项目环境', ready: '环境已就绪',
  failed: '准备失败', cancelled: '已取消准备', interrupted: '准备已中断'
};

function preparationError(code: string | null): string {
  if (code?.includes('lock')) return '项目依赖锁与配置不一致，请更新依赖锁后重试。';
  if (code?.includes('version')) return '项目指定的 Python 版本暂不支持，请检查项目版本配置。';
  if (code?.includes('download') || code?.includes('network')) return '下载未完成，请检查网络连接后重试。';
  if (code?.includes('venv') || code?.includes('directory')) return '已有项目环境无法使用，请检查工作目录中的环境。';
  if (code?.includes('dependency') || code?.includes('source')) return '项目包含暂不支持的依赖，请检查依赖配置。';
  if (code?.includes('workspace')) return '项目工作目录已变化，请检查目录后重试。';
  return '环境准备未完成，请检查项目配置后重试。';
}

export function PythonEnvironmentSection(props: { client: RocClient; projectId: string }): React.JSX.Element {
  return <ProjectPythonEnvironmentSection key={props.projectId} {...props} />;
}

function ProjectPythonEnvironmentSection({ client, projectId }: { client: RocClient; projectId: string }): React.JSX.Element {
  const resource = useAsyncResource(`python-environments:${projectId}`, async () => {
    const [project, environments, status] = await Promise.all([
      client.api.research.getProject({ id: projectId }),
      client.api.research.listPythonEnvironments({ projectId }),
      client.api.research.getPythonEnvironmentStatus({ projectId })
    ]);
    if (!project.ok) return project;
    if (!environments.ok) return environments;
    if (!status.ok) return status;
    if (project.data.id !== projectId || environments.data.some(value => value.snapshot.request.projectId !== projectId)
      || (status.data.operation !== null && status.data.operation.request.projectId !== projectId)
      || (status.data.environment !== null && status.data.environment.snapshot.request.projectId !== projectId)) {
      throw new Error('research_python_environment_project_mismatch');
    }
    return { ok: true as const, data: { project: project.data, environments: environments.data, ...status.data } };
  }, { label: '读取项目 Python 环境' });
  const prepare = useAsyncAction(() => client.api.research.preparePythonEnvironment({ projectId, requestId: crypto.randomUUID() }),
    { label: '准备项目 Python 环境' });
  const cancel = useAsyncAction((operationId: string) => client.api.research.cancelPythonEnvironmentPreparation({ projectId, operationId }),
    { label: '取消准备 Python 环境' });
  const [actionOperation, setActionOperation] = useState<ResearchPythonEnvironmentOperation | null>(null);
  const data = resource.data;
  const operation = actionOperation !== null && (data?.operation == null || actionOperation.updatedAt > data.operation.updatedAt)
    ? actionOperation : data?.operation ?? null;
  const active = operation !== null && pythonEnvironmentActivePhases.has(operation.phase);
  const writable = data?.project.status === 'active' && data.project.workspacePath !== null;
  const pending = prepare.pending || cancel.pending;
  const failed = operation?.phase === 'failed' || operation?.phase === 'interrupted';
  const ready = operation?.phase === 'ready' || (operation === null && data?.environment != null);
  const Icon = active || pending ? LoaderCircle : ready ? CheckCircle2 : failed ? CircleAlert : Circle;

  useEffect(() => {
    if (!active || resource.status !== 'ready') return;
    const timer = setTimeout(resource.reload, 750);
    return () => clearTimeout(timer);
  }, [active, resource.status, resource.data, resource.reload]);

  const completeAction = (value: ResearchPythonEnvironmentOperation): void => {
    if (value.request.projectId === projectId) setActionOperation(value);
    resource.reload();
  };

  return (
    <FormSection title="项目 Python 环境" testId="mgmt-python-environment">
      {resource.status === 'error' ? (
        <div className="grid gap-2">
          <p role="alert" className="break-words text-[var(--st-bad)]">{resource.error}</p>
          <button type="button" className={`${formSecondaryButtonClass} justify-self-start`}
            onClick={resource.reload}>重试读取 Python 环境</button>
        </div>
      ) : data === null ? <p role="status" className="text-subtle">读取 Python 环境中…</p> : null}
      {data === null ? null : (
        <>
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p role="status" aria-atomic="true" data-testid="mgmt-python-status" className="flex min-w-0 items-center gap-2 text-ink">
              <Icon size={14} aria-hidden="true" className={`shrink-0${active || pending ? ' motion-safe:animate-spin' : ''}`} />
              {cancel.pending ? '正在取消准备' : prepare.pending ? '正在提交准备任务' : operation !== null ? phaseLabels[operation.phase] : ready ? '环境已就绪' : '环境尚未准备'}
            </p>
            {writable ? active ? (
              <button type="button" data-testid="mgmt-python-cancel" disabled={pending}
                className={formSecondaryButtonClass} onClick={() => { if (!pending && operation !== null) { prepare.reset(); void cancel.run(operation.id).then(result => { if (result.ok) completeAction(result.data); }); } }}>
                <Square size={12} aria-hidden="true" />{cancel.pending ? '正在取消…' : '取消准备'}
              </button>
            ) : (
              <button type="button" data-testid="mgmt-python-prepare" disabled={pending || resource.status !== 'ready'}
                className={formSecondaryButtonClass} onClick={() => { if (!pending) { cancel.reset(); void prepare.run().then(result => { if (result.ok) completeAction(result.data); }); } }}>
                {prepare.pending ? '正在提交…' : failed || operation?.phase === 'cancelled' ? '重试准备' : ready ? '重新核验环境' : '准备环境'}
              </button>
            ) : null}
          </div>
          {data.environment === null ? null : <p className="text-muted text-[length:var(--font-meta-size)]" data-testid="mgmt-python-version">Python {data.environment.snapshot.version}</p>}
          {failed ? <p role="alert" className="text-[var(--st-bad)]">{preparationError(operation?.errorCode ?? null)}</p> : null}
          {prepare.error || cancel.error ? <p role="alert" className="break-words text-[var(--st-bad)]">{prepare.error ?? cancel.error}</p> : null}
          {data.project.status === 'archived' ? <p className="text-subtle">项目已归档，环境记录只读。</p>
            : data.project.workspacePath === null ? <p className="text-subtle">请先为项目设置工作目录。</p> : null}
          {data.environments.length === 0 ? <p className="text-subtle">暂无环境记录</p> : (
            <details data-testid="mgmt-python-environment-history">
              <summary className="cursor-pointer text-muted focus-visible:outline-2 focus-visible:outline-focus-ring">环境记录（{data.environments.length}）</summary>
              <p className="mt-2 text-subtle">记录时已核验，运行前会再次检查。</p>
              <ol className="mt-2 grid gap-3 text-[length:var(--font-meta-size)]">
                {[...data.environments].reverse().map(({ snapshot }) => (
                  <li key={snapshot.id} className="grid min-w-0 gap-1">
                    <p className="text-ink">Python {snapshot.version}<span className="ml-2 text-subtle">记录于 {date.format(new Date(snapshot.recordedAt))}</span></p>
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
