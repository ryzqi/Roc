import {researchCitationStyles, researchCitationStyleSchema, type ResearchCitationStyle} from '../../shared/schemas/research-citation-style';
import {useEffect, useRef, useState} from 'react';
import type {ResearchExportInputs} from '../../shared/schemas/research-export-publication';
import {researchExportPrepareRequestSchema, type ResearchExportExecution, type ResearchExportInputsRequest,
  type ResearchExportPrepare} from '../../shared/schemas/research-exports';
import {researchCrateProfile, researchCrateVersion} from '../../shared/schemas/research-ro-crate';
import type {RocClient} from '../shared/roc-client';
import {useAsyncAction} from '../app/use-async-resource';
import {formPrimaryButtonClass, formSecondaryButtonClass, formSelectClass} from '../shared/form-ui';
import {emptyExportLicense, emptyExportMetadata, exportLicenseInput, exportMetadataInput, exportOptionalText,
  ExportLicenseFields, ExportMetadataFields, ExportTextField} from './ExportMetadataFields';
import {ExportResourceEditor, type ExportResourceDraft} from './ExportResourceEditor';
import {ExportPublicationReceipt} from './ExportPublicationReceipt';

type PrepareRequest = Omit<ResearchExportPrepare, 'ownerRunId'>;
export function ExportPublicationEditor({client, selection, inputs, writable, onDirty, onPending, onPrepared, onDiscard}: {
  client: RocClient; selection: ResearchExportInputsRequest; inputs: ResearchExportInputs;
  writable: boolean;
  onDirty: (value: boolean) => void; onPending: (value: boolean) => void;
  onPrepared: (value: ResearchExportExecution) => void; onDiscard: () => void
}): React.JSX.Element {
  const [conversionFormats, setConversionFormats] = useState<('docx' | 'html')[]>([]);
  const [reportCitationStyle, setReportCitationStyle] = useState<ResearchCitationStyle | ''>('');
  const [publication, setPublication] = useState(() => ({name: '', description: '', datePublished: '', license: emptyExportLicense()}));
  const [authors, setAuthors] = useState(() => [{name: '', orcid: ''}]);
  const [resources, setResources] = useState<ExportResourceDraft[]>(() => inputs.resources.map(() =>
    ({...emptyExportMetadata(), kind: '', delivery: '', acquisitionUrl: '', instructions: ''})));
  const [references, setReferences] = useState(() => inputs.references.map(reference =>
    ({...emptyExportMetadata(), name: reference.name, url: reference.url ?? '', instructions: ''})));
  const [selected, setSelected] = useState(0), [referenceIndex, setReferenceIndex] = useState(0);
  const [validation, setValidation] = useState<string | null>(null);
  const [preview, setPreview] = useState<PrepareRequest | null>(null);
  const busy = useRef(false), mounted = useRef(true), requestId = useRef(crypto.randomUUID());
  useEffect(() => {mounted.current = true; return () => {mounted.current = false;};}, []);
  const recapture = useAsyncAction(() => client.api.research.getExportInputs(selection), {label: '重新核对出版来源'});
  const prepare = useAsyncAction((request: PrepareRequest) => client.api.research.prepareExport(request), {label: '生成科研交付包'});
  const pending = recapture.pending || prepare.pending;
  const change = (): void => {
    onDirty(true); setPreview(null); setValidation(null); requestId.current = crypto.randomUUID(); recapture.reset(); prepare.reset();
  };
  const finish = (): boolean => {
    busy.current = false;
    if (!mounted.current) return false;
    onPending(false); return true;
  };
  const candidate = inputs.resources[selected], resource = resources[selected], reference = references[referenceIndex];
  return <form className="flex min-w-0 flex-col gap-3" data-testid="artifact-export-editor" noValidate onSubmit={event => {
    event.preventDefault();
    if (!writable || busy.current || preview === null) return;
    busy.current = true; onPending(true);
    void prepare.run(preview).then(result => {
      if (!finish() || !result.ok) return;
      onDirty(false); onPrepared(result.data);
    });
  }}>
    <fieldset disabled={pending || !writable} className="flex min-w-0 flex-col gap-3">
      <h3 className="font-medium">公开出版信息</h3>
      <label className="flex flex-col gap-1">报告与转换稿引用格式
        <select className={formSelectClass} value={reportCitationStyle} onChange={event => {
          setReportCitationStyle(event.target.value === '' ? '' : researchCitationStyleSchema.parse(event.target.value)); change();
        }}>
          <option value="">按项目语言选择</option>
          {Object.entries(researchCitationStyles).map(([key, style]) => <option key={key} value={key}>{style.label}</option>)}
        </select>
      </label>
      <ExportTextField label="出版名称" value={publication.name} onChange={name => {setPublication({...publication, name}); change();}}/>
      <ExportTextField label="出版说明" value={publication.description} multiline
        onChange={description => {setPublication({...publication, description}); change();}}/>
      <ExportTextField label="发布日期" type="date" value={publication.datePublished}
        onChange={datePublished => {setPublication({...publication, datePublished}); change();}}/>
      <section className="flex flex-col gap-2" aria-label="出版作者">
        {authors.map((author, index) => <div className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" key={index}>
          <ExportTextField label={`作者 ${index + 1} 姓名`} value={author.name} onChange={name => {
            setAuthors(authors.map((value, at) => at === index ? {...value, name} : value)); change();
          }}/>
          <ExportTextField label={`作者 ${index + 1} ORCID URL（可留空）`} value={author.orcid} onChange={orcid => {
            setAuthors(authors.map((value, at) => at === index ? {...value, orcid} : value)); change();
          }}/>
          <button type="button" className={`${formSecondaryButtonClass} border-[0.5px] self-start`} disabled={authors.length === 1}
            onClick={() => {setAuthors(authors.filter((_, at) => at !== index)); change();}}>移除作者 {index + 1}</button>
        </div>)}
        <button type="button" className={`${formSecondaryButtonClass} border-[0.5px] self-start`} disabled={authors.length >= 100}
          onClick={() => {setAuthors([...authors, {name: '', orcid: ''}]); change();}}>添加作者</button>
      </section>
      <section className="flex min-w-0 flex-col gap-2" aria-label="出版许可">
        <h3 className="font-medium">出版许可</h3>
        <ExportLicenseFields value={publication.license} onChange={license => {setPublication({...publication, license}); change();}}/>
      </section>
      {candidate === undefined || resource === undefined ? null : <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium">原始资源，共 {inputs.resources.length} 项</h3>
        <label className="flex flex-col gap-1 text-muted">选择待审查资源
          <select className={`${formSelectClass} border-[0.5px]`} value={selected}
            onChange={event => setSelected(Number(event.target.value))}>
            {inputs.resources.map((value, index) => <option key={index} value={index}>
              {index + 1}. {value.source.kind} / {value.source.path}
            </option>)}
          </select>
        </label>
        <ExportResourceEditor candidate={candidate} value={resource} onChange={value => {
          setResources(resources.map((item, index) => index === selected ? value : item)); change();
        }}/>
      </section>}
      {reference === undefined ? null : <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2">
        <h3 className="font-medium">参考文献，共 {references.length} 项</h3>
        <label className="flex flex-col gap-1 text-muted">选择待审查文献
          <select className={`${formSelectClass} border-[0.5px]`} value={referenceIndex}
            onChange={event => setReferenceIndex(Number(event.target.value))}>
            {inputs.references.map((value, index) => <option key={value.id} value={index}>{value.id}</option>)}
          </select>
        </label>
        <p className="text-muted">参考文献仅交付元数据。</p>
        <ExportMetadataFields value={reference} onChange={metadata => {
          setReferences(references.map((value, index) => index === referenceIndex ? {...value, ...metadata} : value)); change();
        }}/>
        <ExportTextField label="文献获取说明" value={reference.instructions} multiline onChange={instructions => {
          setReferences(references.map((value, index) => index === referenceIndex ? {...value, instructions} : value)); change();
        }}/>
      </section>}
    </fieldset>
    {validation === null ? null : <p role="alert" className="break-words text-[var(--st-warn)]">{validation}</p>}
    {recapture.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{recapture.error}</p>}
    {prepare.error === null ? null : <p role="alert" className="text-[var(--st-warn)]">{prepare.error}</p>}
    {pending ? <p role="status">{recapture.pending ? '正在核对当前来源…' : '正在提交生成请求…'}</p> : null}
    <fieldset className="flex flex-col gap-2" disabled={!writable || pending}>
      <legend>附加转换稿</legend>
      {(['docx', 'html'] as const).map(format => <label key={format} className="flex items-center gap-2">
        <input type="checkbox" checked={conversionFormats.includes(format)} onChange={event => {
          setConversionFormats(current => event.target.checked ? [...current, format] : current.filter(value => value !== format)); setPreview(null);
        }}/>{format.toUpperCase()}
      </label>)}
      <p className="text-muted">由已批准正文生成；不转换 TeX 模板布局，正文中的公式和表格语法保留为文本。请检查转换稿。</p>
    </fieldset>
    {preview === null ? null : <section className="flex min-w-0 flex-col gap-2 border-t-[0.5px] border-line pt-2" data-testid="artifact-export-preview">
      <p>转换稿：{preview.conversionFormats?.join("、") || "不生成"}；引用样式：{preview.reportCitationStyle || "按语言默认"}</p>
      <ExportPublicationReceipt review={preview.publicationReview}/>
    </section>}
    <div className="flex flex-wrap gap-2">
      <button type="button" className={`${formSecondaryButtonClass} border-[0.5px]`} disabled={pending || !writable}
        data-testid="artifact-export-preview-button" onClick={() => {
          if (!writable || busy.current) return;
          const missing = resources.findIndex((value, index) => value.delivery === '' || value.kind === '' ||
            inputs.resources[index]!.mandatory && value.delivery !== 'bundled');
          if (missing !== -1) {setValidation(`资源 ${missing + 1} 需要明确选择对象类型与交付方式。`); return;}
          const parsed = researchExportPrepareRequestSchema.safeParse({
            ...selection, requestId: requestId.current, title: publication.name,
            ...(conversionFormats.length ? {conversionFormats} : {}),
            ...(reportCitationStyle === '' ? {} : {reportCitationStyle}),
            publicationReview: {
              sourceHash: inputs.sourceHash,
              publication: {...publication, profile: researchCrateProfile, version: researchCrateVersion,
                authors: authors.map(author => ({name: author.name, orcid: exportOptionalText(author.orcid)})),
                license: exportLicenseInput(publication.license)},
              resources: resources.map((value, index) => ({
                source: inputs.resources[index]!.source, kind: value.kind,
                ...exportMetadataInput(value),
                delivery: value.delivery === 'bundled' ? {kind: 'bundled'} :
                  {kind: 'metadata_only', url: exportOptionalText(value.acquisitionUrl), instructions: value.instructions}
              })),
              references: references.map((value, index) => ({
                id: inputs.references[index]!.id, ...exportMetadataInput(value), instructions: value.instructions
              }))
            }
          });
          if (!parsed.success) {
            setValidation(parsed.error.issues.map(issue => `${issue.path.join('.')}：${issue.message}`).join('；')); return;
          }
          setPreview(null); setValidation(null); busy.current = true; onPending(true);
          void recapture.run().then(result => {
            if (!finish() || !result.ok) return;
            if (result.data.sourceHash !== inputs.sourceHash) {
              setValidation('出版来源已变化。请放弃本次编辑，重新读取来源并审查。'); return;
            }
            setPreview(parsed.data);
          });
        }}>预览并核对当前来源</button>
      <button type="submit" className={`${formPrimaryButtonClass} border-[0.5px]`} disabled={pending || !writable || preview === null}
        data-testid="artifact-export-prepare">确认清单并生成 ZIP</button>
      <button type="button" className={`${formSecondaryButtonClass} border-[0.5px]`} disabled={pending}
        data-testid="artifact-export-discard" onClick={() => {onDirty(false); onDiscard();}}>放弃本次编辑</button>
    </div>
  </form>;
}
