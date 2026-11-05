import {researchExperimentSourcePath} from '../../../shared/schemas/research-experiments';
import type {ResearchProductionInput} from '../../../shared/schemas/research-production-inputs';

export function ExperimentSourceView({source}: {source: Extract<ResearchProductionInput['source'],{kind:'experiment'}>}): React.JSX.Element {
  const run=source.execution;
  return <section className="flex flex-col gap-2" data-testid="artifact-production-experiment">
    <h2 className="font-medium">实验执行来源</h2>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 text-muted">
      <dt>执行标识</dt><dd className="break-all">{run.id}</dd>
      <dt>源文件</dt><dd className="break-all">{run.request.engine==='python'&&run.request.source.kind==='notebook'?`Notebook ${run.request.source.notebookId}`:researchExperimentSourcePath(run.request)}</dd>
      <dt>运行环境</dt><dd>{run.environment===null?'未记录':<>{run.environment.runtime.kind}<span className="ml-2">{run.environment.version}</span></>}</dd>
      <dt>退出码</dt><dd>{run.exitCode===null?'未记录':run.exitCode}</dd>
      <dt>开始时间</dt><dd className="break-words">{run.startedAt??'未记录'}</dd>
      <dt>结束时间</dt><dd className="break-words">{run.endedAt??'未记录'}</dd>
      <dt>输入 SHA-256</dt><dd className="break-all font-mono text-[var(--font-meta-size)]">{run.inputHash??'未记录'}</dd>
    </dl>
    <details data-reading-key="experiment-request" className="text-muted"><summary data-reading-key="experiment-request-summary" className="cursor-pointer">保存的运行参数</summary>
      <pre className="mt-2 whitespace-pre-wrap break-all font-mono text-[var(--font-meta-size)]">{JSON.stringify(run.request,null,2)}</pre>
    </details>
  </section>;
}
