import {useRef, useState} from 'react';
import type {ResearchArtifactInspectResult} from '../../shared/schemas/research-artifact-inspector';
import {researchArgumentOutlineSaveSchema, type ResearchArgumentOutlineInspection, type ResearchArgumentOutlineSave,
  type ResearchArgumentOutlineMaterialize, type ResearchArgumentOutlineMaterialized} from '../../shared/schemas/research-argument-outline';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction, useAsyncResource} from '../app/use-async-resource';
import {formInputClass, formPrimaryButtonClass, formSecondaryButtonClass} from '../shared/form-ui';
import {useArtifactEditorGuard, useArtifactEditorStatus} from './artifact-editor-guard';
import {ArtifactEvidenceSource} from './ArtifactEvidenceSource';
import {ResearchProposalPicker} from './ResearchProposalPicker';

type Props = {client: RocClient; snapshot: ResearchArtifactInspectResult['snapshot']; writable: boolean; onSaved: () => void};
type SavedSection = ResearchArgumentOutlineSave['sections'][number];
type Section = Omit<SavedSection, 'conditions' | 'gaps'> & {conditions: string; gaps: string};
type MatrixRow = ResearchArgumentOutlineInspection['matrix'][number];
const button = formSecondaryButtonClass;
const lines = (value: string): string[] => value.split('\n').map(line => line.trim()).filter(Boolean);
const draftSections = (sections: SavedSection[]): Section[] => sections.map(section => ({...section, claimIds: [...section.claimIds],
  conditions: section.conditions.join('\n'), gaps: section.gaps.join('\n')}));
const relations = {supports: '支持', contradicts: '反对', qualifies: '限定'} as const;

export function ArtifactArgumentOutline(props: Props): React.JSX.Element {
  const {client, snapshot} = props, projectId = snapshot.artifact.projectId, artifactId = snapshot.artifact.id;
  const guard = useArtifactEditorGuard();
  const read = useAsyncResource(`argument-outline:${projectId}:${artifactId}:${snapshot.version}`,
    () => client.api.research.inspectArgumentOutline({projectId, artifactId}), {label: '读取论证依据'});
  const inspection = read.status === 'ready' ? read.data : null;
  return <section className="mt-3 flex min-w-0 flex-col gap-3" aria-label="证据矩阵与论证大纲" data-testid="artifact-outline">
    <button type="button" className={`${button} self-start`} disabled={guard.locked() || read.status === 'loading'} onClick={read.reload}>重新核对矩阵</button>
    {read.status === 'loading' ? <p role="status">正在读取当前主张与证据…</p> : null}
    {read.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{read.error}</p>}
    {inspection === null ? null : <OutlineBody key={`${inspection.matrixHash}:${inspection.latest?.snapshotHash ?? 'new'}`}
      {...props} inspection={inspection} onReload={read.reload}/>}
  </section>;
}

function OutlineBody({client, snapshot, writable, onSaved, inspection, onReload}: Props & {
  inspection: ResearchArgumentOutlineInspection; onReload: () => void;
}): React.JSX.Element {
  const {projectId, artifactId, matrix, latest} = inspection;
  const [sections, setSections] = useState<Section[]>(() => draftSections(latest?.snapshot.request.sections ?? []));
  const [rationale, setRationale] = useState(''), [selectedId, setSelectedId] = useState(sections[0]?.id ?? '');
  const [dirty, setDirty] = useState(false), [validation, setValidation] = useState<string | null>(null);
  const [offset, setOffset] = useState<number | null>(null);
  const request = useRef(crypto.randomUUID()), busy = useRef(false);
  const status = useArtifactEditorStatus({label: '论证大纲', dirty, pending: () => busy.current});
  const save = useAsyncAction((input: ResearchArgumentOutlineSave) => client.api.research.saveArgumentOutline(input), {label: '保存论证大纲'});
  const history = useAsyncResource(offset === null ? null : `argument-outline:history:${projectId}:${artifactId}:${offset}`,
    () => client.api.research.getArgumentOutlineHistory({projectId, artifactId, offset: offset!, limit: 10}), {label: '读取大纲历史'});
  const current = inspection.artifactVersion === snapshot.version;
  const canEdit = writable && current && !status.locked;
  const section = sections.find(section => section.id === selectedId);
  const change = (): void => {setDirty(true); setValidation(null); save.reset(); request.current = crypto.randomUUID();};
  const update = (changes: Partial<Section>): void => {
    setSections(sections.map(value => value.id === selectedId ? {...value, ...changes} : value)); change();
  };
  return <>
    {!current ? <p role="alert" className="text-[var(--st-warn)]">来源工件已变化，请刷新工件。</p> : null}
    <details className="min-w-0" data-testid="artifact-outline-matrix">
      <summary className="cursor-pointer font-medium">证据矩阵（{matrix.length.toLocaleString()} 项主张）</summary>
      <div className="mt-2 flex min-w-0 flex-col gap-3">{matrix.map(row => <MatrixClaim key={row.claim.id} client={client} row={row} onReload={onReload}/>)}</div>
    </details>
    {latest === null ? null : <p className="text-muted tabular-nums">大纲版本 {latest.snapshot.version}，{inspection.latestCurrent ? '依据当前' : '依据已变化，需修订'}，记录人 {latest.snapshot.actor.id}</p>}
    <ResearchProposalPicker client={client} projectId={projectId} artifactId={artifactId} artifactVersion={inspection.artifactVersion}
      kind="argument_outline" disabled={!canEdit || dirty || save.pending}
      onPick={proposal => {if (proposal.kind !== 'argument_outline') return;
        setSections(draftSections(proposal.payload.sections)); setSelectedId(proposal.payload.sections[0]?.id ?? '');
        setRationale(proposal.payload.rationale); change();}}/>
    <form className="flex min-w-0 flex-col gap-3" data-testid="artifact-outline-editor" onSubmit={event => {
      event.preventDefault();
      if (!canEdit || busy.current || status.isLocked()) return;
      const parsed = researchArgumentOutlineSaveSchema.safeParse({projectId, artifactId, expectedArtifactVersion: inspection.artifactVersion,
        expectedMatrixHash: inspection.matrixHash, requestId: request.current,
        parent: latest === null ? null : {outlineId: latest.snapshot.id, outlineHash: latest.snapshotHash},
        sections: sections.map(section => ({...section, conditions: lines(section.conditions), gaps: lines(section.gaps)})), rationale});
      if (!parsed.success) {setValidation('请填写章节标题、问题、主张和大纲修订理由；主张不能重复安排。'); return;}
      busy.current = true;
      void save.run(parsed.data).then(result => {busy.current = false; if (result.ok) {setDirty(false); onReload();}});
    }}>
      <fieldset disabled={!canEdit || save.pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-muted">章节
          <select className={formInputClass} value={selectedId} onChange={event => setSelectedId(event.target.value)}>
            {sections.length === 0 ? <option value="">尚无章节</option> : null}
            {sections.map((section, index) => <option key={section.id} value={section.id}>{index + 1} {section.title || '未命名章节'}</option>)}
          </select>
        </label>
        <button type="button" className={`${button} self-start`} disabled={sections.length >= 100} onClick={() => {
          const section = {id: crypto.randomUUID(), title: '', question: '', claimIds: [], conditions: '', gaps: ''};
          setSections([...sections, section]); setSelectedId(section.id); change();
        }}>添加章节</button>
        {section === undefined ? null : <>
          {(['title', 'question'] as const).map(field => <label key={field} className="flex min-w-0 flex-col gap-1 text-muted">
            {field === 'title' ? '章节标题' : '本节问题'}
            <textarea className={`${formInputClass} h-auto resize-y py-2`} rows={field === 'title' ? 1 : 2}
              maxLength={field === 'title' ? 300 : 12000} value={section[field]} onChange={event => update({[field]: event.target.value})}/>
          </label>)}
          <fieldset className="flex min-w-0 flex-col gap-2"><legend className="mb-2 text-muted">安排主张</legend>
            {matrix.map(row => {
              const assigned = sections.some(other => other.id !== section.id && other.claimIds.includes(row.claim.id));
              const available = row.claim.status === 'supported' && row.sources.every(source => source.referenceStatus === 'recorded');
              return <label key={row.claim.id} className="flex min-w-0 items-start gap-2">
                <input type="checkbox" className="mt-1 shrink-0" checked={section.claimIds.includes(row.claim.id)}
                  disabled={assigned || (!available && !section.claimIds.includes(row.claim.id))}
                  onChange={event => update({claimIds: event.target.checked ? [...section.claimIds, row.claim.id] : section.claimIds.filter(id => id !== row.claim.id)})}/>
                <span className="min-w-0 break-words">{row.claim.content}{assigned ? '（已安排到其他章节）' : !available ? '（依据待处理）' : ''}</span>
              </label>;
            })}
            {section.claimIds.filter(id => !matrix.some(row => row.claim.id === id)).map(id => <div key={id} className="flex min-w-0 flex-col items-start gap-2">
              <p className="break-all text-muted">主张已不在当前矩阵：{id}</p>
              <button type="button" className={button} onClick={() => update({claimIds: section.claimIds.filter(value => value !== id)})}>移除此主张</button>
            </div>)}
          </fieldset>
          {(['conditions', 'gaps'] as const).map(field => <label key={field} className="flex min-w-0 flex-col gap-1 text-muted">
            {field === 'conditions' ? '适用条件（每行一项）' : '论证缺口（每行一项）'}
            <textarea className={`${formInputClass} h-auto resize-y py-2`} rows={3} value={section[field]}
              onChange={event => update({[field]: event.target.value})}/>
          </label>)}
          <div className="flex flex-wrap gap-2">
            {[-1, 1].map(direction => <button key={direction} type="button" className={button}
              disabled={sections.indexOf(section) + direction < 0 || sections.indexOf(section) + direction >= sections.length}
              onClick={() => {const next = [...sections], index = next.indexOf(section); [next[index], next[index + direction]] = [next[index + direction]!, section]; setSections(next); change();}}>
              {direction < 0 ? '上移章节' : '下移章节'}
            </button>)}
            <button type="button" className={button} onClick={() => {const next = sections.filter(value => value.id !== section.id);
              setSections(next); setSelectedId(next[0]?.id ?? ''); change();}}>移除章节</button>
          </div>
        </>}
        <label className="flex min-w-0 flex-col gap-1 text-muted">大纲修订理由
          <textarea className={`${formInputClass} h-auto resize-y py-2`} rows={3} maxLength={12000} value={rationale}
            onChange={event => {setRationale(event.target.value); change();}}/>
        </label>
        <div className="flex flex-wrap gap-2">
          <button type="submit" className={formPrimaryButtonClass} disabled={!dirty} data-testid="artifact-outline-save">保存大纲</button>
          <button type="button" className={button} disabled={!dirty} onClick={() => {
            setSections(draftSections(latest?.snapshot.request.sections ?? [])); setSelectedId(latest?.snapshot.request.sections[0]?.id ?? '');
            setRationale(''); setDirty(false); setValidation(null); save.reset(); request.current = crypto.randomUUID();
          }}>放弃大纲修改</button>
        </div>
      </fieldset>
      {save.pending ? <p role="status">正在保存大纲…</p> : null}
      {[validation, save.error].filter(error => error !== null).map((error, index) => <p role="alert" key={index} className="text-[var(--st-warn)]">{error}</p>)}
    </form>
    {latest === null || !inspection.latestCurrent ? null : <OutlineMaterialize key={latest.snapshotHash} client={client} snapshot={snapshot}
      inspection={inspection} writable={writable && current} onSaved={onSaved}/>}
    <button type="button" className={`${button} self-start`} disabled={dirty || status.locked || save.pending || history.status === 'loading'} onClick={() => {
      if (offset === 0) history.reload(); else setOffset(0);
    }}>读取大纲历史</button>
    {history.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{history.error}</p>}
    {history.status !== 'ready' || history.data === null || offset === null ? null : <>
      <ul className="flex min-w-0 flex-col gap-2">{history.data.items.map(receipt => <li key={receipt.snapshot.id}>
        <details className="min-w-0"><summary className="cursor-pointer break-words">版本 {receipt.snapshot.version}，{receipt.snapshot.request.rationale}</summary>
          <p className="break-all text-muted">{receipt.snapshot.id}，{receipt.snapshot.actor.id}，{receipt.snapshot.recordedAt}</p>
          {receipt.snapshot.request.sections.map(section => <p key={section.id} className="break-words">{section.title}：{section.question}</p>)}
        </details>
      </li>)}</ul>
      <div className="flex flex-wrap gap-2">
        <button type="button" className={button} disabled={dirty || offset === 0} onClick={() => setOffset(offset - 10)}>上一页大纲</button>
        <button type="button" className={button} disabled={dirty || offset + 10 >= history.data.total} onClick={() => setOffset(offset + 10)}>下一页大纲</button>
      </div>
    </>}
  </>;
}

function MatrixClaim({client, row, onReload}: {client: RocClient; row: MatrixRow; onReload: () => void}): React.JSX.Element {
  return <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
    <p className="whitespace-pre-wrap break-words">{row.claim.content}</p>
    <p className="break-all text-muted">{row.claim.id}，版本 {row.claim.version}</p>
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-muted tabular-nums">
      {Object.entries(relations).map(([kind, label]) => <div key={kind} className="contents"><dt>{label}</dt><dd>
        确认 {row.relations.filter(relation => relation.current && relation.kind === kind && relation.status === 'confirmed').length}
        {' '}提议 {row.relations.filter(relation => relation.current && relation.kind === kind && relation.status === 'proposed').length}
      </dd></div>)}
    </dl>
    {row.gaps.map(gap => <p key={gap} className="break-words text-muted">{gap}</p>)}
    <details className="min-w-0"><summary className="cursor-pointer text-muted">原文与关系依据</summary>
      <div className="mt-2 flex min-w-0 flex-col gap-2">{row.sources.map(source => <div key={source.evidence.id} className="min-w-0">
        <p className="break-all text-muted">{source.evidence.id}</p>
        <ArtifactEvidenceSource client={client} source={source} canDecide={false} onChanged={onReload}/>
      </div>)}</div>
      {row.relations.filter(relation => relation.condition !== null).map(relation => <p key={relation.id} className="break-words text-muted">
        {relation.current ? '当前关系条件' : '历史关系条件'}：{relation.condition}
      </p>)}
    </details>
  </section>;
}

function OutlineMaterialize({client, snapshot, inspection, writable, onSaved}: Props & {inspection: ResearchArgumentOutlineInspection}): React.JSX.Element {
  const {projectId, latest, matrixHash} = inspection;
  const [open, setOpen] = useState(false), [targetId, setTargetId] = useState(''), [title, setTitle] = useState(snapshot.artifact.title);
  const [result, setResult] = useState<ResearchArgumentOutlineMaterialized | null>(null);
  const [dirty, setDirty] = useState(false);
  const busy = useRef(false), request = useRef<{signature: string; value: ResearchArgumentOutlineMaterialize} | null>(null);
  const guard = useArtifactEditorGuard();
  const status = useArtifactEditorStatus({label: '大纲生成正文', dirty, pending: () => busy.current});
  const targets = useAsyncResource(open ? `argument-outline:targets:${projectId}:${latest!.snapshotHash}` : null,
    () => client.api.research.listArtifacts({projectId}), {label: '读取正文目标'});
  const materialize = useAsyncAction(async () => {
    const signature = JSON.stringify([latest!.snapshotHash, matrixHash, targetId, title]);
    if (request.current?.signature !== signature) {
      let target: ResearchArgumentOutlineMaterialize['target'] = {kind: 'new', title: title.trim()};
      if (targetId !== '') {
        const current = await client.api.research.inspectArtifact({projectId, artifactId: targetId, expectedVersion: null});
        if (!current.ok) return current;
        target = {kind: 'existing', artifactId: targetId, expectedVersion: current.data.snapshot.version};
      }
      request.current = {signature, value: {projectId, outlineId: latest!.snapshot.id, expectedOutlineHash: latest!.snapshotHash,
        expectedMatrixHash: matrixHash, requestId: crypto.randomUUID(), target}};
    }
    return client.api.research.materializeArgumentOutline(request.current.value);
  }, {label: '从大纲生成正文'});
  const canWrite = writable && ['writing', 'revision'].includes(snapshot.currentStage);
  return <section className="flex min-w-0 flex-col gap-3 border-t-[0.5px] border-line pt-2">
    <button type="button" className={`${button} self-start`} disabled={!canWrite || status.locked || materialize.pending}
      onClick={() => guard.request(() => {setOpen(!open); setDirty(false);}, '收起将放弃正文目标选择。')}>从大纲生成正文</button>
    {!canWrite ? <p className="text-muted">请在写作或修订阶段生成正文。</p> : null}
    {!open ? null : <>
      <fieldset disabled={!canWrite || status.locked || materialize.pending} className="flex min-w-0 flex-col gap-3">
        <label className="flex min-w-0 flex-col gap-1 text-muted">正文目标
          <select className={formInputClass} value={targetId} onChange={event => {setTargetId(event.target.value); setDirty(true); setResult(null); materialize.reset();}}>
            <option value="">新建待审核正文</option>
            {targets.data?.filter(artifact => artifact.kind === 'manuscript' && artifact.stage === snapshot.currentStage && artifact.status === 'draft')
              .map(artifact => <option key={artifact.id} value={artifact.id}>替换结构：{artifact.title}</option>)}
          </select>
        </label>
        {targetId !== '' ? <p className="text-muted">将使用大纲章节替换所选草稿的正文结构。</p> : <label className="flex min-w-0 flex-col gap-1 text-muted">新正文标题
          <input className={formInputClass} maxLength={300} value={title} onChange={event => {setTitle(event.target.value); setDirty(true); setResult(null); materialize.reset();}}/>
        </label>}
        <button type="button" className={`${formPrimaryButtonClass} self-start`} disabled={title.trim() === '' || result !== null}
          data-testid="artifact-outline-materialize" onClick={() => {
            if (busy.current || status.isLocked()) return;
            busy.current = true;
            void materialize.run().then(reply => {busy.current = false; if (reply.ok) {setResult(reply.data); setDirty(false);}});
          }}>{materialize.pending ? '正在保存正文…' : '确认生成待审核正文'}</button>
      </fieldset>
      {[targets.error, materialize.error].filter(error => error !== null).map((error, index) => <p key={index} role="alert" className="text-[var(--st-warn)]">{error}</p>)}
      {result === null ? null : <div className="flex min-w-0 flex-col gap-2" data-testid="artifact-outline-materialized">
        <p role="status">正文已保存，尚待证据审核与阶段批准。</p>
        <p className="break-all text-muted">{result.artifactId}</p>
        <button type="button" className={`${button} self-start`} onClick={onSaved}>刷新当前工件</button>
      </div>}
    </>}
  </section>;
}
