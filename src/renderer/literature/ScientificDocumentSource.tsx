import {useState} from 'react';
import type {ScientificSource} from '../../shared/schemas/research-scientific-facts';
import type {WikiPaperKnowledgeSource} from '../../shared/schemas/research-wiki-pages';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {ErrorBar} from '../shell/ErrorBar';
import {LazyBoundary, retryableLazy} from '../shell/LazyBoundary';
import {documentContentHash} from './document-content-hash';
import {scientificSourceBlock} from './scientific-wiki';
import {scientificObject} from './scientific-wiki';
import type {ResearchSourceLocator} from '../../shared/schemas/research-source-locator';
import {formInputClass, formSecondaryButtonClass} from '../shared/form-ui';

const PaperPdfView = retryableLazy(() => import('./PaperPdfView'));
const PaperBlockAsset = retryableLazy(() => import('./PaperBlockAsset'));

/** Open only a validated captured source; ScientificSource is never converted into Evidence. */
type Target = {source: ScientificSource; object?: never} | {
  source?: never; object: {id: string; objectType: 'Table' | 'Figure' | 'Equation' | 'Algorithm'; locator: ResearchSourceLocator}
};
export function ScientificDocumentSource({client, projectId, reference, source, object}: {
  client: RocClient; projectId: string; reference: WikiPaperKnowledgeSource
} & Target): React.JSX.Element {
  const locator = source?.locator ?? object?.locator ?? null;
  const [locationIndex, setLocationIndex] = useState(0), [assetOpen, setAssetOpen] = useState(false);
  const [selection, setSelection] = useState<{blockId: string; locationIndex: number} | null>(null);
  const key = locator === null ? null : JSON.stringify([projectId, reference, source, object]);
  const read = useAsyncResource(key, async () => {
    if (locator === null) throw new Error('此来源没有 PDF 定位。');
    const resolved = await client.api.research.resolveDocumentParse({projectId, parseId: locator.parseId});
    if (!resolved.ok) return resolved;
    if (resolved.data.id !== locator.documentId || resolved.data.sourceHash !== locator.sourceHash) {
      throw new Error('科研来源与原始文档身份不一致。');
    }
    const response = await client.api.research.getDocumentContent({projectId, documentId: locator.documentId,
      parseId: locator.parseId, sourceHash: locator.sourceHash, parseHash: locator.parseHash});
    if (!response.ok) return response;
    if (await documentContentHash(response.data.content) !== locator.parseHash) throw new Error('科研原文解析内容已改变。');
    // Validate current source/configuration after all asynchronous parse reads.
    const card = await client.api.research.readWikiPaperKnowledge({projectId, ...reference});
    if (!card.ok) return card;
    if (card.data.publishedJob?.id !== reference.generationId) throw new Error('科研知识版本已改变，请重新检索。');
    let original = source;
    if (original === undefined && object !== undefined) {
      const currentObject = scientificObject(card.data, object.id);
      const originalBlock = response.data.content.blocks.find(block => block.id === locator.blockId);
      if (!currentObject || currentObject.kind !== object.objectType || !originalBlock || !card.data.paperIR) {
        throw new Error('此版本中没有所选原始对象。');
      }
      // Read the quote from the real returned parse, never from an inferred caption or summary.
      original = {proposal: {kind: 'object', objectType: object.objectType, objectId: object.id},
        identity: card.data.paperIR.identity, locator,
        quote: currentObject.kind === 'Equation' ? currentObject.value.data.rawLatex ?? originalBlock.text : originalBlock.text,
        tableId: currentObject.kind === 'Table' ? object.id : null, rowId: null, row: null, column: null, cellId: null};
    }
    if (original === undefined) throw new Error('科研来源缺失。');
    const block = scientificSourceBlock(original, card.data, response.data);
    return {ok: true as const, data: {document: resolved.data, parsed: response.data, block, quote: original.quote}};
  }, {label: '核对科研原始来源'});
  const loaded = read.status === 'ready' ? read.data : null;
  const focus = locator?.locations[locationIndex] ?? null;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="wiki-scientific-source" aria-label="科研原始来源">
    {locator === null ? <p className="text-xs text-muted">元数据来源，没有 PDF 区域。</p> : <>
      <p className="break-words text-xs text-muted">{locator.rawLocator}</p>
      {read.status === 'loading' ? <p role="status">核对原始来源…</p> : null}
      {read.error ? <ErrorBar error={{level: 'blocked', message: read.error, retry: read.reload}}/> : null}
      {loaded === null ? null : <>
        {locator.locations.length > 1 ? <label className="flex flex-wrap items-center gap-2 text-xs">来源位置
          <select className={formInputClass} aria-label="科研来源位置" value={locationIndex}
            onChange={event => {setLocationIndex(Number(event.target.value)); setSelection(null);}}>
            {locator.locations.map((location, index) => <option key={index} value={index}>第 {location.page} 页，位置 {index + 1}</option>)}
          </select>
        </label> : null}
        {focus === null || focus.bbox === null ? <p className="text-xs text-muted">未记录精确区域，仅定位原始页。</p> : null}
        {loaded.document.mediaType !== 'application/pdf' ? <p className="text-xs text-muted">此来源没有 PDF 原文。</p> :
          <div className="h-[480px] min-h-0 min-w-0 border-[0.5px] border-line">
            <LazyBoundary fallback={<p role="status" className="p-2">加载原文阅读器…</p>}>
              <PaperPdfView client={client} projectId={projectId} document={loaded.document} parsed={loaded.parsed}
                canAnnotate={false} selection={selection ?? {blockId: locator.blockId, locationIndex: 0}}
                focusLocation={selection === null ? focus : null} onSelectBlock={setSelection}/>
            </LazyBoundary>
          </div>}
        <blockquote className="whitespace-pre-wrap break-words text-ink" data-testid="wiki-scientific-source-quote">{loaded.quote}</blockquote>
        <details><summary className="cursor-pointer text-xs">原始块上下文</summary>
          <p className="whitespace-pre-wrap break-words text-xs">{loaded.block.text}</p>
        </details>
        {loaded.block.imageAssetId === null ? null : <>
          <button type="button" className={formSecondaryButtonClass} aria-expanded={assetOpen}
            onClick={() => setAssetOpen(value => !value)}>核对固定解析图像</button>
          {assetOpen ? <LazyBoundary fallback={<p role="status">加载原始图像…</p>}>
            <PaperBlockAsset client={client} projectId={projectId} document={loaded.document} parsed={loaded.parsed} block={loaded.block}/>
          </LazyBoundary> : null}
        </>}
      </>}
    </>}
  </section>;
}
