import {useState} from 'react';
import type {ResearchDocument, ResearchDocumentParse} from '../../shared/types';
import type {RocClient} from '../shared/roc-client';
import {useAsyncResource} from '../app/use-async-resource';
import {ErrorBar} from '../shell/ErrorBar';
import {documentContentHash} from './document-content-hash';

/** Read the exact parser image next to raw block text, using the verified project preview protocol. */
export default function PaperBlockAsset({client, projectId, document, parsed, block}: {
  client: RocClient; projectId: string; document: ResearchDocument; parsed: ResearchDocumentParse;
  block: ResearchDocumentParse['content']['blocks'][number]
}): React.JSX.Element {
  const key = JSON.stringify([projectId, document.id, parsed.run.id, document.sourceHash, block.id, block.imageAssetId]);
  const [imageError, setImageError] = useState<{key: string; message: string} | null>(null);
  const read = useAsyncResource(key, async () => {
    const expected = parsed.content.assets.find(asset => asset.id === block.imageAssetId);
    if (expected === undefined) throw new Error('该块的解析图像未记录在所选版本中。');
    const parseHash = await documentContentHash(parsed.content);
    const response = await client.api.research.previewDocument({projectId, documentId: document.id, parseId: parsed.run.id,
      sourceHash: document.sourceHash, parseHash});
    if (!response.ok) return response;
    const preview = response.data;
    if (preview.projectId !== projectId || preview.documentId !== document.id || preview.parseId !== parsed.run.id ||
        preview.sourceHash !== document.sourceHash || preview.parseHash !== parseHash) throw new Error('解析图像返回了另一来源版本。');
    const asset = preview.assets.find(asset => asset.id === expected.id);
    if (asset === undefined || asset.sha256 !== expected.sha256 || asset.size !== expected.size ||
        asset.kind !== expected.kind || asset.page !== expected.page) throw new Error('解析图像与保存的块资产不一致。');
    const url = `roc-preview://research/projects/${encodeURIComponent(projectId)}/documents/${encodeURIComponent(document.id)}` +
      `/parses/${encodeURIComponent(parsed.run.id)}/${encodeURIComponent(asset.id)}/${asset.sha256}.png`;
    if (asset.resourceUrl !== url) throw new Error('解析图像资源未绑定所选项目和版本。');
    return {ok: true as const, data: asset};
  }, {label: '读取解析图像'});
  const asset = read.status === 'ready' ? read.data : null;
  const failure = imageError?.key === key ? imageError.message : read.error;
  const retry = (): void => {setImageError(null); read.reload();};
  return <figure className="min-w-0" data-testid="reader-block-asset">
    {read.status === 'loading' ? <p role="status" className="text-muted">读取解析图像…</p> : null}
    {failure === null ? null : <ErrorBar error={{level: 'blocked', message: failure, retry}}/>}
    {asset === null || failure !== null ? null : <>
      <img key={asset.resourceUrl} src={asset.resourceUrl} alt={`${block.label}保存的解析图像`} loading="lazy" decoding="async"
        className="h-auto max-w-full border-[0.5px] border-line" data-testid="reader-block-asset-image"
        onError={() => setImageError({key, message: '所选解析图像读取或解码失败，请重新核对原文。'})}/>
      <figcaption className="mt-1 break-words text-[var(--font-meta-size)] text-muted">
        解析图像{asset.page === null ? '' : `，第 ${asset.page} 页`}
      </figcaption>
    </>}
  </figure>;
}
