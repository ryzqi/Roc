import type {ResearchExportPublicationReview, ResearchExportResourceReview} from '../../shared/schemas/research-export-publication';

function MetadataReceipt({value}: {value: Pick<ResearchExportResourceReview, 'name' | 'description' | 'version' | 'url' | 'license'>}): React.JSX.Element {
  return <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
    <dt>名称</dt><dd>{value.name}</dd>
    <dt>说明</dt><dd>{value.description}</dd>
    {value.version === null ? null : <><dt>版本</dt><dd>{value.version}</dd></>}
    {value.url === null ? null : <><dt>公开 URL</dt><dd className="break-all">{value.url}</dd></>}
    <dt>许可</dt><dd>{value.license.name}</dd>
    <dt>权限说明</dt><dd>{value.license.description}</dd>
    {value.license.url === null ? null : <><dt>许可 URL</dt><dd className="break-all">{value.license.url}</dd></>}
  </dl>;
}

export function ExportPublicationReceipt({review}: {review: ResearchExportPublicationReview}): React.JSX.Element {
  const {publication} = review;
  return <section className="flex min-w-0 flex-col gap-2" aria-label="公开交付清单">
    <h3 className="font-medium">公开交付清单</h3>
    <MetadataReceipt value={{...publication, url: null, version: null}}/>
    <p>RO-Crate {publication.version}，{publication.profile}</p>
    <p>发布日期 {publication.datePublished}</p>
    <ul className="flex min-w-0 flex-col gap-1" aria-label="出版作者">
      {publication.authors.map((author, index) => <li className="break-words" key={index}>
        {author.name}{author.orcid === null ? '' : `，${author.orcid}`}
      </li>)}
    </ul>
    <ul className="flex min-w-0 flex-col gap-3" aria-label="资源交付决定">
      {review.resources.map((value, index) => <li className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line pt-2" key={index}>
        <p className="break-all">{value.source.path}</p>
        <p>{{software: '软件', dataset: '数据', result: '结果', figure: '图稿'}[value.kind]}，
          {value.delivery.kind === 'bundled' ? '已确认再分发权限，原件随包交付' : '仅元数据'}</p>
        <MetadataReceipt value={value}/>
        {value.delivery.kind === 'bundled' ? null : <>
          {value.delivery.url === null ? null : <p className="break-all">获取 URL {value.delivery.url}</p>}
          <p className="break-words">获取说明 {value.delivery.instructions}</p>
        </>}
        <p className="break-all font-mono text-muted">原件 SHA-256 {value.source.sha256}，{value.source.size} B</p>
      </li>)}
      {review.references.map(value => <li className="flex min-w-0 flex-col gap-1 border-t-[0.5px] border-line pt-2" key={value.id}>
        <p className="break-all">参考文献 {value.id}，仅元数据</p>
        <MetadataReceipt value={value}/>
        <p className="break-words">获取说明 {value.instructions}</p>
      </li>)}
    </ul>
    <p className="break-all font-mono text-muted">来源 SHA-256 {review.sourceHash}</p>
  </section>;
}
