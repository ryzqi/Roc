import {useRef, useState} from 'react';
import {researchExternalExperimentCreateSchema, type ResearchExternalExperimentCreate, type ResearchExternalExperimentRecord,
  type ResearchExternalExperimentBind, type ResearchExternalExperimentPreviewResult, type ResearchExternalExperimentImport} from '../../shared/schemas/research-external-experiments';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {useCopyFeedback} from '../shared/hooks/use-copy-feedback';
import {ArtifactDraftDiscard, useArtifactEditorGuard, useArtifactEditorStatus} from './artifact-editor-guard';
import {ResearchProposalPicker} from './ResearchProposalPicker';
import {ExternalExperimentResult} from './ExternalExperimentResult';
import type {CollaborationProps} from './ArtifactCollaboration';

const button = formSecondaryButtonClass;
const statuses = {unbound: '尚未关联外部任务', waiting: '等待外部回传', reported: '已有报告回传'};
type MetricDraft = Omit<ResearchExternalExperimentCreate['definitions'][number], 'direction'> & {direction: '' | ResearchExternalExperimentCreate['definitions'][number]['direction']};
const metricDraft = (): MetricDraft => ({id: '', label: '', definition: '', unit: '', direction: ''});

export function CollaborationExternal(props: CollaborationProps): React.JSX.Element {
  const {client, snapshot, writable} = props, projectId = snapshot.artifact.projectId, artifactId = snapshot.artifact.id;
  const [creating, setCreating] = useState(false), [selectedId, setSelectedId] = useState<string | null>(null), [offset, setOffset] = useState(0);
  const guard = useArtifactEditorGuard();
  const list = useAsyncResource(`external-experiments:${projectId}:${artifactId}:${offset}`,
    () => client.api.research.listExternalExperiments({projectId, artifactId, offset, limit: 10}), {label: '读取外部实验记录'});
  const record = useAsyncResource(selectedId === null ? null : `external-experiment:${projectId}:${selectedId}`,
    () => client.api.research.getExternalExperiment({projectId, contractId: selectedId!}), {label: '读取实验交接合同'});
  return <section className="flex min-w-0 flex-col gap-3" aria-label="外部实验交接与回传" data-testid="artifact-external-experiments">
    <button type="button" className={`${button} self-start`} disabled={!writable || guard.busy()} onClick={() => guard.request(() => {
      setCreating(!creating); setSelectedId(null);
    }, '切换将放弃当前外部实验表单修改。')}>{creating ? '收起新合同' : '新建外部实验合同'}</button>
    {!creating ? null : <ExternalContractForm {...props} onCreated={record => {
      setCreating(false); setSelectedId(record.contract.snapshot.id); list.reload();
    }}/>}
    {record.status === 'loading' ? <p role="status">正在读取持久化合同…</p> : null}
    {record.status !== 'ready' || record.data === null ? null : <ExternalContract key={`${record.data.contract.snapshot.id}:${record.data.recordHash}`}
      {...props} record={record.data} onReload={() => {record.reload(); list.reload();}}/>}
    {[list.error, record.error].filter(error => error !== null).map((error, index) => <p role="alert" key={index} className="text-[var(--st-warn)]">{error}</p>)}
    <ul className="flex min-w-0 flex-col gap-2">{list.data?.items.map(item => <li key={item.contract.snapshot.id}>
      <button type="button" className={`${button} max-w-full break-words text-left`} disabled={guard.busy()} onClick={() => guard.request(() => {
        setCreating(false); setSelectedId(item.contract.snapshot.id);
      }, '切换将放弃当前外部实验表单修改。')}>{item.contract.snapshot.request.title}，{statuses[item.status]}</button>
    </li>)}</ul>
    {list.data === null ? null : <div className="flex flex-wrap gap-2">
      <button type="button" className={button} disabled={guard.busy() || offset === 0} onClick={() => setOffset(offset - 10)}>上一页外部实验</button>
      <button type="button" className={button} disabled={guard.busy() || offset + 10 >= list.data.total} onClick={() => setOffset(offset + 10)}>下一页外部实验</button>
    </div>}
  </section>;
}

function ExternalContractForm({client, snapshot, writable, onCreated}: CollaborationProps & {onCreated: (record: ResearchExternalExperimentRecord) => void}): React.JSX.Element {
  const [title, setTitle] = useState(snapshot.artifact.title), [instructions, setInstructions] = useState('');
  const [definitions, setDefinitions] = useState<MetricDraft[]>([metricDraft()]);
  const [expectedFiles, setExpectedFiles] = useState<ResearchExternalExperimentCreate['expectedFiles']>([]);
  const [filePath, setFilePath] = useState(''), [role, setRole] = useState<ResearchExternalExperimentCreate['expectedFiles'][number]['role']>('input');
  const [dirty, setDirty] = useState(false), [validation, setValidation] = useState<string | null>(null);
  const requestId = useRef(crypto.randomUUID()), busy = useRef(false);
  const status = useArtifactEditorStatus({label: '外部实验合同', dirty, pending: () => busy.current});
  const save = useAsyncAction((request: ResearchExternalExperimentCreate) => client.api.research.createExternalExperiment(request), {label: '保存外部实验合同'});
  const change = (): void => {setDirty(true); setValidation(null); save.reset(); requestId.current = crypto.randomUUID();};
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-external-contract-form">
    <ResearchProposalPicker client={client} projectId={snapshot.artifact.projectId} artifactId={snapshot.artifact.id} artifactVersion={snapshot.version}
      kind="external_experiment" disabled={!writable || dirty || status.locked || save.pending} onPick={proposal => {
        if (proposal.kind !== 'external_experiment') return;
        setTitle(proposal.payload.title); setInstructions(proposal.payload.instructions); setDefinitions(structuredClone(proposal.payload.definitions));
        setExpectedFiles(structuredClone(proposal.payload.expectedFiles)); change();
      }}/>
    <fieldset disabled={!writable || status.locked || save.pending} className="flex min-w-0 flex-col gap-3">
      <label className="flex flex-col gap-1 text-muted">外部实验标题<input className={formInputClass} maxLength={300} value={title} onChange={event => {setTitle(event.target.value); change();}}/></label>
      <label className="flex flex-col gap-1 text-muted">交接要求<textarea rows={3} maxLength={12000} className={`${formInputClass} h-auto resize-y py-2`} value={instructions} onChange={event => {setInstructions(event.target.value); change();}}/></label>
      {definitions.map((metric, index) => <fieldset key={index} className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <legend className="text-muted">预期指标 {index + 1}</legend>
        {(['id', 'label', 'definition', 'unit'] as const).map(field => <label key={field} className="flex flex-col gap-1 text-muted">
          {`指标 ${index + 1} ${{id: 'ID', label: '名称', definition: '定义', unit: '单位'}[field]}`}
          <input className={formInputClass} value={metric[field]} maxLength={field === 'definition' ? 4000 : 128} onChange={event => {
            setDefinitions(values => values.map((value, position) => position === index ? {...value, [field]: event.target.value} : value)); change();
          }}/>
        </label>)}
        <label className="flex flex-col gap-1 text-muted">指标 {index + 1} 方向
          <select className={formInputClass} value={metric.direction} onChange={event => {
            const direction = event.target.value as MetricDraft['direction']; setDefinitions(values => values.map((value, position) => position === index ? {...value, direction} : value)); change();
          }}><option value="">请选择</option><option value="higher">越高越好</option><option value="lower">越低越好</option><option value="neutral">中性</option></select>
        </label>
        <button type="button" className={`${button} self-start`} disabled={definitions.length === 1} onClick={() => {setDefinitions(values => values.filter((_, position) => position !== index)); change();}}>移除此指标</button>
      </fieldset>)}
      <button type="button" className={`${button} self-start`} disabled={definitions.length >= 100} onClick={() => {setDefinitions([...definitions, metricDraft()]); change();}}>添加预期指标</button>
      <details className="min-w-0"><summary className="cursor-pointer text-muted">约定回传文件</summary>
        <div className="mt-2 flex min-w-0 flex-col gap-2">
          {expectedFiles.map(file => <div key={file.path} className="flex min-w-0 items-start gap-2"><span className="min-w-0 break-all">{file.role}：{file.path}</span>
            <button type="button" className={button} onClick={() => {setExpectedFiles(expectedFiles.filter(value => value.path !== file.path)); change();}}>移除文件</button></div>)}
          <label className="flex flex-col gap-1 text-muted">约定文件相对路径<input className={formInputClass} value={filePath} onChange={event => {setFilePath(event.target.value); change();}}/></label>
          <label className="flex flex-col gap-1 text-muted">文件用途<select className={formInputClass} value={role} onChange={event => setRole(event.target.value as typeof role)}>
            <option value="input">输入数据</option><option value="output">输出结果</option><option value="source">分析源代码</option><option value="environment">运行环境</option>
          </select></label>
          <button type="button" className={`${button} self-start`} disabled={filePath.trim() === '' || expectedFiles.length >= 20} onClick={() => {
            setExpectedFiles([...expectedFiles, {path: filePath.trim(), role}]); setFilePath(''); change();
          }}>加入约定文件</button>
        </div>
      </details>
      <button type="button" className={`${formPrimaryButtonClass} self-start`} data-testid="artifact-external-contract-save" onClick={() => {
        if (busy.current || status.isLocked()) return;
        if (filePath.trim() !== '') {setValidation('请加入或清空待添加的约定文件。'); return;}
        const parsed = researchExternalExperimentCreateSchema.safeParse({projectId: snapshot.artifact.projectId, artifactId: snapshot.artifact.id,
          expectedArtifactVersion: snapshot.version, requestId: requestId.current, title, instructions, definitions, expectedFiles, resultFormat: 'roc-external-metrics/v1'});
        if (!parsed.success) {setValidation('请填写完整交接要求与指标；指标 ID、文件路径不能重复。'); return;}
        busy.current = true;
        void save.run(parsed.data).then(result => {busy.current = false; if (result.ok) {setDirty(false); onCreated(result.data);}});
      }}>{save.pending ? '正在保存合同…' : '保存交接合同'}</button>
    </fieldset>
    <ArtifactDraftDiscard dirty={dirty} testId="artifact-external-contract-discard" onDiscard={() => {
      setTitle(snapshot.artifact.title); setInstructions(''); setDefinitions([metricDraft()]); setExpectedFiles([]); setFilePath(''); setDirty(false); setValidation(null); save.reset();
    }}/>
    {[validation, save.error].filter(error => error !== null).map((error, index) => <p key={index} role="alert" className="text-[var(--st-warn)]">{error}</p>)}
  </section>;
}

function ExternalContract({client, snapshot, writable, record, onReload}: CollaborationProps & {record: ResearchExternalExperimentRecord; onReload: () => void}): React.JSX.Element {
  const projectId = snapshot.artifact.projectId, contractId = record.contract.snapshot.id;
  const [provider, setProvider] = useState(''), [externalId, setExternalId] = useState(''), [resultPath, setResultPath] = useState('');
  const [dirty, setDirty] = useState(false), [confirmed, setConfirmed] = useState(false), [preview, setPreview] = useState<ResearchExternalExperimentPreviewResult | null>(null);
  const [historyOffset, setHistoryOffset] = useState<number | null>(null), [resultChoice, setResultChoice] = useState(record.latestResult);
  const busy = useRef(false), bindId = useRef(crypto.randomUUID()), importId = useRef(crypto.randomUUID());
  const status = useArtifactEditorStatus({label: '外部实验回传', dirty, pending: () => busy.current});
  const bind = useAsyncAction((request: ResearchExternalExperimentBind) => client.api.research.bindExternalExperiment(request), {label: '关联外部任务'});
  const read = useAsyncAction(() => client.api.research.previewExternalExperimentImport({projectId, contractId, resultPath: resultPath.trim()}), {label: '核对外部报告'});
  const save = useAsyncAction((request: ResearchExternalExperimentImport) => client.api.research.importExternalExperimentResult(request), {label: '保存外部报告'});
  const copy = useCopyFeedback();
  const results = useAsyncResource(historyOffset === null ? null : `external-results:${projectId}:${contractId}:${historyOffset}`,
    () => client.api.research.listExternalExperimentResults({projectId, contractId, offset: historyOffset!, limit: 10}), {label: '读取历史回传报告'});
  const pending = bind.pending || read.pending || save.pending;
  const original = record.contract.snapshot.request;
  const handoff = [`外部实验：${original.title}`, `合同 ID：${contractId}`, `合同 SHA-256：${record.contract.snapshotHash}`,
    `结果格式：${original.resultFormat}`, original.instructions, ...original.definitions.map(metric => `${metric.id}：${metric.definition}（${metric.unit}）`),
    ...original.expectedFiles.map(file => `${file.role}：${file.path}`)].join('\n');
  return <section className="flex min-w-0 flex-col gap-3" data-testid="artifact-external-contract">
    <h3 className="font-medium break-words">{original.title}，{statuses[record.status]}</h3>
    {!record.sourceCurrent ? <p className="text-muted">合同来源已变化；历史合同与回传报告仍保留原版本。</p> : null}
    <details className="min-w-0"><summary className="cursor-pointer text-muted">冻结的交接要求</summary>
      <p className="mt-2 whitespace-pre-wrap break-words">{original.instructions}</p>
      <p className="break-all font-mono text-muted">{contractId}，{record.contract.snapshotHash}</p>
      <ul className="mt-2 space-y-1">{original.definitions.map(metric => <li key={metric.id} className="break-words">{metric.label}：{metric.definition}（{metric.unit}）</li>)}</ul>
      <button type="button" className={`${button} mt-2`} onClick={() => copy.copy(handoff)}>{copy.copied ? '已复制' : '复制交接信息'}</button>
    </details>
    {record.binding === null ? <fieldset disabled={!writable || status.locked || pending} className="flex min-w-0 flex-col gap-3">
      <label className="flex flex-col gap-1 text-muted">外部执行方<input className={formInputClass} maxLength={300} value={provider} onChange={event => {setProvider(event.target.value); setDirty(true); bindId.current = crypto.randomUUID(); bind.reset();}}/></label>
      <label className="flex flex-col gap-1 text-muted">外部任务编号<input className={formInputClass} maxLength={300} value={externalId} onChange={event => {setExternalId(event.target.value); setDirty(true); bindId.current = crypto.randomUUID(); bind.reset();}}/></label>
      <button type="button" className={`${button} self-start`} disabled={provider.trim() === '' || externalId.trim() === ''} data-testid="artifact-external-bind" onClick={() => {
        if (busy.current || status.isLocked()) return;
        busy.current = true;
        void bind.run({projectId, contractId, expectedRecordHash: record.recordHash, requestId: bindId.current, provider, externalId}).then(result => {
          busy.current = false; if (result.ok) {setDirty(false); onReload();}
        });
      }}>{bind.pending ? '正在记录…' : '记录编号并等待回传'}</button>
    </fieldset> : <>
      <p className="break-words text-muted">执行方 {record.binding.request.provider}，外部编号 {record.binding.request.externalId}</p>
      <fieldset disabled={!writable || status.locked || pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex flex-col gap-1 text-muted">回传报告 JSON（工作区相对路径）<input className={formInputClass} value={resultPath} maxLength={1024}
          onChange={event => {setResultPath(event.target.value); setPreview(null); setConfirmed(false); setDirty(true); importId.current = crypto.randomUUID(); read.reset(); save.reset();}}/></label>
        <button type="button" className={`${button} self-start`} disabled={resultPath.trim() === ''} data-testid="artifact-external-preview" onClick={() => {
          if (busy.current || status.isLocked()) return;
          busy.current = true; setPreview(null); setConfirmed(false);
          void read.run().then(result => {busy.current = false; if (result.ok) setPreview(result.data);});
        }}>读取实际报告与回传文件</button>
        {preview === null ? null : <>
          <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-external-preview-result">
            <h4 className="font-medium">外部报告的方法与环境</h4>
            <p className="break-words">{preview.report.environment.description}，报告人 {preview.report.environment.reportedBy}</p>
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1">{Object.entries(preview.report.method).map(([field, value]) => <div className="contents" key={field}>
              <dt className="text-muted">{{name: '方法', rationale: '选择理由', assumptions: '假设', limitations: '限制'}[field]}</dt><dd className="break-words">{value}</dd>
            </div>)}</dl>
            <ul className="space-y-1">{preview.report.result.metrics.map(metric => <li key={metric.id} className="break-words tabular-nums">{metric.id}：{metric.value} {metric.unit}，样本量 {metric.sampleSize}</li>)}</ul>
            <ul className="space-y-1">{preview.files.map(file => <li key={file.path} className="break-all text-muted">{file.path}，{file.size.toLocaleString()} B，{file.sha256}</li>)}</ul>
          </section>
          <label className="flex items-start gap-2"><input type="checkbox" className="mt-1 shrink-0" checked={confirmed} onChange={event => {setConfirmed(event.target.checked); setDirty(true);}}/>
            <span>已核对报告的方法、环境及实际回传文件</span>
          </label>
          <button type="button" className={`${formPrimaryButtonClass} self-start`} disabled={!confirmed} data-testid="artifact-external-import" onClick={() => {
            if (busy.current || status.isLocked()) return;
            busy.current = true;
            void save.run({projectId, contractId, resultPath: preview.resultPath, expectedRecordHash: preview.recordHash,
              expectedResultHash: preview.original.sha256, requestId: importId.current}).then(result => {busy.current = false; if (result.ok) {setDirty(false); onReload();}});
          }}>{save.pending ? '正在保存报告…' : '保存为未独立验证的外部报告'}</button>
        </>}
      </fieldset>
    </>}
    {resultChoice === null ? null : <ExternalExperimentResult key={resultChoice.expectedHash} client={client} projectId={projectId} result={resultChoice} writable={writable}/>}
    {record.resultCount === 0 ? null : <>
      <button type="button" className={`${button} self-start`} disabled={dirty || pending} onClick={() => {if (historyOffset === 0) results.reload(); else setHistoryOffset(0);}}>读取历史回传报告</button>
      {results.status !== 'ready' || results.data === null || historyOffset === null ? null : <>
        <ul className="space-y-2">{results.data.items.map(result => <li key={result.resultId}>
          <button type="button" className={`${button} max-w-full break-all text-left`} disabled={dirty || pending} onClick={() => setResultChoice(result)}>{result.resultId}</button>
        </li>)}</ul>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={dirty || pending || historyOffset === 0} onClick={() => setHistoryOffset(historyOffset - 10)}>上一页报告</button>
          <button type="button" className={button} disabled={dirty || pending || historyOffset + 10 >= results.data.total} onClick={() => setHistoryOffset(historyOffset + 10)}>下一页报告</button>
        </div>
      </>}
    </>}
    <ArtifactDraftDiscard dirty={dirty} testId="artifact-external-return-discard" onDiscard={() => {
      setProvider(''); setExternalId(''); setResultPath(''); setPreview(null); setConfirmed(false); setDirty(false); bind.reset(); read.reset(); save.reset();
    }}/>
    {[bind.error, read.error, save.error, copy.error, results.error].filter(error => error !== null).map((error, index) => <p role="alert" key={index} className="break-words text-[var(--st-warn)]">{error}</p>)}
  </section>;
}
