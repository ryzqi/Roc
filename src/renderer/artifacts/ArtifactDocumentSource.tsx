import {lazy, Suspense, useRef, useState} from 'react';
import type {ResearchEvidence} from '../../shared/types';
import type {ResearchSourceLocator} from '../../shared/schemas/research-source-locator';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {ErrorBar} from '../shell/ErrorBar';
import {documentContentHash} from '../literature/document-content-hash';

const PaperPdfView = lazy(() => import('../literature/PaperPdfView'));
const PaperBlockAsset = lazy(() => import('../literature/PaperBlockAsset'));

/** Read the captured source version, including its context; never replace it with the current parse. */
export function ArtifactDocumentSource({client, evidence, locator}: {
  client: RocClient; evidence: ResearchEvidence; locator: ResearchSourceLocator
}): React.JSX.Element {
  const key = JSON.stringify([evidence.projectId, evidence.id, locator]);
  const read = useAsyncResource(key, async () => {
    const resolved = await client.api.research.resolveDocumentParse({projectId: evidence.projectId, parseId: locator.parseId});
    if (!resolved.ok) return {ok: false as const, error: resolved.error};
    const document = resolved.data;
    if (document.id !== locator.documentId || document.sourceHash !== locator.sourceHash) {
      throw new Error('保存的来源与原文身份不一致。');
    }
    const response = await client.api.research.getDocumentContent({projectId: evidence.projectId, documentId: locator.documentId,
      parseId: locator.parseId, sourceHash: locator.sourceHash, parseHash: locator.parseHash});
    if (!response.ok) return {ok: false as const, error: response.error};
    const parsed = response.data;
    if (parsed.run.id !== locator.parseId || parsed.run.documentId !== locator.documentId ||
        parsed.content.sourceHash !== locator.sourceHash || parsed.content.parserFingerprint !== locator.parserFingerprint ||
        await documentContentHash(parsed.content) !== locator.parseHash) throw new Error('保存的解析版本与返回内容不一致。');
    const blocks = parsed.content.blocks.filter(block => block.id === locator.blockId);
    if (blocks.length !== 1 || blocks[0].locator !== locator.rawLocator || blocks[0].text !== evidence.excerpt) {
      throw new Error('保存的证据没有唯一的原始解析块。');
    }
    const block = blocks[0];
    if (block.locations.length !== locator.locations.length || block.locations.some((location, index) => {
      const saved = locator.locations[index];
      return location.page !== saved.page || (saved.bbox === null ?
        location.bbox[0] !== location.bbox[2] || location.bbox[1] !== location.bbox[3] :
        JSON.stringify(location.bbox) !== JSON.stringify(saved.bbox) || location.coordinateOrigin !== saved.coordinateOrigin);
    })) throw new Error('保存的页或区域与原始解析块不一致。');
    return {ok: true as const, data: {document, parsed}};
  }, {label: '读取证据原文固定版本'});
  const [selection, setSelection] = useState<{key: string; blockId: string; locationIndex: number} | null>(null);
  const [assetSelection, setAssetSelection] = useState<string | null>(null);
  const blockRef = useRef<HTMLDivElement>(null);
  const selected = selection?.key === key ? selection : {blockId: locator.blockId, locationIndex: 0};
  const loaded = read.status === 'ready' ? read.data : null;
  const block = loaded?.parsed.content.blocks.find(block => block.id === selected.blockId);
  const assetKey = JSON.stringify([key, selected.blockId]);
  const comparingAsset = assetSelection === assetKey;
  return <section className="mt-2 flex min-w-0 flex-col gap-2" data-testid="artifact-document-source" aria-label="证据原文固定版本">
    <p className="break-all font-mono text-[var(--font-meta-size)] text-muted">解析 {locator.parseId}，SHA-256 {locator.parseHash}</p>
    {read.status !== 'loading' ? null : <p role="status">读取证据原文…</p>}
    {read.error === null ? null : <ErrorBar error={{level: 'blocked', message: read.error, retry: read.reload}}/>}
    {loaded === null || block === undefined ? null : <>
      {block.locations.length <= 1 ? null : <label className="flex items-center gap-1 text-muted">块位置
        <select aria-label="证据原文位置" value={selected.locationIndex}
          className="rounded-control border-[0.5px] border-line bg-surface px-1"
          onChange={event => setSelection({key, blockId: selected.blockId, locationIndex: Number(event.target.value)})}>
          {block.locations.map((location,index) => <option key={index} value={index}>第 {location.page} 页，位置 {index + 1}</option>)}
        </select>
      </label>}
      {loaded.document.mediaType !== 'application/pdf' ? <p role="note" className="text-muted">此来源没有 PDF 原文，以下为保存版本的解析块。</p> :
        <div className="h-[480px] min-h-0 min-w-0 border-[0.5px] border-line">
          <Suspense fallback={<p role="status" className="p-2 text-muted">加载原文阅读器…</p>}>
            <PaperPdfView client={client} projectId={evidence.projectId} document={loaded.document} parsed={loaded.parsed}
              canAnnotate={false}
              selection={{blockId: selected.blockId, locationIndex: selected.locationIndex}}
              onSelectBlock={selection => {
                setSelection({key, ...selection});
                blockRef.current?.focus({preventScroll: true});
                blockRef.current?.scrollIntoView({block: 'center'});
              }}/>
          </Suspense>
        </div>}
      <div ref={blockRef} tabIndex={-1} data-testid="artifact-document-source-block"
        className="min-w-0 focus-visible:outline-2 focus-visible:outline-accent">
        <p className="break-words text-muted">{block.label}，{block.locator}</p>
        <div className={comparingAsset ? 'grid grid-cols-2 items-start gap-2' : undefined}>
        <p className="whitespace-pre-wrap break-words text-ink">{block.text}</p>
        {!comparingAsset ? null : <Suspense fallback={<p role="status" className="text-muted">加载固定解析图像…</p>}>
          <PaperBlockAsset client={client} projectId={evidence.projectId} document={loaded.document} parsed={loaded.parsed} block={block}/>
        </Suspense>}
        </div>
        {block.imageAssetId !== null ?
          <button type="button" aria-expanded={comparingAsset} data-testid="artifact-document-source-asset-toggle"
            onClick={() => setAssetSelection(comparingAsset ? null : assetKey)}
            className="mt-1 rounded-control px-1 py-0.5 text-[var(--font-meta-size)] text-muted hover:bg-[var(--overlay-hover)]">
            {comparingAsset ? '收起固定解析图像' : '核对固定解析图像'}
          </button> : null}
      </div>
    </>}
  </section>;
}
