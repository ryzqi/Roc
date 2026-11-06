import {useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import type {ResearchExportExecution, ResearchExportInputsRequest} from '../../shared/schemas/research-exports';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {formSelectClass, formSecondaryButtonClass} from '../shared/form-ui';
import {ExportPublicationEditor} from './ExportPublicationEditor';
import {ExportExecutionReceipt, exportStatusLabels} from './ExportExecutionReceipt';

const button = `${formSecondaryButtonClass} border-[0.5px]`;
export function ArtifactExportReview({client, snapshot, writable, locked, onDirty, onPending}: {
  client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; writable: boolean; locked: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void
}): React.JSX.Element {
  const {projectId, id: manuscriptArtifactId} = snapshot.artifact;
  const [figureIds, setFigureIds] = useState<string[]>([]), [templateId, setTemplateId] = useState('');
  const [selection, setSelection] = useState<ResearchExportInputsRequest | null>(null);
  const [captureNonce, setCaptureNonce] = useState(0), [historyNonce, setHistoryNonce] = useState(0);
  const [chosen, setChosen] = useState<ResearchExportExecution | null>(null);
  const [selectionError, setSelectionError] = useState<string | null>(null);
  const [pending, setPending] = useState(false), [dirty, setDirty] = useState(false);
  const reportPending = (value: boolean): void => {setPending(value); onPending(value);};
  const reportDirty = (value: boolean): void => {setDirty(value); onDirty(value);};
  const controlsLocked = locked || pending;
  const figures = useAsyncResource(`export:figures:${projectId}:${snapshot.version}`,
    () => client.api.research.listFigures({projectId, limit: 200}), {label: '读取已批准图稿'});
  const templates = useAsyncResource(`export:templates:${projectId}:${snapshot.version}`,
    () => client.api.research.listTemplates({projectId}), {label: '读取导出模板'});
  const inputs = useAsyncResource(selection === null ? null : `export:inputs:${snapshot.version}:${JSON.stringify(selection)}:${captureNonce}`,
    () => client.api.research.getExportInputs(selection!), {label: '读取当前出版来源'});
  const history = useAsyncResource(historyNonce === 0 ? null : `export:history:${projectId}:${snapshot.version}:${historyNonce}`,
    () => client.api.research.listExports({projectId, limit: 200}), {label: '读取已保存导出'});
  const approvedFigures = figures.status === 'ready' ? figures.data!.filter(figure => figure.status === 'approved') : [];
  const readyTemplates = templates.status === 'ready' ? templates.data!.filter(template => template.status === 'ready') : [];
  const changeSelection = (): void => {setSelection(null); setChosen(null); setSelectionError(null); reportDirty(true);};
  const discard = (): void => {setSelection(null); setChosen(null); setFigureIds([]); setTemplateId(''); setSelectionError(null); reportDirty(false);};
  return <section className="mt-2 flex min-w-0 flex-col gap-3" data-testid="artifact-export-review" aria-label="公开科研导出">
    <h2 className="font-medium">公开科研导出</h2>
    <p className="text-muted">RO-Crate 1.2，roc-research-1</p>
    {(writable || selection !== null || dirty) && chosen === null ? <>
      <fieldset disabled={controlsLocked || !writable || inputs.status === 'loading'} className="flex min-w-0 flex-col gap-2">
        <legend className="mb-2">已批准图稿</legend>
        {figures.status === 'loading' ? <p role="status">正在读取项目图稿…</p> : null}
        {figures.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{figures.error}</p>}
        {figures.status !== 'error' ? null : <button type="button" className={`${button} self-start`} onClick={figures.reload}>重试读取图稿</button>}
        {approvedFigures.map(figure => <label className="flex min-w-0 items-start gap-2" key={figure.id}>
          <input type="checkbox" disabled={selection !== null} checked={figureIds.includes(figure.id)}
            className="mt-1 accent-[var(--accent)] focus-visible:outline-2 focus-visible:outline-accent" onChange={event => {
              setFigureIds(event.target.checked ? [...figureIds, figure.id] : figureIds.filter(id => id !== figure.id)); changeSelection();
            }}/>
          <span className="break-words">{figure.title}</span>
        </label>)}
        {figures.status !== 'ready' || approvedFigures.length !== 0 ? null : <p className="text-muted">没有已批准图稿。</p>}
        <label className="flex flex-col gap-1 text-muted">导出模板
          <select className={`${formSelectClass} border-[0.5px]`} value={templateId} disabled={selection !== null || templates.status !== 'ready'}
            onChange={event => {setTemplateId(event.target.value); changeSelection();}}>
            <option value="">选择模板</option>
            <option value="default:zh">内置中文模板</option>
            <option value="default:en">内置英文模板</option>
            {readyTemplates.map(template => <option key={template.id} value={template.id}>{template.entryPath}，版本 {template.revision}</option>)}
          </select>
        </label>
        {templates.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{templates.error}</p>}
        {templates.status !== 'error' ? null : <button type="button" className={`${button} self-start`} onClick={templates.reload}>重试读取模板</button>}
        {selectionError === null ? null : <p role="alert" className="text-[var(--st-warn)]">{selectionError}</p>}
        {selection !== null ? null : <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={figures.status !== 'ready' || templates.status !== 'ready'}
            data-testid="artifact-export-inputs-load" onClick={() => {
              if (templateId === '') {setSelectionError('请明确选择导出模板。'); return;}
              const template = readyTemplates.find(value => value.id === templateId);
              if (!templateId.startsWith('default:') && (template === undefined || template.sourceDigest === null)) {
                setSelectionError('模板版本已失效，请重新读取模板。'); return;
              }
              setSelectionError(null); reportDirty(true);
              setSelection({projectId, manuscriptArtifactId, figureIds,
                template: templateId === 'default:zh' ? {kind: 'default', language: 'zh'} :
                  templateId === 'default:en' ? {kind: 'default', language: 'en'} :
                    {kind: 'imported', templateId: template!.id, expectedRevision: template!.revision, expectedSourceDigest: template!.sourceDigest!}});
            }}>读取当前出版来源</button>
          <button type="button" className={button} onClick={discard}>重置选择</button>
        </div>}
      </fieldset>
      {writable || !dirty || selection !== null ? null :
        <button type="button" className={`${button} self-start`} disabled={controlsLocked} onClick={discard}>放弃本次选择</button>}
      {inputs.status === 'loading' ? <p role="status">正在核对稿件、图稿与实验来源…</p> : null}
      {inputs.error === null ? null : <div className="flex flex-col gap-2">
        <p role="alert" className="text-[var(--st-warn)]">{inputs.error}</p>
        <div className="flex flex-wrap gap-2">
          <button type="button" className={button} disabled={controlsLocked || !writable} onClick={() => setCaptureNonce(value => value + 1)}>重试读取出版来源</button>
          <button type="button" className={button} disabled={controlsLocked} onClick={discard}>放弃本次选择</button>
        </div>
      </div>}
      {selection === null || inputs.status !== 'ready' || inputs.data === null ? null :
        <ExportPublicationEditor key={`${inputs.data.sourceHash}:${captureNonce}`} client={client} selection={selection} inputs={inputs.data}
          writable={writable && !locked} onDirty={reportDirty} onPending={reportPending} onDiscard={discard}
          onPrepared={value => {setSelection(null); setChosen(value); setHistoryNonce(nonce => nonce === 0 ? 0 : nonce + 1);}}/>}
    </> : null}
    {chosen === null ? null : <>
      <ExportExecutionReceipt key={chosen.id} client={client} record={chosen} writable={writable && !locked}
        onPending={reportPending} onDirty={reportDirty}/>
      {!writable ? null : <button type="button" className={`${button} self-start`} disabled={controlsLocked || dirty} onClick={discard}>审查新的导出选择</button>}
    </>}
    <button type="button" className={`${button} self-start`} disabled={controlsLocked || history.status === 'loading' || dirty}
      data-testid="artifact-export-history-load" onClick={() => setHistoryNonce(nonce => nonce + 1)}>读取已保存导出</button>
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data!.some(record => record.request.manuscriptArtifactId === manuscriptArtifactId) ? null :
      <p role="status">此稿件没有已保存导出。</p>}
    {history.status !== 'ready' ? null : <ul className="flex min-w-0 flex-col gap-1" data-testid="artifact-export-history">
      {history.data!.filter(record => record.request.manuscriptArtifactId === manuscriptArtifactId).map(record => <li key={record.id}>
        <button type="button" className={`${button} h-auto min-h-[var(--control-height-compact)] max-w-full py-1 text-left break-words`}
          disabled={controlsLocked || dirty} onClick={() => setChosen(record)}>
          {record.request.title}，{exportStatusLabels[record.status]}，{record.createdAt}
        </button>
      </li>)}
    </ul>}
  </section>;
}
