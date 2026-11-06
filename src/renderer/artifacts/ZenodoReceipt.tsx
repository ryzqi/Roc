import type {ZenodoPrepared} from '../../shared/schemas/research-zenodo';
import type {ZenodoOperation} from '../../shared/schemas/research-zenodo-remote';
export const zenodoStatusLabels = {creating:'正在创建草稿',create_unknown:'草稿创建结果待查询',draft:'草稿待核对',uploading:'正在上传',upload_unknown:'上传结果待查询',ready:'文件已核对，等待公开批准',publish_requested:'已请求发布',publish_unknown:'发布结果待查询',published:'已公开发布',remote_error:'远端操作失败'} as const;
export function ZenodoReceipt({preparation, operation}: {preparation: ZenodoPrepared; operation?: ZenodoOperation}): React.JSX.Element {
  const {metadata,environment}=preparation.request;
  return <section className="flex min-w-0 flex-col gap-2" data-testid="artifact-zenodo-receipt" aria-label="Zenodo 公开清单">
    <h3 className="font-medium">{environment==='sandbox'?'Zenodo 测试环境':'Zenodo 正式环境'}</h3>
    <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1 break-words">
      <dt>标题</dt><dd>{metadata.title}</dd><dt>说明</dt><dd className="whitespace-pre-wrap">{metadata.description}</dd>
      <dt>类型</dt><dd>{metadata.publication_type}</dd><dt>日期</dt><dd>{metadata.publication_date}</dd>
      <dt>访问</dt><dd>公开</dd><dt>许可</dt><dd>{metadata.license}</dd><dt>版本</dt><dd>{metadata.version}</dd>
      <dt>作者</dt><dd>{metadata.creators.map((creator,index)=><p key={index}>{creator.name}{creator.affiliation===undefined?'':`，${creator.affiliation}`}{creator.orcid===undefined?'':`，${creator.orcid}`}</p>)}</dd>
      <dt>准备时间</dt><dd>{preparation.createdAt}</dd><dt>审核人</dt><dd>{preparation.actor.id}</dd>
    </dl>
    <ul className="flex min-w-0 flex-col gap-2" aria-label="拟上传文件">
      {preparation.inputs.files.map(file=><li key={file.name} className="break-all border-t-[0.5px] border-line pt-2">
        <p>{file.name}，{file.size} B</p><p className="text-muted">{file.area} / {file.path}</p>
        <p className="font-mono text-muted">SHA-256 {file.sha256}</p><p className="font-mono text-muted">MD5 {file.md5}</p>
      </li>)}
    </ul>
    <p className="break-all font-mono text-muted">准备 SHA-256 {preparation.contentHash}</p>
    {operation===undefined?null:<>
      <p role="status">{zenodoStatusLabels[operation.status]}</p>
      {operation.error===null?null:<p role="alert" className="break-words text-[var(--st-warn)]">{operation.error}</p>}
      <p className="break-all">操作 ID {operation.id}，修订 {operation.revision}</p>
      <p className="break-all">公开关联标识 {operation.marker}</p>
      {operation.remote===null?null:<section className="flex min-w-0 flex-col gap-2" data-testid="artifact-zenodo-remote">
        <h3 className="font-medium">完整远端快照</h3>
        <p>草稿 {operation.remote.id}，所有者 {operation.remote.owner}，{operation.remote.state}，{operation.remote.submitted?'已提交':'未提交'}</p>
        <p>远端修改时间 {operation.remote.modified}</p>
        <pre className="whitespace-pre-wrap break-all font-mono text-[var(--font-chrome-size)]" aria-label="远端完整元数据">{JSON.stringify(operation.remote.metadata,null,2)}</pre>
        <ul aria-label="远端文件">{operation.remote.files.map(file=><li className="break-all border-t-[0.5px] border-line py-1" key={file.id}>
          {file.name}，{file.size} B，MD5 {file.md5}，文件 ID {file.id}
        </li>)}</ul>
        <p className="break-all">上传目标 {operation.remote.bucket??'未提供'}</p>
        <p className="break-all font-mono">远端 SHA-256 {operation.remote.contentHash}</p>
        <p className="break-all">DOI {operation.remote.doi??'尚未取得'}，记录 {operation.remote.recordId??'尚未取得'}</p>
        <p className="break-all">公开地址 {operation.remote.recordUrl??'尚未取得'}</p>
      </section>}
      {operation.approval===null?null:<p className="break-all">独立公开批准 {operation.approval.id}，{operation.approval.actor.id}，{operation.approval.createdAt}</p>}
    </>}
  </section>;
}
